export class ProxyError extends Error {
  constructor(status, message, type = "api_error", headers = {}) {
    super(message)
    this.name = "ProxyError"
    this.status = status
    this.type = type
    this.headers = headers
  }
}

export function abortError(message = "Client disconnected") {
  return new DOMException(message, "AbortError")
}

export function decodeUtf8(decoder, bytes, stream = false) {
  try {
    return decoder.decode(bytes, { stream })
  } catch (error) {
    if (error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") throw new ProxyError(502, "Copilot returned invalid UTF-8")
    throw error
  }
}

export function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value) },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error) },
    )
  })
}

export function sleep(ms, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort) }
    const onAbort = () => { cleanup(); reject(signal.reason) }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function parseRetryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(value)) {
    const ms = Number(value) * 1000
    return Number.isFinite(ms) ? ms : null
  }
  if (/^\s*-/.test(value)) return null
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

export function createAdmissionGate({
  limit = 0, maxQueued = 64, maxQueueBytes = 64 * 1024 * 1024,
  queueTimeoutMs = 30000, minIntervalMs = 0,
} = {}) {
  let active = 0
  let queuedBytes = 0
  let nextStart = 0
  let cooldownUntil = 0
  let timer
  let closed
  const queue = []
  const capacity = () => limit === 0 || active < limit
  const retryError = () => new ProxyError(429, "Copilot is cooling down; retry after the indicated delay", "rate_limit_error", {
    "retry-after": String(Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000))),
  })
  const cleanup = (item) => {
    clearTimeout(item.timer)
    item.signal?.removeEventListener("abort", item.onAbort)
  }
  const remove = (item) => {
    const index = queue.indexOf(item)
    if (index < 0) return false
    queue.splice(index, 1)
    queuedBytes -= item.bytes
    cleanup(item)
    return true
  }
  function admit(item) {
    cleanup(item)
    active++
    nextStart = Date.now() + minIntervalMs
    let released = false
    item.resolve(() => {
      if (released) return
      released = true
      active--
      drain()
    })
  }
  function drain() {
    clearTimeout(timer)
    if (closed) return
    while (queue.length && capacity()) {
      const delay = Math.max(nextStart, cooldownUntil) - Date.now()
      if (delay > 0) {
        timer = setTimeout(drain, Math.min(delay, 2147483647))
        return
      }
      const item = queue.shift()
      queuedBytes -= item.bytes
      admit(item)
    }
  }
  return {
    acquire({ signal, bytes = 0 } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason)
      if (closed) return Promise.reject(closed)
      if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new TypeError("Invalid admission byte count"))
      if (cooldownUntil - Date.now() >= queueTimeoutMs) return Promise.reject(retryError())
      return new Promise((resolve, reject) => {
        const item = { signal, bytes, resolve, reject }
        if (!queue.length && capacity() && Date.now() >= Math.max(nextStart, cooldownUntil)) {
          admit(item)
          return
        }
        if (queue.length >= maxQueued || queuedBytes + bytes > maxQueueBytes) {
          reject(new ProxyError(503, "Proxy request queue is full", "overloaded_error", { "retry-after": "1" }))
          return
        }
        item.onAbort = () => {
          if (remove(item)) { reject(signal.reason); drain() }
        }
        item.timer = setTimeout(() => {
          if (remove(item)) {
            reject(new ProxyError(503, "Proxy request queue deadline exceeded", "overloaded_error", { "retry-after": "1" }))
            drain()
          }
        }, queueTimeoutMs)
        signal?.addEventListener("abort", item.onAbort, { once: true })
        queue.push(item)
        queuedBytes += bytes
        drain()
      })
    },
    cooldown(ms) {
      if (!(ms >= 0) || !Number.isFinite(ms)) throw new TypeError("Invalid cooldown")
      cooldownUntil = Math.max(cooldownUntil, Date.now() + ms)
      for (const item of [...queue]) {
        if (cooldownUntil - Date.now() >= queueTimeoutMs && remove(item)) item.reject(retryError())
      }
      drain()
    },
    close(reason = new ProxyError(503, "Proxy is shutting down", "overloaded_error")) {
      closed = reason
      clearTimeout(timer)
      for (const item of [...queue]) {
        remove(item)
        item.reject(reason)
      }
    },
  }
}

