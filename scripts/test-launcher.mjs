import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { savePrivateJson } from "./credentials.mjs"
import { fixture } from "./test-helpers/gateway.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const bash = process.env.COPILOT_TEST_BASH || (process.platform === "win32"
  ? [
    join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ].find(existsSync)
  : spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0 ? "bash" : undefined)
const options = { skip: !bash && "Bash (Git Bash on Windows) is needed for launcher fixtures", timeout: 120000 }

async function availablePort() {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  return port
}

async function shutdownProxy(env) {
  await new Promise((resolve, reject) => {
    const socket = net.connect(env.TEST_CONTROL_PIPE)
    const finish = () => { socket.destroy(); resolve() }
    socket.setTimeout(2000, finish)
    socket.on("connect", () => socket.end(env.TEST_CONTROL_TOKEN))
    socket.on("close", finish)
    socket.on("error", (error) => {
      if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error.code)) finish()
      else reject(error)
    })
  })
}

async function setup(t, port, key = "launcher-fixture-key") {
  const directory = await mkdtemp(join(tmpdir(), "copilot launcher "))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:copilot_|web_search_|websearch_provider$|anthropic_|brave_api_key$|serper_api_key$|exa_api_key$|parallel_api_key$|path$|bash_env$|env$|shellopts$|bashopts$|node_options$|node_use_env_proxy$)/i.test(name)))
  const oldPath = Object.entries(process.env).find(([name]) => name.toLowerCase() === "path")?.[1] ?? ""
  Object.assign(env, {
    PATH: `${directory}${delimiter}${oldPath}`,
    COPILOT_AUTH_FILE: join(directory, "auth.json"),
    COPILOT_PROXY_KEY_FILE: join(directory, "key.json"),
    COPILOT_PROXY_HOST: "127.0.0.1",
    COPILOT_PROXY_PORT: String(port),
    TEST_REAL_NODE: process.execPath,
    TEST_CLAUDE_APP: join(directory, "client.mjs"),
    TEST_CLIENT_RESULT: join(directory, "client-result.json"),
    TEST_PROXY_HOOK: pathToFileURL(join(directory, "proxy-hook.mjs")).href,
    TEST_CONTROL_PIPE: process.platform === "win32" ? `\\\\.\\pipe\\copilot-launch-${randomUUID()}` : join(directory, "control.sock"),
    TEST_CONTROL_TOKEN: randomUUID(),
    // Stale client settings from older instructions must not reach Claude Code.
    ANTHROPIC_API_KEY: "copilot-proxy",
    ANTHROPIC_AUTH_TOKEN: "stale-fixture-auth-token",
  })
  await savePrivateJson(env.COPILOT_AUTH_FILE, { access_token: "launcher-fixture-upstream-token" })
  await savePrivateJson(env.COPILOT_PROXY_KEY_FILE, { api_key: key })
  await writeFile(join(directory, "node"), `#!/bin/bash
if [[ "$#" -eq 1 && "$1" == */proxy.mjs ]]; then
  exec "$TEST_REAL_NODE" --import "$TEST_PROXY_HOOK" "$@"
fi
exec "$TEST_REAL_NODE" "$@"
`, { mode: 0o755 })
  await writeFile(join(directory, "docker"), "#!/bin/bash\nexit 1\n", { mode: 0o755 })
  await writeFile(join(directory, "claude"), '#!/bin/bash\nexec "$TEST_REAL_NODE" "$TEST_CLAUDE_APP" "$@"\n', { mode: 0o755 })
  await writeFile(env.TEST_CLAUDE_APP, `
import { writeFile } from "node:fs/promises";
const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
  method: "POST", headers: {authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN, "content-type":"application/json"}, body:"null",
  signal: AbortSignal.timeout(3000)
});
await response.arrayBuffer();
await writeFile(process.env.TEST_CLIENT_RESULT, JSON.stringify({
  base: process.env.ANTHROPIC_BASE_URL, keyAccepted: response.status === 400,
  apiKeyUnset: !("ANTHROPIC_API_KEY" in process.env), autoModeServer: process.env.CLAUDE_CODE_AUTO_MODE_SERVER,
  args: process.argv.slice(2)
}));
console.log("fixture client finished");
`)
  await writeFile(join(directory, "proxy-hook.mjs"), `
import net from "node:net";
globalThis.fetch = async () => { throw new Error("Fixture forbids all upstream API calls"); };
const control = net.createServer(socket => {
  socket.once("data", data => {
    if (data.toString() === process.env.TEST_CONTROL_TOKEN) {
      socket.end(() => process.exit(0));
      return;
    }
    socket.end();
  });
});
control.listen(process.env.TEST_CONTROL_PIPE);
control.unref();
`)
  t.after(async () => { await shutdownProxy(env); await rm(directory, { recursive: true, force: true }) })
  return { env, directory }
}

