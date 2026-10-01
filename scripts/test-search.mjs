import assert from "node:assert/strict"
import { setImmediate as nextTurn } from "node:timers/promises"
import test from "node:test"
import * as search from "./search.mjs"
import { readConfig } from "./config.mjs"

const proxy = { ...search, readConfig }

function exported(name) {
  assert.equal(typeof proxy[name], "function", `production ${name} is required`)
  return proxy[name]
}

const quiet = { log() {}, warn() {}, error() {} }
const result = (url = "https://example.com/page") => ({
  type: "web_search_result", title: "A result", url,
  encrypted_content: Buffer.from("Public fixture snippet").toString("base64"), page_age: null,
})
const tool = (id, name = "web_search", input = { query: "fixture query" }) => ({ type: "tool_use", id, name, input })
const answer = (content, stop = "tool_use") => ({
  id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5",
  content, stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 },
})
const request = (maxUses = 5, extra = {}) => ({
  model: "claude-sonnet-5", max_tokens: 64000, stream: true,
  messages: [{ role: "user", content: "Find the current information" }],
  thinking: { type: "disabled" },
  tools: [{ name: "web_search", type: "web_search_20250305", max_uses: maxUses }],
  tool_choice: { type: "tool", name: "web_search", disable_parallel_tool_use: true },
  ...extra,
})

function searchConfig(overrides = {}) {
  return exported("readConfig")({}, overrides)
}

test("search use cap limits executions and leaves one search-disabled synthesis generation", async () => {
  const run = exported("runWebSearch")
  const config = searchConfig()
  const requests = []
  let searches = 0
  const output = await run({
    request: request(500), config, signal: new AbortController().signal,
    search: async () => { searches++; return [result()] },
    generate: async (body) => {
      requests.push(structuredClone(body))
      return body.tools?.some((item) => item.name === "web_search")
        ? answer([tool(`call_${requests.length}`)])
        : answer([{ type: "text", text: "Final synthesis" }], "end_turn")
    },
  })
  assert.equal(searches, 10)
  assert.equal(requests.length, 11)
  assert.equal(requests.at(-1).tools?.some((item) => item.name === "web_search") ?? false, false)
  assert.deepEqual(requests[0].tool_choice, { type: "tool", name: "web_search", disable_parallel_tool_use: true })
  assert.notEqual(requests[1].tool_choice?.type, "tool")
  assert.equal(requests[0].tools[0].type, undefined)
  assert.deepEqual(requests[0].thinking, { type: "disabled" })
  assert.equal(requests[0].max_tokens, 64000)
  assert.equal(output.content.at(-1).text, "Final synthesis")
  assert.equal(output.usage.input_tokens, 110)
  assert.equal(output.usage.output_tokens, 33)
  assert.equal(output.usage.cache_read_input_tokens, 22)
  assert.equal(output.usage.server_tool_use.web_search_requests, 10)
})

test("every co-emitted search and client tool keeps its id and matching result", async () => {
  const run = exported("runWebSearch")
  let calls = 0
  let searches = 0
  const output = await run({
    request: request(1, {
      tools: [
        { name: "web_search", type: "web_search_20250305", max_uses: 1 },
        { name: "read_file", input_schema: { type: "object" } },
      ],
    }),
    config: searchConfig(), signal: new AbortController().signal,
    search: async () => { searches++; return [result()] },
    generate: async () => {
      calls++
      return answer([tool("search_a"), tool("client_b", "read_file", { path: "a.txt" }), tool("search_c")])
    },
  })
  assert.equal(calls, 1, "do not resume the model without the client's tool result")
  assert.equal(searches, 1)
  assert.equal(output.stop_reason, "tool_use")
  assert.deepEqual(output.content.find((block) => block.type === "tool_use"), tool("client_b", "read_file", { path: "a.txt" }))
  const uses = output.content.filter((block) => block.type === "server_tool_use")
  const results = output.content.filter((block) => block.type === "web_search_tool_result")
  assert.equal(uses.length, 2)
  assert.equal(results.length, 2)
  for (const use of uses) assert.ok(results.find((block) => block.tool_use_id === use.id))
  assert.equal(results.find((block) => !Array.isArray(block.content)).content.error_code, "max_uses_exceeded")
})

