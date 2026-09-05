import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { setImmediate as nextTurn } from "node:timers/promises"
import test from "node:test"
import * as runtime from "./runtime.mjs"
import { readConfig } from "./config.mjs"
import { consumeSSE, NativeMessageState, SSEDecoder } from "./sse.mjs"
import { responseHeaders } from "./upstream.mjs"

const proxy = { ...runtime, readConfig, SSEDecoder }

function exported(name) {
  assert.equal(typeof proxy[name], "function", `production ${name} is required`)
  return proxy[name]
}

test("configuration keeps unlimited inference as default and rejects invalid numbers", () => {
  const readConfig = exported("readConfig")
  const defaults = readConfig({})
  assert.equal(defaults.maxConcurrentRequests, 0)
  assert.equal(defaults.host, "127.0.0.1")
  assert.equal(defaults.maxBodyBytes, 32 * 1024 * 1024)
  assert.equal(defaults.maxRetries, 3)
  for (const value of ["NaN", "-1", "1.2", "3oops", "Infinity"]) {
    assert.throws(() => readConfig({ COPILOT_MAX_RETRIES: value }), /COPILOT_MAX_RETRIES/)
  }
  assert.throws(() => readConfig({ WEB_SEARCH_MAX_USES_CAP: "0" }), /WEB_SEARCH_MAX_USES_CAP/)
  assert.throws(() => readConfig({ COPILOT_TRANSPORT: "guess" }), /COPILOT_TRANSPORT/)
})

test("admission transfers a permit to the FIFO waiter before a new arrival", async () => {
  const gate = exported("createAdmissionGate")({ limit: 1, maxQueued: 5, maxQueueBytes: 100, queueTimeoutMs: 1000 })
  const releaseA = await gate.acquire()
  const order = []
  const b = gate.acquire().then((release) => { order.push("b"); return release })
  releaseA()
  const c = gate.acquire().then((release) => { order.push("c"); return release })
  const releaseB = await b
  assert.deepEqual(order, ["b"])
  releaseB()
  releaseB()
  const releaseC = await c
  assert.deepEqual(order, ["b", "c"])
  releaseC()
  gate.close()
})

test("cancelled admission removes its queue count and byte reservation", async () => {
  const gate = exported("createAdmissionGate")({ limit: 1, maxQueued: 1, maxQueueBytes: 20, queueTimeoutMs: 1000 })
  const release = await gate.acquire()
  const controller = new AbortController()
  const queued = gate.acquire({ signal: controller.signal, bytes: 20 })
  const aborted = assert.rejects(queued, { name: "AbortError" })
  await assert.rejects(gate.acquire({ bytes: 1 }), (error) => error.status === 503)
  controller.abort()
  await aborted
  const replacement = gate.acquire({ bytes: 20 })
  release()
  const releaseReplacement = await replacement
  releaseReplacement()
  gate.close()
})

test("admission rejects byte overflow even when a count slot is available", async () => {
  const gate = exported("createAdmissionGate")({ limit: 1, maxQueued: 10, maxQueueBytes: 4, queueTimeoutMs: 1000 })
  const release = await gate.acquire()
  await assert.rejects(gate.acquire({ bytes: 5 }), (error) => error.status === 503)
  release()
  gate.close()
})

test("a queue deadline does not leave an abandoned waiter holding the next permit", async () => {
  const gate = exported("createAdmissionGate")({ limit: 1, maxQueued: 5, maxQueueBytes: 100, queueTimeoutMs: 20 })
  const release = await gate.acquire()
  await assert.rejects(gate.acquire(), (error) => error.status === 503)
  release()
  const finalRelease = await gate.acquire()
  finalRelease()
  gate.close()
})

test("a shared cooldown longer than the queue budget returns the remaining retry hint", async () => {
  const gate = exported("createAdmissionGate")({ limit: 0, maxQueued: 5, maxQueueBytes: 100, queueTimeoutMs: 10 })
  gate.cooldown(90000)
  await assert.rejects(gate.acquire(), (error) => {
    assert.equal(error.status, 429)
    assert.equal(error.headers["retry-after"], "90")
    return true
  })
  gate.close()
})

test("single-flight work survives one subscriber cancelling but not its last subscriber", async () => {
  const shared = exported("createSharedTasks")()
  let calls = 0
  let underlyingSignal
  let finish
  const work = (signal) => {
    calls++
    underlyingSignal = signal
    return new Promise((resolve) => { finish = resolve })
  }
  const a = new AbortController()
  const b = new AbortController()
  const first = shared.run("same", a.signal, work)
  const firstRejected = assert.rejects(first, { name: "AbortError" })
  const second = shared.run("same", b.signal, work)
  await nextTurn()
  a.abort()
  await firstRejected
  assert.equal(calls, 1)
  assert.equal(underlyingSignal.aborted, false)
  finish("shared result")
  assert.equal(await second, "shared result")

  const c = new AbortController()
  const last = shared.run("different", c.signal, work)
  const lastRejected = assert.rejects(last, { name: "AbortError" })
  await nextTurn()
  c.abort()
  await lastRejected
  assert.equal(underlyingSignal.aborted, true)
  shared.close()
})

