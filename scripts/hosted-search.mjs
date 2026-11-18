import { domainToASCII } from "node:url"
import { ProxyError } from "./runtime.mjs"

// Hosted web search: answer a search-only Messages request with one Copilot
// /responses call that runs OpenAI's server-side web_search tool (as Codex
// does), on a small model such as GPT-6 Luna, instead of two or more Claude
// generations around a proxy-run search.

const MAX_SOURCES_PER_SEARCH = 20
const MIN_OUTPUT_TOKENS = 16
const TEXT_DELTA_CHARS = 2048

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

// Text of a string or an array of text blocks; null for any other content.
function textOnly(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (!plainObject(block) || block.type !== "text" || typeof block.text !== "string") return null
    parts.push(block.text)
  }
  return parts.join("\n\n")
}

const forcedChoice = (choice) => choice?.type === "any" || (choice?.type === "tool" && choice.name === "web_search")

// Why hosted search cannot answer this request faithfully, or null when it can.
export function hostedSearchIneligibility(body, settings, config) {
  if (config.webSearchMode !== "hosted") return "disabled by WEB_SEARCH_MODE"
  if (settings.maxUses < 1) return "search is disabled by max_uses"
  // Responses' web_search can restrict to domains but cannot exclude them.
  if (settings.blockedDomains.length) return "blocked_domains require provider search"
  if (!Array.isArray(body.tools) || body.tools.length !== 1) return "the request also declares client tools"
  if (body.tool_choice?.type === "none") return "tool_choice is none"
  if (!(body.max_tokens >= MIN_OUTPUT_TOKENS)) return "max_tokens is below the hosted search minimum"
  if (body.system !== undefined && textOnly(body.system) === null) return "the system prompt has non-text content"
  if (body.messages.some((message) => textOnly(message.content) === null)) return "the conversation has non-text content"
  return null
}

export function buildHostedSearchRequest(body, settings, config, modelInfo) {
  const limit = modelInfo?.capabilities?.limits?.max_output_tokens
  const instructions = body.system === undefined ? "" : textOnly(body.system)
  return {
    model: modelInfo.id,
    ...(instructions.trim() ? { instructions } : {}),
    input: body.messages.map((message) => ({
      role: message.role === "system" ? "developer" : message.role,
      content: textOnly(message.content),
    })),
    tools: [{
      type: "web_search", search_context_size: config.webSearchContextSize,
      ...(settings.allowedDomains.length ? { filters: { allowed_domains: settings.allowedDomains } } : {}),
    }],
    tool_choice: forcedChoice(body.tool_choice) ? "required" : "auto",
    max_tool_calls: settings.maxUses,
    include: ["web_search_call.action.sources"],
    reasoning: { effort: config.webSearchReasoningEffort },
    max_output_tokens: Number.isSafeInteger(limit) && limit > 0 ? Math.min(body.max_tokens, limit) : body.max_tokens,
    store: false,
    stream: false,
  }
}

function httpUrl(value) {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && url.hostname ? url : null
  } catch { return null }
}

// Citation URLs gain utm_source=openai; compare them with sources without it.
function urlKey(url) {
  const copy = new URL(url.href)
  copy.searchParams.delete("utm_source")
  copy.hash = ""
  return copy.href
}

