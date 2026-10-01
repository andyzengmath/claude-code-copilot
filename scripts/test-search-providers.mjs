import test from "node:test"
import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { createSearchProvider, WebSearchError } from "./search-providers.mjs"

// All traffic is intercepted by an injected fetch; no credentials or network.
const QUERY = "private query & site:example.org"
const URL_RESULT = "https://example.org/article"
const json = (value, options) => Response.json(value, options)
const rpc = (content, extra = {}) => json({
  jsonrpc: "2.0", id: 1, result: { content, ...extra },
})
const mcp = (value) => rpc([{ type: "text", text: JSON.stringify(value) }])
const hit = (url = URL_RESULT) => ({ url, title: "A title", excerpts: ["first", "second"] })
const unavailable = () => json({ error: "private upstream details" }, { status: 503 })
const instantEmpty = () => json({ AbstractURL: "", AbstractText: "", RelatedTopics: [] })
const providerName = (input) => ({
  "mcp.exa.ai": "exa",
  "search.parallel.ai": "parallel",
  "api.search.brave.com": "brave",
  "google.serper.dev": "serper",
  "lite.duckduckgo.com": "lite",
  "api.duckduckgo.com": "instant",
})[new URL(input).hostname]

function harness(respond = () => unavailable(), config = {}) {
  assert.equal(typeof createSearchProvider, "function", "provider factory must be implemented")
  const calls = []
  const warnings = []
  const search = createSearchProvider({
    config: { websearchProvider: "exa", ...config },
    logger: {
      warn: (...args) => warnings.push(args.join(" ")),
      log: (...args) => warnings.push(args.join(" ")),
    },
    fetchImpl: async (url, options) => {
      const call = { name: providerName(url), url: new URL(url), ...options }
      calls.push(call)
      return respond(call, calls.length)
    },
  })
  return { search, calls, warnings }
}

async function assertUnavailable(promise) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WebSearchError)
    assert.equal(error.errorCode, "unavailable")
    assert.match(error.message, /provider|search/i)
    return true
  })
}

test("exports the requested error and provider factory", () => {
  assert.equal(typeof createSearchProvider, "function")
  assert.equal(typeof WebSearchError, "function")
  const error = new WebSearchError("Search is unavailable", "unavailable")
  assert.ok(error instanceof Error)
  assert.equal(error.name, "WebSearchError")
  assert.equal(error.errorCode, "unavailable")
})

test("MCP JSON returns the original result shape and default request arguments", async () => {
  const { search, calls } = harness(() => mcp({ results: [{ ...hit(), publish_date: "2026-01-02" }] }))
  assert.deepEqual(await search(QUERY), [{
    type: "web_search_result", url: URL_RESULT, title: "A title",
    encrypted_content: Buffer.from("first\nsecond").toString("base64"), page_age: "2026-01-02",
  }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.href, "https://mcp.exa.ai/mcp")
  assert.equal(calls[0].redirect, "error")
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.deepEqual(JSON.parse(calls[0].body), {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_exa", arguments: {
      query: QUERY, numResults: 5, type: "auto", livecrawl: "auto",
    } },
  })
})

test("MCP SSE supports CRLF, multiline data, comments and notifications", async () => {
  const sse = [
    ": heartbeat", "",
    'data:{"jsonrpc":"2.0","method":"notifications/progress","params":{}}', "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,',
    `data: "result":{"content":[{"type":"text","text":${JSON.stringify(JSON.stringify([hit()]))}}]}}`,
    "", "data: [DONE]", "",
  ].join("\r\n")
  const { search, calls } = harness(() => new Response(sse, {
    headers: { "content-type": "text/event-stream" },
  }))
  assert.equal((await search(QUERY))[0].url, URL_RESULT)
  assert.equal(calls.length, 1)
})

