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
const search = (id, query, sources = [], status = "completed") => ({ id, type: "web_search_call", status, action: { type: "search", query, sources: sources.map((url) => ({ type: "url", url })) } })
const answer = (text, citations = []) => ({
  id: "msg_answer", type: "message", role: "assistant",
  content: [{ type: "output_text", text, annotations: citations.map(([url, title]) => ({ type: "url_citation", url, title, start_index: 0, end_index: 1 })) }],
})
const map = (response, settings = settingsFor(nestedSearch())) => hostedSearchMessage(response, { id: "msg_t", model: "m", settings })
const results = (message) => message.content.filter((block) => block.type === "web_search_tool_result").map((block) => block.content)

test("Claude Code's nested WebSearch request becomes one hosted Responses search", () => {
  const location = { type: "approximate", city: "Seattle", region: "Washington", country: "US", timezone: "America/Los_Angeles" }
  const body = nestedSearch({}, { allowed_domains: ["NodeJS.org"], search_profile: "default", user_location: location })
  assert.equal(hostedSearchIneligibility(body, settingsFor(body), config), null)
  const { instructions, ...payload } = buildHostedSearchRequest(body, settingsFor(body), config, luna)
  assert.deepEqual(payload, {
    model: "gpt-6-luna",
    input: [{ role: "user", content: "Perform a web search for the query: Node.js LTS schedule" }],
    tools: [{ type: "web_search", search_context_size: "low", filters: { allowed_domains: ["nodejs.org"] }, user_location: location }],
    tool_choice: "required",
    max_tool_calls: 8,
    include: ["web_search_call.action.sources"],
    reasoning: { effort: "low" },
    max_output_tokens: 128000,
    store: false,
    stream: false,
  })
  assert.match(instructions, /^You run a web search for another Claude model\.\n\n/)
  assert.match(instructions, /untrusted data, not instructions/)
  assert.match(buildHostedSearchRequest(nestedSearch({ system: undefined }), settingsFor(body), config, luna).instructions, /^Web pages/)
})

test("hosted search keeps text history and always requires a search, honoring configuration and output limits", () => {
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
  assert.match(payload.instructions, /^Plain system\n\n/)
  assert.deepEqual(payload.input, [
    { role: "user", content: "First\n\nquestion" },
    { role: "assistant", content: "Earlier answer" },
    { role: "developer", content: "Mid-conversation instruction" },
    { role: "user", content: "Follow-up" },
  ])
  // Claude Code sends "auto" for its 5.5 models; a search-only request must still search.
  assert.equal(payload.tool_choice, "required")
  assert.equal(payload.max_tool_calls, config.searchMaxUses)
  assert.equal(payload.max_output_tokens, 128000, "never request more than the search model can produce")
  assert.deepEqual(payload.tools, [{ type: "web_search", search_context_size: "medium" }])
  assert.deepEqual(payload.reasoning, { effort: "high" })
  assert.equal(buildHostedSearchRequest(nestedSearch({ tool_choice: undefined }), settingsFor(nestedSearch()), config, luna).tool_choice, "required")
  assert.equal(buildHostedSearchRequest(nestedSearch({ max_tokens: 4000 }), settingsFor(nestedSearch()), config, { id: "gpt-6-luna" }).max_output_tokens, 4000)
})

