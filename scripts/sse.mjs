import { decodeUtf8, ProxyError, writeResponse } from "./runtime.mjs"

export class SSEDecoder {
  constructor({ maxEventBytes = 8 * 1024 * 1024 } = {}) {
    this.decoder = new TextDecoder("utf-8", { fatal: true })
    this.maxEventBytes = maxEventBytes
    this.buffer = ""
    this.raw = ""
    this.event = ""
    this.data = []
  }

  push(bytes) {
    this.buffer += decodeUtf8(this.decoder, bytes, true)
    return this.consume(false)
  }

  finish() {
    this.buffer += decodeUtf8(this.decoder)
    return this.consume(true)
  }

  consume(final) {
    const frames = []
    for (;;) {
      const match = /[\r\n]/.exec(this.buffer)
      if (!match) break
      const index = match.index
      if (this.buffer[index] === "\r" && index === this.buffer.length - 1 && !final) break
      const width = this.buffer.slice(index, index + 2) === "\r\n" ? 2 : 1
      const line = this.buffer.slice(0, index)
      const raw = this.buffer.slice(0, index + width)
      this.buffer = this.buffer.slice(index + width)
      this.line(line, raw, frames)
    }
    if (final && this.buffer) {
      this.line(this.buffer, this.buffer, frames)
      this.buffer = ""
    }
    if (Buffer.byteLength(this.buffer) + Buffer.byteLength(this.raw) > this.maxEventBytes) {
      throw new ProxyError(502, "Upstream SSE event exceeds the size limit")
    }
    if (final && this.raw) this.flush(frames)
    return frames
  }

  line(line, raw, frames) {
    this.raw += raw
    if (Buffer.byteLength(this.raw) > this.maxEventBytes) throw new ProxyError(502, "Upstream SSE event exceeds the size limit")
    if (line === "") { this.flush(frames); return }
    if (line.startsWith(":")) return
    const colon = line.indexOf(":")
    const name = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (name === "event") this.event = value
    else if (name === "data") this.data.push(value)
  }

  flush(frames) {
    frames.push({ event: this.event, data: this.data.length ? this.data.join("\n") : null, raw: this.raw })
    this.raw = ""
    this.event = ""
    this.data = []
  }
}

export function parseSSEData(frame) {
  try {
    const data = JSON.parse(frame.data)
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected an object")
    return data
  } catch {
    throw new ProxyError(502, "Copilot returned malformed SSE JSON")
  }
}

export async function consumeSSE(upstream, onFrame, maxEventBytes) {
  const decoder = new SSEDecoder({ maxEventBytes })
  for await (const bytes of upstream.chunks()) {
    for (const frame of decoder.push(bytes)) {
      if (await onFrame(frame)) return true
    }
  }
  for (const frame of decoder.finish()) {
    if (await onFrame(frame)) return true
  }
  return false
}

