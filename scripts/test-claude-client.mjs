import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fixture, message, models, nativeFrames, streamResponse } from "./test-helpers/gateway.mjs"

const executable = process.env.CLAUDE_CODE_TEST_BINARY
const luna = { id: "gpt-6-luna", supported_endpoints: ["/responses", "ws:/responses"], policy: { state: "enabled" } }
// Both search paths answer with this source and text, which Claude Code must pass on in its WebSearch result.
const source = "https://nodejs.org/en/download"
const answer = "The official Node.js downloads page lists installers for every platform."
const hostedReply = {
  id: "resp_fixture", object: "response", status: "completed", model: "gpt-6-luna",
  output: [
    { id: "ws_fixture", type: "web_search_call", status: "completed", action: { type: "search", query: "Node.js official downloads", sources: [{ type: "url", url: source }] } },
    { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: answer, annotations: [] }] },
  ],
  usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 40 },
}

async function runClient(t, webSearch, hosted = false) {
  const frontend = []
  const backend = []
  const webSearchResults = []
  let searches = 0
  let hostedSearches = 0
  const f = await fixture(t, (call) => {
    if (call.url.pathname === "/responses") {
      hostedSearches++
      return Response.json(hostedReply)
    }
    const body = JSON.parse(call.body)
    if (call.url.pathname === "/v1/messages/count_tokens") return Response.json({ input_tokens: 9 })
    assert.equal(call.url.pathname, "/v1/messages")
    const tools = body.tools ?? []
    const results = body.messages.flatMap((entry) => Array.isArray(entry.content) ? entry.content : []).filter((block) => block.type === "tool_result")
    backend.push({ tools: tools.map(({ name, type }) => ({ name, type })), thinking: body.thinking, tool_choice: body.tool_choice })
    assert.ok(backend.length <= 12, "unexpected fixture request loop")
    assert.equal(tools.some((tool) => tool.type?.startsWith("web_search_")), false)
    let response
    if (!webSearch) response = message([{ type: "text", text: "OK" }])
    else if (tools.some((tool) => tool.name === "web_search")) {
      response = results.length === 0
        ? message([{ type: "tool_use", id: "toolu_search_fixture", name: "web_search", input: { query: "Node.js official downloads" } }], "tool_use")
        : message([{ type: "text", text: answer }])
    } else if (tools.some((tool) => tool.name === "WebSearch") && results.length === 0) {
      response = message([{ type: "tool_use", id: "toolu_client_fixture", name: "WebSearch", input: { query: "Node.js official downloads" } }], "tool_use")
    } else {
      webSearchResults.push(...results.filter((block) => block.tool_use_id === "toolu_client_fixture"))
      response = message([{ type: "text", text: "DONE" }])
    }
    response.model = body.model
    return body.stream ? streamResponse(nativeFrames(response), { fragments: 19 }) : Response.json(response)
  }, {
    config: { requestTimeoutMs: 10000, heartbeatMs: 20 },
    ...(hosted ? { catalog: async () => Response.json({ data: [...models, luna] }) } : {}),
    searchProvider: async () => {
      searches++
      return [{
        type: "web_search_result", url: source,
        title: "Node.js Downloads", encrypted_content: Buffer.from("Official Node.js downloads fixture.").toString("base64"), page_age: null,
      }]
    },
  })
  f.server.on("request", (req) => {
    if (req.method !== "POST") return
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      frontend.push({
        tools: (body.tools ?? []).map(({ name, type }) => ({ name, type })),
        thinking: body.thinking?.type, tool_choice: body.tool_choice,
      })
    })
  })
  const args = [
    "-p", webSearch ? "Use WebSearch once to find the official Node.js downloads page, then say DONE." : "Reply only OK.",
    "--model", "claude-sonnet-5", "--no-session-persistence", "--output-format", "json",
    "--system-prompt", "Follow the user request.", "--tools", webSearch ? "WebSearch" : "",
  ]
  if (webSearch) args.push(
    "--allowedTools", "WebSearch", "--permission-mode", "dontAsk",
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  )
  else args.push("--bare")
  // A private config directory, and none of the developer's Anthropic, cloud
  // provider or network proxy settings: Claude Code reaches only the fixture.
  const configDir = await mkdtemp(join(tmpdir(), "claude-client-fixture-"))
  let child
  t.after(async () => {
    if (child?.exitCode === null && !child.killed) child.kill()
    await rm(configDir, { recursive: true, force: true, maxRetries: 5 })
  })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:anthropic_|claude_code_use_|https?_proxy$|claude_config_dir$)/i.test(name)))
  child = spawn(executable, args, {
    env: {
      ...env,
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: f.base, ANTHROPIC_AUTH_TOKEN: f.key,
      CLAUDE_CODE_SIMPLE: webSearch ? "0" : "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "0",
      DISABLE_AUTOUPDATER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill(), 45000)
  let exitCode
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
  } finally { clearTimeout(timer) }
  assert.equal(exitCode, 0, stderr.slice(0, 1000))
  const output = JSON.parse(stdout)
  assert.equal(output.is_error, false)
  assert.equal(output.result, webSearch ? "DONE" : "OK")
  assert.ok(backend.length > 0)
  if (webSearch) {
    const nested = frontend.find((call) => call.tools.some((tool) => tool.type === "web_search_20250305"))
    assert.ok(nested, "ordinary Claude Code must actually invoke its nested server-search request")
    assert.deepEqual(nested.tool_choice, { type: "tool", name: "web_search" })
    assert.equal(nested.thinking, "disabled")
    if (hosted) {
      // One hosted /responses search answers the nested request: no provider
      // search and no Claude generation around it.
      assert.equal(hostedSearches, 1)
      assert.equal(searches, 0)
      assert.equal(backend.some((call) => call.tools.some((tool) => tool.name === "web_search")), false)
    } else {
      assert.equal(hostedSearches, 0)
      assert.ok(backend.some((call) => call.tools.some((tool) => tool.name === "web_search" && !tool.type)))
      assert.equal(searches, 1)
      assert.ok(backend.length >= 4)
    }
    // What the main model receives: the source and the search answer, not an error or links alone.
    assert.ok(webSearchResults.length > 0, "Claude Code never returned its WebSearch result to the model")
    for (const result of webSearchResults) {
      const text = [result.content ?? ""].flat().map((part) => typeof part === "string" ? part : part.text ?? "").join("\n")
      assert.notEqual(result.is_error, true, text)
      assert.ok(text.includes(source), text)
      assert.ok(text.includes(answer), text)
    }
  }
}

test("installed Claude Code completes ordinary native inference through the real proxy", {
  skip: !executable && "Set CLAUDE_CODE_TEST_BINARY to run the installed-client offline fixture",
  timeout: 60000,
}, (t) => runClient(t, false))

test("installed Claude Code completes its non-bare nested WebSearch flow through provider search", {
  skip: !executable && "Set CLAUDE_CODE_TEST_BINARY to run the installed-client offline fixture",
  timeout: 60000,
}, (t) => runClient(t, true))

test("installed Claude Code completes its nested WebSearch flow through one hosted search", {
  skip: !executable && "Set CLAUDE_CODE_TEST_BINARY to run the installed-client offline fixture",
  timeout: 60000,
}, (t) => runClient(t, true, true))
