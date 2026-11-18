#!/usr/bin/env node
import { randomUUID, timingSafeEqual, createHmac } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { getProxyKey, readAuthToken } from "./credentials.mjs"
import { readConfig } from "./config.mjs"
import { adaptToModel, claudeApiId, createModelCatalog, isRoutable, withoutSafeguards } from "./models.mjs"
import { buildChatRequest, createStreamTranslator, translateResponseToAnthropic } from "./chat.mjs"
import { abortError, parseRetryAfterMs, ProxyError } from "./runtime.mjs"
import { consumeSSE, createSSEWriter, NativeMessageState, parseSSEData, validateNativeContentBlock } from "./sse.mjs"
import { createSearchProvider } from "./search-providers.mjs"
import { createWebSearchService, extractWebSearchConfig, prepareSearchRequest, runWebSearch } from "./search.mjs"
import { buildHostedSearchRequest, emitHostedMessage, hostedSearchIneligibility, hostedSearchMessage, hostedSearchUsage } from "./hosted-search.mjs"
import { createUpstreamClient, errorEnvelope, errorType, responseHeaders, upstreamError } from "./upstream.mjs"

export { createStreamTranslator, translateMessages, translateContentPart } from "./chat.mjs"
export { mapModel } from "./models.mjs"
export { readConfig } from "./config.mjs"
export { createAdmissionGate, createSharedTasks, writeResponse, parseRetryAfterMs } from "./runtime.mjs"
export { SSEDecoder } from "./sse.mjs"
export { runWebSearch, createWebSearchService, extractWebSearchConfig, restoreSearchHistory } from "./search.mjs"

function authorized(req, key) {
  const matches = (candidate) => {
    if (typeof candidate !== "string") return false
    const value = Buffer.from(candidate)
    return value.length === key.length && timingSafeEqual(value, key)
  }
  return matches(req.headers["x-api-key"]) || matches(req.headers.authorization?.replace(/^Bearer /i, ""))
}

function jsonResponse(res, status, body, headers = {}) {
  res.writeHead(status, { ...headers, "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

// Client-chosen names in logs: escaped, truncated and limited in number.
function fieldList(names) {
  const shown = names.slice(0, 5).map((name) => JSON.stringify(name.slice(0, 64))).join(", ")
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown
}

function readRequestBody(req, { signal, maxBytes, timeoutMs }) {
  signal.throwIfAborted()
  if (Number(req.headers["content-length"]) > maxBytes) {
    throw new ProxyError(413, "Request body exceeds the configured byte limit", "request_too_large")
  }
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let bytes = 0
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      req.removeListener("data", onData)
      req.removeListener("end", onEnd)
      req.removeListener("error", onError)
      signal.removeEventListener("abort", onAbort)
    }
    const fail = (error) => { cleanup(); req.pause(); reject(error) }
    const resetTimeout = () => {
      clearTimeout(timer)
      timer = setTimeout(() => fail(new ProxyError(408, "Request body upload timed out", "invalid_request_error")), timeoutMs)
    }
    const onData = (chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) { fail(new ProxyError(413, "Request body exceeds the configured byte limit", "request_too_large")); return }
      chunks.push(chunk)
      resetTimeout()
    }
    const onEnd = () => {
      cleanup()
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
        resolveBody({ body: JSON.parse(text), bytes })
      } catch {
        reject(new ProxyError(400, "Request body must contain valid UTF-8 JSON", "invalid_request_error"))
      }
    }
    const onError = (error) => fail(error)
    const onAbort = () => fail(signal.reason)
    req.on("data", onData)
    req.once("end", onEnd)
    req.once("error", onError)
    signal.addEventListener("abort", onAbort, { once: true })
    resetTimeout()
  })
}

