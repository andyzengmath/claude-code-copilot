import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
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
  assert.equal(proxy.mapModel("claude-opus-5-5"), "claude-opus-5.5")
  assert.equal(proxy.mapModel("claude-opus-5.5"), "claude-opus-5.5")
  assert.equal(proxy.mapModel("claude-opus-5"), "claude-opus-5")
  assert.equal(proxy.mapModel("future-sonnet-999"), "future-sonnet-999")
  assert.equal(proxy.mapModel("claude-sonnet-4"), "claude-sonnet-4")
})

test("Claude Code's default Opus 5.5 request routes natively with adaptive settings intact", async (t) => {
  let seen
  const opus = (id) => ({ id, supported_endpoints: ["/v1/messages", "/chat/completions"], policy: { state: "enabled" } })
  const f = await fixture(t, (call) => {
    seen = call
    return streamResponse(nativeFrames(message()))
  }, { catalog: async () => Response.json({ data: [...models, opus("claude-opus-5"), opus("claude-opus-5.5")] }) })
  // Shape of Claude Code 2.1.281's default-model request (no --model).
  const body = {
    model: "claude-opus-5-5", max_tokens: 128000, stream: true,
    thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "medium" },
    messages: [{ role: "user", content: "Hello" }],
  }
  const response = await f.request(body)
  assert.equal(response.status, 200)
  assert.equal(parsedEvents(await response.text()).at(-1).type, "message_stop")
  assert.equal(seen.url.pathname, "/v1/messages")
  assert.deepEqual(JSON.parse(seen.body), { ...body, model: "claude-opus-5.5" })
})

// Copilot's 5.5 models reject a forced tool_choice ("type tool and any are not
// supported for this model") and thinking.type "disabled" with HTTP 400 on both
// endpoints. Claude Code sends both when the model is selected by its dotted
// Copilot ID, e.g. for WebSearch's nested request. The catalog marks these
// models as adaptive-only: adaptive_thinking without a manual thinking budget.
const adaptiveOnly = (id) => ({
  id, supported_endpoints: ["/v1/messages", "/chat/completions"], policy: { state: "enabled" },
  capabilities: { supports: { adaptive_thinking: true, tool_calls: true } },
})
const manualBudget = (id) => ({
  id, supported_endpoints: ["/v1/messages", "/chat/completions"], policy: { state: "enabled" },
  capabilities: { supports: { adaptive_thinking: true, max_thinking_budget: 32000, min_thinking_budget: 1024, tool_calls: true } },
})

test("adaptive-only models get auto tool choice and no disabled thinking", async (t) => {
  let seen
  const f = await fixture(t, (call) => {
    seen = call
    return Response.json(message([{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }], "tool_use"))
  }, { catalog: async () => Response.json({ data: [...models, adaptiveOnly("claude-opus-5.5")] }) })
  const body = {
    model: "claude-opus-5.5", max_tokens: 1000,
    thinking: { type: "disabled" },
    tool_choice: { type: "tool", name: "read_file", disable_parallel_tool_use: true },
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "Read it" }],
  }
  const response = await f.request(body)
  assert.equal(response.status, 200)
  const sent = JSON.parse(seen.body)
  assert.deepEqual(sent.tool_choice, { type: "auto", disable_parallel_tool_use: true })
  assert.equal(Object.hasOwn(sent, "thinking"), false)
  assert.deepEqual(sent.tools, body.tools)
})

test("models with a manual thinking budget keep forced tool choice and disabled thinking", async (t) => {
  let seen
  const f = await fixture(t, (call) => {
    seen = call
    return Response.json(message([{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }], "tool_use"))
  }, { catalog: async () => Response.json({ data: [...models, manualBudget("claude-opus-5")] }) })
  const body = {
    model: "claude-opus-5", max_tokens: 1000,
    thinking: { type: "disabled" },
    tool_choice: { type: "any" },
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "Read it" }],
  }
  assert.equal((await f.request(body)).status, 200)
  assert.deepEqual(JSON.parse(seen.body), body)
})

