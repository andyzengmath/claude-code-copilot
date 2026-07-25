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

console.log(failures === 0 ? "\n✅ all streaming tests passed\n" : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