function validateRequest(body, countTokens) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProxyError(400, "Messages request must be a JSON object", "invalid_request_error")
  }
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 200 || /[\r\n\0]/.test(body.model)) {
    throw new ProxyError(400, "A valid model identifier is required", "invalid_request_error")
  }
  if (!Array.isArray(body.messages) || body.messages.some((message) => !message || typeof message !== "object" || !["user", "assistant", "system"].includes(message.role))) {
    throw new ProxyError(400, "messages must be an array of message objects with valid roles", "invalid_request_error")
  }
  if ((!countTokens || body.max_tokens !== undefined) && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 0)) {
    throw new ProxyError(400, "max_tokens must be a nonnegative integer", "invalid_request_error")
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new ProxyError(400, "stream must be a boolean", "invalid_request_error")
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => !tool || typeof tool !== "object" || Array.isArray(tool)))) {
    throw new ProxyError(400, "tools must be an array of tool objects", "invalid_request_error")
  }
}

function beginStream(res, upstreamHeaders = {}) {
  res.writeHead(200, {
    ...upstreamHeaders,
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  })
  res.flushHeaders()
}

async function nativeMessage(upstream, onEvent, config) {
  if (!upstream.response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new ProxyError(502, "Copilot returned a non-SSE payload for a streaming request")
  }
  const state = new NativeMessageState({ collect: true })
  const terminal = await consumeSSE(upstream, async (frame) => {
    if (frame.data === null) return false
    const data = parseSSEData(frame)
    const done = state.accept(data, frame.event)
    if (data.type?.startsWith("content_block_") && onEvent) await onEvent(data)
    return done
  }, config.maxEventBytes)
  if (state.error) {
    const error = new ProxyError(502, state.error.error?.message ?? "Copilot stream failed", state.error.error?.type ?? "api_error")
    error.envelope = state.error.type === "error" ? state.error : undefined
    throw error
  }
  if (!terminal || !state.completed) throw new ProxyError(502, "Copilot stream ended before a complete message_stop")
  return state.message
}

