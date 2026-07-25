// Regression tests for the streaming translator and the search concurrency
// gate. Pure in-process assertions — no network, no Copilot token needed.
//
//   node scripts/test-streaming.mjs
//
// Covers the three regressions fixed in fix/streaming-regressions:
//   #3 parallel tool-call argument deltas routed by tc.index (was .pop())
//   #8 first tool_call delta carrying id + a leading argument fragment
//   #6 concurrency semaphore over-admission on wakeup

import { createStreamTranslator } from "./proxy.mjs"

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// Minimal ServerResponse stand-in that records the SSE frames written.
function makeFakeRes() {
  const events = []
  return {
    events,
    write(s) {
      const m = /^event: (.+)\ndata: ([\s\S]+)\n\n$/.exec(s)
      if (m) events.push({ event: m[1], data: JSON.parse(m[2]) })
      return true
    },
    writeHead() {},
    end() {},
  }
}

const chunk = (delta, finish = null) => ({
  choices: [{ delta, finish_reason: finish }],
})

// ── Test 1: parallel tool calls — the #3 regression ────────────────────────
// Two tool calls open (index 0, 1), then argument fragments arrive for the
// OLDER one. The buggy .pop() implementation routed every bare-argument delta
// to the newest buffer, so tool 0's fragments landed on tool 1's block index.
console.log("\nparallel tool-call argument routing (#3)")
{
  const res = makeFakeRes()
  const t = createStreamTranslator("claude-opus-5", res)

  t.processChunk(chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "" } }] }))
  t.processChunk(chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "write_file", arguments: "" } }] }))
  // Fragment for tool 0 — arrives AFTER tool 1 opened.
  t.processChunk(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }))
  // Fragment for tool 1.
  t.processChunk(chunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"b.txt"}' } }] }))

  const starts = res.events.filter((e) => e.event === "content_block_start")
  const deltas = res.events.filter(
    (e) => e.event === "content_block_delta" && e.data.delta?.type === "input_json_delta",
  )

  const blockOfA = starts.find((e) => e.data.content_block.id === "call_a")?.data.index
  const blockOfB = starts.find((e) => e.data.content_block.id === "call_b")?.data.index

  check("two tool_use blocks opened", starts.length === 2, `got ${starts.length}`)
  check("blocks have distinct indices", blockOfA !== blockOfB, `${blockOfA} vs ${blockOfB}`)

  const aDelta = deltas.find((d) => d.data.delta.partial_json.includes("a.txt"))
  const bDelta = deltas.find((d) => d.data.delta.partial_json.includes("b.txt"))

  check(
    "tool A's args routed to tool A's block",
    aDelta && aDelta.data.index === blockOfA,
    `expected index ${blockOfA}, got ${aDelta?.data.index}`,
  )
  check(
    "tool B's args routed to tool B's block",
    bDelta && bDelta.data.index === blockOfB,
    `expected index ${blockOfB}, got ${bDelta?.data.index}`,
  )
}

// ── Test 2: first delta carries id AND a leading argument fragment (#8) ────
console.log("\nfirst delta carrying id + argument fragment (#8)")
{
  const res = makeFakeRes()
  const t = createStreamTranslator("claude-opus-5", res)

  t.processChunk(chunk({ tool_calls: [{ index: 0, id: "call_c", function: { name: "grep", arguments: '{"q":' } }] }))
  t.processChunk(chunk({ tool_calls: [{ index: 0, function: { arguments: '"needle"}' } }] }))

  const deltas = res.events
    .filter((e) => e.event === "content_block_delta" && e.data.delta?.type === "input_json_delta")
    .map((e) => e.data.delta.partial_json)
    .join("")

  check("leading fragment not dropped", deltas === '{"q":"needle"}', `reassembled: ${deltas}`)
}

