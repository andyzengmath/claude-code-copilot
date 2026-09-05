import assert from "node:assert/strict"
import test from "node:test"
import { createStreamTranslator, translateContentPart, translateMessages } from "./chat.mjs"

function sink() {
  const events = []
  return {
    events,
    write(frame) {
      const match = /^event: (.+)\ndata: ([\s\S]+)\n\n$/.exec(frame)
      assert.ok(match, "translator must emit complete SSE frames")
      events.push({ event: match[1], data: JSON.parse(match[2]) })
      return true
    },
  }
}

const chunk = (delta, finish = null) => ({ choices: [{ delta, finish_reason: finish }] })

test("parallel argument fragments are routed by the provider tool index", () => {
  const res = sink()
  const translator = createStreamTranslator("claude-opus-5", res)
  translator.processChunk(chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "" } }] }))
  translator.processChunk(chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "write_file", arguments: "" } }] }))
  translator.processChunk(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }))
  translator.processChunk(chunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"b.txt"}' } }] }))
  translator.processChunk(chunk({}, "tool_calls"))
  translator.processChunk("[DONE]")
  const starts = res.events.filter((event) => event.event === "content_block_start")
  assert.equal(starts.length, 2)
  const blockA = starts.find((event) => event.data.content_block.id === "call_a").data.index
  const blockB = starts.find((event) => event.data.content_block.id === "call_b").data.index
  assert.notEqual(blockA, blockB)
  const deltas = res.events.filter((event) => event.data.delta?.type === "input_json_delta")
  assert.equal(deltas.find((event) => event.data.delta.partial_json.includes("a.txt")).data.index, blockA)
  assert.equal(deltas.find((event) => event.data.delta.partial_json.includes("b.txt")).data.index, blockB)
})

test("a first tool delta carrying both id and argument bytes loses neither", () => {
  const res = sink()
  const translator = createStreamTranslator("claude-opus-5", res)
  translator.processChunk(chunk({ tool_calls: [{ index: 0, id: "call_c", function: { name: "grep", arguments: '{"q":' } }] }))
  translator.processChunk(chunk({ tool_calls: [{ index: 0, function: { arguments: '"needle"}' } }] }))
  const json = res.events.filter((event) => event.data.delta?.type === "input_json_delta").map((event) => event.data.delta.partial_json).join("")
  assert.equal(json, '{"q":"needle"}')
})

test("text then tools use distinct indices and close each block once", () => {
  const res = sink()
  const translator = createStreamTranslator("claude-opus-5", res)
  translator.processChunk(chunk({ content: "thinking out loud" }))
  translator.processChunk(chunk({ tool_calls: [{ index: 0, id: "call_d", function: { name: "ls", arguments: "{}" } }] }))
  translator.processChunk(chunk({}, "tool_calls"))
  translator.processChunk("[DONE]")
  assert.deepEqual(res.events.filter((event) => event.event === "content_block_start").map((event) => event.data.index), [0, 1])
  assert.deepEqual(res.events.filter((event) => event.event === "content_block_stop").map((event) => event.data.index), [0, 1])
  assert.equal(res.events.find((event) => event.event === "message_delta").data.delta.stop_reason, "tool_use")
})

test("a completed stream emits exactly one terminator despite repeated EOF markers", () => {
  const res = sink()
  const translator = createStreamTranslator("claude-opus-5", res)
  translator.processChunk(chunk({ content: "hi" }))
  translator.processChunk(chunk({}, "stop"))
  translator.processChunk("[DONE]")
  translator.processChunk(null)
  translator.processChunk("[DONE]")
  assert.equal(res.events.filter((event) => event.event === "message_stop").length, 1)
  assert.equal(res.events.filter((event) => event.event === "message_delta").length, 1)
})

test("chat image translation preserves valid sources and rejects incomplete sources", () => {
  assert.equal(translateContentPart({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }).image_url.url, "data:image/png;base64,AAAA")
  assert.equal(translateContentPart({ type: "image", source: { type: "url", url: "https://example.com/cat.png" } }).image_url.url, "https://example.com/cat.png")
  assert.throws(() => translateContentPart({ type: "image", source: { type: "base64" } }), /image|source|base64/i)
})

test("images from tool results move to user content rather than raw base64 prompt text", () => {
  const translated = translateMessages([{
    role: "user",
    content: [{
      type: "tool_result", tool_use_id: "toolu_1",
      content: [
        { type: "text", text: "here is the screenshot" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "SCREENSHOT" } },
      ],
    }],
  }])
  const tool = translated.find((message) => message.role === "tool")
  const user = translated.find((message) => message.role === "user")
  assert.equal(tool.tool_call_id, "toolu_1")
  assert.equal(typeof tool.content, "string")
  assert.ok(tool.content.includes("here is the screenshot"))
  assert.equal(tool.content.includes("SCREENSHOT"), false)
  assert.equal(user.content.find((part) => part.type === "image_url").image_url.url, "data:image/png;base64,SCREENSHOT")
  const textOnly = translateMessages([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "just text" }] }])
  assert.equal(textOnly.some((message) => message.role === "user"), false)
  assert.equal(textOnly.find((message) => message.role === "tool").content, "just text")
})
