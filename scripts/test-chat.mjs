import assert from "node:assert/strict"
import test from "node:test"

import * as chat from "./chat.mjs"
const { translateMessages, translateContentPart, translateResponseToAnthropic,
  buildAnthropicUsage, createStreamTranslator } = chat
const request = (fields = {}) => ({
  model: "claude-sonnet-4-5", max_tokens: 32,
  messages: [{ role: "user", content: "hello" }], ...fields,
})
const build = (...args) => {
  assert.equal(typeof chat.buildChatRequest, "function", "chat adapter must expose buildChatRequest")
  return chat.buildChatRequest(...args)
}
const invalid = (fn) => assert.throws(fn, (error) =>
  error.status === 400 && error.type === "invalid_request_error" && /use native Messages/i.test(error.message))
const upstreamError = (fn) => assert.throws(fn, (error) => error.status === 502 && error.type === "api_error")
const chunk = (delta = {}, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] })
const call = (index, id, name, args = "") => ({
  index, id, type: "function", function: { name, arguments: args },
})
const response = (message = { content: "hello" }, finish_reason = "stop") => ({
  id: "chat_fixture", choices: [{ message, finish_reason }],
})
function sink() {
  const events = []
  return {
    events,
    write(frame) {
      const match = /^event: ([^\n]+)\ndata: ([^\n]+)\n\n$/.exec(frame)
      assert.ok(match, "each write is a complete SSE frame")
      const data = JSON.parse(match[2])
      assert.equal(data.type, match[1])
      events.push(data)
      return false // Backpressure belongs to the parent's frame collector.
    },
  }
}
const eventsOf = (res, type) => res.events.filter((event) => event.type === type)

test("unexpected EOF is an error, not a successful empty or partial response", () => {
  for (const sendText of [false, true]) {
    const res = sink()
    const translator = createStreamTranslator("model", res)
    if (sendText) translator.processChunk(chunk({ content: "partial" }))
    upstreamError(() => translator.processChunk(null))
    assert.equal(eventsOf(res, "message_stop").length, 0)
  }
})

test("finish records intent; trailing usage is included only at DONE", () => {
  const res = sink()
  const translator = createStreamTranslator("model", res)
  assert.equal(translator.processChunk(chunk({ content: "hello" }, "stop")), false)
  assert.equal(eventsOf(res, "message_delta").length, 0)
  assert.equal(eventsOf(res, "message_stop").length, 0)
  assert.equal(translator.processChunk({
    choices: [], usage: { prompt_tokens: 101, completion_tokens: 17, prompt_tokens_details: { cached_tokens: 11 } },
  }), false)
  assert.equal(translator.processChunk("[DONE]"), true)
  assert.deepEqual(eventsOf(res, "message_delta")[0].usage, {
    input_tokens: 90, output_tokens: 17, cache_read_input_tokens: 11, cache_creation_input_tokens: 0,
  })
  assert.equal(translator.processChunk(null), true)
  assert.equal(translator.processChunk("[DONE]"), true)
  assert.equal(eventsOf(res, "message_stop").length, 1)
})

test("mid-conversation system messages retain their position", () => {
  const history = [
    { role: "user", content: "before" }, { role: "system", content: "changed instructions" },
    { role: "assistant", content: "after" },
  ]
  assert.deepEqual(translateMessages(history), history)
  assert.deepEqual(translateMessages(history, [{ type: "text", text: "initial" }]), [
    { role: "system", content: "initial" }, ...history,
  ])
})

test("supported URL and base64 images survive translation unchanged", () => {
  for (const [source, url] of [
    [{ type: "url", url: "https://example.com/image.png" }, "https://example.com/image.png"],
    [{ type: "base64", media_type: "image/png", data: "AAAA" }, "data:image/png;base64,AAAA"],
  ]) assert.deepEqual(translateContentPart({ type: "image", source }), { type: "image_url", image_url: { url } })
})

test("unsupported content never becomes stringified prompt text or disappears", () => {
  for (const part of [
    { type: "image", source: { type: "file", file_id: "file_secret" } },
    { type: "image", source: { type: "base64" } },
    { type: "image", source: { type: "url", url: "file:///secret" } },
    { type: "document", source: { type: "base64", data: "SECRET" } },
    { type: "thinking", thinking: "private" },
    { type: "redacted_thinking", data: "opaque" },
    { type: "server_tool_use", id: "srv", name: "web_search", input: {} },
    { type: "future_content" }, { type: "text", text: 3 },
  ]) invalid(() => translateContentPart(part))
})