test("Exa text blocks parse CRLF, dates and snippets deterministically", async () => {
  const { search } = harness(() => rpc([{ type: "text", text:
    "Title: Example\r\nURL: https://example.org/one\r\nPublished: 2026-01-01\r\nHighlights:\r\nA highlight\r\n---\r\nTitle: Two\r\nURL: http://example.org/two\r\nHighlights:\r\nTwo highlights",
  }]))
  const results = await search(QUERY)
  assert.deepEqual(results.map((r) => [r.url, r.title, r.page_age]), [
    ["https://example.org/one", "Example", "2026-01-01"],
    ["http://example.org/two", "Two", null],
  ])
  assert.equal(Buffer.from(results[0].encrypted_content, "base64").toString(), "A highlight")
})

test("caps combined MCP blocks and filters unsafe URLs before the result limit", async () => {
  const { search } = harness(() => rpc([
    { type: "text", text: JSON.stringify([
      hit("javascript:alert(1)"), hit("/relative"), { title: "Missing URL" },
      hit("https://example.org/one"), hit("http://example.org/two"),
    ]) },
    { type: "text", text: JSON.stringify([hit("https://example.org/three")]) },
  ]), { searchMaxResults: 2 })
  assert.deepEqual((await search(QUERY)).map((r) => r.url), [
    "https://example.org/one", "http://example.org/two",
  ])
})

test("selection preserves checksum parity, one-key preference and explicit override", async () => {
  for (const [query, config, expected] of [
    ["b", {}, "exa"], ["a", {}, "parallel"],
    ["a", { exaApiKey: "fake-exa" }, "exa"],
    ["b", { parallelApiKey: "fake-parallel" }, "parallel"],
    ["a", { exaApiKey: "fake-exa", parallelApiKey: "fake-parallel" }, "parallel"],
    ["b", { websearchProvider: "parallel", exaApiKey: "fake-exa" }, "parallel"],
  ]) {
    const { search, calls } = harness(() => mcp([hit()]), { websearchProvider: "", ...config })
    await search(query)
    assert.equal(calls[0].name, expected)
  }
})

test("fallback priority, pinned endpoints and API-key placement remain compatible", async () => {
  const keys = {
    exaApiKey: "fake-exa ?&", parallelApiKey: "fake-parallel",
    braveApiKey: "fake-brave", serperApiKey: "fake-serper",
  }
  const { search, calls, warnings } = harness((call) =>
    call.name === "instant" ? instantEmpty() : unavailable(), keys)
  assert.deepEqual(await search(QUERY), [])
  assert.deepEqual(calls.map((r) => r.name), ["exa", "parallel", "brave", "serper", "lite", "instant"])
  assert.equal(calls[0].url.searchParams.get("exaApiKey"), keys.exaApiKey)
  assert.equal(new Headers(calls[1].headers).get("authorization"), `Bearer ${keys.parallelApiKey}`)
  assert.equal(new Headers(calls[2].headers).get("x-subscription-token"), keys.braveApiKey)
  assert.equal(new Headers(calls[3].headers).get("x-api-key"), keys.serperApiKey)
  assert.deepEqual(JSON.parse(calls[1].body).params, {
    name: "web_search", arguments: { objective: QUERY, search_queries: [QUERY] },
  })
  assert.equal(calls[2].url.searchParams.get("q"), QUERY)
  assert.deepEqual(JSON.parse(calls[3].body), { q: QUERY, num: 5 })
  assert.equal(new URLSearchParams(calls[4].body).get("q"), QUERY)
  for (const call of calls) assert.equal(call.redirect, "error")
  for (const key of Object.values(keys)) assert.ok(!warnings.join("\n").includes(key))
  assert.ok(!warnings.join("\n").includes(QUERY))
})

test("no-key MCP and reverse cross-fallback still run, keyed services are skipped", async () => {
  const { search, calls } = harness((call) =>
    call.name === "instant" ? instantEmpty() : unavailable(), { websearchProvider: "parallel" })
  assert.deepEqual(await search(QUERY), [])
  assert.deepEqual(calls.map((r) => r.name), ["parallel", "exa", "lite", "instant"])
  assert.equal(new Headers(calls[0].headers).has("authorization"), false)
  assert.equal(calls[1].url.search, "")
})

