#!/usr/bin/env node
import { timingSafeEqual, createHmac } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { getProxyKey, readAuthToken } from "./credentials.mjs"
import { readConfig } from "./config.mjs"
import { adaptToModel, claudeApiId, createModelCatalog, isRoutable, withoutSafeguards } from "./models.mjs"
import { buildChatRequest, createStreamTranslator, translateResponseToAnthropic } from "./chat.mjs"
import { abortError, ProxyError } from "./runtime.mjs"
import { consumeSSE, createSSEWriter, NativeMessageState, parseSSEData, validateNativeContentBlock } from "./sse.mjs"
import { createSearchProvider } from "./search-providers.mjs"
import { createWebSearchService, extractWebSearchConfig, prepareSearchRequest, runWebSearch } from "./search.mjs"
import { createHostedSearch, emitHostedMessage, hostedSearchIneligibility } from "./hosted-search.mjs"
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
  // Hosted search makes one attempt with the search deadline, since provider
  // search is the fallback. It shares the admission gate, so the configured
  // concurrency and spacing limits cover all Copilot requests, but its
  // Retry-After pauses only hosted search, never the gate Claude requests use.
  const searchDeadline = Math.min(config.requestTimeoutMs, config.searchTimeoutMs)
  const hostedClient = createUpstreamClient({
    fetchImpl, baseUrl, logger, gate: copilot.gate, cooldown: false,
    config: { ...config, maxRetries: 0, requestTimeoutMs: searchDeadline, nonStreamingTimeoutMs: searchDeadline },
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
  const hostedSearch = createHostedSearch({ catalog, client: hostedClient, config, logger, warnOnce })

  // Start an SSE response; handle() closes its writer.
  function startStream(ctx, headers) {
    beginStream(ctx.res, headers)
    ctx.writer = createSSEWriter(ctx.res, {
      signal: ctx.signal, timeoutMs: config.requestTimeoutMs, heartbeatMs: config.heartbeatMs,
      onError: (error) => { ctx.controller.abort(error); ctx.res.destroy() },
    })
    ctx.writer.startPings()
  }

  // handle() disposes the response, including after an error.
  async function send(ctx, path, payload, token) {
    ctx.upstream = await copilot.request(path, payload, { token, headers: ctx.req.headers, signal: ctx.signal })
    if (!ctx.upstream.response.ok) throw await upstreamError(ctx.upstream)
    return ctx.upstream
  }

  function healthCheck({ req, res }, url) {
    if (!["GET", "HEAD"].includes(req.method)) throw new ProxyError(405, "Method not allowed", "invalid_request_error", { allow: "GET, HEAD" })
    // With a nonce, prove possession of the local key without revealing it,
    // so the launcher never sends its key to a server that does not hold it.
    const nonce = url.searchParams.get("nonce")
    const proof = nonce && /^[0-9a-f]{32,128}$/.test(nonce)
      ? { key_proof: createHmac("sha256", key).update(`claude-code-copilot health ${nonce}`).digest("hex") } : {}
    jsonResponse(res, 200, { status: "ok", provider: "github-copilot", api_key_required: true, ...proof })
  }

  async function listModels({ res, signal }) {
    const models = await catalog.get(await getToken(), signal)
    const visible = models.filter((model) => isRoutable(model) && model.model_picker_enabled !== false &&
      model.supported_endpoints?.some((path) => path === "/v1/messages" || path === "/chat/completions"))
    const data = visible.map((model) => {
      const id = claudeApiId(model.id)
      return { id, object: "model", display_name: model.name ?? id }
    })
    jsonResponse(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null })
  }

  // /v1/messages, or /v1/messages/count_tokens when `countOnly` is set.
  async function handleMessages(ctx, url, countOnly) {
    const { req, signal } = ctx
    const { body } = await readRequestBody(req, { signal, maxBytes: config.maxBodyBytes, timeoutMs: config.requestTimeoutMs })
    validateRequest(body, countOnly)
    const searchSettings = extractWebSearchConfig(body.tools, config)
    let preparedSearch = searchSettings ? prepareSearchRequest(body, config, searchSettings) : null
    const token = await getToken()
    const { model, modelInfo, transport } = await catalog.resolve(body.model, token, signal)
    ctx.nativeTransport = transport === "messages"
    // Validate the client's request as sent, then fit the upstream payload to
    // what this model and Copilot accept.
    const upstreamBody = (payload) => withoutSafeguards(adaptToModel(payload, modelInfo))
    if (preparedSearch) preparedSearch = { ...upstreamBody(preparedSearch), model }
    let request = { ...upstreamBody(body), model }
    if (ctx.nativeTransport && !searchSettings) request = prepareSearchRequest(request, config, null)
    ctx.inference = true
    logger.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname} | model: ${model} | transport: ${transport}${searchSettings ? " + search" : ""}`)
    if (countOnly) {
      if (!ctx.nativeTransport) {
        throw new ProxyError(501, "Authoritative token counting requires native Messages transport", "api_error")
      }
      await countTokens(ctx, { payload: preparedSearch ?? request, queryString: url.search, token })
    } else if (searchSettings) {
      await searchMessages(ctx, { body, request, preparedSearch, settings: searchSettings, queryString: url.search, token })
    } else {
      await forwardMessages(ctx, { body, request, model, modelInfo, queryString: url.search, token })
    }
  }

  async function countTokens(ctx, { payload, queryString, token }) {
    const upstream = await send(ctx, `/v1/messages/count_tokens${queryString}`, payload, token)
    const text = await upstream.text()
    let data
    try { data = JSON.parse(text) } catch { throw new ProxyError(502, "Copilot returned invalid token-count JSON") }
    if (!Number.isSafeInteger(data?.input_tokens) || data.input_tokens < 0) throw new ProxyError(502, "Copilot returned an invalid token count")
    ctx.res.writeHead(upstream.response.status, responseHeaders(upstream.response.headers))
    ctx.res.end(text)
    ctx.outcome = "complete"
  }

  // A request with the server web_search tool: hosted search when it can
  // answer, otherwise provider search emulation on the requested model.
  async function searchMessages(ctx, { body, request, preparedSearch, settings, queryString, token }) {
    if (settings.requested > settings.maxUses) logger.warn(`Web search max_uses capped at ${settings.maxUses}`)
    if (settings.ignoredFields.length) warnOnce(`Ignored unsupported web_search tool field(s): ${fieldList(settings.ignoredFields)}`)
    const ineligible = hostedSearchIneligibility(body, settings, config)
    if (ineligible && config.webSearchMode === "hosted") logger.log(`  search: providers (${ineligible})`)
    // Hosted search runs before any output, and does not use the requested
    // model's transport, so it also serves Chat-transport models.
    const hosted = ineligible ? { message: null } : await hostedSearch({
      body, settings, model: request.model, token, signal: ctx.signal,
    })
    if (hosted.message) {
      const headers = { "x-copilot-search-model": hosted.searchModel }
      if (request.stream) {
        startStream(ctx, headers)
        await emitHostedMessage(hosted.message, (type, data) => ctx.writer.event(type, data))
      } else jsonResponse(ctx.res, 200, hosted.message, headers)
      ctx.outcome = "complete"
      return
    }
    if (!ctx.nativeTransport) {
      throw new ProxyError(501, "Provider web search requires native Messages transport; this request is not eligible for hosted search", "api_error")
    }
    if (settings.userLocation) warnOnce("Provider web search ignored the web_search user_location")
    if (request.stream) startStream(ctx)
    const { writer } = ctx
    const result = await runWebSearch({
      request, preparedRequest: preparedSearch, config, signal: ctx.signal, priorUsage: hosted.usage,
      search: (query, options) => search.search(query, { ...options, token }),
      emit: writer ? (type, data) => writer.event(type, data) : undefined,
      generate: async (payload, onEvent) => {
        const generation = await copilot.request(`/v1/messages${queryString}`, payload, { token, headers: ctx.req.headers, signal: ctx.signal })
        try {
          if (!generation.response.ok) throw await upstreamError(generation)
          return await nativeMessage(generation, onEvent, config)
        } finally { generation.dispose() }
      },
    })
    if (!writer) jsonResponse(ctx.res, 200, result)
    ctx.outcome = "complete"
  }

  // Any other Messages request, on the model's own transport.
  async function forwardMessages(ctx, { body, request, model, modelInfo, queryString, token }) {
    const { res, nativeTransport } = ctx
    const payload = nativeTransport ? request : buildChatRequest(request, { model, modelInfo, forwardReasoning: config.forwardReasoning })
    const upstream = await send(ctx, nativeTransport ? `/v1/messages${queryString}` : "/chat/completions", payload, token)
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
      ctx.outcome = "complete"
      return
    }
    if (!upstream.response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new ProxyError(502, "Copilot returned a non-SSE payload for a streaming request")
    }
    startStream(ctx, responseHeaders(upstream.response.headers))
    const { writer } = ctx
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
      ctx.outcome = state.error ? "upstream error" : "complete"
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
      ctx.outcome = "complete"
    }
  }

  async function handle(req, res) {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifecycle])
    req.once("aborted", () => controller.abort(abortError("Client aborted request upload")))
    req.on("error", (error) => controller.abort(error))
    res.on("error", (error) => controller.abort(error))
    res.once("close", () => { if (!res.writableFinished) controller.abort(abortError()) })
    // Request state that the route helpers share with the error handling and cleanup below.
    const ctx = { req, res, signal, controller, writer: null, upstream: null, nativeTransport: false, inference: false, outcome: "failed" }
    try {
      signal.throwIfAborted()
      const url = new URL(req.url, "http://localhost")
      const route = url.pathname
      if (route === "/health" || route === "/") {
        healthCheck(ctx, url)
        return
      }
      if (!["/v1/messages", "/v1/messages/count_tokens", "/v1/models"].includes(route)) {
        throw new ProxyError(404, "Not found", "not_found_error")
      }
      if (!authorized(req, key)) throw new ProxyError(401, "A valid local proxy API key is required", "authentication_error")
      const modelsRoute = route === "/v1/models"
      if (req.method !== (modelsRoute ? "GET" : "POST")) {
        throw new ProxyError(405, "Method not allowed", "invalid_request_error", { allow: modelsRoute ? "GET" : "POST" })
      }
      if (modelsRoute) await listModels(ctx)
      else await handleMessages(ctx, url, route === "/v1/messages/count_tokens")
    } catch (error) {
      if (signal.aborted || res.destroyed) {
        if (!res.destroyed) res.destroy()
        return
      }
      if (ctx.inference) logger.error(`Proxy request failed: ${error.status ?? 500} ${error.name}`)
      if (ctx.writer && res.headersSent) {
        ctx.writer.stopPings()
        await ctx.writer.event("error", errorEnvelope(error))
      } else if (!res.headersSent) {
        const status = Number.isInteger(error.status) ? error.status : 500
        const headers = { ...error.headers, ...(!req.complete ? { connection: "close" } : {}) }
        if (ctx.nativeTransport && error.rawBody !== undefined) {
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
      ctx.upstream?.dispose()
      if (ctx.writer) await ctx.writer.close()
      if (!res.destroyed && !res.writableEnded) res.end()
      controller.abort(abortError("Request finished"))
      if (ctx.inference) logger.log(`  <- ${ctx.outcome}`)
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