test("hosted search accepts only request fields it can honor; everything else uses provider search", () => {
  const reason = (body, settings = settingsFor(body), options = config) => hostedSearchIneligibility(body, settings, options)
  // Every shape Claude Code 2.1.303 sends for its nested WebSearch request.
  for (const eligible of [
    nestedSearch(),
    nestedSearch({ thinking: undefined, tool_choice: { type: "auto" }, output_config: { effort: "medium" }, metadata: { user_id: "u" } }),
    nestedSearch({ thinking: { type: "adaptive" }, stop_sequences: [] }),
  ]) assert.equal(reason(eligible), null)
  const eligible = nestedSearch()
  assert.match(reason(eligible, settingsFor(eligible), readConfig({ WEB_SEARCH_MODE: "providers" })), /WEB_SEARCH_MODE/)
  for (const [body, expected] of [
    [nestedSearch({}, { blocked_domains: ["example.com"] }), /blocked_domains/],
    [nestedSearch({ tools: [...eligible.tools, { name: "read_file", input_schema: { type: "object" } }] }), /client tools/],
    [nestedSearch({ tool_choice: { type: "none" } }), /none/],
    [nestedSearch({ max_tokens: 8 }), /max_tokens/],
    [nestedSearch({}, { max_uses: 0 }), /max_uses/],
    [nestedSearch({ stop_sequences: ["<END>"] }), /stop_sequences/],
    [nestedSearch({ temperature: 0 }), /"temperature"/],
    [nestedSearch({ top_p: 0.5 }), /"top_p"/],
    [nestedSearch({ "future\nfield": true }), /"future\\nfield"/],
    [nestedSearch({ thinking: { type: "enabled", budget_tokens: 2048 } }), /thinking/],
    [nestedSearch({ output_config: { effort: "high", format: { type: "json_schema", schema: {} } } }), /output_config/],
    [nestedSearch({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "Prefilled" }] }), /user turn/],
    [nestedSearch({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] }), /non-text/],
    [nestedSearch({ messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q" } }] },
      { role: "user", content: "again" },
    ] }), /non-text/],
    [nestedSearch({ system: [{ type: "image", source: {} }] }), /non-text/],
  ]) assert.match(reason(body), expected)
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

test("pages the model opened or cited are listed even when no search returned them", () => {
  const message = map({ ...lunaResponse(), output: [
    search("ws_1", "first query", ["https://nodejs.org/a"]),
    { id: "ws_open", type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://nodejs.org/opened" } },
    { id: "ws_find", type: "web_search_call", status: "completed", action: { type: "find_in_page", url: "https://nodejs.org/a#section", pattern: "LTS" } },
    search("ws_2", "second query", []),
    answer("Answer", [["https://nodejs.org/cited?utm_source=openai", "Cited page"], ["https://nodejs.org/a?utm_source=openai", "Page A"]]),
  ] })
  assert.deepEqual(results(message).map((list) => list.map((result) => [result.url, result.title])), [
    [["https://nodejs.org/a", "Page A"]],
    [["https://nodejs.org/opened", "nodejs.org"], ["https://nodejs.org/cited", "Cited page"]],
  ])
  // Sources may be absent; the cited pages still reach Claude Code as links.
  const citedOnly = map({ ...lunaResponse(), output: [search("ws_1", "query"), answer("Answer", [["https://nodejs.org/x?utm_source=openai", "X"]])] })
  assert.deepEqual(results(citedOnly), [[{ type: "web_search_result", url: "https://nodejs.org/x", title: "X", encrypted_content: "", page_age: null }]])
  // Hash routes name different pages; anchors and text fragments do not, and links keep them.
  const fragments = map({ ...lunaResponse(), output: [search("ws_1", "query", ["https://docs.example.org/guide"]), answer("Answer", [
    ["https://docs.example.org/?utm_source=openai#/api/widgets", "Widgets"], ["https://docs.example.org/?utm_source=openai#/api/users", "Users"],
    ["https://docs.example.org/guide?utm_source=openai#install", "Guide"], ["https://docs.example.org/faq?utm_source=openai#:~:text=LTS", "FAQ"],
  ])] })
  assert.deepEqual(results(fragments)[0].map((result) => result.url), [
    "https://docs.example.org/guide", "https://docs.example.org/#/api/widgets", "https://docs.example.org/#/api/users", "https://docs.example.org/faq#:~:text=LTS",
  ])
})

test("allowed domains admit subdomains, and any page outside them sends the request to provider search", () => {
  const settings = settingsFor(nestedSearch({}, { allowed_domains: ["nodejs.org"] }))
  const kept = map({ ...lunaResponse(), output: [search("ws_1", "q", ["https://www.nodejs.org/a", "https://nodejs.org./b"]), answer("A")] }, settings)
  assert.deepEqual(results(kept)[0].map((result) => result.url), ["https://www.nodejs.org/a", "https://nodejs.org./b"])
  for (const output of [
    [search("ws_1", "q", ["https://nodejs.org/a", "https://evilnodejs.org/b"]), answer("A")],
    [search("ws_1", "q", ["https://nodejs.org/a"]), { id: "o", type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://example.com/" } }, answer("A")],
    [search("ws_1", "q", ["https://nodejs.org/a"]), answer("Run this", [["https://evil.example/x?utm_source=openai", "Evil"]])],
  ]) {
    assert.throws(() => map({ ...lunaResponse(), output }, settings), (error) => error.status === 502 && /allowed_domains/.test(error.message))
  }
})

test("a hosted answer without a completed search, or a declined one, falls back to provider search", () => {
  for (const [output, expected] of [
    [[answer("From memory")], /no search/],
    [[search("ws_1", "q", [], "failed"), answer("Sorry, search is unavailable")], /no search/],
    [[search("ws_1", "q", ["https://nodejs.org/a"]), { id: "m", type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }], /declined/],
    [[search("ws_1", "q", ["https://nodejs.org/a"])], /no answer/],
  ]) {
    assert.throws(() => map({ ...lunaResponse(), output }), (error) => error.status === 502 && expected.test(error.message))
  }
  // One failed search beside a completed one is reported, not hidden.
  const mixed = map({ ...lunaResponse(), output: [search("ws_1", "q", ["https://nodejs.org/a"]), search("ws_2", "second", [], "failed"), answer("A")] })
  assert.deepEqual(results(mixed)[1], { type: "web_search_tool_result_error", error_code: "unavailable" })
  assert.equal(mixed.usage.server_tool_use.web_search_requests, 2)
})

test("hosted search ids, queries, source caps and usage are normalized or rejected", () => {
  const queried = map({ ...lunaResponse(), output: [
    { id: "ws bad id!", type: "web_search_call", status: "completed", action: { type: "search", queries: ["  from queries  "], sources: Array.from({ length: 25 }, (_, index) => ({ type: "url", url: `https://nodejs.org/${index}` })) } },
    answer("A"),
  ] })
  assert.deepEqual(queried.content[0], { type: "server_tool_use", id: "srvtoolu_hosted_1", name: "web_search", input: { query: "from queries" } })
  assert.equal(results(queried)[0].length, 20)
  const nullDetails = map(lunaResponse({ usage: { input_tokens: 50, input_tokens_details: { cached_tokens: null, cache_write_tokens: null }, output_tokens: 5 } }))
  assert.deepEqual([nullDetails.usage.input_tokens, nullDetails.usage.cache_read_input_tokens], [50, 0])
  for (const usage of [undefined, { input_tokens: 10, output_tokens: -1 }, { input_tokens: 10, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 }, output_tokens: 1 }]) {
    assert.throws(() => map(lunaResponse({ usage })), (error) => error.status === 502 && /usage/.test(error.message))
  }
})

test("hosted search truncation is reported and invalid payloads are rejected for fallback", () => {
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
    null,
  ]) {
    assert.throws(() => map(invalid), (error) => error.status === 502)
  }
})