test("a failed post-search generation is not rerun as an unsearched answer", async () => {
  const run = exported("runWebSearch")
  let calls = 0
  const failure = Object.assign(new Error("upstream overloaded"), { status: 503, type: "overloaded_error" })
  await assert.rejects(run({
    request: request(), config: searchConfig(), signal: new AbortController().signal,
    search: async () => [result()],
    generate: async () => {
      calls++
      if (calls === 1) return answer([tool("first")])
      throw failure
    },
  }), (error) => error === failure)
  assert.equal(calls, 2)
})

test("search progress and result blocks are emitted before the following generation finishes", async () => {
  const run = exported("runWebSearch")
  const events = []
  let calls = 0
  const output = await run({
    request: request(), config: searchConfig(), signal: new AbortController().signal,
    search: async () => [result()],
    emit: async (type, data) => { events.push({ type, data }) },
    generate: async (body, onEvent) => {
      calls++
      if (calls === 2) {
        assert.ok(events.some((entry) => entry.data.content_block?.type === "web_search_tool_result"))
      }
      const response = calls === 1
        ? answer([tool("search_first")])
        : answer([{ type: "text", text: "partially generated answer" }], "max_tokens")
      for (const [index, block] of response.content.entries()) {
        await onEvent({ type: "content_block_start", index, content_block: block })
        await onEvent({ type: "content_block_stop", index })
      }
      return response
    },
  })
  assert.equal(output.stop_reason, "max_tokens")
  assert.equal(events.at(-2).data.delta.stop_reason, "max_tokens")
  assert.equal(events.filter((entry) => entry.type === "message_stop").length, 1)
  assert.equal(events.filter((entry) => entry.type === "message_start").length, 1)
  assert.deepEqual(events.filter((entry) => entry.type === "content_block_start").map((entry) => entry.data.index), [0, 1, 2])
})

test("unsupported search versions, user location and contradictory domain lists reject explicitly", () => {
  const extract = exported("extractWebSearchConfig")
  const config = searchConfig()
  for (const type of ["web_search_20260209", "web_search_20260318"]) {
    assert.throws(() => extract([{ name: "web_search", type }], config), /version|unsupported|20250305/i)
  }
  assert.throws(() => extract([{ name: "web_search", type: "web_search_20250305", user_location: { country: "US" } }], config), /location/i)
  assert.throws(() => extract([{ name: "web_search", type: "web_search_20250305", allowed_domains: ["example.com"], blocked_domains: ["other.com"] }], config), /both|allowed_domains|blocked_domains/i)
  assert.throws(() => extract([{ name: "web_search", type: "web_search_20250305", max_uses: -1 }], config), /max_uses/i)
})

test("domain constraints match normalized hostname boundaries, never string suffix tricks", async () => {
  const createService = exported("createWebSearchService")
  const service = createService({
    config: searchConfig(), logger: quiet,
    provider: async () => [
      result("https://EXAMPLE.com./one"), result("https://sub.example.com/two"),
      result("https://evil-example.com/three"), result("https://example.com.evil.test/four"),
    ],
  })
  try {
    const allowed = await service.search("fixture", { allowedDomains: ["EXAMPLE.COM."] })
    assert.equal(allowed.length, 2)
    const blocked = await service.search("fixture", { blockedDomains: ["example.com"] })
    assert.equal(blocked.length, 2)
    assert.equal(blocked.some((entry) => new URL(entry.url).hostname === "sub.example.com"), false)
  } finally { service.close() }
})