test("successful empty MCP responses continue fallback but prevent all-failure error", async () => {
  for (const empty of [() => rpc([]), () => mcp({ results: [] }), () => mcp([])]) {
    const { search, calls, warnings } = harness((call) => call.name === "exa" ? empty() : unavailable())
    assert.deepEqual(await search(QUERY), [])
    assert.deepEqual(calls.map((r) => r.name), ["exa", "parallel", "lite", "instant"])
    assert.equal(warnings.some((line) => /Exa.*failed/i.test(line)), false)
  }
})

test("empty first provider may fall through to real results", async () => {
  const { search, calls } = harness((call) => call.name === "exa" ? mcp([]) : mcp([hit()]))
  assert.equal((await search(QUERY))[0].url, URL_RESULT)
  assert.deepEqual(calls.map((r) => r.name), ["exa", "parallel"])
})

test("all transport failures throw a nonsecret unavailable error and scoped warnings", async () => {
  const secret = "fake-private-key-and-query"
  const { search, calls, warnings } = harness(() => { throw new Error(secret) }, {
    exaApiKey: secret, parallelApiKey: secret, braveApiKey: secret, serperApiKey: secret,
  })
  await assert.rejects(search(secret), (error) => {
    assert.ok(error instanceof WebSearchError)
    assert.equal(error.errorCode, "unavailable")
    assert.ok(!String(error).includes(secret))
    return true
  })
  assert.equal(warnings.length, calls.length)
  assert.ok(warnings.some((line) => /Exa/.test(line)))
  assert.ok(warnings.some((line) => /DDG Instant/.test(line)))
  assert.ok(!warnings.join("\n").includes(secret))
})

test("MCP errors and malformed protocol/content are failures, never genuine empties", async () => {
  for (const response of [
    () => rpc([], { isError: true }),
    () => json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "private" } }),
    () => json({}),
    () => new Response("{broken"),
    () => json({ jsonrpc: "2.0", id: 2, result: { content: [] } }),
    () => rpc([{ type: "text", text: "upstream service broke" }]),
    () => mcp({ error: "upstream service broke" }),
    () => mcp({ results: {} }),
    () => mcp([hit("javascript:alert(1)")]),
    () => rpc([{ type: "image", data: "abc" }]),
    () => new Response('data: {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[]}}\n\n'),
    () => new Response("data: {broken}\n\n"),
    () => new Response('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'),
  ]) {
    const { search, warnings } = harness((call) => call.name === "exa" ? response() : unavailable())
    await assertUnavailable(search(QUERY))
    assert.match(warnings[0], /Exa/)
    assert.ok(!warnings.join("\n").includes("upstream service broke"))
  }
})

test("Brave and Serper normalize results, filter invalid URLs and honor max results", async () => {
  for (const name of ["brave", "serper"]) {
    const { search, calls } = harness((call) => {
      if (call.name !== name) return unavailable()
      return json(name === "brave" ? { web: { results: [
        { url: "javascript:bad" },
        { url: URL_RESULT, title: "Found", description: "Snippet", age: "1 day ago" },
        { url: "https://example.org/extra" },
      ] } } : { organic: [
        { link: "/relative" },
        { link: URL_RESULT, title: "Found", snippet: "Snippet" },
        { link: "https://example.org/extra" },
      ] })
    }, { braveApiKey: "fake-brave", serperApiKey: "fake-serper", searchMaxResults: 1 })
    assert.deepEqual(await search(QUERY), [{
      type: "web_search_result", url: URL_RESULT, title: "Found",
      encrypted_content: Buffer.from("Snippet").toString("base64"),
      page_age: name === "brave" ? "1 day ago" : null,
    }])
    assert.equal(calls.at(-1).name, name)
  }
})

