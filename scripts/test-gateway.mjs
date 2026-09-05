import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { gzipSync } from "node:zlib"
import test from "node:test"
import * as proxy from "./proxy.mjs"
import { fixture, event, message, nativeFrames, streamResponse, key, token, models } from "./test-helpers/gateway.mjs"

const parsedEvents = (text) => [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]))

test("model spelling normalization never substitutes a different version", () => {
  assert.equal(proxy.mapModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4.5")
  assert.equal(proxy.mapModel("claude-opus-4-8-latest"), "claude-opus-4.8")
  assert.equal(proxy.mapModel("future-sonnet-999"), "future-sonnet-999")
  assert.equal(proxy.mapModel("claude-sonnet-4"), "claude-sonnet-4")
})

test("chat translator does not certify an unfinished stream", () => {
  const frames = []
  const translator = proxy.createStreamTranslator("claude-sonnet-5", { write: (frame) => frames.push(frame) })
  translator.processChunk({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })
  assert.throws(() => translator.processChunk(null), /incomplete|completion|finish/i)
  assert.equal(frames.some((frame) => frame.includes("event: message_stop")), false)
})

test("chat translator includes usage delivered after the finish reason", () => {
  const frames = []
  const translator = proxy.createStreamTranslator("claude-sonnet-5", { write: (frame) => frames.push(frame) })
  translator.processChunk({ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] })
  assert.equal(frames.some((frame) => frame.includes("event: message_stop")), false)
  translator.processChunk({ choices: [], usage: { prompt_tokens: 101, completion_tokens: 17 } })
  translator.processChunk("[DONE]")
  const delta = parsedEvents(frames.join("")).find((frame) => frame.type === "message_delta")
  assert.equal(delta.usage.input_tokens, 101)
  assert.equal(delta.usage.output_tokens, 17)
})

test("unsupported chat images and documents are rejected rather than lost", () => {
  assert.throws(() => proxy.translateContentPart({ type: "image", source: { type: "file", file_id: "file_test" } }), /image|native/i)
  assert.throws(() => proxy.translateContentPart({ type: "document", source: { type: "base64", data: "SECRET_DOCUMENT" } }), /document|native/i)
})

test("chat history retains mid-conversation system instructions", () => {
  const history = [
    { role: "user", content: "before" },
    { role: "system", content: "important change" },
    { role: "assistant", content: "after" },
  ]
  assert.deepEqual(proxy.translateMessages(history), history)
})

test("native forwarding preserves semantic body fields and Anthropic headers", async (t) => {
  let seen
  const result = message([], "max_tokens")
  const f = await fixture(t, (call) => {
    seen = call
    return Response.json(result)
  })
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 0,
    system: [{ type: "text", text: "Keep me", cache_control: { type: "ephemeral" } }],
    thinking: { type: "enabled", budget_tokens: 2048 },
    output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    context_management: { edits: [] },
    metadata: { user_id: "fixture" },
    tool_choice: { type: "tool", name: "read_file", disable_parallel_tool_use: true },
    tools: [{ name: "read_file", input_schema: { type: "object" }, eager_input_streaming: true }],
    messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "file_fixture" } }] }],
  }
  const response = await f.request(body, undefined, {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "fixture-beta-1,fixture-beta-2" },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), result)
  assert.equal(seen.url.pathname, "/v1/messages")
  assert.equal(seen.url.search, "?beta=true")
  assert.deepEqual(JSON.parse(seen.body), { ...body, model: "claude-haiku-4.5" })
  assert.equal(new Headers(seen.headers).get("anthropic-beta"), "fixture-beta-1,fixture-beta-2")
  assert.equal(new Headers(seen.headers).get("anthropic-version"), "2023-06-01")
  assert.equal(new Headers(seen.headers).get("authorization"), `Bearer ${token}`)
  assert.equal(new Headers(seen.headers).has("x-api-key"), false)
})

test("health is public but inference and model discovery require the local key", async (t) => {
  const f = await fixture(t, () => assert.fail("unauthorized requests must not contact Copilot"))
  assert.equal((await fetch(`${f.base}/health`)).status, 200)
  assert.equal((await fetch(`${f.base}/health`, { method: "HEAD" })).status, 200)
  for (const path of ["/v1/messages", "/v1/models", "/v1/messages/count_tokens"]) {
    const response = await fetch(`${f.base}${path}`, { headers: { "x-api-key": "wrong" } })
    assert.equal(response.status, 401)
    assert.equal(response.headers.has("access-control-allow-origin"), false)
  }
  assert.equal(f.calls.length, 0)
})