// The adaptation only rewrites requests that are valid as sent. A malformed
// choice or thinking setting must reach the same validation it would on any
// other model, rather than being quietly repaired into an upstream call.
for (const transport of ["messages", "chat"]) {
  test(`adaptive-only models still get a valid forced choice downgraded over ${transport}`, async (t) => {
    let seen
    const f = await fixture(t, (call) => {
      seen = call
      return transport === "chat"
        ? Response.json({ id: "chat_fixture", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })
        : Response.json(message())
    }, { config: { transport, forwardReasoning: false }, catalog: async () => Response.json({ data: [...models, adaptiveOnly("claude-opus-5.5")] }) })
    const response = await f.request({
      model: "claude-opus-5.5", thinking: { type: "disabled" },
      tool_choice: { type: "tool", name: "read_file" },
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
    })
    assert.equal(response.status, 200)
    const sent = JSON.parse(seen.body)
    assert.equal(Object.hasOwn(sent, "thinking"), false)
    assert.deepEqual(sent.tool_choice, transport === "chat" ? "auto" : { type: "auto" })
  })

  test(`malformed choices on adaptive-only models are not repaired over ${transport}`, async (t) => {
    const seen = []
    const f = await fixture(t, (call) => {
      seen.push(JSON.parse(call.body))
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "rejected upstream" } }, { status: 400 })
    }, {
      config: { transport, forwardReasoning: false },
      catalog: async () => Response.json({ data: [...models, adaptiveOnly("claude-opus-5.5")] }),
    })
    const tools = [{ name: "read_file", input_schema: { type: "object" } }]
    const choices = [{ type: "tool", name: "undeclared" }, { type: "any" }, { type: "tool" }]
    for (const [index, tool_choice] of choices.entries()) {
      const response = await f.request({ model: "claude-opus-5.5", tool_choice, ...(index === 1 ? {} : { tools }) })
      assert.equal(response.status, 400)
    }
    if (transport === "chat") {
      // The chat adapter validates locally, so nothing reaches Copilot.
      assert.equal(seen.length, 0)
    } else {
      // Native has no local tool_choice validation: each request goes upstream
      // unchanged and Copilot rejects it, as it would for any other model.
      assert.deepEqual(seen.map((body) => body.tool_choice), choices)
    }
  })
}

test("a null tool choice on an adaptive-only model is left for validation, not a crash", async (t) => {
  let seen
  const f = await fixture(t, (call) => {
    seen = call
    return Response.json(message())
  }, { catalog: async () => Response.json({ data: [...models, adaptiveOnly("claude-opus-5.5")] }) })
  const response = await f.request({ model: "claude-opus-5.5", thinking: { type: "disabled" }, tool_choice: null })
  assert.notEqual(response.status, 500)
  if (seen) assert.equal(JSON.parse(seen.body).tool_choice, null)
})

test("thinking disabled with extra fields is not silently dropped", async (t) => {
  let seen
  const f = await fixture(t, (call) => {
    seen = call
    return Response.json(message())
  }, { catalog: async () => Response.json({ data: [...models, adaptiveOnly("claude-opus-5.5")] }) })
  await f.request({ model: "claude-opus-5.5", thinking: { type: "disabled", budget_tokens: 5 } })
  assert.deepEqual(JSON.parse(seen.body).thinking, { type: "disabled", budget_tokens: 5 })
})

