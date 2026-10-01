import { copilotHeaders } from "./models.mjs"
import { performance } from "node:perf_hooks"
import { createAdmissionGate, openResponse, parseRetryAfterMs, ProxyError, sleep } from "./runtime.mjs"

const retryable = new Set([429, 500, 502, 503, 504])
const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "content-length", "content-encoding",
])

export function responseHeaders(headers) {
  const blocked = new Set(hopByHop)
  for (const name of (headers.get("connection") ?? "").split(",")) blocked.add(name.trim().toLowerCase())
  return Object.fromEntries([...headers].filter(([name]) => !blocked.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie"))
}

export function errorType(status) {
  if (status === 400 || status === 422) return "invalid_request_error"
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 413) return "request_too_large"
  if (status === 429) return "rate_limit_error"
  if (status === 503 || status === 529) return "overloaded_error"
  return "api_error"
}

export function errorEnvelope(error) {
  if (error.envelope) return error.envelope
  return { type: "error", error: { type: error.type ?? errorType(error.status), message: error.message } }
}

export async function upstreamError(upstream) {
  const { response } = upstream
  const rawBody = await upstream.text()
  let source
  try { source = JSON.parse(rawBody) } catch { source = null }
  const type = source?.error?.type ?? errorType(response.status)
  const message = typeof source?.error?.message === "string" ? source.error.message
    : typeof source?.message === "string" ? source.message
    : rawBody.trim() || `Copilot returned HTTP ${response.status}`
  const error = new ProxyError(response.status, message, type, responseHeaders(response.headers))
  error.rawBody = rawBody
  error.envelope = source?.type === "error" && source?.error?.type
    ? source
    : { type: "error", error: { ...(source?.error && typeof source.error === "object" ? source.error : {}), type, message } }
  if (source?.request_id) error.envelope.request_id = source.request_id
  return error
}

export function createUpstreamClient({ fetchImpl, baseUrl, config, logger }) {
  const gate = createAdmissionGate({
    limit: config.maxConcurrentRequests,
    maxQueued: config.maxQueuedRequests,
    maxQueueBytes: config.maxQueueBytes,
    queueTimeoutMs: config.queueTimeoutMs,
    minIntervalMs: config.minRequestIntervalMs,
  })
  return {
    async request(path, body, { token, headers: incoming, signal }) {
      const serialized = JSON.stringify(body)
      const bytes = Buffer.byteLength(serialized)
      const deadline = performance.now() + config.retryBudgetMs
      let retryHeaders = {}
      const budgetError = () => new ProxyError(504, "Copilot retry budget expired before another request could be sent", "api_error", retryHeaders)
      async function acquire(attempt) {
        if (attempt === 0) return gate.acquire({ signal, bytes })
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw budgetError()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(budgetError()), Math.ceil(remaining))
        try {
          return await gate.acquire({
            bytes, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          })
        } finally { clearTimeout(timer) }
      }
      const headers = copilotHeaders(token, config, incoming)
      if (serialized.includes('"type":"image"') || serialized.includes('"type":"image_url"')) {
        headers["copilot-vision-request"] = "true"
      }
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        const release = await acquire(attempt)
        let upstream
        try {
          const dispatch = (url, init) => {
            if (attempt > 0 && performance.now() >= deadline) throw budgetError()
            return fetchImpl(url, init)
          }
          upstream = await openResponse(dispatch, `${baseUrl}${path}`, {
            method: "POST", headers, body: serialized,
          }, {
            signal, timeoutMs: config.requestTimeoutMs, maxBytes: config.maxResponseBytes, logger,
          })
        } catch (error) {
          release()
          throw error
        }
        let disposed = false
        const dispose = () => {
          if (disposed) return
          disposed = true
          upstream.dispose()
          release()
        }
        const { response } = upstream
        const hint = parseRetryAfterMs(response.headers.get("retry-after"))
        if ((response.status === 429 || response.status === 503) && hint !== null) gate.cooldown(hint)
        const delay = hint ?? Math.floor(Math.min(1000 * 2 ** attempt, 8000) * (0.5 + Math.random() * 0.5))
        if (!retryable.has(response.status) || attempt === config.maxRetries || performance.now() + delay > deadline) {
          return { ...upstream, dispose }
        }
        retryHeaders = responseHeaders(response.headers)
        dispose()
        logger.warn(`Copilot HTTP ${response.status}; retry ${attempt + 1}/${config.maxRetries} in ${delay}ms`)
        await sleep(delay, signal)
      }
      throw new ProxyError(502, "Copilot retry budget exhausted")
    },
    close() { gate.close() },
  }
}