test("JSON provider schema errors differ from explicit empty arrays", async () => {
  for (const [name, empty] of [
    ["brave", { web: { results: [] } }],
    ["serper", { organic: [] }],
    ["instant", { AbstractURL: "", AbstractText: "", RelatedTopics: [] }],
  ]) {
    for (const invalid of [{}, { error: "private" }, { web: { results: "broken" }, organic: {}, RelatedTopics: {} }]) {
      const { search } = harness((call) => call.name === name ? json(invalid) : unavailable(), {
        braveApiKey: "fake-brave", serperApiKey: "fake-serper",
      })
      await assertUnavailable(search(QUERY))
    }
    const { search } = harness((call) => call.name === name ? json(empty) : unavailable(), {
      braveApiKey: "fake-brave", serperApiKey: "fake-serper",
    })
    assert.deepEqual(await search(QUERY), [])
  }
})

test("DDG Lite decodes HTML, titles, numeric entities and safe result redirect links", async () => {
  const html = `<html><body><table>
    <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Farticle%3Fx%3D1%26y%3D2&amp;rut=test" rel="nofollow">A &amp; B</a></td></tr>
    <tr><td class="result-snippet">Some <b>bold</b> &#x1f600; &quot;text&quot; &#39;ok&#39;</td></tr>
    <tr><td><a rel="nofollow" href="javascript:bad" class='result-link'>Unsafe</a></td></tr>
    <tr><td class='result-snippet'>Not returned</td></tr>
  </table></body></html>`
  const { search, calls } = harness((call) => call.name === "lite" ? new Response(html) : unavailable())
  const results = await search(QUERY)
  assert.equal(results.length, 1)
  assert.equal(results[0].url, "https://example.org/article?x=1&y=2")
  assert.equal(results[0].title, "A & B")
  assert.equal(Buffer.from(results[0].encrypted_content, "base64").toString(), 'Some bold 😀 "text" \'ok\'')
  assert.equal(calls.at(-1).name, "lite")
})

test("DDG Lite recognizes explicit no-results but not CAPTCHA or unrelated HTML", async () => {
  const { search } = harness((call) => call.name === "lite"
    ? new Response('<html><div class="no-results">No results found for <b>example</b></div></html>')
    : unavailable())
  assert.deepEqual(await search(QUERY), [])
  for (const html of [
    '<html><form id="challenge-form" action="/anomaly.js">Solve CAPTCHA</form></html>',
    "<html><body>Service unavailable</body></html>",
    "<html><body></body></html>",
  ]) {
    const { search: failing } = harness((call) => call.name === "lite" ? new Response(html) : unavailable())
    await assertUnavailable(failing(QUERY))
  }
})

test("DDG Instant parses abstracts and grouped topics with validated URLs", async () => {
  const { search } = harness((call) => call.name === "instant" ? json({
    AbstractURL: URL_RESULT, AbstractText: "Abstract", Heading: "Heading",
    RelatedTopics: [
      { FirstURL: "javascript:bad", Text: "Unsafe" },
      { Name: "Group", Topics: [{ FirstURL: "https://example.org/topic", Text: "Topic text" }] },
    ],
  }) : unavailable())
  assert.deepEqual((await search(QUERY)).map((r) => [r.url, r.title]), [
    [URL_RESULT, "Heading"], ["https://example.org/topic", "Topic text"],
  ])
})

test("rejects redirects, cancels response bodies and never requests redirect targets", async () => {
  let cancelled = 0
  const { search, calls } = harness(() => new Response(new ReadableStream({
    cancel() { cancelled++ },
  }), { status: 302, headers: { location: "https://untrusted.example/leak" } }), {
    exaApiKey: "fake-exa", parallelApiKey: "fake-parallel", braveApiKey: "fake-brave", serperApiKey: "fake-serper",
  })
  await assertUnavailable(search(QUERY))
  assert.equal(calls.length, 6)
  assert.equal(cancelled, 6)
  for (const call of calls) assert.equal(call.redirect, "error")
})

test("rejects a response already redirected by a noncompliant fetch", async () => {
  const { search } = harness(() => {
    const response = mcp([])
    Object.defineProperty(response, "redirected", { value: true })
    return response
  })
  await assertUnavailable(search(QUERY))
})

