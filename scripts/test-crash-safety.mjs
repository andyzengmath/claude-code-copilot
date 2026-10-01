import assert from "node:assert/strict"
import { once } from "node:events"
import net from "node:net"
import test from "node:test"
import { fixture, event, message, streamResponse } from "./test-helpers/gateway.mjs"

function tcp(port, request, resetWhen) {
  return new Promise((resolve, reject) => {
    let data = ""
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request))
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("TCP fixture timed out")) }, 2000)
    const finish = () => { clearTimeout(timer); resolve(data) }
    socket.on("data", (chunk) => {
      data += chunk
      if (resetWhen?.test(data)) { socket.resetAndDestroy(); finish() }
    })
    socket.once("end", finish)
    socket.once("error", (error) => { clearTimeout(timer); reject(error) })
  })
}

test("real TCP reset after a complete response is not logged as a client error", { timeout: 5000 }, async (t) => {
  const warnings = []
  const f = await fixture(t, () => Response.json({ input_tokens: 9 }), {
    logger: { log() {}, error() {}, warn: (line) => warnings.push(line) },
  })
  const port = f.server.address().port
  const resetSeen = once(f.server, "clientError")
  const body = JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hello" }] })
  const response = await tcp(port,
    `POST /v1/messages/count_tokens HTTP/1.1\r\nHost: localhost\r\nX-API-Key: ${f.key}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`,
    /"input_tokens":9}/,
  )
  assert.match(response, /"input_tokens":9}/)
  const [error] = await resetSeen
  assert.equal(error.code, "ECONNRESET")
  assert.equal(warnings.some((line) => line.includes("ECONNRESET")), false)
  assert.equal((await fetch(`${f.base}/health`)).status, 200)
})

test("aborted uploads never dispatch inference or kill the listening server", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, () => assert.fail("an incomplete upload reached Copilot"))
  for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let onPartial
      let onAbort
      const partial = new Promise((resolve) => { onPartial = resolve })
      const aborted = new Promise((resolve) => { onAbort = resolve })
      f.server.once("request", (request) => {
        request.once("data", onPartial)
        request.once("aborted", onAbort)
      })
      const socket = net.connect(f.server.address().port, "127.0.0.1")
      socket.on("error", () => {})
      await once(socket, "connect")
      socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nX-API-Key: ${f.key}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"partial":"data"`)
      await partial
      socket.resetAndDestroy()
      await aborted
    }
  }
  assert.equal(f.calls.length, 0)
  const response = await fetch(`${f.base}/health`)
  assert.equal((await response.json()).status, "ok")
})

test("malformed HTTP still gets a visible parser warning and a 400 response", async (t) => {
  const warnings = []
  const f = await fixture(t, () => assert.fail("parser failure dispatched upstream"), {
    logger: { log() {}, error() {}, warn: (line) => warnings.push(line) },
  })
  const response = await tcp(f.server.address().port, "NOT AN HTTP REQUEST\r\n\r\n")
  assert.match(response, /^HTTP\/1\.1 400 Bad Request/)
  assert.ok(warnings.some((line) => line.includes("Client error:")))
  assert.equal((await fetch(`${f.base}/health`)).status, 200)
})

test("a post-header upstream failure produces one SSE error and leaves the server healthy", async (t) => {
  const errors = []
  const f = await fixture(t, () => streamResponse(event("message_start", {
    type: "message_start", message: { ...message(), content: [], stop_reason: null },
  })), { logger: { log() {}, warn() {}, error: (line) => errors.push(line) } })
  const response = await f.request({ stream: true })
  const body = await response.text()
  assert.equal(response.status, 200)
  assert.equal((body.match(/event: error\n/g) ?? []).length, 1)
  assert.equal(/^event: message_stop$/m.test(body), false)
  assert.equal(errors.some((line) => line.includes("ERR_HTTP_HEADERS_SENT")), false)
  assert.equal(f.calls.filter((call) => call.url.pathname === "/v1/messages").length, 1)
  assert.equal((await fetch(`${f.base}/health`)).status, 200)
})