// Claude Code's auto mode asks the API for server-side classifier review with a
// top-level `safeguards` field and the dangerous-tool-use beta. Copilot rejects
// the field ("safeguards: Extra inputs are not permitted") and cannot run the
// classifier, so forwarding it only costs a failed request before Claude Code
// retries without it. Strip both so the session falls back to local review.
test("auto mode safeguards and their beta are not forwarded to Copilot", async (t) => {
  let seen
  const f = await fixture(t, (call) => {
    seen = call
    return Response.json(message())
  })
  const body = { safeguards: [{ type: "dangerous_tool_use", classifier_context: { v: 1 } }] }
  const response = await f.request(body, undefined, {
    headers: { "x-api-key": key, "anthropic-beta": "claude-code-20250219,dangerous-tool-use-2026-09-03,effort-2025-11-24" },
  })
  assert.equal(response.status, 200)
  assert.equal(Object.hasOwn(JSON.parse(seen.body), "safeguards"), false)
  assert.equal(new Headers(seen.headers).get("anthropic-beta"), "claude-code-20250219,effort-2025-11-24")
})

test("a beta header carrying only the safeguards beta is dropped rather than sent empty", async (t) => {
  let seen
  const f = await fixture(t, (call) => {
    seen = call
    return Response.json(message())
  })
  await f.request({ safeguards: [] }, undefined, { headers: { "x-api-key": key, "anthropic-beta": "dangerous-tool-use-2026-09-03" } })
  assert.equal(new Headers(seen.headers).has("anthropic-beta"), false)
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

test("health proves possession of the local key only for a well-formed nonce", async (t) => {
  const f = await fixture(t, () => assert.fail("no upstream calls"))
  const nonce = "0123456789abcdef0123456789abcdef"
  const proven = await (await fetch(`${f.base}/health?nonce=${nonce}`)).json()
  assert.equal(proven.key_proof, createHmac("sha256", f.key).update(`claude-code-copilot health ${nonce}`).digest("hex"))
  for (const query of ["", "?nonce=short", `?nonce=${nonce.toUpperCase()}`]) {
    assert.deepEqual(await (await fetch(`${f.base}/health${query}`)).json(), { status: "ok", provider: "github-copilot", api_key_required: true })
  }
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
  assert.deepEqual(catalog.data.map((entry) => entry.id), ["claude-sonnet-5", "claude-haiku-4-5"])
  assert.equal((await f.request({ model: "hidden-utility" })).status, 200)
  assert.equal((await f.request({ model: "claude-opus-disabled" })).status, 403)
  assert.equal(f.calls.filter((call) => call.url.pathname === "/models").length, 1)
})

// Claude Code sizes the context window, output limit and request shape from the
// model ID. It recognizes the dashed Claude API spelling but treats Copilot's
// dotted IDs as unknown: claude-opus-4.7 gets a 200K window instead of 1M, and
// claude-opus-5.5 gets the pre-5.5 request shape. So advertise the dashed form,
// which routes back to the same catalog entry, and keep the readable name.
test("model discovery advertises Claude API spellings that route to the same catalog entry", async (t) => {
  let seen
  const f = await fixture(t, (call) => {
    seen = call
    return Response.json(message())
  }, { catalog: async () => Response.json({ data: [
    { ...adaptiveOnly("claude-opus-5.5"), name: "Claude Opus 5.5" },
    { ...manualBudget("claude-opus-4.7"), name: "Claude Opus 4.7" },
    { id: "claude-haiku-4.5", supported_endpoints: ["/v1/messages"], policy: { state: "enabled" } },
    { id: "gpt-5.5", name: "GPT-5.5", supported_endpoints: ["/chat/completions"], policy: { state: "enabled" } },
  ] }) })
  const catalog = await (await fetch(`${f.base}/v1/models`, { headers: { "x-api-key": key } })).json()
  assert.deepEqual(catalog.data.map(({ id, display_name }) => [id, display_name]), [
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-opus-4-7", "Claude Opus 4.7"],
    ["claude-haiku-4-5", "claude-haiku-4-5"],
    ["gpt-5.5", "GPT-5.5"],
  ])
  assert.equal(catalog.first_id, "claude-opus-5-5")
  assert.equal(catalog.last_id, "gpt-5.5")
  assert.equal((await f.request({ model: "claude-opus-4-7" })).status, 200)
  assert.equal(JSON.parse(seen.body).model, "claude-opus-4.7")
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

test("a native stream cut off inside an event still ends with a parseable error event", async (t) => {
  const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } }
  const frames = event("message_start", { type: "message_start", message: { ...message(), content: [], stop_reason: null } }) +
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    `event: content_block_delta\ndata: ${JSON.stringify(delta)}`
  const f = await fixture(t, () => streamResponse(frames))
  const events = parsedEvents(await (await f.request({ stream: true })).text())
  assert.deepEqual(events.map((entry) => entry.type), ["message_start", "content_block_start", "content_block_delta", "error"])
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
  assert.deepEqual(await discover(), ["claude-haiku-4-5"])
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

// Claude Code 2.1.286 builds WebSearch's nested request with a forced
// web_search choice and disabled thinking whenever it does not recognize the
// model ID as a 5.5 model, which includes Copilot's dotted IDs. Copilot's 5.5
// models reject both fields, so every search round must be adapted.
test("WebSearch on an adaptive-only model sends auto choice and no disabled thinking on every round", async (t) => {
  const sent = []
  const f = await fixture(t, (call) => {
    const body = JSON.parse(call.body)
    sent.push(body)
    const result = sent.length === 1
      ? message([{ type: "tool_use", id: "toolu_search", name: "web_search", input: { query: "node 24 lts" } }], "tool_use")
      : message([{ type: "text", text: "Answer" }])
    return streamResponse(nativeFrames(result))
  }, {
    catalog: async () => Response.json({ data: [...models, adaptiveOnly("claude-opus-5.5")] }),
    searchProvider: async () => [],
  })
  const response = await f.request({
    model: "claude-opus-5.5", max_tokens: 64000, stream: true,
    thinking: { type: "disabled" }, output_config: { effort: "high" },
    system: [{ type: "text", text: "You are an assistant for performing a web search tool use" }],
    messages: [{ role: "user", content: "Perform a web search for the query: node 24 lts" }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    tool_choice: { type: "tool", name: "web_search" },
  })
  assert.equal(response.status, 200)
  assert.equal(parsedEvents(await response.text()).at(-1).type, "message_stop")
  assert.equal(sent.length, 2)
  for (const body of sent) {
    assert.notEqual(body.tool_choice?.type, "tool")
    assert.equal(Object.hasOwn(body, "thinking"), false)
    assert.deepEqual(body.output_config, { effort: "high" })
  }
})

// Hosted web search: Claude Code's nested WebSearch request is answered by one
// Copilot /responses call that runs OpenAI's server-side web_search tool.
const lunaModel = {
  id: "gpt-6-luna", supported_endpoints: ["/responses", "ws:/responses"], policy: { state: "enabled" },
  capabilities: { limits: { max_output_tokens: 128000 } },
}
const withLuna = { catalog: async () => Response.json({ data: [...models, lunaModel] }) }
const hostedReply = () => ({
  id: "resp_fixture", object: "response", status: "completed", model: "gpt-6-luna",
  output: [
    { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "node lts", sources: [{ type: "url", url: "https://nodejs.org/en/about/previous-releases" }] } },
    { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Node 26 is LTS.", annotations: [] }] },
  ],
  usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 40 },
})
const nestedWebSearch = (overrides = {}, tool = {}) => ({
  model: "claude-sonnet-5", max_tokens: 64000, stream: true,
  system: [{ type: "text", text: "You run a web search for another Claude model." }],
  messages: [{ role: "user", content: "Perform a web search for the query: node lts" }],
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, search_profile: "default", ...tool }],
  tool_choice: { type: "tool", name: "web_search" },
  ...overrides,
})
const providerResult = { type: "web_search_result", url: "https://example.com/node", title: "Example", encrypted_content: Buffer.from("snippet").toString("base64"), page_age: null }
const emulationRound = (body, rounds) => {
  rounds.push(body)
  return streamResponse(nativeFrames(rounds.length === 1
    ? message([{ type: "tool_use", id: "toolu_s", name: "web_search", input: { query: "node lts" } }], "tool_use")
    : message([{ type: "text", text: "Emulated answer" }])))
}

for (const streaming of [true, false]) {
  test(`Claude Code's nested WebSearch is answered by one hosted GPT-6 Luna search (${streaming ? "streaming" : "JSON"})`, async (t) => {
    const sent = []
    const f = await fixture(t, (call) => {
      sent.push(call)
      assert.equal(call.url.pathname, "/responses", "no Claude generation for a hosted search")
      return Response.json(hostedReply())
    }, withLuna)
    const response = await f.request(nestedWebSearch({ stream: streaming }), undefined, {
      headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "fixture-beta-2026-01-01" },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("x-copilot-search-model"), "gpt-6-luna")
    assert.equal(sent.length, 1)
    const headers = new Headers(sent[0].headers)
    assert.equal(headers.get("authorization"), `Bearer ${token}`)
    assert.equal(headers.get("anthropic-beta"), null)
    assert.equal(headers.get("anthropic-version"), null)
    const payload = JSON.parse(sent[0].body)
    assert.equal(payload.model, "gpt-6-luna")
    assert.equal(payload.tool_choice, "required")
    assert.deepEqual(payload.tools, [{ type: "web_search", search_context_size: "low" }])
    const expectedContent = [
      { type: "server_tool_use", id: "srvtoolu_ws_1", name: "web_search", input: { query: "node lts" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_ws_1", content: [{ type: "web_search_result", url: "https://nodejs.org/en/about/previous-releases", title: "nodejs.org", encrypted_content: "", page_age: null }] },
      { type: "text", text: "Node 26 is LTS." },
    ]
    if (streaming) {
      const events = parsedEvents(await response.text())
      assert.deepEqual(events.map((event) => event.type), [
        "message_start", "content_block_start", "content_block_delta", "content_block_stop",
        "content_block_start", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop",
        "message_delta", "message_stop",
      ])
      assert.equal(events.at(-2).delta.stop_reason, "end_turn")
      assert.deepEqual(events.at(-2).usage.server_tool_use, { web_search_requests: 1 })
      assert.equal(events.at(-2).usage.output_tokens, 40)
    } else {
      const body = await response.json()
      assert.deepEqual(body.content, expectedContent)
      assert.equal(body.stop_reason, "end_turn")
      assert.equal(body.usage.input_tokens, 900)
    }
  })
}

test("a failed hosted search falls back to provider search with a single message_start", async (t) => {
  const paths = []
  const rounds = []
  const f = await fixture(t, (call) => {
    paths.push(call.url.pathname)
    if (call.url.pathname === "/responses") return Response.json({ error: { message: "hosted search unavailable" } }, { status: 500 })
    return emulationRound(JSON.parse(call.body), rounds)
  }, { ...withLuna, searchProvider: async () => [providerResult] })
  const response = await f.request(nestedWebSearch())
  assert.equal(response.status, 200)
  const events = parsedEvents(await response.text())
  assert.equal(events.filter((event) => event.type === "message_start").length, 1)
  assert.equal(events.at(-1).type, "message_stop")
  assert.ok(events.some((event) => event.content_block?.type === "web_search_tool_result" && event.content_block.content[0]?.url === providerResult.url))
  assert.ok(events.some((event) => event.delta?.text === "Emulated answer"))
  assert.deepEqual(paths, ["/responses", "/v1/messages", "/v1/messages"])
})

test("provider search is used when the hosted search model, mode or request does not allow hosted search", async (t) => {
  const catalogWith = (entry) => ({ catalog: async () => Response.json({ data: [...models, entry] }) })
  for (const [name, options, request] of [
    ["model missing from the catalog", {}, nestedWebSearch()],
    ["model disabled by policy", catalogWith({ ...lunaModel, policy: { state: "disabled" } }), nestedWebSearch()],
    ["model without /responses", catalogWith({ ...lunaModel, supported_endpoints: ["/chat/completions"] }), nestedWebSearch()],
    ["WEB_SEARCH_MODE=providers", { ...withLuna, config: { webSearchMode: "providers" } }, nestedWebSearch()],
    ["blocked_domains", withLuna, nestedWebSearch({}, { blocked_domains: ["example.org"] })],
    ["stop_sequences", withLuna, nestedWebSearch({ stop_sequences: ["<END>"] })],
    ["temperature", withLuna, nestedWebSearch({ temperature: 0 })],
  ]) {
    const paths = []
    const rounds = []
    const f = await fixture(t, (call) => {
      paths.push(call.url.pathname)
      return emulationRound(JSON.parse(call.body), rounds)
    }, { ...options, searchProvider: async () => [providerResult] })
    const response = await f.request(request)
    assert.equal(response.status, 200, name)
    assert.equal(parsedEvents(await response.text()).at(-1).type, "message_stop", name)
    assert.deepEqual(paths, ["/v1/messages", "/v1/messages"], name)
  }
})

test("provider search receives the account token for GitHub's own search", async (t) => {
  const seen = []
  const rounds = []
  const f = await fixture(t, (call) => emulationRound(JSON.parse(call.body), rounds), {
    config: { webSearchMode: "providers" },
    searchProvider: async (query, options) => { seen.push(options.token); return [providerResult] },
  })
  const response = await f.request(nestedWebSearch())
  assert.equal(response.status, 200)
  await response.text()
  assert.deepEqual(seen, [token])
})

test("a rate-limited hosted search falls back at once, pauses hosted search and never throttles Claude traffic", async (t) => {
  const paths = []
  const rounds = []
  const f = await fixture(t, (call) => {
    paths.push(call.url.pathname)
    if (call.url.pathname === "/responses") {
      return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "60" } })
    }
    const body = JSON.parse(call.body)
    return body.tools ? emulationRound(body, rounds) : streamResponse(nativeFrames(message()))
  }, { ...withLuna, config: { maxRetries: 3 }, searchProvider: async () => [providerResult] })
  const first = await f.request(nestedWebSearch())
  assert.equal(first.status, 200)
  assert.equal(parsedEvents(await first.text()).at(-1).type, "message_stop")
  assert.deepEqual(paths, ["/responses", "/v1/messages", "/v1/messages"])
  const plain = await f.request({ stream: true })
  assert.equal(plain.status, 200)
  assert.equal(parsedEvents(await plain.text()).at(-1).type, "message_stop")
  paths.length = 0
  rounds.length = 0
  const second = await f.request(nestedWebSearch())
  assert.equal(parsedEvents(await second.text()).at(-1).type, "message_stop")
  assert.deepEqual(paths, ["/v1/messages", "/v1/messages"], "hosted search stays paused for the Retry-After period")
})

test("hosted search is attempted once even when Copilot retries are enabled", async (t) => {
  const paths = []
  const rounds = []
  const f = await fixture(t, (call) => {
    paths.push(call.url.pathname)
    if (call.url.pathname === "/responses") return Response.json({ error: { message: "boom" } }, { status: 500 })
    return emulationRound(JSON.parse(call.body), rounds)
  }, { ...withLuna, config: { maxRetries: 3 }, searchProvider: async () => [providerResult] })
  const response = await f.request(nestedWebSearch())
  assert.equal(parsedEvents(await response.text()).at(-1).type, "message_stop")
  assert.deepEqual(paths, ["/responses", "/v1/messages", "/v1/messages"])
})

test("a hosted answer without a completed search falls back, and its tokens are still reported", async (t) => {
  const paths = []
  const rounds = []
  const f = await fixture(t, (call) => {
    paths.push(call.url.pathname)
    if (call.url.pathname === "/responses") return Response.json({ ...hostedReply(), output: [hostedReply().output[1]] })
    return emulationRound(JSON.parse(call.body), rounds)
  }, { ...withLuna, searchProvider: async () => [providerResult] })
  const response = await f.request(nestedWebSearch({ stream: false }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(paths, ["/responses", "/v1/messages", "/v1/messages"])
  assert.equal(body.content.at(-1).text, "Emulated answer")
  assert.equal(body.usage.input_tokens, 900 + 2 * 9)
  assert.equal(body.usage.output_tokens, 40 + 2 * 3)
})

test("Claude Code's 5.5 WebSearch request with automatic choice still makes the hosted model search", async (t) => {
  let payload
  const f = await fixture(t, (call) => {
    payload = JSON.parse(call.body)
    return Response.json(hostedReply())
  }, { catalog: async () => Response.json({ data: [...models, adaptiveOnly("claude-opus-5.5"), lunaModel] }) })
  // Shape Claude Code 2.1.303 sends for its 5.5 models (captured from the installed client).
  const response = await f.request(nestedWebSearch({
    model: "claude-opus-5-5", max_tokens: 128000, tool_choice: { type: "auto" }, output_config: { effort: "medium" },
    metadata: { user_id: "fixture-user" },
  }))
  assert.equal(response.status, 200)
  assert.equal(parsedEvents(await response.text()).at(-1).type, "message_stop")
  assert.equal(payload.model, "gpt-6-luna")
  assert.equal(payload.tool_choice, "required")
})

test("a client abort during hosted search cancels it without falling back", { timeout: 2500 }, async (t) => {
  const paths = []
  let hostedSignal
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const f = await fixture(t, (call) => {
    paths.push(call.url.pathname)
    hostedSignal = call.signal
    started()
    return new Promise(() => {})
  }, { ...withLuna, config: { requestTimeoutMs: 10000 }, searchProvider: async () => assert.fail("no provider search after an abort") })
  const controller = new AbortController()
  const pending = f.request(nestedWebSearch(), undefined, { signal: controller.signal })
  await ready
  controller.abort()
  await assert.rejects(pending)
  while (!hostedSignal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(paths, ["/responses"])
})

test("hosted search serves Chat-transport models, and other searches there get 501 before any output", async (t) => {
  const paths = []
  const f = await fixture(t, (call) => {
    paths.push(call.url.pathname)
    return Response.json(hostedReply())
  }, { ...withLuna, config: { transport: "chat" } })
  const response = await f.request(nestedWebSearch())
  assert.equal(response.status, 200)
  assert.equal(parsedEvents(await response.text()).at(-1).type, "message_stop")
  const blocked = await f.request(nestedWebSearch({}, { blocked_domains: ["example.org"] }))
  assert.equal(blocked.status, 501)
  assert.equal((await blocked.json()).type, "error")
  assert.deepEqual(paths, ["/responses"])
})

test("unknown search tool fields and an unused user_location are reported once, escaped and bounded", async (t) => {
  const warnings = []
  const rounds = []
  const f = await fixture(t, (call) => emulationRound(JSON.parse(call.body), rounds), {
    config: { webSearchMode: "providers" }, searchProvider: async () => [providerResult],
    logger: { log() {}, error() {}, warn: (line) => warnings.push(line) },
  })
  const fields = Object.fromEntries(["a\n[2026-11-18] POST /v1/messages", "b", "c", "d", "e", "f", "g"].map((name) => [name, true]))
  for (let attempt = 0; attempt < 2; attempt++) {
    rounds.length = 0
    const response = await f.request(nestedWebSearch({}, { ...fields, user_location: { type: "approximate", country: "US" } }))
    assert.equal(parsedEvents(await response.text()).at(-1).type, "message_stop")
  }
  assert.deepEqual(warnings, [
    'Ignored unsupported web_search tool field(s): "a\\n[2026-11-18] POST /v1/messages", "b", "c", "d", "e" and 2 more',
    "Provider web search ignored the web_search user_location",
  ])
})

test("provider search forwards only a plain custom web_search tool to Claude", async (t) => {
  const rounds = []
  const f = await fixture(t, (call) => emulationRound(JSON.parse(call.body), rounds), {
    config: { webSearchMode: "providers" }, searchProvider: async () => [providerResult],
  })
  const response = await f.request(nestedWebSearch({}, {
    search_profile: "default", future_hint: true, allowed_domains: ["example.com"], cache_control: { type: "ephemeral" },
  }))
  assert.equal(parsedEvents(await response.text()).at(-1).type, "message_stop")
  const forwarded = rounds[0].tools.find((tool) => tool.name === "web_search")
  assert.deepEqual(Object.keys(forwarded).sort(), ["cache_control", "description", "input_schema", "name"])
})

test("provider search asks GitHub's own search first, with the account token", async (t) => {
  const rounds = []
  const searches = []
  const github = { search_result_groups: [{ search_result_type: "webResults", items: [{ title: "Node.js", url: "https://nodejs.org/en/download", snippets: ["Downloads"] }] }], error_message: null }
  const f = await fixture(t, (call) => {
    if (call.url.pathname !== "/mcp/") return emulationRound(JSON.parse(call.body), rounds)
    searches.push(call)
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(github) }] } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } })
  }, { config: { webSearchMode: "providers" } })
  const response = await f.request(nestedWebSearch({ stream: false }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(searches.length, 1)
  assert.equal(new Headers(searches[0].headers).get("authorization"), `Bearer ${token}`)
  assert.deepEqual(body.content.find((block) => block.type === "web_search_tool_result").content.map((result) => result.url), ["https://nodejs.org/en/download"])
})