test("routing is exact and malformed bodies are rejected before upstream dispatch", async (t) => {
  const f = await fixture(t, () => assert.fail("invalid request dispatched"))
  for (const path of ["/v1/messages-suffix", "/anything/token", "/v1/models-extra"]) {
    assert.equal((await f.request({}, path)).status, 404)
  }
  assert.equal((await fetch(`${f.base}/v1/messages`, { headers: { "x-api-key": key } })).status, 405)
  for (const body of ["{", "null", "[]", '"string"']) {
    const response = await fetch(`${f.base}/v1/messages`, {
      method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body,
    })
    assert.equal(response.status, 400)
  }
  assert.equal(f.calls.length, 0)
})

test("declared and chunked request bodies obey the byte limit", async (t) => {
  const f = await fixture(t, () => assert.fail("oversized request dispatched"), { config: { maxBodyBytes: 256 } })
  assert.equal((await f.request({ messages: [{ role: "user", content: "x".repeat(500) }] })).status, 413)
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(200)))
      controller.enqueue(new TextEncoder().encode("y".repeat(200)))
      controller.close()
    },
  })
  const response = await fetch(`${f.base}/v1/messages`, {
    method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body, duplex: "half",
  })
  assert.equal(response.status, 413)
  assert.equal(f.calls.length, 0)
})

test("native errors retain upstream status, body and diagnostic headers", async (t) => {
  const error = { type: "error", error: { type: "invalid_request_error", message: "Thinking rejected" }, request_id: "req_fixture" }
  const f = await fixture(t, () => Response.json(error, {
    status: 400,
    headers: { "request-id": "req_fixture", "retry-after": "90", "content-encoding": "identity" },
  }))
  const response = await f.request()
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), error)
  assert.equal(response.headers.get("request-id"), "req_fixture")
  assert.equal(response.headers.get("retry-after"), "90")
  assert.equal(response.headers.has("content-encoding"), false)
})

test("an inference 404 is never replayed against a second transport", async (t) => {
  const dispatched = []
  const f = await fixture(t, (call) => {
    dispatched.push(call.url.pathname)
    return Response.json({ error: { message: "model unavailable" } }, { status: 404 })
  })
  assert.equal((await f.request()).status, 404)
  assert.deepEqual(dispatched, ["/v1/messages"])
})

test("a network failure does not replay an ambiguously submitted completion", async (t) => {
  let dispatched = 0
  const f = await fixture(t, () => {
    dispatched++
    throw new TypeError("fetch failed")
  }, { config: { maxRetries: 3 } })
  assert.equal((await f.request()).status, 502)
  assert.equal(dispatched, 1)
})

test("native token counting uses the same normalized payload without an estimate fallback", async (t) => {
  let body
  const f = await fixture(t, (call) => {
    assert.equal(call.url.pathname, "/v1/messages/count_tokens")
    body = JSON.parse(call.body)
    return Response.json({ input_tokens: 42 })
  })
  const response = await f.request({ model: "claude-haiku-4-5", tools: [{ name: "read", input_schema: { type: "object" } }] }, "/v1/messages/count_tokens")
  assert.equal((await response.json()).input_tokens, 42)
  assert.equal(body.model, "claude-haiku-4.5")
  assert.equal(body.tools[0].name, "read")
  const missing = await fixture(t, () => Response.json({ error: { message: "No count endpoint" } }, { status: 404 }))
  assert.equal((await missing.request({}, "/v1/messages/count_tokens")).status, 404)
})

