const EXA_URL = "https://mcp.exa.ai/mcp"
const PARALLEL_URL = "https://search.parallel.ai/mcp"
const USER_AGENT = "claude-code-copilot-provider/1.0.0"

export class WebSearchError extends Error {
  constructor(message, errorCode = "unavailable") {
    super(message)
    this.name = "WebSearchError"
    this.errorCode = errorCode
  }
}

// Only these locally authored messages may appear in logs. Never include
// upstream error messages, response bodies, queries, URLs or credentials.
class ProviderFailure extends Error {}

function malformed() {
  return new ProviderFailure("malformed provider response")
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { throw malformed() }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function httpUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return null
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null
    return value
  } catch { return null }
}

function result(url, title, snippet, age = null) {
  if (!httpUrl(url)) return null
  return {
    type: "web_search_result",
    url,
    title: typeof title === "string" ? title : "",
    encrypted_content: Buffer.from(typeof snippet === "string" ? snippet : "").toString("base64"),
    page_age: typeof age === "string" ? age : null,
  }
}

function validResults(items, convert, maxResults) {
  if (!Array.isArray(items)) throw malformed()
  const results = items.map((item) => isObject(item) ? convert(item) : null).filter(Boolean)
  // Filtering unsafe/missing URLs is not evidence of a successful empty search.
  if (items.length && !results.length) throw malformed()
  return results.slice(0, maxResults)
}

function selectProvider(query, config) {
  if (config.websearchProvider === "exa" || config.websearchProvider === "parallel") {
    return config.websearchProvider
  }
  if (config.parallelApiKey && !config.exaApiKey) return "parallel"
  if (config.exaApiKey && !config.parallelApiKey) return "exa"
  let hash = 0
  for (let i = 0; i < query.length; i++) hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0
  return Math.abs(hash) % 2 === 0 ? "exa" : "parallel"
}

// One deadline covers both headers and the entire decoded response stream.
// Race explicitly: injected fetch/read implementations need not honor abort.
async function requestText(fetchImpl, url, options, config, signal) {
  signal?.throwIfAborted()
  const controller = new AbortController()
  let body
  let reader
  let cancelled = false
  const cancelBody = () => {
    if (!body || cancelled) return
    cancelled = true
    try {
      // A broken/stalled cancel must not delay cancellation or fallback.
      Promise.resolve(reader ? reader.cancel(controller.signal.reason) : body.cancel(controller.signal.reason)).catch(() => {})
    } catch { /* best effort; abort also reaches native fetch */ }
    finally {
      try { reader?.releaseLock() } catch { /* noncompliant injected readers */ }
    }
  }
  let rejectAbort
  const interrupted = new Promise((_, reject) => { rejectAbort = reject })
  const onAbort = () => {
    cancelBody()
    rejectAbort(controller.signal.reason)
  }
  const onCallerAbort = () => controller.abort(signal.reason)
  controller.signal.addEventListener("abort", onAbort, { once: true })
  signal?.addEventListener("abort", onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new ProviderFailure("request timed out"))
  }, config.searchTimeoutMs)

  const work = async () => {
    const response = await fetchImpl(url, { ...options, redirect: "error", signal: controller.signal })
    body = response?.body
    if (controller.signal.aborted) {
      cancelBody() // A fetch that resolves after the race lost still owns a body.
      throw controller.signal.reason
    }
    if (response?.redirected || (response?.status >= 300 && response?.status < 400)) {
      throw new ProviderFailure("redirect refused")
    }
    if (!response?.ok) {
      throw new ProviderFailure(Number.isInteger(response?.status) ? `HTTP ${response.status}` : "invalid HTTP response")
    }
    if (Number(response.headers?.get("content-length")) > config.searchMaxResponseBytes) {
      throw new ProviderFailure("response exceeds byte limit")
    }
    if (!body) return ""
    reader = body.getReader()
    const chunks = []
    let bytes = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        controller.signal.throwIfAborted()
        if (done) break
        if (!(value instanceof Uint8Array)) throw malformed()
        bytes += value.byteLength
        if (bytes > config.searchMaxResponseBytes) throw new ProviderFailure("response exceeds byte limit")
        chunks.push(Buffer.from(value))
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))
    } finally {
      // Keep the reader while failing: cancellation of a locked body must go
      // through its reader, not body.cancel().
      if (!controller.signal.aborted && bytes <= config.searchMaxResponseBytes) {
        reader.releaseLock()
        reader = undefined
      }
    }
  }
  try {
    return await Promise.race([work(), interrupted])
  } catch (error) {
    controller.abort(error)
    cancelBody()
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onCallerAbort)
    controller.signal.removeEventListener("abort", onAbort)
  }
}