test("simultaneous cache misses deduplicate by query plus normalized constraints", async () => {
  const createService = exported("createWebSearchService")
  let calls = 0
  const releases = []
  const service = createService({
    config: searchConfig(), logger: quiet,
    provider: async () => {
      calls++
      await new Promise((resolve) => releases.push(resolve))
      return [result(), result("https://other.test/page")]
    },
  })
  const first = service.search("fixture", { allowedDomains: ["example.com"] })
  const second = service.search("fixture", { allowedDomains: ["EXAMPLE.COM."] })
  const different = service.search("fixture", { allowedDomains: ["other.test"] })
  await nextTurn()
  assert.equal(calls, 2)
  for (const release of releases) release()
  const values = await Promise.all([first, second, different])
  assert.deepEqual(values[0], values[1])
  assert.equal(values[2][0].url, "https://other.test/page")
  await service.search("fixture", { allowedDomains: ["example.com"] })
  assert.equal(calls, 2)
  service.close()
})

test("search follow-up history preserves all pairs and interleaved system instructions", async () => {
  const run = exported("runWebSearch")
  let calls = 0
  await run({
    request: request(5, {
      messages: [
        { role: "user", content: "first" },
        { role: "system", content: "retain this" },
        { role: "user", content: "second" },
      ],
    }),
    config: searchConfig(), signal: new AbortController().signal,
    search: async () => [result()],
    generate: async (body) => {
      calls++
      if (calls === 1) return answer([tool("a"), tool("b")])
      assert.equal(body.messages[1].role, "system")
      assert.deepEqual(body.messages.at(-2).content.map((block) => block.id), ["a", "b"])
      assert.deepEqual(body.messages.at(-1).content.map((block) => block.tool_use_id), ["a", "b"])
      assert.ok(body.messages.at(-1).content.every((block) => block.content.includes("Public fixture snippet")))
      return answer([{ type: "text", text: "done" }], "end_turn")
    },
  })
  assert.equal(calls, 2)
})

test("malformed native search tool headers cannot cause provider execution", async () => {
  const run = exported("runWebSearch")
  let searches = 0
  await assert.rejects(run({
    request: request(), config: searchConfig(), signal: new AbortController().signal,
    search: async () => { searches++; return [result()] },
    generate: async () => answer([{ type: "tool_use", name: "web_search", input: { query: "fixture" } }]),
  }), (error) => error.status === 502 && /tool.*id|tool.*header/i.test(error.message))
  assert.equal(searches, 0)
})