test("tool results retain error markers and move images into user content", () => {
  const translated = translateMessages([{
    role: "user", content: [{
      type: "tool_result", tool_use_id: "call_1", is_error: true,
      content: [
        { type: "text", text: "Screenshot failed" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "SCREENSHOT" } },
      ],
    }],
  }])
  assert.equal(translated[0].role, "tool")
  assert.equal(translated[0].tool_call_id, "call_1")
  assert.match(translated[0].content, /error/i)
  assert.match(translated[0].content, /Screenshot failed/)
  assert.match(translated[0].content, /image.*attached/i)
  assert.equal(translated[0].content.includes("SCREENSHOT"), false)
  assert.equal(translated[1].role, "user")
  assert.equal(translated[1].content.find((part) => part.type === "image_url").image_url.url,
    "data:image/png;base64,SCREENSHOT")
  invalid(() => translateMessages([{
    role: "user", content: [{ type: "tool_result", tool_use_id: "call_1",
      content: [{ type: "image", source: { type: "file", file_id: "secret" } }] }],
  }]))
})

test("assistant history preserves custom calls without inventing missing inputs", () => {
  assert.deepEqual(translateMessages([{
    role: "assistant", content: [{ type: "text", text: "read" },
      { type: "tool_use", id: "call_1", name: "read", input: { path: "a" } }],
  }]), [{ role: "assistant", content: "read", tool_calls: [
    { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
  ] }])
  for (const content of [
    [{ type: "thinking", thinking: "private" }],
    [{ type: "tool_use", id: "call_1", name: "read" }],
    [{ type: "tool_use", id: "", name: "read", input: {} }],
    [{ type: "tool_use", id: "call_1", name: "read", input: [] }],
    [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
  ]) invalid(() => translateMessages([{ role: "assistant", content }]))
})

test("request maps sampling, preserves max_tokens zero, and never normalizes models", () => {
  const body = build(request({
    max_tokens: 0, temperature: 0, top_p: 0, stop_sequences: ["end"],
  }))
  assert.equal(body.model, "claude-sonnet-4-5")
  assert.equal(body.max_tokens, 0)
  assert.equal(body.temperature, 0)
  assert.equal(body.top_p, 0)
  assert.deepEqual(body.stop, ["end"])
  assert.equal(body.stream, false)
  assert.equal(Object.hasOwn(body, "stream_options"), false)
  assert.equal(build(request({ max_tokens: undefined })).max_tokens, 4096)
  assert.equal(build(request(), { model: "resolved" }).model, "resolved")
  assert.deepEqual(build(request({ stream: true })).stream_options, { include_usage: true })
})

test("tool choice mappings and parallel control preserve caller intent", () => {
  const tools = [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: {} } }]
  for (const [choice, expected] of [
    [{ type: "auto" }, "auto"], [{ type: "none" }, "none"],
    [{ type: "any" }, "required"], [{ type: "tool", name: "read" }, { type: "function", function: { name: "read" } }],
  ]) {
    const body = build(request({ tools, tool_choice: { ...choice, disable_parallel_tool_use: true } }))
    assert.deepEqual(body.tool_choice, expected)
    assert.equal(body.parallel_tool_calls, false)
    assert.deepEqual(body.tools, [{ type: "function", function: {
      name: "read", description: "Read a file", parameters: tools[0].input_schema,
    } }])
  }
  assert.equal(Object.hasOwn(build(request({ tools })), "parallel_tool_calls"), false)
  invalid(() => build(request({ tools, tool_choice: { type: "tool", name: "missing" } })))
  invalid(() => build(request({ tool_choice: { type: "any" } })))
  invalid(() => build(request({ tools: [{ type: "web_search_20250305", name: "web_search" }] })))
  invalid(() => build(request({ tools: [{ type: "future_tool", name: "read", input_schema: {} }] })))
})

test("cache hints and newer semantics are explicitly rejected at every represented level", () => {
  for (const fields of [
    { cache_control: { type: "ephemeral" } },
    { context_management: { edits: [] } },
    { output_config: { format: { type: "json_schema", schema: {} } } },
    { metadata: { arbitrary: "bookkeeping" } }, { top_k: 5 }, { future_option: true },
    { system: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }] },
    { messages: [{ role: "system", content: [{ type: "text", text: "cached", cache_control: {} }] }] },
    { messages: [{ role: "user", content: [{ type: "text", text: "cached", cache_control: {} }] }] },
    { messages: [{ role: "assistant", content: [{ type: "text", text: "cached", citations: [] }] }] },
    { tools: [{ name: "read", input_schema: {}, cache_control: {} }] },
    { tools: [{ name: "read", input_schema: {}, eager_input_streaming: true }] },
  ]) invalid(() => build(request(fields)))
  assert.equal(build(request({ metadata: { user_id: "opaque-user" } })).user, "opaque-user")
})

