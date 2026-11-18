import assert from "node:assert/strict"
import { once } from "node:events"
import * as proxy from "../proxy.mjs"

export const key = "local-fixture-key"
export const token = "upstream-fixture-token"
const quiet = { log() {}, warn() {}, error() {} }
export const models = [
  { id: "claude-sonnet-5", supported_endpoints: ["/v1/messages", "/chat/completions"], model_picker_enabled: true, policy: { state: "enabled" } },
  { id: "claude-haiku-4.5", supported_endpoints: ["/v1/messages", "/chat/completions"], policy: { state: "enabled" } },
  { id: "hidden-utility", supported_endpoints: ["/chat/completions"], model_picker_enabled: false, policy: { state: "enabled" } },
  { id: "claude-opus-disabled", supported_endpoints: ["/v1/messages"], policy: { state: "disabled" } },
]

export const event = (type, data = { type }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

export function message(content = [{ type: "text", text: "hello" }], stop = "end_turn") {
  return {
    id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5", content,
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
  }
}

export function nativeFrames(result = message()) {
  let text = event("message_start", {
    type: "message_start",
    message: { ...result, content: [], stop_reason: null, usage: { ...result.usage, output_tokens: 0 } },
  })
  for (const [index, block] of result.content.entries()) {
    const contentBlock = block.type === "text" ? { ...block, text: "" }
      : block.type === "tool_use" ? { ...block, input: {} } : block
    text += event("content_block_start", { type: "content_block_start", index, content_block: contentBlock })
    if (block.type === "text") {
      text += event("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } })
    } else if (block.type === "tool_use") {
      text += event("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })
    }
    text += event("content_block_stop", { type: "content_block_stop", index })
  }
  return text + event("message_delta", {
    type: "message_delta", delta: { stop_reason: result.stop_reason, stop_sequence: result.stop_sequence }, usage: result.usage,
  }) + event("message_stop")
}

export function streamResponse(text, { keepOpen = false, onCancel = () => {}, fragments } = {}) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({
    start(controller) {
      if (fragments) {
        for (let offset = 0; offset < bytes.length; offset += fragments) controller.enqueue(bytes.subarray(offset, offset + fragments))
      } else controller.enqueue(bytes)
      if (!keepOpen) controller.close()
    },
    cancel: onCancel,
  }), { headers: { "content-type": "text/event-stream" } })
}

export async function fixture(t, upstream, options = {}) {
  assert.equal(typeof proxy.createProxyServer, "function", "production must expose an injectable server factory")
  const calls = []
  const apiKey = options.proxyKey ?? key
  const server = proxy.createProxyServer({
    ...options,
    token: options.token ?? token,
    proxyKey: apiKey,
    logger: options.logger ?? quiet,
    config: { maxRetries: 0, requestTimeoutMs: 1000, heartbeatMs: 0, ...options.config },
    fetchImpl: async (url, init) => {
      const call = { url: new URL(url), ...init }
      calls.push(call)
      if (call.url.pathname === "/models") {
        return options.catalog ? options.catalog(call) : Response.json({ data: models })
      }
      return upstream(call, calls)
    },
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    server, calls, base, key: apiKey,
    request(body = {}, path = "/v1/messages?beta=true", init = {}) {
      return fetch(`${base}${path}`, {
        method: "POST", ...init,
        headers: { "x-api-key": apiKey, "content-type": "application/json", ...init.headers },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "Hello" }], ...body }),
      })
    },
  }
}
