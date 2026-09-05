import { createHash } from "node:crypto"
import { createSharedTasks, openResponse, ProxyError } from "./runtime.mjs"

export function mapModel(model) {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2}))?(?:-(?:\d{8}|latest))?$/.exec(model)
  return match ? `claude-${match[1]}-${match[2]}${match[3] ? `.${match[3]}` : ""}` : model
}

export function copilotHeaders(token, config, incoming = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "claude-code-copilot-provider/1.0.0",
    "editor-version": config.editorVersion,
    "copilot-integration-id": config.integrationId,
    "openai-intent": "conversation-edits",
  }
  for (const name of ["anthropic-version", "anthropic-beta"]) {
    if (typeof incoming[name] === "string") headers[name] = incoming[name]
  }
  return headers
}

export function isRoutable(model) {
  return model.policy?.state !== "disabled"
}

export function createModelCatalog({ fetchImpl, baseUrl, config, logger }) {
  const cache = new Map()
  const flights = createSharedTasks()

  async function get(token, signal) {
    const key = createHash("sha256").update(token).digest("hex")
    const cached = cache.get(key)
    const age = cached ? Date.now() - cached.at : Infinity
    if (cached?.models && age < config.modelCacheTtlMs) return cached.models
    if (cached?.error && Date.now() < cached.retryAt) {
      if (cached.models && age < config.modelCacheTtlMs + config.modelCacheMaxStaleMs) return cached.models
      throw cached.error
    }
    return flights.run(key, signal, async (sharedSignal) => {
      let upstream
      try {
        upstream = await openResponse(fetchImpl, `${baseUrl}/models`, {
          method: "GET", headers: copilotHeaders(token, config),
        }, {
          signal: sharedSignal, timeoutMs: config.modelRequestTimeoutMs,
          maxBytes: Math.min(config.maxResponseBytes, 4 * 1024 * 1024), logger,
        })
        if (!upstream.response.ok) {
          const status = upstream.response.status
          throw new ProxyError(status, `Copilot model discovery returned HTTP ${status}`,
            status === 401 ? "authentication_error" : status === 403 ? "permission_error" : "api_error")
        }
        const text = await upstream.text()
        let data
        try { data = JSON.parse(text) } catch { throw new ProxyError(502, "Copilot model catalog is not valid JSON") }
        if (!Array.isArray(data?.data) || data.data.some((model) => !model || typeof model.id !== "string")) {
          throw new ProxyError(502, "Copilot model catalog has an invalid shape")
        }
        const entry = { models: data.data, at: Date.now() }
        cache.delete(key)
        cache.set(key, entry)
        while (cache.size > 4) cache.delete(cache.keys().next().value)
        return entry.models
      } catch (error) {
        sharedSignal.throwIfAborted()
        if (error.status === 401 || error.status === 403) {
          cache.delete(key)
          throw error
        }
        const entry = { ...cached, at: cached?.at ?? 0, error, retryAt: Date.now() + 1000 }
        cache.set(key, entry)
        while (cache.size > 4) cache.delete(cache.keys().next().value)
        if (cached?.models && Date.now() - cached.at < config.modelCacheTtlMs + config.modelCacheMaxStaleMs) {
          logger.warn("Copilot model discovery unavailable; using the bounded cached catalog")
          return cached.models
        }
        throw error
      } finally {
        upstream?.dispose()
      }
    })
  }

  return {
    get,
    async resolve(requested, token, signal) {
      let models
      try {
        models = await get(token, signal)
      } catch (error) {
        signal.throwIfAborted()
        if (config.transport === "auto" || error.status === 401 || error.status === 403) throw error
        logger.warn("Model discovery unavailable; using the explicitly configured transport")
        return { model: mapModel(requested), modelInfo: {}, transport: config.transport }
      }
      const normalized = mapModel(requested)
      const modelInfo = models.find((model) => model.id === requested) ?? models.find((model) => model.id === normalized)
      if (modelInfo && !isRoutable(modelInfo)) {
        throw new ProxyError(403, `Copilot reports model ${modelInfo.id} as disabled`, "permission_error")
      }
      if (config.transport !== "auto") return { model: modelInfo?.id ?? normalized, modelInfo: modelInfo ?? {}, transport: config.transport }
      if (!modelInfo) {
        throw new ProxyError(400, `Model ${normalized} is not in the current Copilot catalog. Choose an enabled model from /v1/models; versions are not substituted.`, "invalid_request_error")
      }
      const endpoints = modelInfo.supported_endpoints ?? []
      if (endpoints.includes("/v1/messages")) return { model: modelInfo.id, modelInfo, transport: "messages" }
      if (endpoints.includes("/chat/completions")) return { model: modelInfo.id, modelInfo, transport: "chat" }
      throw new ProxyError(400, `Model ${modelInfo.id} does not advertise a supported inference endpoint; select a transport explicitly if required`, "invalid_request_error")
    },
    close() { flights.close(); cache.clear() },
  }
}
