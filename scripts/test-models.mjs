// Model routing and advertised-catalog regression tests. Pure in-process
// assertions — no network, no Copilot token needed.
//
//   node scripts/test-models.mjs
//
// Claude Opus 5.5 is Claude Code's default model from v2.1.280. Its Claude API
// ID `claude-opus-5-5` is served by Copilot as `claude-opus-5.5`; it must route
// to that exact version (never silently to Opus 5) and be advertised first.

import * as proxy from "./proxy.mjs"

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function routes(from, to) {
  const actual = proxy.mapModel(from)
  check(`${from} → ${to}`, actual === to, `got ${actual}`)
}

console.log("\nOpus 5.5 routes to its exact Copilot ID")
routes("claude-opus-5-5", "claude-opus-5.5")
routes("claude-opus-5.5", "claude-opus-5.5")
routes("claude-opus-5-5-latest", "claude-opus-5.5")
routes("claude-opus-5-6", "claude-opus-5.6") // unlisted 5.x keeps its exact version (fallback parser)

console.log("\nOpus 5 is unchanged and never upgraded to 5.5")
routes("claude-opus-5", "claude-opus-5")
routes("claude-opus-5-latest", "claude-opus-5")
routes("claude-opus-5-20260722", "claude-opus-5") // a date suffix is not a minor version

console.log("\nother tiers keep their existing routing")
routes("claude-opus-4-8", "claude-opus-4.8")
routes("claude-opus-4-5", "claude-opus-4.6")
routes("claude-opus-50", "claude-opus-4.6")
routes("claude-sonnet-5", "claude-sonnet-5")
routes("claude-haiku-4-5", "claude-haiku-4.5")

console.log("\n/v1/models advertises Opus 5.5 as the default flagship")
const advertised = Array.isArray(proxy.ADVERTISED_MODELS) ? proxy.ADVERTISED_MODELS.map((model) => model.id) : []
check("advertised model list is exported", advertised.length > 0)
check("claude-opus-5-5 is listed first", advertised[0] === "claude-opus-5-5", `got ${advertised[0]}`)
check("claude-opus-5 remains available", advertised.includes("claude-opus-5"))
check("advertised IDs are unique", new Set(advertised).size === advertised.length)
check("every advertised ID routes to a Copilot ID",
  advertised.every((id) => /^claude-(opus|sonnet|haiku)-\d+(\.\d+)?$/.test(proxy.mapModel(id))))

console.log(failures === 0 ? "\n✅ all model tests passed\n" : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