async function launch(t, env, args = [], trace = false) {
  const child = spawn(bash, [...(trace ? ["-x"] : []), "scripts/launch.sh", ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const closed = new Promise((resolve) => child.once("close", resolve))
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill()
    await shutdownProxy(env)
    await closed
  })
  // A launch takes 1-2 s in CI, but over 35 s through the Docker fallback on a loaded Windows machine.
  const timer = setTimeout(() => child.kill(), 90000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    return { code, stdout, stderr }
  } finally { clearTimeout(timer) }
}

test("launcher refuses a healthy service whose API key differs from its configured key", options, async (t) => {
  const f = await fixture(t, () => assert.fail("no upstream calls expected"))
  const { env } = await setup(t, f.server.address().port, "a-different-fixture-key")
  const result = await launch(t, env)
  assert.notEqual(result.code, 0)
  assert.equal(existsSync(env.TEST_CLIENT_RESULT), false)
  assert.equal((await fetch(`${f.base}/health`)).status, 200)
})

test("launcher hands the configured key to Claude as its auth token and unsets an inherited API key", options, async (t) => {
  const f = await fixture(t, () => assert.fail("no upstream calls expected"))
  const { env } = await setup(t, f.server.address().port, f.key)
  const result = await launch(t, env, ["-p", "fixture with spaces"])
  assert.equal(result.code, 0, result.stderr)
  const client = JSON.parse(await readFile(env.TEST_CLIENT_RESULT, "utf8"))
  assert.equal(client.keyAccepted, true)
  // Unset, not empty: interactive Claude Code asks before using an API key.
  assert.equal(client.apiKeyUnset, true)
  assert.equal(client.autoModeServer, "0")
  assert.equal(client.base, f.base)
  assert.deepEqual(client.args, ["-p", "fixture with spaces"])
})

test("launcher Node fallback stays available for other sessions after the initial Claude exits", options, async (t) => {
  const port = await availablePort()
  const { env } = await setup(t, port)
  const result = await launch(t, env)
  assert.equal(result.code, 0, result.stderr)
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
  assert.equal(response.status, 200)
})

test("launcher shell tracing cannot print the local API key", options, async (t) => {
  const f = await fixture(t, () => assert.fail("no upstream calls expected"))
  const { env } = await setup(t, f.server.address().port, f.key)
  const result = await launch(t, env, [], true)
  assert.equal(result.code, 0)
  assert.equal(result.stdout.includes(f.key), false)
  assert.equal(result.stderr.includes(f.key), false)
})

test("launcher passes the local API key in no command line, which other local users can list", options, async (t) => {
  const port = await availablePort()
  const key = `argv-fixture-key-${randomUUID()}`
  const { env, directory } = await setup(t, port, key)
  env.TEST_ARGV_LOG = join(directory, "argv.log")
  env.TEST_REAL_ENV = spawnSync(bash, ["-c", "command -v env"], { encoding: "utf8" }).stdout.trim()
  const logged = (name, body) => `#!/bin/bash
{ printf '<<${name}>>'; printf ' %q' "$@"; printf '\\n'; } >> "$TEST_ARGV_LOG"
${body}
`
  // Docker is available but fails to start, so the probes, Docker, the Node fallback and Claude all run.
  const wrappers = {
    node: `if [[ "$#" -eq 1 && "$1" == */proxy.mjs ]]; then
  exec "$TEST_REAL_NODE" --import "$TEST_PROXY_HOOK" "$@"
fi
exec "$TEST_REAL_NODE" "$@"`,
    docker: `if [[ "$1" == info || ( "$1" == compose && "$2" == version ) ]]; then exit 0; fi
exit 1`,
    curl: "exit 1",
    env: 'exec "$TEST_REAL_ENV" "$@"',
    claude: 'exec "$TEST_REAL_NODE" "$TEST_CLAUDE_APP" "$@"',
  }
  for (const [name, body] of Object.entries(wrappers)) {
    await writeFile(join(directory, name), logged(name, body), { mode: 0o755 })
  }
  // Git Bash puts its own directories, which have env and curl, ahead of the inherited PATH.
  env.TEST_WRAPPERS = process.platform === "win32"
    ? spawnSync(bash, ["-c", 'cygpath -u "$0"', directory], { encoding: "utf8" }).stdout.trim() : directory
  await writeFile(join(directory, "path.sh"), 'PATH="$TEST_WRAPPERS:$PATH"\n')
  env.BASH_ENV = `${env.TEST_WRAPPERS}/path.sh`
  const result = await launch(t, env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(await readFile(env.TEST_CLIENT_RESULT, "utf8")).keyAccepted, true)
  const calls = (await readFile(env.TEST_ARGV_LOG, "utf8")).trim().split("\n")
  const names = new Set(calls.map((line) => line.match(/^<<(\w+)>>/)?.[1]))
  for (const name of ["node", "docker", "env", "claude"]) assert.ok(names.has(name), `${name} was not run`)
  for (const line of calls) assert.equal(line.includes(key), false, `key in argv: ${line.slice(0, 120)}`)
})