function mcpReply(text) {
  const trimmed = text.trim()
  let messages
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    messages = [parseJson(trimmed)]
  } else {
    messages = []
    for (const frame of text.replace(/\r\n?/g, "\n").split("\n\n")) {
      const data = frame.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
      if (!data.trim() || data.trim() === "[DONE]") continue
      messages.push(parseJson(data))
    }
  }
  for (const message of messages) {
    if (!isObject(message) || message.jsonrpc !== "2.0") throw malformed()
    if (message.id !== 1) continue // Ignore notifications/other request IDs.
    if (Object.hasOwn(message, "error")) throw new ProviderFailure("MCP protocol error")
    if (!isObject(message.result) || !Array.isArray(message.result.content)) throw malformed()
    if (message.result.isError === true) throw new ProviderFailure("MCP tool error")
    if (message.result.isError !== undefined && typeof message.result.isError !== "boolean") throw malformed()
    return message.result.content
  }
  throw malformed()
}

function mcpResults(text, maxResults) {
  const content = mcpReply(text)
  const candidates = []
  for (const item of content) {
    if (!isObject(item) || item.type !== "text" || typeof item.text !== "string" || !item.text.trim()) {
      throw malformed()
    }
    const text = item.text.trim()
    if (text.startsWith("{") || text.startsWith("[")) {
      const parsed = parseJson(text)
      if (isObject(parsed) && Object.hasOwn(parsed, "error")) throw new ProviderFailure("MCP tool error")
      if (Array.isArray(parsed)) candidates.push(...parsed)
      else if (isObject(parsed) && Array.isArray(parsed.results)) candidates.push(...parsed.results)
      else if (isObject(parsed) && typeof parsed.url === "string") candidates.push(parsed)
      else throw malformed()
    } else {
      const blocks = text.replace(/\r\n?/g, "\n").split(/\n---+(?:\n|$)/).filter((block) => block.trim())
      for (const block of blocks) {
        const url = block.match(/^URL:[ \t]*(.+)$/m)?.[1].trim()
        if (!url) throw malformed()
        candidates.push({
          url,
          title: block.match(/^Title:[ \t]*(.*)$/m)?.[1].trim() ?? "",
          publishedDate: block.match(/^Published:[ \t]*(.+)$/m)?.[1].trim(),
          content: block.match(/^Highlights:[ \t]*\n([\s\S]*)/m)?.[1].trim() ?? block.trim(),
        })
      }
    }
  }
  return validResults(candidates, (item) => {
    const snippet = [item.content, item.text, item.snippet, item.description]
      .find((value) => typeof value === "string" && value) ??
      (Array.isArray(item.excerpts) ? item.excerpts.filter((value) => typeof value === "string").join("\n") : "")
    return result(item.url, item.title, snippet, item.publishedDate || item.publish_date || item.age)
  }, maxResults)
}

function decodeHtml(text) {
  const entities = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, entity) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()]
    const point = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : "\uFFFD"
  })
}

function plainHtml(text) {
  return decodeHtml(text.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim()
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))?.slice(1).find((value) => value !== undefined) ?? ""
}

function ddgUrl(value) {
  const decoded = decodeHtml(value)
  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded)
    if (["duckduckgo.com", "www.duckduckgo.com", "lite.duckduckgo.com"].includes(url.hostname) &&
        url.pathname === "/l/" && ["http:", "https:"].includes(url.protocol)) {
      return url.searchParams.get("uddg") ?? ""
    }
  } catch { /* The common result validator rejects malformed/relative URLs. */ }
  return decoded
}

