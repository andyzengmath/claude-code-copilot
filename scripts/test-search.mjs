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

// Claude Code 2.1.328 forwards both lists to its nested WebSearch request,
// one of them possibly empty, and rejects only two nonempty lists itself.
test("an empty companion domain list is not a contradiction", () => {
  const extract = exported("extractWebSearchConfig")
  const config = searchConfig()
  const domains = (fields) => {
    const { allowedDomains, blockedDomains } = extract([{ name: "web_search", type: "web_search_20250305", ...fields }], config)
    return { allowedDomains, blockedDomains }
  }
  assert.deepEqual(domains({ allowed_domains: ["NodeJS.org"], blocked_domains: [] }), { allowedDomains: ["nodejs.org"], blockedDomains: [] })
  assert.deepEqual(domains({ allowed_domains: [], blocked_domains: ["example.com"] }), { allowedDomains: [], blockedDomains: ["example.com"] })
  assert.deepEqual(domains({ allowed_domains: [], blocked_domains: [] }), { allowedDomains: [], blockedDomains: [] })
  assert.throws(() => domains({ allowed_domains: ["nodejs.org"], blocked_domains: ["example.com"] }),
    (error) => error.status === 400 && /both allowed_domains and blocked_domains/.test(error.message))
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

// Claude Code 2.1.303 can add search_profile to its nested WebSearch tool, and
// later releases may add more optional fields. Rejecting them broke WebSearch.
test("optional search tool hints are accepted; unrecognized fields are ignored and reported", () => {
  const extract = exported("extractWebSearchConfig")
  const profiled = extract([{ name: "web_search", type: "web_search_20250305", max_uses: 8, search_profile: "default" }], searchConfig())
  assert.equal(profiled.maxUses, 8)
  assert.deepEqual(profiled.ignoredFields, [])
  const future = extract([{ name: "web_search", type: "web_search_20250305", future_hint: true, another: 1 }], searchConfig())
  assert.deepEqual(future.ignoredFields, ["another", "future_hint"])
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

test("user_location is validated and kept for hosted search", () => {
  const extract = exported("extractWebSearchConfig")
  const config = searchConfig()
  const location = { type: "approximate", city: "Seattle", region: "Washington", country: "US", timezone: "America/Los_Angeles" }
  assert.deepEqual(extract([{ name: "web_search", type: "web_search_20250305", user_location: location }], config).userLocation, location)
  assert.deepEqual(extract([{ name: "web_search", type: "web_search_20250305", user_location: { type: "approximate", country: "DE", city: null } }], config).userLocation,
    { type: "approximate", country: "DE" })
  assert.equal(extract([{ name: "web_search", type: "web_search_20250305" }], config).userLocation, null)
  for (const user_location of [
    { country: "US" }, { type: "exact", country: "US" }, { type: "approximate", country: "USA" }, { type: "approximate", latitude: "1" },
    { type: "approximate", city: "" }, { type: "approximate", city: "a\nb" }, { type: "approximate", city: 7 }, "US", [],
  ]) {
    assert.throws(() => extract([{ name: "web_search", type: "web_search_20250305", user_location }], config),
      (error) => error.status === 400 && /user_location/.test(error.message))
  }
})

test("allowed and blocked domains become site: operators and the provider's result filter", async () => {
  const queries = []
  const service = exported("createWebSearchService")({
    config: searchConfig(), logger: quiet,
    provider: async (query, { accepts }) => {
      queries.push(query)
      return [result("https://nodejs.org/a"), result("https://docs.github.com/b"), result("https://other.test/c")].filter(accepts)
    },
  })
  try {
    assert.deepEqual((await service.search("node lts", { allowedDomains: ["nodejs.org", "github.com"] })).map((item) => item.url),
      ["https://nodejs.org/a", "https://docs.github.com/b"])
    assert.deepEqual((await service.search("node lts", { blockedDomains: ["github.com"] })).map((item) => item.url),
      ["https://nodejs.org/a", "https://other.test/c"])
    assert.deepEqual(queries, ["node lts (site:github.com OR site:nodejs.org)", "node lts -site:github.com"])
  } finally { service.close() }
})

test("searches with different credentials never share a request or a cached result", async () => {
  const tokens = []
  const service = exported("createWebSearchService")({
    config: searchConfig(), logger: quiet,
    provider: async (query, { token }) => { tokens.push(token); await nextTurn(); return [result()] },
  })
  try {
    await Promise.all([service.search("fixture", { token: "token-a" }), service.search("fixture", { token: "token-b" })])
    await service.search("fixture", { token: "token-a" })
    assert.deepEqual(tokens, ["token-a", "token-b"])
  } finally { service.close() }
})

test("a full search queue and unexpected provider failures become search errors, not failed responses", async () => {
  let release
  const warnings = []
  const service = exported("createWebSearchService")({
    config: searchConfig({ maxConcurrentSearches: 1, maxQueuedRequests: 0 }), logger: { ...quiet, warn: (line) => warnings.push(line) },
    provider: async (query) => {
      if (query === "slow") await new Promise((resolve) => { release = resolve })
      if (query === "buggy") throw new TypeError("private provider detail")
      if (query === "ftp") return [{ ...result(), url: "ftp://example.com/file" }]
      return [result()]
    },
  })
  try {
    const slow = service.search("slow")
    await nextTurn()
    await assert.rejects(service.search("queued"), (error) => error.status === 429 && error.errorCode === "too_many_requests")
    release()
    assert.equal((await slow).length, 1)
    await assert.rejects(service.search("buggy"), (error) => error.errorCode === "unavailable")
    assert.deepEqual(warnings, ["Search provider failed unexpectedly (TypeError)"])
    await assert.rejects(service.search("ftp"), (error) => error.status === 502 && error.errorCode === "unavailable")
  } finally { service.close() }
})

test("results of one search round are appended whole and in call order", async () => {
  const events = []
  const output = await exported("runWebSearch")({
    request: request(), config: searchConfig(), signal: new AbortController().signal,
    emit: async (type, data) => {
      await nextTurn()
      if (type.startsWith("content_block_") && type !== "content_block_delta") events.push(`${type === "content_block_start" ? "start" : "stop"} ${data.index}`)
    },
    search: async (query) => {
      if (query === "first") await nextTurn()
      return [result(`https://example.com/${query}`)]
    },
    generate: async (body) => body.messages.length === 1
      ? answer([tool("first_call", "web_search", { query: "first" }), tool("second_call", "web_search", { query: "second" })])
      : answer([{ type: "text", text: "done" }], "end_turn"),
  })
  assert.deepEqual(events, ["start 2", "stop 2", "start 3", "stop 3"])
  assert.deepEqual(output.content.filter((block) => block.type === "web_search_tool_result").map((block) => [block.tool_use_id, block.content[0].url]), [
    ["srvtoolu_first_call", "https://example.com/first"], ["srvtoolu_second_call", "https://example.com/second"],
  ])
})

test("a fatal search failure cancels the other searches of its round and adds no later output", async () => {
  const failure = new Error("unexpected search failure")
  const events = []
  let sibling
  await assert.rejects(exported("runWebSearch")({
    request: request(), config: searchConfig(), signal: new AbortController().signal,
    emit: async (type, data) => { events.push(type === "content_block_start" ? data.content_block.type : type) },
    search: async (query, { signal }) => {
      if (query === "broken") throw failure
      sibling = signal
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    },
    generate: async () => answer([tool("slow", "web_search", { query: "slow" }), tool("bad", "web_search", { query: "broken" })]),
  }), (error) => error === failure)
  assert.equal(sibling.aborted, true)
  assert.deepEqual(events, ["message_start"])
})

test("tokens and searches of a rejected hosted answer are reported without shrinking the response's allowance", async () => {
  const limits = []
  let searched = 0
  const output = await exported("runWebSearch")({
    request: request(1, { max_tokens: 100 }), config: searchConfig(), signal: new AbortController().signal,
    priorUsage: { input_tokens: 500, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2 } },
    search: async () => { searched++; return [result()] },
    generate: async (body) => {
      limits.push(body.max_tokens)
      return limits.length === 1 ? answer([tool("s")]) : answer([{ type: "text", text: "done" }], "end_turn")
    },
  })
  assert.deepEqual(limits, [100, 97])
  assert.equal(searched, 1)
  assert.equal(output.usage.input_tokens, 520)
  assert.equal(output.usage.output_tokens, 96)
  assert.deepEqual(output.usage.server_tool_use, { web_search_requests: 3 })
})