for (const status of [404, 500, 200]) {
  test(`launcher rejects ${status === 200 ? "old unauthenticated" : status} health without stopping that service`, options, async (t) => {
    const server = createServer((req, res) => {
      // The old proxy on main answers only the exact paths /health and /.
      const health = status === 200 ? req.url === "/health" || req.url === "/" : req.url.startsWith("/health")
      if (health) {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify({
          status: "ok", provider: "github-copilot", ...(status === 200 ? {} : { api_key_required: true }),
        }))
      } else {
        res.writeHead(status === 200 ? 404 : 400)
        res.end("{}")
      }
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
    const port = server.address().port
    const { env } = await setup(t, port)
    const result = await launch(t, env)
    assert.notEqual(result.code, 0)
    assert.equal(existsSync(env.TEST_CLIENT_RESULT), false)
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, status)
    if (status === 200) {
      assert.match(result.stderr, /older claude-code-copilot proxy/)
      assert.match(result.stderr, /docker rm -f claude-copilot-proxy/)
    }
  })
}

test("launcher never sends its key to a listener that cannot prove it holds the key", options, async (t) => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers["x-api-key"] ?? req.headers.authorization ?? null })
    res.writeHead(req.url.startsWith("/health") ? 200 : 400, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: "ok", provider: "github-copilot", api_key_required: true, key_proof: "00".repeat(32) }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const { env } = await setup(t, server.address().port)
  const result = await launch(t, env)
  assert.notEqual(result.code, 0)
  assert.equal(existsSync(env.TEST_CLIENT_RESULT), false)
  assert.ok(seen.length > 0)
  for (const request of seen) {
    assert.equal(request.key, null)
    assert.match(request.url, /^\/health\?nonce=[0-9a-f]{32}$/)
  }
})

test("a Docker startup command failure reaches the working Node fallback despite set-e", options, async (t) => {
  const port = await availablePort()
  const { env, directory } = await setup(t, port)
  env.TEST_DOCKER_ATTEMPT = join(directory, "docker-attempt")
  await writeFile(join(directory, "docker"), `#!/bin/bash
if [[ "$1" == info || ( "$1" == compose && "$2" == version ) ]]; then exit 0; fi
printf attempted > "$TEST_DOCKER_ATTEMPT"
exit 1
`, { mode: 0o755 })
  const result = await launch(t, env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(existsSync(env.TEST_DOCKER_ATTEMPT), true)
  assert.equal(JSON.parse(await readFile(env.TEST_CLIENT_RESULT, "utf8")).keyAccepted, true)
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
})

test("launcher restricts an auth file other users can read before it starts Docker", {
  ...options, skip: process.platform === "win32" ? "POSIX permissions only" : options.skip,
}, async (t) => {
  const port = await availablePort()
  const { env, directory } = await setup(t, port)
  await chmod(env.COPILOT_AUTH_FILE, 0o644)
  env.TEST_DOCKER_MODE = join(directory, "docker-mode")
  // Compose mounts the file read-only, so its mode when Docker starts is what the container gets.
  await writeFile(join(directory, "docker"), `#!/bin/bash
if [[ "$1" == info || ( "$1" == compose && "$2" == version ) ]]; then exit 0; fi
"$TEST_REAL_NODE" -e 'process.stdout.write((require("node:fs").statSync(process.env.COPILOT_AUTH_FILE).mode & 0o777).toString(8))' > "$TEST_DOCKER_MODE"
exit 1
`, { mode: 0o755 })
  const result = await launch(t, env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(await readFile(env.TEST_DOCKER_MODE, "utf8"), "600")
  assert.match(result.stdout, /Restricted .+ to owner-only access/)
})