test("Claude 5.5 IDs missing from the catalog are rejected, never routed to another version", async (t) => {
  const f = await fixture(t, () => assert.fail("no inference dispatch for an uncatalogued version"))
  for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
    const response = await f.request({ model })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /versions are not substituted/)
  }
  assert.ok(f.calls.every((call) => call.url.pathname === "/models"))
})

test("model discovery lists only models that serve Claude requests", async (t) => {
  const f = await fixture(t, () => assert.fail("no inference"), withLuna)
  const response = await fetch(`${f.base}/v1/models`, { headers: { "x-api-key": f.key } })
  const ids = (await response.json()).data.map((model) => model.id)
  assert.equal(ids.includes("gpt-6-luna"), false)
  assert.ok(ids.includes("claude-sonnet-5"))
})

for (const [name, frames] of [
  ["ends without message_stop", event("message_start", { type: "message_start", message: { ...message(), content: [], stop_reason: null } }) +
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })],
  ["sends an error event", event("message_start", { type: "message_start", message: { ...message(), content: [], stop_reason: null } }) +
    event("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })],
]) {
  test(`a search generation that ${name} reports an error, never a finished message`, async (t) => {
    const f = await fixture(t, () => streamResponse(frames), {
      config: { webSearchMode: "providers" }, searchProvider: async () => assert.fail("no search without a complete generation"),
    })
    const events = parsedEvents(await (await f.request(nestedWebSearch())).text())
    assert.equal(events.at(-1).type, "error")
    assert.equal(events.some((entry) => entry.type === "message_stop" || entry.type === "message_delta"), false)
    if (name === "sends an error event") assert.equal(events.at(-1).error.type, "overloaded_error")
  })
}

test("a chat stream that ends without finishing reports an error, never a finished message", async (t) => {
  const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`
  const f = await fixture(t, () => streamResponse(frames), { config: { transport: "chat" } })
  const events = parsedEvents(await (await f.request({ stream: true })).text())
  assert.equal(events.at(-1).type, "error")
  assert.equal(events.some((entry) => entry.type === "message_stop"), false)
})
