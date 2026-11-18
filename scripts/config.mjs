// Search providers that WEBSEARCH_PROVIDER can move to the front of the chain.
export const PREFERRED_SEARCH_PROVIDERS = Object.freeze(["github", "exa", "parallel"])

const numbers = {
  port: ["COPILOT_PROXY_PORT", 18080, 0, 65535],
  maxBodyBytes: ["COPILOT_MAX_BODY_BYTES", 32 * 1024 * 1024, 1],
  maxResponseBytes: ["COPILOT_MAX_RESPONSE_BYTES", 64 * 1024 * 1024, 1],
  maxEventBytes: ["COPILOT_MAX_SSE_EVENT_BYTES", 8 * 1024 * 1024, 1],
  requestTimeoutMs: ["COPILOT_REQUEST_TIMEOUT_MS", 120000, 1],
  maxRetries: ["COPILOT_MAX_RETRIES", 3, 0, 20],
  retryBudgetMs: ["COPILOT_RETRY_BUDGET_MS", 30000, 0],
  minRequestIntervalMs: ["COPILOT_MIN_REQUEST_INTERVAL_MS", 0, 0],
  maxConcurrentRequests: ["COPILOT_MAX_CONCURRENT_REQUESTS", 0, 0],
  maxQueuedRequests: ["COPILOT_MAX_QUEUED_REQUESTS", 64, 0],
  maxQueueBytes: ["COPILOT_MAX_QUEUE_BYTES", 64 * 1024 * 1024, 0],
  queueTimeoutMs: ["COPILOT_QUEUE_TIMEOUT_MS", 30000, 1],
  modelCacheTtlMs: ["COPILOT_MODEL_CACHE_TTL_MS", 300000, 1],
  modelCacheMaxStaleMs: ["COPILOT_MODEL_CACHE_MAX_STALE_MS", 3600000, 0],
  modelRequestTimeoutMs: ["COPILOT_MODEL_REQUEST_TIMEOUT_MS", 3000, 1],
  heartbeatMs: ["COPILOT_HEARTBEAT_INTERVAL_MS", 15000, 0],
  searchMaxResults: ["WEB_SEARCH_MAX_RESULTS", 5, 1, 100],
  searchMaxUses: ["WEB_SEARCH_MAX_USES_CAP", 10, 1, 100],
  searchTimeoutMs: ["WEB_SEARCH_TIMEOUT_MS", 25000, 1],
  searchTotalTimeoutMs: ["WEB_SEARCH_TOTAL_TIMEOUT_MS", 60000, 1],
  searchMaxResponseBytes: ["WEB_SEARCH_MAX_RESPONSE_BYTES", 2 * 1024 * 1024, 1],
  maxConcurrentSearches: ["WEB_SEARCH_MAX_CONCURRENT", 2, 1],
  searchCacheTtlMs: ["WEB_SEARCH_CACHE_TTL_MS", 300000, 0],
  searchCacheMaxEntries: ["WEB_SEARCH_CACHE_MAX_ENTRIES", 500, 0],
  searchCacheMaxBytes: ["WEB_SEARCH_CACHE_MAX_BYTES", 16 * 1024 * 1024, 0],
  searchMaxQueryBytes: ["WEB_SEARCH_MAX_QUERY_BYTES", 8192, 1],
}

const strings = {
  host: ["COPILOT_PROXY_HOST", "127.0.0.1"],
  transport: ["COPILOT_TRANSPORT", "auto"],
  editorVersion: ["COPILOT_EDITOR_VERSION", "vscode/1.99.0"],
  integrationId: ["COPILOT_INTEGRATION_ID", "vscode-chat"],
  websearchProvider: ["WEBSEARCH_PROVIDER", ""],
  braveApiKey: ["BRAVE_API_KEY", ""],
  serperApiKey: ["SERPER_API_KEY", ""],
  exaApiKey: ["EXA_API_KEY", ""],
  parallelApiKey: ["PARALLEL_API_KEY", ""],
  webSearchMode: ["WEB_SEARCH_MODE", "hosted"],
  webSearchModel: ["WEB_SEARCH_MODEL", "gpt-6-luna"],
  webSearchContextSize: ["WEB_SEARCH_CONTEXT_SIZE", "low"],
  webSearchReasoningEffort: ["WEB_SEARCH_REASONING_EFFORT", "low"],
}

export function readConfig(env = process.env, overrides = {}) {
  const config = {}
  for (const [property, [name, fallback, min, max = 2147483647]] of Object.entries(numbers)) {
    const value = overrides[property] ?? (env[name] === undefined || env[name] === "" ? fallback : Number(env[name]))
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}`)
    }
    config[property] = value
  }
  for (const [property, [name, fallback]] of Object.entries(strings)) {
    const value = overrides[property] ?? env[name] ?? fallback
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error(`${name} must be a single-line string`)
    config[property] = value
  }
  for (const [property, name, fallback] of [
    ["forwardReasoning", "COPILOT_FORWARD_REASONING", true],
    ["logSearchQueries", "COPILOT_LOG_SEARCH_QUERIES", false],
  ]) {
    const value = overrides[property] ?? env[name] ?? fallback
    if (![true, false, "0", "1"].includes(value)) throw new Error(`${name} must be 0 or 1`)
    config[property] = value === true || value === "1"
  }
  if (!config.host.trim()) throw new Error("COPILOT_PROXY_HOST must not be empty")
  if (!["auto", "messages", "chat"].includes(config.transport)) {
    throw new Error("COPILOT_TRANSPORT must be auto, messages, or chat")
  }
  if (!["", ...PREFERRED_SEARCH_PROVIDERS].includes(config.websearchProvider)) {
    throw new Error("WEBSEARCH_PROVIDER must be github, exa, parallel, or empty")
  }
  if (!["hosted", "providers"].includes(config.webSearchMode)) {
    throw new Error("WEB_SEARCH_MODE must be hosted or providers")
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(config.webSearchModel)) {
    throw new Error("WEB_SEARCH_MODEL must be a Copilot model ID")
  }
  if (!["low", "medium", "high"].includes(config.webSearchContextSize)) {
    throw new Error("WEB_SEARCH_CONTEXT_SIZE must be low, medium, or high")
  }
  if (!["low", "medium", "high"].includes(config.webSearchReasoningEffort)) {
    throw new Error("WEB_SEARCH_REASONING_EFFORT must be low, medium, or high")
  }
  for (const property of Object.keys(overrides)) {
    if (!(property in config)) throw new Error(`Unknown proxy configuration: ${property}`)
  }
  return Object.freeze(config)
}