export function createSharedTasks() {
  const flights = new Map()
  let closed
  return {
    run(key, signal, work) {
      if (signal?.aborted) return Promise.reject(signal.reason)
      if (closed) return Promise.reject(closed)
      let flight = flights.get(key)
      if (!flight) {
        const controller = new AbortController()
        flight = { controller, subscribers: new Set(), settled: false }
        const promise = Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          return work(controller.signal)
        })
        flight.promise = abortable(promise, controller.signal)
        flights.set(key, flight)
        const finish = () => {
          flight.settled = true
          if (flights.get(key) === flight) flights.delete(key)
        }
        flight.promise.then(finish, finish)
      }
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (ok, value) => {
          if (settled) return
          settled = true
          signal?.removeEventListener("abort", onAbort)
          flight.subscribers.delete(onAbort)
          if (!flight.settled && flight.subscribers.size === 0) {
            flight.controller.abort(abortError("No subscribers remain"))
            if (flights.get(key) === flight) flights.delete(key)
          }
          if (ok) resolve(value)
          else reject(value)
        }
        const onAbort = () => finish(false, signal.reason)
        flight.subscribers.add(onAbort)
        signal?.addEventListener("abort", onAbort, { once: true })
        flight.promise.then((value) => finish(true, value), (error) => finish(false, error))
      })
    },
    close(reason = abortError("Proxy is shutting down")) {
      closed = reason
      for (const flight of flights.values()) flight.controller.abort(reason)
      flights.clear()
    },
  }
}

export async function writeResponse(res, data, { signal, timeoutMs = 120000 } = {}) {
  signal?.throwIfAborted()
  if (res.destroyed || res.writableEnded) throw abortError("Response closed")
  if (res.write(data)) return
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      res.removeListener("drain", onDrain)
      res.removeListener("close", onClose)
      res.removeListener("error", onError)
      signal?.removeEventListener("abort", onAbort)
    }
    const onDrain = () => { cleanup(); resolve() }
    const onClose = () => { cleanup(); reject(abortError("Response closed during backpressure")) }
    const onError = (error) => { cleanup(); reject(error) }
    const onAbort = () => { cleanup(); reject(signal.reason) }
    const timer = setTimeout(() => {
      cleanup()
      res.destroy()
      reject(new ProxyError(504, "Client stopped reading the response"))
    }, timeoutMs)
    res.once("drain", onDrain)
    res.once("close", onClose)
    res.once("error", onError)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else if (res.destroyed || res.writableEnded) onClose()
  })
}

export async function openResponse(fetchImpl, url, init, {
  signal: parentSignal, timeoutMs = 120000, maxBytes = 64 * 1024 * 1024, logger = console,
} = {}) {
  parentSignal?.throwIfAborted()
  const controller = new AbortController()
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  const cancel = (body) => {
    if (!body || body.locked) return
    body.cancel().catch((error) => {
      if (error.name !== "AbortError") logger.warn("Upstream body cancellation failed")
    })
  }
  async function wait(promise, phase) {
    const timer = setTimeout(() => controller.abort(new ProxyError(504, `Copilot ${phase} timed out after ${timeoutMs}ms`)), timeoutMs)
    try {
      return await abortable(promise, signal)
    } finally {
      clearTimeout(timer)
    }
  }
  const pending = Promise.resolve().then(() => {
    signal.throwIfAborted()
    return fetchImpl(url, { ...init, redirect: "error", signal })
  })
  pending.then((response) => { if (signal.aborted) cancel(response.body) }, () => {})
  let response
  try {
    response = await wait(pending, "request")
  } catch (error) {
    controller.abort(error)
    if (error.status || error.name === "AbortError") throw error
    throw new ProxyError(502, "Copilot connection failed; the submitted request was not replayed")
  }
  let reader
  let exhausted = false
  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    if (!exhausted) {
      controller.abort(abortError("Upstream response consumption ended"))
      if (reader) {
        reader.cancel().catch((error) => {
          if (error.name !== "AbortError") logger.warn("Upstream reader cancellation failed")
        })
      } else cancel(response.body)
    }
  }
  async function* chunks() {
    if (!response.body) throw new ProxyError(502, "Copilot returned an empty response body")
    reader = response.body.getReader()
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await wait(reader.read(), "body read")
        if (done) { exhausted = true; break }
        bytes += value.byteLength
        if (bytes > maxBytes) throw new ProxyError(502, "Copilot response exceeds the configured byte limit")
        yield value
      }
    } finally {
      dispose()
      reader.releaseLock()
    }
  }
  return {
    response, signal, chunks, dispose,
    async text() {
      const buffers = []
      for await (const chunk of chunks()) buffers.push(chunk)
      return decodeUtf8(new TextDecoder("utf-8", { fatal: true }), Buffer.concat(buffers))
    },
  }
}