test("the model catalog distinguishes picker visibility from routing permission", async (t) => {
  const f = await fixture(t, (call) => {
    assert.equal(call.url.pathname, "/chat/completions")
    return Response.json({ id: "chat_fixture", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })
  })
  const response = await fetch(`${f.base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
  const catalog = await response.json()
  assert.deepEqual(catalog.data.map((entry) => entry.id), ["claude-sonnet-5", "claude-haiku-4.5"])
  assert.equal((await f.request({ model: "hidden-utility" })).status, 200)
  assert.equal((await f.request({ model: "claude-opus-disabled" })).status, 403)
  assert.equal(f.calls.filter((call) => call.url.pathname === "/models").length, 1)
})

test("native SSE framing survives fragmented UTF-8 and preserves completion metadata", async (t) => {
  const expected = nativeFrames(message([{ type: "text", text: "hello \u263a" }], "pause_turn"))
  const f = await fixture(t, () => streamResponse(expected, { fragments: 1 }))
  const response = await f.request({ stream: true })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), expected)
})

test("native message_stop ends the relay without waiting for connection EOF", async (t) => {
  let cancelled = false
  const f = await fixture(t, () => streamResponse(nativeFrames(), {
    keepOpen: true, onCancel: () => { cancelled = true },
  }), { config: { requestTimeoutMs: 50 } })
  const response = await f.request({ stream: true })
  const events = parsedEvents(await response.text())
  assert.equal(events.at(-1).type, "message_stop")
  assert.equal(events.some((frame) => frame.type === "error"), false)
  assert.equal(cancelled, true)
})

test("unexpected native EOF emits an error, never a fabricated successful stop", async (t) => {
  const start = event("message_start", { type: "message_start", message: { ...message(), content: [], stop_reason: null } })
  const f = await fixture(t, () => streamResponse(start))
  const response = await f.request({ stream: true })
  const events = parsedEvents(await response.text())
  assert.equal(events.at(-1).type, "error")
  assert.equal(events.some((frame) => frame.type === "message_stop"), false)
})

test("an upstream SSE error is terminal and preserved exactly once", async (t) => {
  const error = { type: "error", error: { type: "overloaded_error", message: "busy" } }
  const f = await fixture(t, () => streamResponse(event("error", error), { keepOpen: true }))
  const events = parsedEvents(await (await f.request({ stream: true })).text())
  assert.deepEqual(events, [error])
})

test("an idle upstream is cancelled and receives a structured streaming error", async (t) => {
  let upstreamSignal
  let cancelled = false
  const start = event("message_start", { type: "message_start", message: { ...message(), content: [], stop_reason: null } })
  const f = await fixture(t, (call) => {
    upstreamSignal = call.signal
    return streamResponse(start, { keepOpen: true, onCancel: () => { cancelled = true } })
  }, { config: { requestTimeoutMs: 40 } })
  const events = parsedEvents(await (await f.request({ stream: true })).text())
  assert.equal(events.at(-1).type, "error")
  assert.equal(events.some((frame) => frame.type === "message_stop"), false)
  assert.equal(upstreamSignal.aborted, true)
  assert.equal(cancelled, true)
})

test("downstream disconnect aborts and cancels the upstream body", { timeout: 2500 }, async (t) => {
  let upstreamSignal
  let resolveCancelled
  const cancelled = new Promise((resolve) => { resolveCancelled = resolve })
  const f = await fixture(t, (call) => {
    upstreamSignal = call.signal
    return streamResponse(event("ping"), { keepOpen: true, onCancel: resolveCancelled })
  }, { config: { requestTimeoutMs: 2000 } })
  const controller = new AbortController()
  const response = await f.request({ stream: true }, undefined, { signal: controller.signal })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()
  await cancelled
  assert.equal(upstreamSignal.aborted, true)
})

test("chat fallback maps forced tool choice and parallel-tool control", async (t) => {
  let body
  const f = await fixture(t, (call) => {
    body = JSON.parse(call.body)
    return Response.json({
      choices: [{
        message: { tool_calls: [{ id: "call_one", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
        finish_reason: "tool_calls",
      }],
    })
  }, { config: { transport: "chat" } })
  const response = await f.request({
    tools: [{ name: "read", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "read", disable_parallel_tool_use: true },
    max_tokens: 0,
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).stop_reason, "tool_use")
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "read" } })
  assert.equal(body.parallel_tool_calls, false)
  assert.equal(body.max_tokens, 0)
})

test("malformed chat tool arguments cannot turn into an executable empty object", async (t) => {
  const f = await fixture(t, () => Response.json({
    choices: [{
      message: { tool_calls: [{ id: "call_bad", function: { name: "delete", arguments: "{broken" } }] },
      finish_reason: "tool_calls",
    }],
  }), { config: { transport: "chat" } })
  const response = await f.request()
  assert.equal(response.status, 502)
  assert.equal((await response.json()).type, "error")
})

test("same-buffer chat usage and DONE tails are processed before finalization", async (t) => {
  let cancelled = false
  const frames = [
    { choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 123, completion_tokens: 17 } },
  ].map((data) => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n"
  const f = await fixture(t, () => streamResponse(frames, {
    keepOpen: true, onCancel: () => { cancelled = true },
  }), { config: { transport: "chat", requestTimeoutMs: 50 } })
  const events = parsedEvents(await (await f.request({ stream: true })).text())
  assert.equal(events.filter((frame) => frame.type === "message_stop").length, 1)
  const usage = events.find((frame) => frame.type === "message_delta").usage
  assert.equal(usage.input_tokens, 123)
  assert.equal(usage.output_tokens, 17)
  assert.equal(cancelled, true)
})

test("a Retry-After beyond the retry budget is returned without clipping or replay", async (t) => {
  let attempts = 0
  const f = await fixture(t, () => {
    attempts++
    return Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, {
      status: 429, headers: { "retry-after": "90" },
    })
  }, { config: { maxRetries: 3, retryBudgetMs: 50 } })
  const response = await f.request()
  assert.equal(response.status, 429)
  assert.equal(response.headers.get("retry-after"), "90")
  assert.equal(attempts, 1)
  const next = await f.request()
  assert.equal(next.status, 429)
  assert.equal(next.headers.get("retry-after"), "90")
  assert.equal(attempts, 1)
})

test("inference permits are held until response consumption rather than just headers", { timeout: 2500 }, async (t) => {
  const bodies = []
  let resolveSecond
  const secondStarted = new Promise((resolve) => { resolveSecond = resolve })
  const f = await fixture(t, () => {
    let controller
    const response = new Response(new ReadableStream({
      start(value) { controller = value; controller.enqueue(new TextEncoder().encode(event("ping"))) },
    }), { headers: { "content-type": "text/event-stream" } })
    bodies.push(controller)
    if (bodies.length === 2) resolveSecond()
    return response
  }, { config: { maxConcurrentRequests: 1, maxQueuedRequests: 1 } })
  const first = await f.request({ stream: true })
  const pendingSecond = f.request({ stream: true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(bodies.length, 1)
  const rejected = await f.request({ stream: true })
  assert.equal(rejected.status, 503)
  bodies[0].enqueue(new TextEncoder().encode(nativeFrames()))
  bodies[0].close()
  await first.text()
  await secondStarted
  bodies[1].enqueue(new TextEncoder().encode(nativeFrames()))
  bodies[1].close()
  assert.equal((await (await pendingSecond).text()).includes("message_stop"), true)
})

test("model discovery caches are isolated when the credential provider changes", async (t) => {
  let currentToken = "first-fixture-token"
  let discoveries = 0
  const f = await fixture(t, () => assert.fail("catalog-only test dispatched inference"), {
    tokenProvider: async () => currentToken,
    catalog: async (call) => {
      discoveries++
      const id = new Headers(call.headers).get("authorization") === "Bearer first-fixture-token" ? models[0].id : models[1].id
      return Response.json({ data: models.filter((model) => model.id === id) })
    },
  })
  const discover = async () => (await (await fetch(`${f.base}/v1/models`, { headers: { "x-api-key": key } })).json()).data.map((model) => model.id)
  assert.deepEqual(await discover(), ["claude-sonnet-5"])
  currentToken = "second-fixture-token"
  assert.deepEqual(await discover(), ["claude-haiku-4.5"])
  currentToken = "first-fixture-token"
  assert.deepEqual(await discover(), ["claude-sonnet-5"])
  assert.equal(discoveries, 2)
})

test("a temporary catalog outage permits bounded stale data but never indefinite stale routing", async (t) => {
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  let available = true
  const f = await fixture(t, () => Response.json(message()), {
    config: { modelCacheTtlMs: 5, modelCacheMaxStaleMs: 20 },
    catalog: async () => available ? Response.json({ data: models }) : Response.json({ error: { message: "catalog outage" } }, { status: 503 }),
  })
  assert.equal((await f.request()).status, 200)
  available = false
  now += 10
  assert.equal((await f.request()).status, 200)
  now += 20
  assert.equal((await f.request()).status, 503)
  assert.equal((await fetch(`${f.base}/health`)).status, 200)
})

test("explicit HTTP retries use separate attempt signals and release cancelled bodies", async (t) => {
  const signals = []
  let cancelled = false
  const f = await fixture(t, (call) => {
    signals.push(call.signal)
    if (signals.length === 1) {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("busy")) },
        cancel() { cancelled = true },
      }), { status: 503, headers: { "retry-after": "0" } })
    }
    assert.equal(cancelled, true)
    assert.equal(signals[0].aborted, true)
    assert.equal(call.signal.aborted, false)
    return Response.json(message())
  }, { config: { maxRetries: 3 } })
  const response = await f.request()
  assert.equal(response.status, 200)
  assert.equal(signals.length, 2)
  assert.notEqual(signals[0], signals[1])
})

test("real Fetch decompression does not leave gzip encoding or compressed length on the client response", async (t) => {
  const expected = message([{ type: "text", text: "a long fixture ".repeat(100) }])
  const compressed = gzipSync(JSON.stringify(expected))
  const backend = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(compressed.length) })
    res.end(compressed)
  })
  backend.listen(0, "127.0.0.1")
  await once(backend, "listening")
  t.after(async () => {
    backend.closeAllConnections()
    await new Promise((resolve) => backend.close(resolve))
  })
  const f = await fixture(t, (call) => fetch(`http://127.0.0.1:${backend.address().port}`, {
    method: call.method, body: call.body, headers: call.headers, signal: call.signal,
  }))
  const response = await f.request()
  assert.equal(response.headers.has("content-encoding"), false)
  assert.notEqual(response.headers.get("content-length"), String(compressed.length))
  assert.deepEqual(await response.json(), expected)
})