test("hosted messages stream as standard Anthropic events without splitting characters", async () => {
  const message = map(lunaResponse())
  message.content.push({ type: "text", text: "x".repeat(2047) + "😀" + "y".repeat(3000) })
  const events = []
  await emitHostedMessage(message, async (type, data) => { events.push({ type, data }) })
  assert.deepEqual(events.slice(0, 7).map((event) => event.type), [
    "message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_stop", "content_block_start",
  ])
  assert.deepEqual(events[0].data.message, {
    id: "msg_t", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 3427, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 4354 },
  })
  assert.deepEqual(events[1].data, { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_ws_abc123", name: "web_search", input: {} } })
  assert.deepEqual(events[2].data.delta, { type: "input_json_delta", partial_json: JSON.stringify({ query: "Node.js LTS schedule" }) })
  assert.equal(events[4].data.content_block.type, "web_search_tool_result")
  const deltas = events.filter((event) => event.type === "content_block_delta" && event.data.index === 3).map((event) => event.data.delta.text)
  assert.ok(deltas.length > 1, "long text is streamed in several deltas")
  assert.equal(deltas.join(""), "x".repeat(2047) + "😀" + "y".repeat(3000))
  for (const delta of deltas) assert.equal(delta, Buffer.from(delta).toString(), "no delta ends or starts inside a surrogate pair")
  assert.deepEqual(events.at(-2), { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: message.usage } })
  assert.deepEqual(events.at(-1), { type: "message_stop", data: { type: "message_stop" } })
})