function liteResults(html, maxResults) {
  // Detect challenge markup, not words in an ordinary search result/query.
  if (/<(?:form|input|div)[^>]*(?:id|class|action)\s*=\s*["'][^"']*(?:captcha|anomaly|challenge)/i.test(html)) {
    throw new ProviderFailure("CAPTCHA challenge")
  }
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .filter((match) => attribute(match[1], "class").split(/\s+/).includes("result-link"))
  const snippets = [...html.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
    .filter((match) => attribute(match[1], "class").split(/\s+/).includes("result-snippet"))
    .map((match) => plainHtml(match[2]))
  if (!links.length) {
    if (/<(?:div|td)\b[^>]*class\s*=\s*["'][^"']*\bno-results\b/i.test(html)) return []
    throw malformed()
  }
  return validResults(links.map((match, index) => ({
    url: ddgUrl(attribute(match[1], "href")), title: plainHtml(match[2]), snippet: snippets[index] ?? "",
  })), (item) => result(item.url, item.title, item.snippet), maxResults)
}

function instantResults(text, maxResults) {
  const data = parseJson(text)
  if (!isObject(data) || data.error || !Array.isArray(data.RelatedTopics)) throw malformed()
  if ((data.AbstractURL !== undefined && typeof data.AbstractURL !== "string") ||
      (data.AbstractText !== undefined && typeof data.AbstractText !== "string")) throw malformed()
  const candidates = []
  if (data.AbstractURL || data.AbstractText) {
    candidates.push({ url: data.AbstractURL, title: data.Heading, snippet: data.AbstractText })
  }
  const topics = [...data.RelatedTopics].reverse()
  while (topics.length) {
    const topic = topics.pop()
    if (!isObject(topic)) throw malformed()
    if (topic.Topics !== undefined) {
      if (!Array.isArray(topic.Topics)) throw malformed()
      for (let i = topic.Topics.length - 1; i >= 0; i--) topics.push(topic.Topics[i])
    } else {
      candidates.push({
        url: topic.FirstURL, title: typeof topic.Text === "string" ? topic.Text.slice(0, 100) : "",
        snippet: topic.Text,
      })
    }
  }
  return validResults(candidates, (item) => result(item.url, item.title, item.snippet), maxResults)
}

export function createSearchProvider({ fetchImpl = globalThis.fetch, config = {}, logger = console } = {}) {
  const settings = {
    braveApiKey: config.braveApiKey ?? "",
    serperApiKey: config.serperApiKey ?? "",
    exaApiKey: config.exaApiKey ?? "",
    parallelApiKey: config.parallelApiKey ?? "",
    websearchProvider: config.websearchProvider ?? "",
    searchMaxResults: config.searchMaxResults ?? 5,
    searchTimeoutMs: config.searchTimeoutMs ?? 25000,
    searchMaxResponseBytes: config.searchMaxResponseBytes ?? 2097152,
  }
  const maxResults = settings.searchMaxResults
  const request = (url, options, signal) => requestText(fetchImpl, url, options, settings, signal)
  const callMcp = async (url, name, args, headers, signal) => mcpResults(await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }, signal), maxResults)
  const providers = {
    exa: {
      label: "Exa",
      search: (query, signal) => callMcp(
        settings.exaApiKey ? `${EXA_URL}?exaApiKey=${encodeURIComponent(settings.exaApiKey)}` : EXA_URL,
        "web_search_exa",
        { query, numResults: maxResults, type: "auto", livecrawl: "auto" }, {}, signal,
      ),
    },
    parallel: {
      label: "Parallel",
      search: (query, signal) => callMcp(
        PARALLEL_URL, "web_search", { objective: query, search_queries: [query] },
        settings.parallelApiKey ? { Authorization: `Bearer ${settings.parallelApiKey}` } : {}, signal,
      ),
    },
    brave: {
      label: "Brave",
      async search(query, signal) {
        const data = parseJson(await request(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
          { headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": settings.braveApiKey } },
          signal,
        ))
        if (!isObject(data) || data.error || !isObject(data.web)) throw malformed()
        return validResults(data.web.results, (item) => result(item.url, item.title, item.description, item.age), maxResults)
      },
    },
    serper: {
      label: "Serper",
      async search(query, signal) {
        const data = parseJson(await request("https://google.serper.dev/search", {
          method: "POST",
          headers: { "X-API-KEY": settings.serperApiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ q: query, num: maxResults }),
        }, signal))
        if (!isObject(data) || data.error) throw malformed()
        return validResults(data.organic, (item) => result(item.link, item.title, item.snippet), maxResults)
      },
    },
    lite: {
      label: "DDG Lite",
      async search(query, signal) {
        return liteResults(await request("https://lite.duckduckgo.com/lite/", {
          method: "POST",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "text/html", "Accept-Language": "en-US,en;q=0.9",
          },
          body: `q=${encodeURIComponent(query)}&kl=us-en`,
        }, signal), maxResults)
      },
    },
    instant: {
      label: "DDG Instant",
      async search(query, signal) {
        return instantResults(await request(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
          { headers: { "User-Agent": USER_AGENT } }, signal,
        ), maxResults)
      },
    },
  }

  return async function search(query, { signal } = {}) {
    signal?.throwIfAborted()
    const first = selectProvider(query, settings)
    const order = [first, first === "exa" ? "parallel" : "exa",
      ...(settings.braveApiKey ? ["brave"] : []), ...(settings.serperApiKey ? ["serper"] : []),
      "lite", "instant"]
    let succeeded = false
    for (const name of order) {
      signal?.throwIfAborted()
      const provider = providers[name]
      try {
        const results = await provider.search(query, signal)
        signal?.throwIfAborted()
        if (results.length) return results
        succeeded = true
      } catch (error) {
        signal?.throwIfAborted()
        const detail = error instanceof ProviderFailure ? error.message : "request or response read failed"
        logger.warn(`⚠ ${provider.label} search failed: ${detail}`)
      }
    }
    if (succeeded) return []
    throw new WebSearchError("Web search is unavailable: all providers failed; check provider connectivity and configuration.", "unavailable")
  }
}