test("legacy reasoning is restricted rather than guessed, upgraded or clamped", () => {
  for (const fields of [
    { thinking: { type: "enabled", budget_tokens: 4096 } },
    { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
    { output_config: { effort: "none" } }, { output_config: { effort: "minimal" } },
    { thinking: { type: "disabled" } },
  ]) {
    invalid(() => build(request(fields), { modelInfo: { id: "claude-opus-5" } }))
    const optedOut = build(request(fields), { forwardReasoning: false })
    assert.equal(Object.hasOwn(optedOut, "reasoning_effort"), false)
    assert.equal(Object.hasOwn(optedOut, "thinking"), false)
    assert.equal(Object.hasOwn(optedOut, "output_config"), false)
  }
  invalid(() => build(request({ thinking: { type: "future" } }), { forwardReasoning: false }))
  invalid(() => build(request({ output_config: { effort: "high", format: {} } }), { forwardReasoning: false }))
  invalid(() => build(request({
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "history" }] }],
  }), { forwardReasoning: false }))
})

test("invalid caller shapes produce typed caller errors", () => {
  for (const fields of [
    { messages: null }, { messages: [{ role: "future", content: "hello" }] },
    { messages: [{ role: "user", content: null }] }, { stream: "true" },
    { max_tokens: -1 }, { max_tokens: 0.5 }, { temperature: "1" },
    { top_p: 2 }, { stop_sequences: [3] }, { tools: {} },
    { tool_choice: { type: "auto", disable_parallel_tool_use: "false" } },
  ]) invalid(() => build(request(fields)))
})

test("nonstream text and tool responses have validated stop reasons and inputs", () => {
  const text = translateResponseToAnthropic(response(), "model")
  assert.equal(text.stop_reason, "end_turn")
  assert.deepEqual(text.content, [{ type: "text", text: "hello" }])
  const tool = translateResponseToAnthropic(response({
    role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
  }, "tool_calls"), "model")
  assert.equal(tool.stop_reason, "tool_use")
  assert.deepEqual(tool.content, [{ type: "tool_use", id: "call_1", name: "read", input: { path: "a" } }])
  assert.equal(translateResponseToAnthropic(response({ content: "" }, "length"), "model").stop_reason, "max_tokens")
})

test("malformed nonstream envelopes and unsupported finishes cannot fabricate success", () => {
  for (const data of [
    null, {}, { choices: [] }, { choices: [{}] }, response({}),
    response({ content: null }), response({ content: 1 }), response({ role: "user", content: "hi" }),
    response({ content: "hi" }, null), response({ content: "hi" }, "content_filter"),
    response({ content: "hi" }, "future"), response({ content: "hi" }, "tool_calls"),
    response({ content: "hi", refusal: "blocked" }),
    { error: { message: "SECRET upstream text" }, ...response() },
    { choices: [...response().choices, ...response().choices] },
  ]) upstreamError(() => translateResponseToAnthropic(data, "model"))
})

test("malformed tool JSON and headers are never repaired into executable calls", () => {
  for (const tool of [
    { id: "call_1", function: { name: "read", arguments: "{broken" } },
    { id: "call_1", function: { name: "read", arguments: "" } },
    { id: "call_1", function: { name: "read", arguments: "[]" } },
    { id: "call_1", function: { name: "read", arguments: "null" } },
    { id: "call_1", function: { name: "read", arguments: "7" } },
    { function: { name: "read", arguments: "{}" } },
    { id: "call_1", function: { arguments: "{}" } },
    { id: "call_1", type: "custom", function: { name: "read", arguments: "{}" } },
  ]) upstreamError(() => translateResponseToAnthropic(response({ tool_calls: [tool] }, "tool_calls"), "model"))
})