test("chat error normalization keeps text diagnostics and always declares JSON", async (t) => {
  const f = await fixture(t, () => new Response("Temperature is out of range", {
    status: 400, headers: { "content-type": "text/plain", "request-id": "req_text_error" },
  }), { config: { transport: "chat" } })
  const response = await f.request()
  assert.equal(response.status, 400)
  assert.equal(response.headers.get("content-type"), "application/json")
  const body = await response.json()
  assert.equal(body.error.type, "invalid_request_error")
  assert.equal(body.error.message, "Temperature is out of range")
  assert.equal(response.headers.get("request-id"), "req_text_error")
})

test("persisted proxy search history remains usable after the search tool is removed", async (t) => {
  let forwarded
  const f = await fixture(t, (call) => {
    forwarded = JSON.parse(call.body)
    return Response.json(message())
  })
  const response = await f.request({ messages: [
    { role: "user", content: "Look it up" },
    { role: "assistant", content: [
      { type: "server_tool_use", id: "srvtoolu_prior", name: "web_search", input: { query: "fixture" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_prior", content: [{
        type: "web_search_result", url: "https://example.com", title: "Fixture",
        encrypted_content: Buffer.from("Saved public snippet").toString("base64"),
      }] },
      { type: "text", text: "The earlier answer" },
    ] },
    { role: "user", content: "Summarize that answer" },
  ] })
  assert.equal(response.status, 200)
  assert.equal(forwarded.tools, undefined)
  assert.equal(forwarded.messages[1].content[0].type, "tool_use")
  assert.equal(forwarded.messages[2].role, "user")
  assert.equal(forwarded.messages[2].content[0].tool_use_id, "srvtoolu_prior")
  assert.match(forwarded.messages[2].content[0].content, /Saved public snippet/)
  assert.equal(forwarded.messages[3].content[0].text, "The earlier answer")
})

