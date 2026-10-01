import { createHash } from "node:crypto"
import { createSharedTasks, openResponse, ProxyError } from "./runtime.mjs"

export function mapModel(model) {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2}))?(?:-(?:\d{8}|latest))?$/.exec(model)
  return match ? `claude-${match[1]}-${match[2]}${match[3] ? `.${match[3]}` : ""}` : model
}

// The Claude API spelling of a Copilot catalog ID (claude-opus-4.7 ->
// claude-opus-4-7). Claude Code recognizes only this spelling: it treats the
// dotted form as an unknown model, assuming a 200K window instead of 1M and an
// older request shape. mapModel turns it back into the same catalog ID.
export function claudeApiId(id) {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)\.(\d{1,2})$/.exec(id)
  return match ? `claude-${match[1]}-${match[2]}-${match[3]}` : id
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
    const value = name === "anthropic-beta" ? forwardedBeta(incoming[name]) : incoming[name]
    if (typeof value === "string") headers[name] = value
  }
  return headers
}

export function isRoutable(model) {
  return model.policy?.state !== "disabled"
}

// Copilot's adaptive-only models (catalog: adaptive_thinking with no manual
// thinking budget, e.g. Opus 5.5 and Sonnet 5.5) reject a forced tool_choice
// ("type tool and any are not supported for this model") and thinking.type
// "disabled" with HTTP 400 on both endpoints. Claude Code sends both whenever it
// does not recognize the model ID as a 5.5 model, including for WebSearch's
// nested request. Downgrade the choice to auto and omit disabled thinking, which
// matches what Claude Code itself sends for these models.
function adaptiveOnly(modelInfo) {
  const supports = modelInfo?.capabilities?.supports
  return supports?.adaptive_thinking === true && supports.max_thinking_budget === undefined
}

export function adaptToModel(body, modelInfo) {
  if (!adaptiveOnly(modelInfo)) return body
  const forced = ["tool", "any"].includes(body.tool_choice?.type)
  const disabled = body.thinking?.type === "disabled"
  if (!forced && !disabled) return body
  const { thinking, tool_choice: choice, ...rest } = body
  const result = { ...rest }
  if (!disabled && Object.hasOwn(body, "thinking")) result.thinking = thinking
  if (choice !== undefined) {
    const { name, ...options } = choice
    result.tool_choice = forced ? { ...options, type: "auto" } : choice
  }
  return result
}

// Claude Code's auto mode asks for server-side classifier review with a
// top-level `safeguards` field and the dangerous-tool-use beta. Copilot rejects
// the field ("safeguards: Extra inputs are not permitted") and cannot produce
// verdicts, so forwarding it only costs a failed request before Claude Code
// retries without it. Dropping both makes Claude Code use its local classifier.
const SAFEGUARDS_BETA = /^dangerous-tool-use-/

export function withoutSafeguards(body) {
  if (!Object.hasOwn(body, "safeguards")) return body
  const { safeguards, ...rest } = body
  return rest
}

export function forwardedBeta(value) {
  if (typeof value !== "string") return undefined
  const kept = value.split(",").map((beta) => beta.trim()).filter((beta) => beta && !SAFEGUARDS_BETA.test(beta))
  return kept.length ? kept.join(",") : undefined
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
