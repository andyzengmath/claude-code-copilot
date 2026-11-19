import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHmac, randomBytes } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"
import { getProxyKey, savePrivateJson } from "./credentials.mjs"

const exec = promisify(execFile)
const proxyFile = fileURLToPath(new URL("./proxy.mjs", import.meta.url))

async function environment(t) {
  const directory = await mkdtemp(join(tmpdir(), "copilot-proxy-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return {
    ...process.env,
    COPILOT_AUTH_FILE: join(directory, "auth.json"),
    COPILOT_PROXY_KEY_FILE: join(directory, "key.json"),
    COPILOT_PROXY_HOST: "127.0.0.1",
    COPILOT_PROXY_PORT: "0",
  }
}

// Starts the CLI proxy with a fixture sign-in; resolves once it is listening.
async function startProxy(t, env) {
  await savePrivateJson(env.COPILOT_AUTH_FILE, { access_token: "cli-fixture-upstream-token" })
  const key = await getProxyKey({ filePath: env.COPILOT_PROXY_KEY_FILE })
  const child = spawn(process.execPath, [proxyFile], { env, stdio: ["ignore", "pipe", "pipe"] })
  const closed = new Promise((resolve) => child.once("close", resolve))
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill()
    await closed
  })
  const output = { stdout: "", stderr: "" }
  child.stderr.on("data", (chunk) => { output.stderr += chunk })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Proxy did not become ready")), 15000)
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`Proxy exited before readiness: ${output.stderr}`)) })
    child.stdout.on("data", (chunk) => {
      output.stdout += chunk
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output.stdout)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
  })
  return { key, port, output }
}

async function listen(server, port, host) {
  server.listen(port, host)
  await once(server, "listening")
  return server.address().port
}

// Whether this host has an IPv6 loopback address to listen on.
async function hasIPv6Loopback() {
  const server = createServer()
  try {
    await listen(server, 0, "::1")
    return true
  } catch (error) {
    if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code)) return false
    throw error
  } finally { server.close() }
}

test("--print-api-key returns only the persistent key without requiring GitHub credentials", async (t) => {
  const env = await environment(t)
  const printed = await exec(process.execPath, [proxyFile, "--print-api-key"], { env, timeout: 15000 })
  const key = await getProxyKey({ filePath: env.COPILOT_PROXY_KEY_FILE, create: false })
  assert.ok(key.length >= 43)
  assert.equal(printed.stdout.trim(), key)
  assert.equal(printed.stdout.trim().split(/\r?\n/).length, 1)
  assert.equal(printed.stderr, "")
  const again = await exec(process.execPath, [proxyFile, "--print-api-key"], { env, timeout: 15000 })
  assert.equal(again.stdout, printed.stdout)
})

test("normal CLI startup binds loopback and never prints the local key", { timeout: 20000 }, async (t) => {
  const { key, port, output } = await startProxy(t, await environment(t))
  const base = `http://127.0.0.1:${port}`
  assert.equal((await (await fetch(`${base}/health`)).json()).api_key_required, true)
  assert.equal((await fetch(`${base}/v1/models`)).status, 401)
  assert.equal(output.stdout.includes(key), false)
  assert.equal(output.stderr.includes(key), false)
})

test("on 127.0.0.1 the proxy also holds [::1], so clients using localhost cannot reach another process", { timeout: 20000 }, async (t) => {
  if (!await hasIPv6Loopback()) { t.skip("this host has no IPv6 loopback"); return }
  const { key, port } = await startProxy(t, await environment(t))
  // Only this proxy holds the key that the health proof is computed with.
  const nonce = randomBytes(16).toString("hex")
  const health = await (await fetch(`http://[::1]:${port}/health?nonce=${nonce}`)).json()
  assert.equal(health.key_proof, createHmac("sha256", key).update(`claude-code-copilot health ${nonce}`).digest("hex"))
})

test("when another process holds [::1] on its port, the proxy warns clients to use 127.0.0.1", { timeout: 20000 }, async (t) => {
  if (!await hasIPv6Loopback()) { t.skip("this host has no IPv6 loopback"); return }
  // Hold [::1] on a port that is still free on 127.0.0.1.
  let port
  for (let attempt = 0; attempt < 5 && !port; attempt++) {
    const other = createServer()
    const candidate = await listen(other, 0, "::1")
    const probe = createServer()
    try {
      await listen(probe, candidate, "127.0.0.1")
      port = candidate
      t.after(() => other.close())
    } catch {
      other.close()
    } finally { probe.close() }
  }
  assert.ok(port, "no port was free on 127.0.0.1 while held on [::1]")
  const { output } = await startProxy(t, { ...await environment(t), COPILOT_PROXY_PORT: String(port) })
  for (let waited = 0; !output.stderr.includes("[::1]") && waited < 5000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.match(output.stderr, new RegExp(`another process is listening on \\[::1\\]:${port}\\. Clients using http://localhost:${port} may reach another process; use http://127\\.0\\.0\\.1:${port} instead`))
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
})