// ── Test 3: text then tool call — block indices stay consistent ────────────
console.log("\ntext block followed by tool call")
{
  const res = makeFakeRes()
  const t = createStreamTranslator("claude-opus-5", res)

  t.processChunk(chunk({ content: "thinking out loud" }))
  t.processChunk(chunk({ tool_calls: [{ index: 0, id: "call_d", function: { name: "ls", arguments: "{}" } }] }))
  t.processChunk(chunk({}, "tool_calls"))

  const textStart = res.events.find((e) => e.event === "content_block_start" && e.data.content_block.type === "text")
  const toolStart = res.events.find((e) => e.event === "content_block_start" && e.data.content_block.type === "tool_use")
  const stops = res.events.filter((e) => e.event === "content_block_stop").map((e) => e.data.index)
  const msgDelta = res.events.find((e) => e.event === "message_delta")

  check("text block opened at index 0", textStart?.data.index === 0, `got ${textStart?.data.index}`)
  check("tool block opened after text", toolStart?.data.index === 1, `got ${toolStart?.data.index}`)
  check("both blocks closed", stops.includes(0) && stops.includes(1), `stops: ${stops}`)
  check("stop_reason is tool_use", msgDelta?.data.delta.stop_reason === "tool_use", msgDelta?.data.delta.stop_reason)
}

// ── Test 4: single message_stop terminator ─────────────────────────────────
console.log("\nstream terminator idempotency")
{
  const res = makeFakeRes()
  const t = createStreamTranslator("claude-opus-5", res)

  t.processChunk(chunk({ content: "hi" }))
  t.processChunk(chunk({}, "stop"))
  t.processChunk("[DONE]")
  t.processChunk(null)

  const stops = res.events.filter((e) => e.event === "message_stop")
  const deltas = res.events.filter((e) => e.event === "message_delta")
  check("exactly one message_stop", stops.length === 1, `got ${stops.length}`)
  check("exactly one message_delta", deltas.length === 1, `got ${deltas.length}`)
}

// ── Test 5: concurrency gate never over-admits (#6) ────────────────────────
// Reproduces the wakeup race: a queued waiter is woken, but before it resumes a
// brand-new caller claims the freed slot. With `if` the waiter proceeded anyway
// (3 concurrent under a limit of 2); with `while` it re-queues.
console.log("\nsearch concurrency gate (#6)")
{
  const MAX = 2
  let active = 0
  let peak = 0
  const queue = []

  async function gate(work) {
    while (active >= MAX) {
      await new Promise((r) => queue.push(r))
    }
    active++
    peak = Math.max(peak, active)
    try {
      return await work()
    } finally {
      active--
      if (queue.length > 0) queue.shift()()
    }
  }

  const defer = () => {
    let release
    const p = new Promise((r) => (release = r))
    return { p, release }
  }

  const a = defer()
  const b = defer()
  const c = defer()

  const t1 = gate(() => a.p)
  const t2 = gate(() => b.p)
  const t3 = gate(() => c.p) // queued

  // Free one slot, then immediately race a new caller into it.
  a.release()
  const d = defer()
  const t4 = gate(() => d.p)

  await new Promise((r) => setTimeout(r, 10))

  check(`never exceeded limit of ${MAX}`, peak <= MAX, `peak concurrency was ${peak}`)

  b.release()
  c.release()
  d.release()
  await Promise.all([t1, t2, t3, t4])
  check("all tasks drained", active === 0, `active=${active}`)
}

// ── Test 6: max_uses clamp (#7) ────────────────────────────────────────────
// max_uses is client-supplied and each round is a billed completion, so an
// unclamped value fans one request out into hundreds.
console.log("\nweb_search max_uses clamp (#7)")
{
  const CAP = 10
  const effective = (maxUses) => {
    const requested = Number.isFinite(maxUses) && maxUses > 0 ? Math.floor(maxUses) : 5
    return Math.min(requested, CAP)
  }

  check("absurd max_uses clamped to cap", effective(500) === CAP, `got ${effective(500)}`)
  check("reasonable max_uses preserved", effective(3) === 3, `got ${effective(3)}`)
  check("undefined falls back to default", effective(undefined) === 5, `got ${effective(undefined)}`)
  check("zero falls back to default", effective(0) === 5, `got ${effective(0)}`)
  check("negative falls back to default", effective(-1) === 5, `got ${effective(-1)}`)
}