test("contradictory zero-use forced search is rejected before starting SSE or contacting Copilot", async (t) => {
  const f = await fixture(t, () => assert.fail("contradictory input dispatched inference"))
  const response = await f.request({
    stream: true,
    tools: [{ name: "web_search", type: "web_search_20250305", max_uses: 0 }],
    tool_choice: { type: "tool", name: "web_search" },
  })
  assert.equal(response.status, 400)
  assert.equal(response.headers.get("content-type"), "application/json")
  assert.equal(f.calls.length, 0)
})

test("history detection does not turn a native validation error into an internal TypeError", async (t) => {
  const expected = { type: "error", error: { type: "invalid_request_error", message: "content block is null" } }
  const f = await fixture(t, () => Response.json(expected, { status: 400 }))
  const response = await f.request({ messages: [{ role: "assistant", content: [null] }] })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), expected)
})

test("native streaming never closes or certifies a malformed tool input", async (t) => {
  const frames = event("message_start", {
    type: "message_start", message: { ...message(), content: [], stop_reason: null },
  }) + event("content_block_start", {
    type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_broken", name: "read", input: {} },
  }) + event("content_block_delta", {
    type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' },
  }) + event("content_block_stop", { type: "content_block_stop", index: 0 }) +
    event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) +
    event("message_stop")
  const f = await fixture(t, () => streamResponse(frames))
  const response = await f.request({ stream: true })
  const events = parsedEvents(await response.text())
  assert.equal(events.at(-1).type, "error")
  assert.equal(events.some((frame) => frame.type === "content_block_stop"), false)
  assert.equal(events.some((frame) => frame.type === "message_stop"), false)
})