function hostAllowed(url, allowedDomains) {
  if (!allowedDomains.length) return true
  const host = domainToASCII(url.hostname.toLowerCase().replace(/\.$/, ""))
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function usageFrom(usage, searches) {
  const input = count(usage?.input_tokens)
  const output = count(usage?.output_tokens)
  const cached = usage?.input_tokens_details?.cached_tokens === undefined ? 0 : count(usage.input_tokens_details.cached_tokens)
  const written = usage?.input_tokens_details?.cache_write_tokens === undefined ? 0 : count(usage.input_tokens_details.cache_write_tokens)
  if (input === null || output === null || cached === null || written === null || cached + written > input) {
    throw new ProxyError(502, "Copilot hosted search returned invalid usage")
  }
  return {
    input_tokens: input - cached - written, output_tokens: output,
    cache_read_input_tokens: cached, cache_creation_input_tokens: written,
    server_tool_use: { web_search_requests: searches },
  }
}

// Map a Responses API result onto an Anthropic web search message. Throws a
// 502 ProxyError for anything the caller should not present as an answer.
export function hostedSearchMessage(response, { id, model, settings }) {
  if (!plainObject(response) || !Array.isArray(response.output)) {
    throw new ProxyError(502, "Copilot hosted search returned an invalid Responses payload")
  }
  const truncated = response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
  if (response.status !== "completed" && !truncated) {
    throw new ProxyError(502, "Copilot hosted search did not complete")
  }
  const titles = new Map()
  for (const item of response.output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
        const url = annotation?.type === "url_citation" ? httpUrl(annotation.url) : null
        if (url && typeof annotation.title === "string" && annotation.title.trim() && !titles.has(urlKey(url))) {
          titles.set(urlKey(url), annotation.title.trim())
        }
      }
    }
  }
  const content = []
  let searches = 0
  let refused = false
  for (const item of response.output) {
    if (item?.type === "web_search_call") {
      const action = item.action
      // Page reads (open_page, find_in_page) belong to the preceding search.
      if (!plainObject(action) || action.type !== "search") continue
      const query = [action.query, ...(Array.isArray(action.queries) ? action.queries : [])]
        .find((value) => typeof value === "string" && value.trim())
      if (!query) continue
      searches++
      const toolId = `srvtoolu_${typeof item.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(item.id) ? item.id : `hosted_${searches}`}`
      content.push({ type: "server_tool_use", id: toolId, name: "web_search", input: { query: query.trim() } })
      if (item.status !== "completed") {
        content.push({ type: "web_search_tool_result", tool_use_id: toolId, content: { type: "web_search_tool_result_error", error_code: "unavailable" } })
        continue
      }
      const seen = new Set()
      const results = []
      for (const source of Array.isArray(action.sources) ? action.sources : []) {
        const url = httpUrl(source?.url)
        if (!url || !hostAllowed(url, settings.allowedDomains) || seen.has(urlKey(url))) continue
        seen.add(urlKey(url))
        results.push({ type: "web_search_result", url: source.url, title: titles.get(urlKey(url)) ?? url.hostname, encrypted_content: "", page_age: null })
        if (results.length >= MAX_SOURCES_PER_SEARCH) break
      }
      content.push({ type: "web_search_tool_result", tool_use_id: toolId, content: results })
    } else if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string" && part.text) {
          content.push({ type: "text", text: part.text })
        } else if (part?.type === "refusal" && typeof part.refusal === "string" && part.refusal) {
          refused = true
          content.push({ type: "text", text: part.refusal })
        }
      }
    }
  }
  if (!truncated && !content.some((block) => block.type === "text")) {
    throw new ProxyError(502, "Copilot hosted search returned no answer")
  }
  return {
    id, type: "message", role: "assistant", model, content,
    stop_reason: truncated ? "max_tokens" : refused ? "refusal" : "end_turn", stop_sequence: null,
    usage: usageFrom(response.usage, searches),
  }
}

// Stream a hosted message's content after message_start has been sent.
export async function emitHostedMessage(message, emit) {
  for (const [index, block] of message.content.entries()) {
    if (block.type === "server_tool_use") {
      await emit("content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } })
      await emit("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })
    } else if (block.type === "text") {
      await emit("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } })
      for (let offset = 0; offset < block.text.length; offset += TEXT_DELTA_CHARS) {
        await emit("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(offset, offset + TEXT_DELTA_CHARS) } })
      }
    } else {
      await emit("content_block_start", { type: "content_block_start", index, content_block: block })
    }
    await emit("content_block_stop", { type: "content_block_stop", index })
  }
  await emit("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage })
  await emit("message_stop", { type: "message_stop" })
}