test("mixed persisted search and client tool history merges the immediately following results", () => {
  const history = exported("restoreSearchHistory")([
    { role: "assistant", content: [
      { type: "server_tool_use", id: "srvtoolu_a", name: "web_search", input: { query: "fixture" } },
      tool("client_b", "read_file", { path: "a.txt" }),
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_a", content: [result()] },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "client_b", content: "file contents" }] },
  ])
  assert.equal(history.length, 2)
  assert.deepEqual(history[0].content.map((block) => block.type), ["tool_use", "tool_use"])
  assert.deepEqual(history[1].content.map((block) => block.tool_use_id), ["srvtoolu_a", "client_b"])
})

test("zero-use search preserves a forced client tool and an explicit no-tools choice", async () => {
  for (const choice of [{ type: "tool", name: "read_file", disable_parallel_tool_use: true }, { type: "none" }]) {
    let sent
    await exported("runWebSearch")({
      request: request(0, {
        tools: [
          { name: "web_search", type: "web_search_20250305", max_uses: 0 },
          { name: "read_file", input_schema: { type: "object" } },
        ],
        tool_choice: choice,
      }),
      config: searchConfig(), signal: new AbortController().signal,
      search: () => assert.fail("zero-use search must not reach a provider"),
      generate: async (body) => {
        sent = body
        return choice.type === "none" ? answer([{ type: "text", text: "No tools" }], "end_turn") : answer([tool("client", "read_file", {})])
      },
    })
    assert.deepEqual(sent.tool_choice, choice)
    assert.deepEqual(sent.tools.map((entry) => entry.name), ["read_file"])
  }
})

test("documented nullable search options mean unset rather than unsupported restrictions", () => {
  const extract = exported("extractWebSearchConfig")
  for (const fields of [
    { user_location: null },
    { allowed_domains: null, blocked_domains: ["example.com"] },
    { allowed_domains: null, blocked_domains: null, user_location: null },
  ]) {
    const parsed = extract([{ name: "web_search", type: "web_search_20250305", ...fields }], searchConfig())
    assert.deepEqual(parsed.allowedDomains, [])
    assert.deepEqual(parsed.blockedDomains, fields.blocked_domains ?? [])
  }
})

test("zero-use search cannot silently erase a required tool choice when no tools remain", async () => {
  for (const tool_choice of [{ type: "any" }, { type: "tool", name: "unavailable" }]) {
    await assert.rejects(exported("runWebSearch")({
      request: request(0, { tool_choice }), config: searchConfig(), signal: new AbortController().signal,
      search: () => assert.fail("search is disabled"),
      generate: async () => answer([{ type: "text", text: "Unrequested plain answer" }], "end_turn"),
    }), (error) => error.status === 400)
  }
})

test("exhausted logical output allowance stops before another hidden generation", async () => {
  let generations = 0
  let searches = 0
  const output = await exported("runWebSearch")({
    request: request(1, { max_tokens: 100 }), config: searchConfig(), signal: new AbortController().signal,
    search: async () => { searches++; return [result()] },
    generate: async () => {
      generations++
      if (generations > 1) return answer([{ type: "text", text: "extra output" }], "end_turn")
      const response = answer([tool("last_allowed")])
      response.usage.output_tokens = 100
      return response
    },
  })
  assert.equal(generations, 1)
  assert.equal(searches, 1)
  assert.equal(output.usage.output_tokens, 100)
  assert.equal(output.stop_reason, "max_tokens")
  assert.equal(output.content.at(-1).type, "web_search_tool_result")
})

test("search budgets require valid output usage rather than an implicit zero", async () => {
  for (const usage of [undefined, null, -1, 1.5, 101]) {
    let generations = 0
    let searches = 0
    await assert.rejects(exported("runWebSearch")({
      request: request(1, { max_tokens: 100 }), config: searchConfig(), signal: new AbortController().signal,
      search: async () => { searches++; return [result()] },
      generate: async () => {
        if (++generations > 1) return answer([{ type: "text", text: "extra output" }], "end_turn")
        const response = answer([tool("unaccounted")])
        response.usage.output_tokens = usage
        return response
      },
    }), (error) => error.status === 502 && /usage|allowance/i.test(error.message))
    assert.equal(generations, 1)
    assert.equal(searches, 0)
  }
})

test("an unusable continuation thinking budget errors instead of enlarging output or disabling thinking", async () => {
  let generations = 0
  let searches = 0
  await assert.rejects(exported("runWebSearch")({
    request: request(1, {
      max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 1024 }, tool_choice: { type: "auto" },
    }),
    config: searchConfig(), signal: new AbortController().signal,
    search: async () => { searches++; return [result()] },
    generate: async () => {
      if (++generations > 1) return answer([{ type: "text", text: "extra output" }], "end_turn")
      const response = answer([tool("manual_budget")])
      response.usage.output_tokens = 1500
      return response
    },
  }), (error) => error.status === 400 && /thinking.*budget|budget.*thinking/i.test(error.message))
  assert.equal(generations, 1)
  assert.equal(searches, 0)
})

test("an affordable continuation preserves manual thinking and signed history within the remaining allowance", async () => {
  const limits = []
  const thinking = { type: "thinking", thinking: "Search first.", signature: "opaque-fixture-signature" }
  await exported("runWebSearch")({
    request: request(1, {
      max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 1024 }, tool_choice: { type: "auto" },
    }),
    config: searchConfig(), signal: new AbortController().signal,
    search: async () => [result()],
    generate: async (body) => {
      limits.push(body.max_tokens)
      assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 1024 })
      if (limits.length === 1) {
        const response = answer([thinking, tool("manual_ok")])
        response.usage.output_tokens = 1000
        return response
      }
      assert.deepEqual(body.messages.at(-2).content[0], thinking)
      return answer([{ type: "text", text: "done" }], "end_turn")
    },
  })
  assert.deepEqual(limits, [4096, 3096])
})