test("valid native streaming tool inputs remain byte-for-byte passthrough", async (t) => {
  const frames = nativeFrames(message([{ type: "tool_use", id: "toolu_ok", name: "read", input: { path: "a.txt" } }], "tool_use"))
  const f = await fixture(t, () => streamResponse(frames, { fragments: 3 }))
  assert.equal(await (await f.request({ stream: true })).text(), frames)
})

test("native nonstreaming rejects malformed tool input shapes instead of forwarding an executable call", async (t) => {
  const f = await fixture(t, () => Response.json(message([
    { type: "tool_use", id: "toolu_broken", name: "read", input: '{"path":' },
  ], "tool_use")))
  const response = await f.request()
  assert.equal(response.status, 502)
  assert.equal((await response.json()).type, "error")
})

test("retry admission cannot dispatch after its budget or retain an abandoned queue reservation", async (t) => {
  const dispatched = []
  const f = await fixture(t, (call) => {
    dispatched.push(JSON.parse(call.body).messages[0].content)
    return dispatched.length === 1
      ? Response.json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, { status: 503, headers: { "retry-after": "0", "request-id": "req_retry" } })
      : Response.json(message())
  }, { config: { maxRetries: 1, retryBudgetMs: 50, minRequestIntervalMs: 180, maxConcurrentRequests: 1 } })
  const first = await f.request({ messages: [{ role: "user", content: "first" }] })
  assert.ok([503, 504].includes(first.status), `unexpected retry result ${first.status}`)
  await first.text()
  assert.deepEqual(dispatched, ["first"])
  const next = await f.request({ messages: [{ role: "user", content: "next" }] })
  assert.equal(next.status, 200)
  await next.text()
  assert.deepEqual(dispatched, ["first", "next"])
})

for (const streaming of [false, true]) {
  test(`search continuations honor the logical output limit (${streaming ? "SSE" : "JSON"})`, async (t) => {
    const limits = []
    const f = await fixture(t, (call) => {
      const body = JSON.parse(call.body)
      limits.push(body.max_tokens)
      let result
      if (limits.length === 1) {
        result = message([{ type: "tool_use", id: "toolu_budget", name: "web_search", input: { query: "fixture" } }], "tool_use")
        result.usage.output_tokens = 60
      } else {
        result = message([{ type: "text", text: "Bounded answer" }], body.max_tokens < 80 ? "max_tokens" : "end_turn")
        result.usage.output_tokens = Math.min(80, body.max_tokens)
      }
      return streamResponse(nativeFrames(result))
    }, { searchProvider: async () => [] })
    const response = await f.request({
      max_tokens: 100, stream: streaming,
      tools: [{ name: "web_search", type: "web_search_20250305", max_uses: 1 }],
      tool_choice: { type: "tool", name: "web_search" },
    })
    assert.equal(response.status, 200)
    if (streaming) {
      const delta = parsedEvents(await response.text()).findLast((frame) => frame.type === "message_delta")
      assert.equal(delta.usage.output_tokens, 100)
      assert.equal(delta.delta.stop_reason, "max_tokens")
    } else {
      const body = await response.json()
      assert.equal(body.usage.output_tokens, 100)
      assert.equal(body.stop_reason, "max_tokens")
    }
    assert.deepEqual(limits, [100, 40])
  })
}

test("search generation requires a final output-usage report before spending on providers or continuations", async (t) => {
  let searches = 0
  const frames = event("message_start", {
    type: "message_start", message: { ...message(), content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } },
  }) + event("content_block_start", {
    type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_usage", name: "web_search", input: { query: "fixture" } },
  }) + event("content_block_stop", { type: "content_block_stop", index: 0 }) +
    event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }) + event("message_stop")
  const f = await fixture(t, () => streamResponse(frames), { searchProvider: async () => { searches++; return [] } })
  const response = await f.request({
    max_tokens: 100, tools: [{ name: "web_search", type: "web_search_20250305", max_uses: 1 }],
  })
  assert.equal(response.status, 502)
  assert.match((await response.json()).error.message, /usage/i)
  assert.equal(searches, 0)
  assert.equal(f.calls.filter((call) => call.url.pathname === "/v1/messages").length, 1)
})