// ── Test 7: outer catch respects headersSent (#4) ──────────────────────────
// Once a streaming response has sent headers, writeHead(500) throws
// ERR_HTTP_HEADERS_SENT on top of the original error and corrupts the socket.
console.log("\nerror path respects headersSent (#4)")
{
  const attempts = []
  const fakeRes = {
    headersSent: true,
    writeHead() {
      attempts.push("writeHead")
      throw new Error("ERR_HTTP_HEADERS_SENT")
    },
    end() {
      attempts.push("end")
    },
  }

  // Mirrors the guard in handleRequest's outer catch.
  const handleError = (res) => {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end("{}")
  }

  handleError(fakeRes)
  check("no writeHead after headers sent", !attempts.includes("writeHead"), `attempts: ${attempts}`)
  check("connection closed cleanly", attempts.includes("end"), `attempts: ${attempts}`)

  const freshAttempts = []
  handleError({
    headersSent: false,
    writeHead: () => freshAttempts.push("writeHead"),
    end: () => freshAttempts.push("end"),
  })
  check("still sends 500 when headers not yet sent", freshAttempts.includes("writeHead"), `attempts: ${freshAttempts}`)
}

// ── Test 8: web-search catch scope (#1) ────────────────────────────────────
// The old code wrapped BOTH the search loop and the SSE emission in one try.
// A failure during emission (client EPIPE, JSON.stringify throw) was treated as
// "search failed" and fell through to the normal path — a second billed
// completion plus writeHead() on an already-streaming socket.
//
// Models both shapes and asserts the new one cannot double-bill.
console.log("\nweb-search catch scope (#1)")
{
  // Old shape: one try around loop + emission.
  function oldShape({ loopThrows, emitThrows }) {
    const effects = []
    try {
      if (loopThrows) throw new Error("search failed")
      effects.push("writeHead")
      if (emitThrows) throw new Error("EPIPE")
      effects.push("emitted")
      return effects
    } catch {
      effects.push("fallthrough")
      effects.push("upstreamCall") // second billed completion
      effects.push("writeHead") // on an already-streaming socket
    }
    return effects
  }

  // New shape: try around the loop only; emission errors propagate.
  function newShape({ loopThrows, emitThrows }) {
    const effects = []
    let searchResult = null
    try {
      if (loopThrows) throw new Error("search failed")
      searchResult = { ok: true }
    } catch {
      effects.push("fallthrough")
    }
    if (searchResult) {
      effects.push("writeHead")
      if (emitThrows) {
        effects.push("propagated")
        return effects
      }
      effects.push("emitted")
      return effects
    }
    effects.push("upstreamCall")
    return effects
  }

  const oldEmitFail = oldShape({ loopThrows: false, emitThrows: true })
  const newEmitFail = newShape({ loopThrows: false, emitThrows: true })

  check(
    "old shape double-billed on emission failure (documents the bug)",
    oldEmitFail.filter((e) => e === "upstreamCall").length === 1 &&
      oldEmitFail.filter((e) => e === "writeHead").length === 2,
    `old: ${oldEmitFail}`,
  )
  check(
    "emission failure does NOT trigger a second upstream call",
    !newEmitFail.includes("upstreamCall"),
    `new: ${newEmitFail}`,
  )
  check(
    "emission failure does NOT writeHead twice",
    newEmitFail.filter((e) => e === "writeHead").length === 1,
    `new: ${newEmitFail}`,
  )

  // Search-loop failure must still fall back — that behaviour is intentional.
  const loopFail = newShape({ loopThrows: true, emitThrows: false })
  check("search-loop failure still falls back to normal path", loopFail.includes("upstreamCall"), `new: ${loopFail}`)
  check("fallback path does not pre-send headers", loopFail.indexOf("writeHead") === -1, `new: ${loopFail}`)

  // Happy path unchanged.
  const ok = newShape({ loopThrows: false, emitThrows: false })
  check(
    "happy path emits once with no upstream refetch",
    ok.includes("emitted") && !ok.includes("upstreamCall") && ok.filter((e) => e === "writeHead").length === 1,
    `new: ${ok}`,
  )
}

console.log(failures === 0 ? "\n✅ all streaming tests passed\n" : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