test("each fetch is deadline-bounded even when injected fetch ignores AbortSignal", { timeout: 2000 }, async () => {
  const { search, calls, warnings } = harness(() => new Promise(() => {}), {
    braveApiKey: "fake-brave", serperApiKey: "fake-serper", searchTimeoutMs: 15,
  })
  await assertUnavailable(search(QUERY))
  assert.equal(calls.length, 6)
  assert.ok(calls.every((call) => call.signal.aborted))
  assert.ok(warnings.every((line) => /timed out/i.test(line)))
})

test("body deadline cancels stalled reads without awaiting a stalled cancel", { timeout: 2000 }, async () => {
  let cancelled = 0
  const bodies = []
  const { search, calls } = harness(() => {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')) },
      cancel() { cancelled++; return new Promise(() => {}) },
    })
    bodies.push(body)
    return new Response(body)
  }, { searchTimeoutMs: 15 })
  await assertUnavailable(search(QUERY))
  assert.equal(cancelled, 4)
  assert.ok(calls.every((call) => call.signal.aborted))
  assert.ok(bodies.every((body) => !body.locked), "losing readers must release their locks")
})

test("fetch and body share one total provider deadline", { timeout: 2000 }, async () => {
  let cancelled = 0
  const { search, warnings } = harness((call) => {
    if (call.name !== "exa") return unavailable()
    return new Promise((resolve) => setTimeout(() => resolve(new Response(new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            jsonrpc: "2.0", id: 1, result: { content: [] },
          })))
          controller.close()
        }, 80)
        this.timer = timer
      },
      cancel() { cancelled++; clearTimeout(this.timer) },
    }))), 70))
  }, { searchTimeoutMs: 120 })
  await assertUnavailable(search(QUERY))
  assert.equal(cancelled, 1)
  assert.match(warnings[0], /timed out/i)
})

test("caller cancellation before a request preserves the exact reason and never falls back", async () => {
  for (const reason of [new Error("caller stopped"), "caller sentinel", undefined]) {
    const controller = new AbortController()
    controller.abort(reason)
    const { search, calls, warnings } = harness()
    await assert.rejects(search(QUERY, { signal: controller.signal }), (error) => error === controller.signal.reason)
    assert.equal(calls.length, 0)
    assert.equal(warnings.length, 0)
  }
})

test("cancellation during fetch rejects immediately and cancels a late response", { timeout: 2000 }, async () => {
  const controller = new AbortController()
  const reason = new Error("caller stopped")
  let deliver
  let cancelled = 0
  const { search, calls, warnings } = harness(() => new Promise((resolve) => { deliver = resolve }))
  const pending = search(QUERY, { signal: controller.signal })
  const rejected = assert.rejects(pending, (error) => error === reason)
  controller.abort(reason)
  await rejected
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal.reason, reason)
  deliver(new Response(new ReadableStream({ cancel() { cancelled++ } })))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancelled, 1)
  assert.equal(warnings.length, 0)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

test("cancellation during body read aborts and cancels without fallback", { timeout: 2000 }, async () => {
  const controller = new AbortController()
  const reason = new DOMException("caller stopped", "AbortError")
  let started
  const reading = new Promise((resolve) => { started = resolve })
  let cancelled = 0
  const { search, calls, warnings } = harness(() => new Response(new ReadableStream({
    pull() { started(); return new Promise(() => {}) },
    cancel() { cancelled++ },
  })))
  const pending = search(QUERY, { signal: controller.signal })
  const rejected = assert.rejects(pending, (error) => error === reason)
  await reading
  controller.abort(reason)
  await rejected
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal.reason, reason)
  assert.equal(cancelled, 1)
  assert.equal(warnings.length, 0)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

test("byte cap is enforced on streamed UTF-8 bytes, not characters or content-length alone", async () => {
  let cancelled = 0
  const { search, calls, warnings } = harness(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("😀".repeat(20)))
    },
    cancel() { cancelled++ },
  }), { headers: { "content-length": "1" } }), { searchMaxResponseBytes: 64 })
  await assertUnavailable(search(QUERY))
  assert.equal(cancelled, 4)
  assert.ok(calls.every((call) => call.signal.aborted))
  assert.ok(warnings.every((line) => /byte limit/i.test(line)))
})

