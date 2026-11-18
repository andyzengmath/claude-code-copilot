import assert from "node:assert/strict"
import test from "node:test"
import { readConfig } from "./config.mjs"
import { buildHostedSearchRequest, emitHostedMessage, hostedSearchIneligibility, hostedSearchMessage } from "./hosted-search.mjs"
import { extractWebSearchConfig } from "./search.mjs"

const config = readConfig({})
const luna = { id: "gpt-6-luna", supported_endpoints: ["/responses", "ws:/responses"], capabilities: { limits: { max_output_tokens: 128000 } } }

// Shape of Claude Code 2.1.303's nested WebSearch request.
function nestedSearch(overrides = {}, tool = {}) {
  return {
    model: "claude-opus-5-5", max_tokens: 128000, stream: true,
    system: [{ type: "text", text: "You run a web search for another Claude model.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "Perform a web search for the query: Node.js LTS schedule" }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, ...tool }],
    tool_choice: { type: "tool", name: "web_search" },
    thinking: { type: "disabled" },
    ...overrides,
  }
}
const settingsFor = (body) => extractWebSearchConfig(body.tools, config)

// Response shape captured from Copilot /responses (gpt-6-luna, hosted web_search).
function lunaResponse(overrides = {}) {
  return {
    id: "resp_fixture", object: "response", status: "completed", model: "gpt-6-luna",
    output: [
      { id: "rs_1", type: "reasoning", summary: [] },
      {
        id: "ws_abc123", type: "web_search_call", status: "completed",
        action: {
          type: "search", query: "Node.js LTS schedule", queries: ["Node.js LTS schedule"],
          sources: [
            { type: "url", url: "https://nodejs.org/en/about/previous-releases" },
            { type: "url", url: "https://github.com/nodejs/Release/blob/main/README.md?plain=1" },
            { type: "url", url: "https://nodejs.org/en/about/previous-releases" },
            { type: "url", url: "javascript:alert(1)" },
          ],
        },
      },
      {
        id: "msg_1", type: "message", role: "assistant", status: "completed",
        content: [{
          type: "output_text", text: "Node.js 26 is the active LTS line ([nodejs.org](https://nodejs.org/en/about/previous-releases?utm_source=openai)).",
          annotations: [{
            type: "url_citation", start_index: 35, end_index: 120, title: "Node.js — Node.js Releases",
            url: "https://nodejs.org/en/about/previous-releases?utm_source=openai",
          }],
        }],
      },
    ],
    usage: {
      input_tokens: 8781, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 4354 },
      output_tokens: 153, output_tokens_details: { reasoning_tokens: 31 }, total_tokens: 8934,
    },
    ...overrides,
  }
}

test("Claude Code's nested WebSearch request becomes one hosted Responses search", () => {
  const body = nestedSearch({}, { allowed_domains: ["NodeJS.org"], search_profile: "default" })
  assert.equal(hostedSearchIneligibility(body, settingsFor(body), config), null)
  assert.deepEqual(buildHostedSearchRequest(body, settingsFor(body), config, luna), {
    model: "gpt-6-luna",
    instructions: "You run a web search for another Claude model.",
    input: [{ role: "user", content: "Perform a web search for the query: Node.js LTS schedule" }],
    tools: [{ type: "web_search", search_context_size: "low", filters: { allowed_domains: ["nodejs.org"] } }],
    tool_choice: "required",
    max_tool_calls: 8,
    include: ["web_search_call.action.sources"],
    reasoning: { effort: "low" },
    max_output_tokens: 128000,
    store: false,
    stream: false,
  })
})

test("hosted search keeps text history, honors automatic choice, configuration and output limits", () => {
  const body = nestedSearch({
    max_tokens: 200000, tool_choice: { type: "auto" }, system: "Plain system",
    messages: [
      { role: "user", content: [{ type: "text", text: "First" }, { type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
      { role: "system", content: "Mid-conversation instruction" },
      { role: "user", content: "Follow-up" },
    ],
  }, { max_uses: 50 })
  const custom = readConfig({ WEB_SEARCH_MODEL: "gpt-6-luna", WEB_SEARCH_CONTEXT_SIZE: "medium", WEB_SEARCH_REASONING_EFFORT: "high" })
  const payload = buildHostedSearchRequest(body, settingsFor(body), custom, luna)
  assert.equal(payload.instructions, "Plain system")
  assert.deepEqual(payload.input, [
    { role: "user", content: "First\n\nquestion" },
    { role: "assistant", content: "Earlier answer" },
    { role: "developer", content: "Mid-conversation instruction" },
    { role: "user", content: "Follow-up" },
  ])
  assert.equal(payload.tool_choice, "auto")
  assert.equal(payload.max_tool_calls, config.searchMaxUses)
  assert.equal(payload.max_output_tokens, 128000, "never request more than the search model can produce")
  assert.deepEqual(payload.tools, [{ type: "web_search", search_context_size: "medium" }])
  assert.deepEqual(payload.reasoning, { effort: "high" })
  assert.equal(buildHostedSearchRequest(nestedSearch({ tool_choice: { type: "any" } }), settingsFor(nestedSearch()), config, luna).tool_choice, "required")
  assert.equal(buildHostedSearchRequest(nestedSearch({ max_tokens: 4000 }), settingsFor(nestedSearch()), config, { id: "gpt-6-luna" }).max_output_tokens, 4000)
})

test("requests that hosted search cannot represent faithfully use provider search", () => {
  const eligible = nestedSearch()
  const reason = (body, settings = settingsFor(body), options = config) => hostedSearchIneligibility(body, settings, options)
  assert.match(reason(eligible, settingsFor(eligible), readConfig({ WEB_SEARCH_MODE: "providers" })), /WEB_SEARCH_MODE/)
  assert.match(reason(nestedSearch({}, { blocked_domains: ["example.com"] })), /blocked_domains/)
  assert.match(reason(nestedSearch({ tools: [...eligible.tools, { name: "read_file", input_schema: { type: "object" } }] })), /client tools/)
  assert.match(reason(nestedSearch({ tool_choice: { type: "none" } })), /none/)
  assert.match(reason(nestedSearch({ max_tokens: 8 })), /max_tokens/)
  assert.match(reason(nestedSearch({}, { max_uses: 0 })), /max_uses/)
  assert.match(reason(nestedSearch({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] })), /non-text/)
  assert.match(reason(nestedSearch({ messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q" } }] },
  ] })), /non-text/)
  assert.match(reason(nestedSearch({ system: [{ type: "image", source: {} }] })), /non-text/)
})

test("hosted results map to server_tool_use, web_search_tool_result and text blocks", () => {
  const body = nestedSearch()
  const message = hostedSearchMessage(lunaResponse(), { id: "msg_hosted", model: "claude-opus-5.5", settings: settingsFor(body) })
  assert.deepEqual(message, {
    id: "msg_hosted", type: "message", role: "assistant", model: "claude-opus-5.5",
    content: [
      { type: "server_tool_use", id: "srvtoolu_ws_abc123", name: "web_search", input: { query: "Node.js LTS schedule" } },
      {
        type: "web_search_tool_result", tool_use_id: "srvtoolu_ws_abc123", content: [
          { type: "web_search_result", url: "https://nodejs.org/en/about/previous-releases", title: "Node.js — Node.js Releases", encrypted_content: "", page_age: null },
          { type: "web_search_result", url: "https://github.com/nodejs/Release/blob/main/README.md?plain=1", title: "github.com", encrypted_content: "", page_age: null },
        ],
      },
      { type: "text", text: "Node.js 26 is the active LTS line ([nodejs.org](https://nodejs.org/en/about/previous-releases?utm_source=openai))." },
    ],
    stop_reason: "end_turn", stop_sequence: null,
    usage: {
      input_tokens: 3427, output_tokens: 153, cache_read_input_tokens: 1000, cache_creation_input_tokens: 4354,
      server_tool_use: { web_search_requests: 1 },
    },
  })
})

test("hosted results enforce allowed domains, report failed searches and skip page reads", () => {
  const body = nestedSearch({}, { allowed_domains: ["nodejs.org"] })
  const response = lunaResponse()
  response.output.splice(2, 0,
    { id: "ws_open", type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://nodejs.org/en" } },
    { id: "ws_failed", type: "web_search_call", status: "failed", action: { type: "search", query: "second query" } },
  )
  const message = hostedSearchMessage(response, { id: "msg_x", model: "m", settings: settingsFor(body) })
  assert.deepEqual(message.content.filter((block) => block.type === "server_tool_use").map((block) => block.input.query), ["Node.js LTS schedule", "second query"])
  const [allowed, failed] = message.content.filter((block) => block.type === "web_search_tool_result")
  assert.deepEqual(allowed.content.map((result) => result.url), ["https://nodejs.org/en/about/previous-releases"])
  assert.deepEqual(failed.content, { type: "web_search_tool_result_error", error_code: "unavailable" })
  assert.equal(message.usage.server_tool_use.web_search_requests, 2)
})

test("hosted search truncation is reported and invalid payloads are rejected for fallback", () => {
  const settings = settingsFor(nestedSearch())
  const map = (response) => hostedSearchMessage(response, { id: "msg_t", model: "m", settings })
  const truncated = map(lunaResponse({
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ id: "ws_partial", type: "web_search_call", status: "incomplete", action: {} }],
    usage: { input_tokens: 4455, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 16 },
  }))
  assert.equal(truncated.stop_reason, "max_tokens")
  assert.deepEqual(truncated.content, [])
  assert.equal(truncated.usage.output_tokens, 16)
  for (const invalid of [
    lunaResponse({ status: "failed" }),
    lunaResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" } }),
    lunaResponse({ output: [] }),
    lunaResponse({ output: "not a list" }),
    lunaResponse({ usage: undefined }),
    lunaResponse({ usage: { input_tokens: 10, output_tokens: -1 } }),
    null,
  ]) {
    assert.throws(() => map(invalid), (error) => error.status === 502)
  }
})

test("hosted messages stream as standard Anthropic content events after message_start", async () => {
  const message = hostedSearchMessage(lunaResponse(), { id: "msg_s", model: "m", settings: settingsFor(nestedSearch()) })
  message.content.push({ type: "text", text: "x".repeat(5000) })
  const events = []
  await emitHostedMessage(message, async (type, data) => { events.push({ type, data }) })
  assert.deepEqual(events.slice(0, 6).map((event) => event.type), [
    "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_stop", "content_block_start",
  ])
  assert.deepEqual(events[0].data, { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_ws_abc123", name: "web_search", input: {} } })
  assert.deepEqual(events[1].data.delta, { type: "input_json_delta", partial_json: JSON.stringify({ query: "Node.js LTS schedule" }) })
  assert.equal(events[3].data.content_block.type, "web_search_tool_result")
  const longText = events.filter((event) => event.type === "content_block_delta" && event.data.index === 3)
  assert.ok(longText.length > 1, "long text is streamed in several deltas")
  assert.equal(longText.map((event) => event.data.delta.text).join(""), "x".repeat(5000))
  assert.deepEqual(events.at(-2), { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: message.usage } })
  assert.deepEqual(events.at(-1), { type: "message_stop", data: { type: "message_stop" } })
})