export function createProxyServer({
  token, tokenProvider, proxyKey, fetchImpl = globalThis.fetch, searchProvider,
  config: overrides = {}, logger = console, upstreamBaseUrl = "https://api.githubcopilot.com",
  signal: shutdownSignal,
} = {}) {
  if (typeof proxyKey !== "string" || !proxyKey) throw new TypeError("A local proxy API key is required")
  const key = Buffer.from(proxyKey)
  const config = readConfig({}, overrides)
  const baseUrl = upstreamBaseUrl.replace(/\/$/, "")
  const getToken = tokenProvider ?? (token ? async () => token : readAuthToken)
  const shutdown = new AbortController()
  const lifecycle = shutdownSignal ? AbortSignal.any([shutdownSignal, shutdown.signal]) : shutdown.signal
  const catalog = createModelCatalog({ fetchImpl, baseUrl, config, logger })
  const copilot = createUpstreamClient({ fetchImpl, baseUrl, config, logger })
  // Hosted search gets its own client: one attempt with the search deadline,
  // since provider search is the fallback, and its own admission gate, so a
  // Retry-After for the search model never delays or rejects Claude traffic.
  const hostedClient = createUpstreamClient({
    fetchImpl, baseUrl, logger,
    config: { ...config, maxRetries: 0, requestTimeoutMs: Math.min(config.requestTimeoutMs, config.searchTimeoutMs) },
  })
  const search = createWebSearchService({
    provider: searchProvider ?? createSearchProvider({ fetchImpl, config, logger, githubMcpUrl: `${baseUrl}/mcp/` }), config, logger,
  })
  const warned = new Set()
  const warnOnce = (message) => {
    if (warned.has(message)) return
    if (warned.size < 256) warned.add(message)
    logger.warn(message)
  }

  // After a refusal or rate limit, skip hosted search for a while instead of
  // paying for a failing call before every provider search.
  let hostedPausedUntil = 0
  function pauseHostedSearch(error) {
    const hint = parseRetryAfterMs(error?.headers?.["retry-after"] ?? null)
    const pause = error?.status === 429 ? hint ?? 60000
      : error?.status === 503 ? hint ?? 0
      : [401, 403, 404].includes(error?.status) ? 300000 : 0
    if (pause > 0) hostedPausedUntil = Math.max(hostedPausedUntil, Date.now() + Math.min(pause, 3600000))
    return pause
  }

  // Answer a search-only request with one Copilot /responses call using the
  // hosted web_search tool. Returns { message } on success. Otherwise returns
  // { message: null, usage } so the caller uses provider search; `usage` holds
  // the tokens of a hosted answer that was received but rejected.
  async function hostedSearch({ body, settings, model, token, signal }) {
    const paused = hostedPausedUntil - Date.now()
    if (paused > 0) {
      logger.log(`  search: providers (hosted search paused for ${Math.ceil(paused / 1000)}s)`)
      return { message: null }
    }
    let upstream
    let usage
    try {
      const info = (await catalog.get(token, signal)).find((entry) => entry.id === config.webSearchModel)
      if (!info || !isRoutable(info) || !info.supported_endpoints?.includes("/responses")) {
        warnOnce(`Hosted web search model ${config.webSearchModel} is unavailable for /responses; using provider search`)
        return { message: null }
      }
      // No incoming headers: anthropic-* headers do not apply to /responses.
      upstream = await hostedClient.request("/responses", buildHostedSearchRequest(body, settings, config, info), { token, headers: {}, signal })
      if (!upstream.response.ok) throw await upstreamError(upstream)
      let data
      try { data = JSON.parse(await upstream.text()) } catch { throw new ProxyError(502, "Copilot hosted search returned invalid JSON") }
      try { usage = hostedSearchUsage(data?.usage) } catch { /* hostedSearchMessage rejects it below */ }
      let message
      try {
        message = hostedSearchMessage(data, { id: `msg_${randomUUID()}`, model, settings })
      } catch (error) {
        error.hostedReason = error.message
        throw error
      }
      const searches = message.usage.server_tool_use.web_search_requests
      logger.log(`  search: hosted ${info.id} (${searches} ${searches === 1 ? "search" : "searches"})`)
      return { message, searchModel: info.id }
    } catch (error) {
      signal.throwIfAborted()
      const pause = pauseHostedSearch(error)
      // Upstream messages are never logged; hostedReason is written locally.
      logger.warn(`Hosted web search failed (${error.hostedReason ?? error.status ?? error.name}); using provider search` +
        (pause > 0 ? ` for the next ${Math.ceil(pause / 1000)}s` : ""))
      return { message: null, usage }
    } finally {
      upstream?.dispose()
    }
  }

  async function handle(req, res) {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifecycle])
    req.once("aborted", () => controller.abort(abortError("Client aborted request upload")))
    req.on("error", (error) => controller.abort(error))
    res.on("error", (error) => controller.abort(error))
    res.once("close", () => { if (!res.writableFinished) controller.abort(abortError()) })
    let writer
    let upstream
    let nativeTransport = false
    let inference = false
    let outcome = "failed"
    const makeWriter = () => {
      const stream = createSSEWriter(res, {
        signal, timeoutMs: config.requestTimeoutMs, heartbeatMs: config.heartbeatMs,
        onError: (error) => { controller.abort(error); res.destroy() },
      })
      stream.startPings()
      return stream
    }
    try {
      signal.throwIfAborted()
      const url = new URL(req.url, "http://localhost")
      const health = url.pathname === "/health" || url.pathname === "/"
      const route = url.pathname
      if (health) {
        if (!["GET", "HEAD"].includes(req.method)) throw new ProxyError(405, "Method not allowed", "invalid_request_error", { allow: "GET, HEAD" })
        // With a nonce, prove possession of the local key without revealing it,
        // so the launcher never sends its key to a server that does not hold it.
        const nonce = url.searchParams.get("nonce")
        const proof = nonce && /^[0-9a-f]{32,128}$/.test(nonce)
          ? { key_proof: createHmac("sha256", key).update(`claude-code-copilot health ${nonce}`).digest("hex") } : {}
        jsonResponse(res, 200, { status: "ok", provider: "github-copilot", api_key_required: true, ...proof })
        return
      }
      if (!["/v1/messages", "/v1/messages/count_tokens", "/v1/models"].includes(route)) {
        throw new ProxyError(404, "Not found", "not_found_error")
      }
      if (!authorized(req, key)) throw new ProxyError(401, "A valid local proxy API key is required", "authentication_error")
      const modelsRoute = route === "/v1/models"
      const countTokens = route === "/v1/messages/count_tokens"
      if (req.method !== (modelsRoute ? "GET" : "POST")) {
        throw new ProxyError(405, "Method not allowed", "invalid_request_error", { allow: modelsRoute ? "GET" : "POST" })
      }
      if (modelsRoute) {
        const authToken = await getToken()
        const models = await catalog.get(authToken, signal)
        const visible = models.filter((model) => isRoutable(model) && model.model_picker_enabled !== false &&
          model.supported_endpoints?.some((path) => path === "/v1/messages" || path === "/chat/completions"))
        const data = visible.map((model) => {
          const id = claudeApiId(model.id)
          return { id, object: "model", display_name: model.name ?? id }
        })
        jsonResponse(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null })
        return
      }
      const { body } = await readRequestBody(req, { signal, maxBytes: config.maxBodyBytes, timeoutMs: config.requestTimeoutMs })
      validateRequest(body, countTokens)
      const searchSettings = extractWebSearchConfig(body.tools, config)
      let preparedSearch = searchSettings ? prepareSearchRequest(body, config, searchSettings) : null
      const authToken = await getToken()
      const { model, modelInfo, transport } = await catalog.resolve(body.model, authToken, signal)
      nativeTransport = transport === "messages"
      // Validate the client's request as sent, then fit the upstream payload to
      // what this model and Copilot accept.
      const upstreamBody = (payload) => withoutSafeguards(adaptToModel(payload, modelInfo))
      if (preparedSearch) preparedSearch = upstreamBody(preparedSearch)
      let request = { ...upstreamBody(body), model }
      if (nativeTransport && !searchSettings) request = prepareSearchRequest(request, config, null)
      inference = true
      logger.log(`[${new Date().toISOString()}] ${req.method} ${route} | model: ${model} | transport: ${transport}${searchSettings ? " + search" : ""}`)
      if (!nativeTransport && countTokens) {
        throw new ProxyError(501, "Authoritative token counting requires native Messages transport", "api_error")
      }
      if (countTokens) {
        const payload = preparedSearch ? { ...preparedSearch, model } : request
        upstream = await copilot.request(`/v1/messages/count_tokens${url.search}`, payload, { token: authToken, headers: req.headers, signal })
        if (!upstream.response.ok) throw await upstreamError(upstream)
        const text = await upstream.text()
        let data
        try { data = JSON.parse(text) } catch { throw new ProxyError(502, "Copilot returned invalid token-count JSON") }
        if (!Number.isSafeInteger(data?.input_tokens) || data.input_tokens < 0) throw new ProxyError(502, "Copilot returned an invalid token count")
        res.writeHead(upstream.response.status, responseHeaders(upstream.response.headers))
        res.end(text)
        outcome = "complete"
        return
      }
      if (searchSettings) {
        if (searchSettings.requested > searchSettings.maxUses) logger.warn(`Web search max_uses capped at ${searchSettings.maxUses}`)
        if (searchSettings.ignoredFields.length) warnOnce(`Ignored unsupported web_search tool field(s): ${fieldList(searchSettings.ignoredFields)}`)
        const ineligible = hostedSearchIneligibility(body, searchSettings, config)
        if (ineligible && config.webSearchMode === "hosted") logger.log(`  search: providers (${ineligible})`)
        // Hosted search runs before any output, and does not use the requested
        // model's transport, so it also serves Chat-transport models.
        const hosted = ineligible ? { message: null } : await hostedSearch({
          body, settings: searchSettings, model: request.model, token: authToken, signal,
        })
        if (hosted.message) {
          const headers = { "x-copilot-search-model": hosted.searchModel }
          if (request.stream) {
            beginStream(res, headers)
            writer = makeWriter()
            await emitHostedMessage(hosted.message, (type, data) => writer.event(type, data))
          } else jsonResponse(res, 200, hosted.message, headers)
          outcome = "complete"
          return
        }
        if (!nativeTransport) {
          throw new ProxyError(501, "Provider web search requires native Messages transport; this request is not eligible for hosted search", "api_error")
        }
        if (searchSettings.userLocation) warnOnce("Provider web search ignored the web_search user_location")
        if (request.stream) { beginStream(res); writer = makeWriter() }
        const result = await runWebSearch({
          request, preparedRequest: { ...preparedSearch, model }, config, signal, priorUsage: hosted.usage,
          search: (query, options) => search.search(query, { ...options, token: authToken }),
          emit: writer ? (type, data) => writer.event(type, data) : undefined,
          generate: async (payload, onEvent) => {
            const generation = await copilot.request(`/v1/messages${url.search}`, payload, { token: authToken, headers: req.headers, signal })
            try {
              if (!generation.response.ok) throw await upstreamError(generation)
              return await nativeMessage(generation, onEvent, config)
            } finally { generation.dispose() }
          },
        })
        if (!writer) jsonResponse(res, 200, result)
        outcome = "complete"
        return
      }
      const payload = nativeTransport ? request : buildChatRequest(request, { model, modelInfo, forwardReasoning: config.forwardReasoning })
      const path = nativeTransport ? `/v1/messages${url.search}` : "/chat/completions"
      upstream = await copilot.request(path, payload, { token: authToken, headers: req.headers, signal })
      if (!upstream.response.ok) throw await upstreamError(upstream)
      if (!request.stream) {
        const text = await upstream.text()
        let data
        try { data = JSON.parse(text) } catch { throw new ProxyError(502, "Copilot returned invalid response JSON") }
        if (nativeTransport) {
          if (data?.type !== "message" || !Array.isArray(data.content) || typeof data.stop_reason !== "string") {
            throw new ProxyError(502, "Copilot returned an incomplete native message")
          }
          for (const block of data.content) validateNativeContentBlock(block)
          res.writeHead(upstream.response.status, responseHeaders(upstream.response.headers))
          res.end(text)
        } else jsonResponse(res, 200, translateResponseToAnthropic(data, body.model), responseHeaders(upstream.response.headers))
        outcome = "complete"
        return
      }
      if (!upstream.response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new ProxyError(502, "Copilot returned a non-SSE payload for a streaming request")
      }
      beginStream(res, responseHeaders(upstream.response.headers))
      writer = makeWriter()
      if (nativeTransport) {
        const state = new NativeMessageState()
        const terminal = await consumeSSE(upstream, async (frame) => {
          let done = false
          if (frame.data !== null) done = state.accept(parseSSEData(frame), frame.event)
          // An event cut off at EOF still needs its blank line, or the next
          // event written (such as an error) would join its last line.
          await writer.write(frame.unterminated ? `${frame.raw}\n\n` : frame.raw)
          return done
        }, config.maxEventBytes)
        if (!terminal) throw new ProxyError(502, "Copilot stream ended before a complete message_stop")
        outcome = state.error ? "upstream error" : "complete"
      } else {
        const frames = []
        const translator = createStreamTranslator(body.model, { write(frame) { frames.push(frame); return true } })
        const flush = async () => { for (const frame of frames.splice(0)) await writer.write(frame) }
        const terminal = await consumeSSE(upstream, async (frame) => {
          if (frame.data === null) return false
          const done = translator.processChunk(frame.data === "[DONE]" ? "[DONE]" : parseSSEData(frame))
          await flush()
          return done
        }, config.maxEventBytes)
        if (!terminal) { translator.processChunk(null); await flush() }
        outcome = "complete"
      }
    } catch (error) {
      if (signal.aborted || res.destroyed) {
        if (!res.destroyed) res.destroy()
        return
      }
      if (inference) logger.error(`Proxy request failed: ${error.status ?? 500} ${error.name}`)
      if (writer && res.headersSent) {
        writer.stopPings()
        await writer.event("error", errorEnvelope(error))
      } else if (!res.headersSent) {
        const status = Number.isInteger(error.status) ? error.status : 500
        const headers = { ...error.headers, ...(!req.complete ? { connection: "close" } : {}) }
        if (nativeTransport && error.rawBody !== undefined) {
          res.writeHead(status, headers)
          res.end(error.rawBody)
        } else {
          const envelope = error.status ? errorEnvelope(error) : {
            type: "error", error: { type: errorType(status), message: "Internal proxy error" },
          }
          jsonResponse(res, status, envelope, headers)
        }
      } else res.destroy()
    } finally {
      upstream?.dispose()
      if (writer) await writer.close()
      if (!res.destroyed && !res.writableEnded) res.end()
      controller.abort(abortError("Request finished"))
      if (inference) logger.log(`  <- ${outcome}`)
    }
  }

  const server = createServer({
    requestTimeout: config.requestTimeoutMs,
    headersTimeout: Math.min(config.requestTimeoutMs, 60000),
  }, (req, res) => {
    handle(req, res).catch((error) => {
      if (res.destroyed) return
      logger.error(`Unhandled proxy request failure: ${error.name}`)
      if (!res.headersSent) jsonResponse(res, 500, { type: "error", error: { type: "api_error", message: "Internal proxy error" } })
      else res.destroy()
    })
  })
  server.on("clientError", (error, socket) => {
    if (error.code === "ECONNRESET" || !socket.writable) { socket.destroy(); return }
    logger.warn(`Client error: ${error.message}`)
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  })
  server.once("close", () => {
    shutdown.abort(abortError("Proxy stopped"))
    catalog.close()
    copilot.close()
    hostedClient.close()
    search.close()
  })
  return server
}