test("write backpressure blocks progress until drain and removes its listeners", async () => {
  const writeResponse = exported("writeResponse")
  const response = new EventEmitter()
  response.write = () => false
  let complete = false
  const pending = writeResponse(response, "data", { timeoutMs: 1000 }).then(() => { complete = true })
  await nextTurn()
  assert.equal(complete, false)
  response.emit("drain")
  await pending
  assert.equal(complete, true)
  assert.equal(response.listenerCount("drain"), 0)
  assert.equal(response.listenerCount("close"), 0)
  assert.equal(response.listenerCount("error"), 0)
})

test("a closed backpressured response rejects instead of hanging", async () => {
  const writeResponse = exported("writeResponse")
  const response = new EventEmitter()
  response.write = () => false
  const pending = writeResponse(response, "data", { timeoutMs: 1000 })
  const rejected = assert.rejects(pending, /closed|disconnect/i)
  response.emit("close")
  await rejected
  assert.equal(response.listenerCount("drain"), 0)
})

test("Retry-After seconds and dates are not truncated to thirty seconds", () => {
  const parseRetryAfterMs = exported("parseRetryAfterMs")
  assert.equal(parseRetryAfterMs("90"), 90000)
  assert.equal(parseRetryAfterMs("0"), 0)
  assert.equal(parseRetryAfterMs("not a date"), null)
  assert.equal(parseRetryAfterMs("-1"), null)
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:00 GMT")), 60000)
})

test("SSE decoder handles CRLF, comments, multiline data and an unterminated final frame", () => {
  const Decoder = exported("SSEDecoder")
  const decoder = new Decoder({ maxEventBytes: 1024 })
  const bytes = new TextEncoder().encode(': comment\r\nevent: value\r\ndata: {"text":\r\ndata: "\u263a"}\r\n\r\ndata:[DONE]')
  const frames = []
  for (const byte of bytes) frames.push(...decoder.push(new Uint8Array([byte])))
  frames.push(...decoder.finish())
  assert.equal(frames.length, 2)
  assert.equal(frames[0].event, "value")
  assert.deepEqual(JSON.parse(frames[0].data), { text: "\u263a" })
  assert.equal(frames[1].data, "[DONE]")
})

test("SSE decoder bounds a single unbroken upstream event", () => {
  const Decoder = exported("SSEDecoder")
  const decoder = new Decoder({ maxEventBytes: 16 })
  assert.throws(() => decoder.push(new TextEncoder().encode(`data: ${"x".repeat(100)}`)), /large|limit|size/i)
})

test("malformed upstream UTF-8 is a protocol error rather than an internal server failure", async () => {
  const decoder = new SSEDecoder()
  assert.throws(() => decoder.push(new Uint8Array([255])), (error) => error.status === 502)
  const upstream = await runtime.openResponse(async () => new Response(new Uint8Array([255])), "https://fixture.invalid", {}, { timeoutMs: 100 })
  await assert.rejects(upstream.text(), (error) => error.status === 502)
  upstream.dispose()
})

test("a header timeout aborts the fetch and cancels a late ignored response", async () => {
  let finishFetch
  let signal
  let cancelled = false
  const pending = runtime.openResponse((url, init) => {
    signal = init.signal
    return new Promise((resolve) => { finishFetch = resolve })
  }, "https://fixture.invalid", {}, { timeoutMs: 20 })
  await assert.rejects(pending, (error) => error.status === 504)
  assert.equal(signal.aborted, true)
  finishFetch(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])) },
    cancel() { cancelled = true },
  })))
  await nextTurn()
  assert.equal(cancelled, true)
})

test("relay headers discard decompression lengths and connection-nominated hop headers", () => {
  const headers = responseHeaders(new Headers({
    "content-type": "application/json", "content-encoding": "gzip", "content-length": "42",
    connection: "x-hop, keep-alive", "x-hop": "remove", "keep-alive": "timeout=5",
    "request-id": "req_fixture", "retry-after": "90",
  }))
  assert.deepEqual(headers, { "content-type": "application/json", "request-id": "req_fixture", "retry-after": "90" })
})

test("the SSE driver does not read another upstream chunk while the response is backpressured", async () => {
  let reads = 0
  const response = new EventEmitter()
  response.write = () => reads !== 1
  const upstream = {
    async *chunks() {
      reads++
      yield new TextEncoder().encode("data: first\n\n")
      reads++
      yield new TextEncoder().encode("data: second\n\n")
    },
  }
  const relay = consumeSSE(upstream, async (frame) => {
    await runtime.writeResponse(response, frame.raw, { timeoutMs: 1000 })
    return frame.data === "second"
  }, 1024)
  await nextTurn()
  assert.equal(reads, 1)
  response.emit("drain")
  await relay
  assert.equal(reads, 2)
})

test("native stream validation rejects malformed block headers before forwarding a successful stop", () => {
  const state = new NativeMessageState()
  state.accept({ type: "message_start", message: { type: "message", content: [], usage: {} } })
  assert.throws(() => state.accept({ type: "content_block_start", index: 0, content_block: "not a block" }), (error) => error.status === 502)
})