test("usage preserves prompt/cache accounting and rejects impossible counters", () => {
  assert.deepEqual(buildAnthropicUsage({ prompt_tokens: 100, completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 20 } }), {
    input_tokens: 80, output_tokens: 7, cache_read_input_tokens: 20, cache_creation_input_tokens: 0,
  })
  assert.deepEqual(buildAnthropicUsage(), {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  })
  for (const usage of [
    { prompt_tokens: -1 }, { completion_tokens: "3" }, { prompt_tokens: 0.5 },
    { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 11 } },
  ]) upstreamError(() => buildAnthropicUsage(usage))
})

test("parallel calls retain first argument bytes and stable text/tool/text indices", () => {
  const res = sink()
  const translator = createStreamTranslator("model", res)
  translator.processChunk(chunk({ content: "before" }))
  translator.processChunk(chunk({ tool_calls: [call(4, "call_a", "read", '{"path":')] }))
  translator.processChunk(chunk({ tool_calls: [call(9, "call_b", "list", "{}")] }))
  translator.processChunk(chunk({ content: "after" }))
  translator.processChunk(chunk({ tool_calls: [{ index: 4, function: { arguments: '"a"}' } }] }, "tool_calls"))
  assert.equal(eventsOf(res, "content_block_stop").some((event) => [1, 2].includes(event.index)), false)
  assert.equal(translator.processChunk(null), true)
  assert.deepEqual(eventsOf(res, "content_block_start").map((event) => event.index), [0, 1, 2, 3])
  const deltas = eventsOf(res, "content_block_delta").filter((event) => event.delta.type === "input_json_delta")
  assert.equal(deltas.filter((event) => event.index === 1).map((event) => event.delta.partial_json).join(""), '{"path":"a"}')
  assert.equal(deltas.filter((event) => event.index === 2).map((event) => event.delta.partial_json).join(""), "{}")
  const stops = eventsOf(res, "content_block_stop").map((event) => event.index)
  assert.equal(new Set(stops).size, 4)
  assert.equal(stops.length, 4)
  assert.equal(eventsOf(res, "message_delta")[0].delta.stop_reason, "tool_use")
})

test("clean EOF requires a valid finish reason and retains length", () => {
  const res = sink()
  const translator = createStreamTranslator("model", res)
  assert.equal(translator.processChunk(JSON.stringify(chunk({ content: "truncated" }, "length"))), false)
  assert.equal(translator.processChunk(null), true)
  assert.equal(eventsOf(res, "message_delta")[0].delta.stop_reason, "max_tokens")
})

test("stream JSON, error payloads and unsupported deltas fail explicitly", () => {
  for (const data of [
    "{broken", "[DONE]", "null", {}, { choices: [] },
    { error: { message: "upstream error" } },
    chunk({ content: 5 }), chunk({ content: "hi" }, "content_filter"),
    chunk({ role: "user" }), chunk({ reasoning_content: "opaque" }),
    chunk({ refusal: "blocked" }), chunk({ future_delta: true }),
    { choices: [...chunk().choices, ...chunk().choices] },
  ]) {
    const res = sink()
    const translator = createStreamTranslator("model", res)
    upstreamError(() => translator.processChunk(data))
    assert.equal(eventsOf(res, "message_stop").length, 0)
  }
})

test("malformed and length-truncated streamed tools never get a completed tool block", () => {
  for (const args of ["{broken", "", "[]", "null"]) {
    for (const finish of ["tool_calls", "length"]) {
      const res = sink()
      const translator = createStreamTranslator("model", res)
      upstreamError(() => {
        translator.processChunk(chunk({ tool_calls: [call(0, "call_bad", "read", args)] }, finish))
        translator.processChunk("[DONE]")
      })
      assert.equal(eventsOf(res, "content_block_stop").length, 0)
      assert.equal(eventsOf(res, "message_stop").length, 0)
      upstreamError(() => translator.processChunk(null))
    }
  }
})

test("fragmented tool headers and orphan argument deltas cannot name an executable call", () => {
  for (const deltas of [
    [{ tool_calls: [call(0, "call_a", undefined)] }],
    [{ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }],
    [{ tool_calls: [call(undefined, "call_a", "read", "{}")] }],
    [{ tool_calls: [call(-1, "call_a", "read", "{}")] }],
    [{ tool_calls: [call(0, "call_a", "re", "{}")] }, { tool_calls: [{ index: 0, function: { name: "ad" } }] }],
    [{ tool_calls: [call(0, "call_", "read", "{}")] }, { tool_calls: [{ index: 0, id: "a" }] }],
    [{ tool_calls: [call(0, "call_a", "read", "{}"), call(1, "call_a", "list", "{}")] }],
  ]) {
    const res = sink()
    const translator = createStreamTranslator("model", res)
    upstreamError(() => { for (const delta of deltas) translator.processChunk(chunk(delta)) })
    assert.equal(eventsOf(res, "content_block_stop").length, 0)
    assert.equal(eventsOf(res, "message_stop").length, 0)
  }
})