export function createSSEWriter(res, { signal, timeoutMs, heartbeatMs = 15000, onError = (error) => res.destroy(error) } = {}) {
  let tail = Promise.resolve()
  let pending = 0
  let stopped = false
  let timer
  const writer = {
    get busy() { return pending !== 0 },
    write(raw) {
      if (stopped) return Promise.reject(new ProxyError(502, "SSE writer is already closed"))
      pending++
      const next = tail.then(() => writeResponse(res, raw, { signal, timeoutMs }))
      // Callers retain the rejection; the queue can still carry an error frame.
      tail = next.then(() => { pending-- }, () => { pending-- })
      return next
    },
    event(type, data = { type }) {
      return writer.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    startPings() {
      if (!heartbeatMs || timer) return
      timer = setInterval(() => {
        if (!writer.busy && !stopped) writer.event("ping").catch(onError)
      }, heartbeatMs)
      timer.unref()
    },
    stopPings() { clearInterval(timer); timer = undefined },
    async close() {
      writer.stopPings()
      stopped = true
      await tail
    },
  }
  return writer
}

export class NativeMessageState {
  constructor({ collect = false } = {}) {
    this.collect = collect
    this.message = null
    this.blocks = new Map()
    this.stopReason = null
    this.completed = false
    this.error = null
    this.hasOutputUsage = false
  }

  accept(data, event) {
    if (event === "error" || data.type === "error" || data.error) {
      this.error = data
      return true
    }
    if (this.completed) throw new ProxyError(502, "Native stream continued after message_stop")
    if (data.type === "message_start") {
      if (this.message || !data.message || data.message.type !== "message") throw new ProxyError(502, "Invalid native message_start")
      this.message = structuredClone(data.message)
      this.message.content = []
    } else if (data.type === "content_block_start") {
      if (!this.message || !Number.isSafeInteger(data.index) || data.index < 0 || this.blocks.has(data.index) ||
        !data.content_block || typeof data.content_block !== "object" || Array.isArray(data.content_block) || typeof data.content_block.type !== "string") {
        throw new ProxyError(502, "Invalid native content block start")
      }
      const block = structuredClone(data.content_block)
      validateNativeContentBlock(block)
      this.hasOutputUsage = false
      this.blocks.set(data.index, { block, stopped: false, json: null })
      if (this.collect) this.message.content[data.index] = block
    } else if (data.type === "content_block_delta" || data.type === "content_block_stop") {
      const entry = this.blocks.get(data.index)
      if (!entry || entry.stopped) throw new ProxyError(502, "Native delta references a closed or missing block")
      if (data.type === "content_block_stop") {
        if (entry.json !== null) {
          let input
          try { input = JSON.parse(entry.json) } catch { throw new ProxyError(502, "Copilot returned malformed tool input JSON") }
          validateNativeContentBlock({ ...entry.block, input })
          if (this.collect) entry.block.input = input
          entry.json = null
        }
        entry.stopped = true
      } else {
        if (!data.delta || typeof data.delta.type !== "string") throw new ProxyError(502, "Invalid native content delta")
        if (data.delta.type === "input_json_delta") {
          if (typeof data.delta.partial_json !== "string") throw new ProxyError(502, "Invalid native tool argument delta")
          entry.json = (entry.json ?? "") + data.delta.partial_json
        } else if (this.collect) this.addDelta(entry, data.delta)
      }
    } else if (data.type === "message_delta") {
      if (!this.message) throw new ProxyError(502, "Native message_delta arrived before message_start")
      if (data.usage && Object.hasOwn(data.usage, "output_tokens")) {
        if (!Number.isSafeInteger(data.usage.output_tokens) || data.usage.output_tokens < 0) {
          throw new ProxyError(502, "Copilot returned invalid output token usage")
        }
        this.hasOutputUsage = [...this.blocks.values()].every((entry) => entry.stopped)
      }
      if (data.delta?.stop_reason != null) this.stopReason = data.delta.stop_reason
      Object.assign(this.message, data.delta)
      if (data.usage) this.message.usage = mergeUsage(this.message.usage, data.usage)
    } else if (data.type === "message_stop") {
      if (!this.message || typeof this.stopReason !== "string" || [...this.blocks.values()].some((entry) => !entry.stopped)) {
        throw new ProxyError(502, "Incomplete native completion before message_stop")
      }
      if (this.collect && !this.hasOutputUsage) throw new ProxyError(502, "Copilot did not report final output token usage for search emulation")
      this.completed = true
      return true
    }
    return false
  }

  addDelta(entry, delta) {
    if (!delta || typeof delta.type !== "string") throw new ProxyError(502, "Invalid native content delta")
    const properties = {
      text_delta: "text", thinking_delta: "thinking",
      signature_delta: "signature", compaction_delta: "content",
    }
    const property = properties[delta.type]
    if (property) {
      if (typeof delta[property] !== "string") throw new ProxyError(502, "Invalid native text delta")
      entry.block[property] = (entry.block[property] ?? "") + delta[property]
    } else if (delta.type === "citations_delta") {
      ;(entry.block.citations ??= []).push(delta.citation)
    } else {
      throw new ProxyError(502, `Search emulation cannot preserve native delta type ${delta.type}`)
    }
  }
}

export function validateNativeContentBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block) || typeof block.type !== "string") {
    throw new ProxyError(502, "Copilot returned an invalid native content block")
  }
  if (!["tool_use", "server_tool_use", "mcp_tool_use"].includes(block.type)) return
  if (typeof block.id !== "string" || !block.id.trim() || typeof block.name !== "string" || !block.name.trim() ||
      !block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
    throw new ProxyError(502, "Copilot returned an invalid native tool header or input object")
  }
}

export function mergeUsage(previous = {}, update = {}) {
  const merged = { ...previous }
  for (const [key, value] of Object.entries(update)) {
    merged[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeUsage(previous[key], value) : value
  }
  return merged
}

export function sumUsage(total = {}, update = {}) {
  const sum = { ...total }
  for (const [key, value] of Object.entries(update)) {
    if (typeof value === "number") sum[key] = (typeof total[key] === "number" ? total[key] : 0) + value
    else if (value && typeof value === "object" && !Array.isArray(value)) sum[key] = sumUsage(total[key], value)
    else if (sum[key] === undefined) sum[key] = value
  }
  return sum
}