test("oversized content-length cancels without starting a read", async () => {
  let readCalls = 0
  let cancelled = 0
  const { search } = harness(() => ({
    ok: true, status: 200, redirected: false,
    headers: new Headers({ "content-length": "65" }),
    body: {
      getReader() { readCalls++; throw new Error("must not read") },
      cancel() { cancelled++; return Promise.resolve() },
    },
  }), { searchMaxResponseBytes: 64 })
  await assertUnavailable(search(QUERY))
  assert.equal(readCalls, 0)
  assert.equal(cancelled, 4)
})

test("default body cap is 2 MiB and exact configured cap is accepted", async () => {
  const { search: tooLarge } = harness(() => new Response(new Uint8Array(2097153)))
  await assertUnavailable(tooLarge(QUERY))
  const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
    content: [{ type: "text", text: JSON.stringify([hit()]) }],
  } })
  const { search } = harness(() => new Response(text), { searchMaxResponseBytes: Buffer.byteLength(text) })
  assert.equal((await search(QUERY))[0].url, URL_RESULT)
})

test("read failures and invalid UTF-8 cannot masquerade as successful empties", async () => {
  for (const response of [
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private")) } })),
    () => new Response(new Uint8Array([0xff, 0xfe])),
  ]) {
    const { search } = harness(() => response())
    await assertUnavailable(search(QUERY))
  }
})

test("successful requests remove caller listeners and clear deadline timers", async () => {
  const controller = new AbortController()
  const { search, calls } = harness(() => mcp([hit()]), { searchTimeoutMs: 20 })
  await search(QUERY, { signal: controller.signal })
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(calls[0].signal.aborted, false)
  controller.abort()
  assert.equal(calls[0].signal.aborted, false)
})

test("an error-bearing MCP JSON result cannot count as a successful empty search", async () => {
  for (const response of [
    () => mcp({ error: "private error", results: [] }),
    () => json({ jsonrpc: "2.0", id: 1, error: null, result: { content: [] } }),
  ]) {
    const { search } = harness((call) => call.name === "exa" ? response() : unavailable())
    await assertUnavailable(search(QUERY))
  }
})

test("Exa text accepts a trailing block separator rather than failing valid results", async () => {
  const { search } = harness(() => rpc([{ type: "text", text:
    "Title: Example\nURL: https://example.org/article\nHighlights:\nSnippet\n---\n",
  }]))
  assert.equal((await search(QUERY))[0].url, URL_RESULT)
  assert.equal(Buffer.from((await search(QUERY))[0].encrypted_content, "base64").toString(), "Snippet")
})

test("default 25-second deadline also applies with no config override", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { search, calls } = harness((call) => call.name === "exa" ? new Promise(() => {}) : mcp([hit()]))
  const pending = search(QUERY)
  t.mock.timers.tick(24999)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal.aborted, false)
  t.mock.timers.tick(1)
  assert.equal((await pending)[0].url, URL_RESULT)
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(calls.length, 2)
})

test("a mocked reader that ignores abort and cancel is still deadline-bounded", { timeout: 2000 }, async () => {
  let cancelled = 0
  let released = 0
  const { search } = harness(() => ({
    ok: true, status: 200, redirected: false, headers: new Headers(),
    body: { getReader: () => ({
      read: () => new Promise(() => {}),
      cancel() { cancelled++; return new Promise(() => {}) },
      releaseLock() { released++ },
    }) },
  }), { searchTimeoutMs: 15 })
  await assertUnavailable(search(QUERY))
  assert.equal(cancelled, 4)
  assert.equal(released, 4)
})