export async function startServer() {
  const args = process.argv.slice(2)
  if (args.length) {
    if (args.length === 1 && args[0] === "--print-api-key") {
      console.log(await getProxyKey())
      return
    }
    throw new Error("Usage: node scripts/proxy.mjs [--print-api-key]; configure the server with environment variables")
  }
  const config = readConfig()
  await readAuthToken()
  const proxyKey = await getProxyKey()
  const shutdown = new AbortController()
  const server = createProxyServer({ proxyKey, config, signal: shutdown.signal })
  server.listen(config.port, config.host)
  try {
    await once(server, "listening")
  } catch (error) {
    if (error.code === "EADDRINUSE") throw new Error(`Port ${config.port} is already in use; stop the old proxy or choose COPILOT_PROXY_PORT`)
    throw error
  }
  console.log(`Claude Code / GitHub Copilot proxy listening on ${config.host}:${server.address().port}`)
  console.log(`Transport: ${config.transport}; local API key required (retrieve with --print-api-key)`)
  const stop = () => {
    shutdown.abort(abortError("Proxy is shutting down"))
    server.close()
    const timer = setTimeout(() => server.closeAllConnections(), 5000)
    timer.unref()
    server.once("close", () => clearTimeout(timer))
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  return server
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  startServer().catch((error) => {
    console.error(`Proxy startup failed: ${error.message}`)
    process.exitCode = 1
  })
}