test("post-finish content, inconsistent reasons and late errors cannot become success", () => {
  for (const tail of [
    chunk({ content: "after finish" }), chunk({}, "length"), { error: { message: "late error" } },
  ]) {
    const res = sink()
    const translator = createStreamTranslator("model", res)
    translator.processChunk(chunk({ content: "hi" }, "stop"))
    upstreamError(() => translator.processChunk(tail))
    upstreamError(() => translator.processChunk("[DONE]"))
    assert.equal(eventsOf(res, "message_stop").length, 0)
  }
})

test("partial late usage chunks merge instead of resetting known counters", () => {
  const res = sink()
  const translator = createStreamTranslator("model", res)
  translator.processChunk({ ...chunk({ content: "hi" }),
    usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 15 } } })
  translator.processChunk(chunk({}, "stop"))
  translator.processChunk({ choices: [], usage: { completion_tokens: 3 } })
  translator.processChunk(null)
  assert.deepEqual(eventsOf(res, "message_delta")[0].usage, {
    input_tokens: 85, output_tokens: 3, cache_read_input_tokens: 15, cache_creation_input_tokens: 0,
  })
})

test("invalid root requests and URL source types expose caller errors, not TypeErrors", () => {
  for (const value of [null, undefined, [], "request"]) invalid(() => build(value))
  invalid(() => translateContentPart({ type: "image", source: {
    type: "url", url: ["https://example.com/a.png"],
  } }))
})

test("upstream tool fields cannot silently discard unknown tool semantics", () => {
  for (const extra of [
    { future_tool_option: true },
    { function: { name: "read", arguments: "{}", future_function_option: true } },
  ]) {
    const tool = { id: "call_1", type: "function", function: { name: "read", arguments: "{}" }, ...extra }
    upstreamError(() => translateResponseToAnthropic(response({ tool_calls: [tool] }, "tool_calls"), "model"))
    const res = sink()
    const translator = createStreamTranslator("model", res)
    upstreamError(() => translator.processChunk(chunk({ tool_calls: [{ index: 0, ...tool }] }, "tool_calls")))
    assert.equal(eventsOf(res, "content_block_stop").length, 0)
  }
})

test("tool schemas and inputs are opaque JSON payloads, not request option bags", () => {
  const schema = { type: "object", properties: { cache_control: { type: "object" }, thinking: { type: "string" } } }
  const body = build(request({ tools: [{ name: "read", input_schema: schema }] }))
  assert.deepEqual(body.tools[0].function.parameters, schema)
  const input = { cache_control: { custom: "data" }, thinking: "a field in the tool schema" }
  const translated = translateMessages([{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input }] }])
  assert.deepEqual(JSON.parse(translated[0].tool_calls[0].function.arguments), input)
})

test("typed errors never echo document data or malformed upstream payloads", () => {
  assert.equal(new chat.ChatRequestError("Unsupported").status, 400)
  assert.equal(new chat.ChatUpstreamError("Malformed").type, "api_error")
  for (const run of [
    () => translateContentPart({ type: "document", source: { type: "base64", data: "SENSITIVE_FIXTURE" } }),
    () => translateResponseToAnthropic(response({ tool_calls: [{
      id: "call_1", function: { name: "read", arguments: "SENSITIVE_FIXTURE" },
    }] }, "tool_calls"), "model"),
    () => createStreamTranslator("model", sink()).processChunk({ error: { message: "SENSITIVE_FIXTURE" } }),
  ]) assert.throws(run, (error) => !error.message.includes("SENSITIVE_FIXTURE") && [400, 502].includes(error.status))
})

test("choice-level errors and unknown result semantics are not silently ignored", () => {
  for (const fields of [{ error: { message: "failed" } }, { future_result: "unsupported" }]) {
    const nonstream = response()
    Object.assign(nonstream.choices[0], fields)
    upstreamError(() => translateResponseToAnthropic(nonstream, "model"))
    const streamed = chunk({ content: "hi" }, "stop")
    Object.assign(streamed.choices[0], fields)
    upstreamError(() => createStreamTranslator("model", sink()).processChunk(streamed))
  }
})
