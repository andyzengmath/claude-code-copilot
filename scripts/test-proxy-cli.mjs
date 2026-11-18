import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
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
  const env = await environment(t)
  await savePrivateJson(env.COPILOT_AUTH_FILE, { access_token: "cli-fixture-upstream-token" })
  const key = await getProxyKey({ filePath: env.COPILOT_PROXY_KEY_FILE })
  const child = spawn(process.execPath, [proxyFile], { env, stdio: ["ignore", "pipe", "pipe"] })
  const closed = new Promise((resolve) => child.once("close", resolve))
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill()
    await closed
  })
  let stdout = ""
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Proxy did not become ready")), 15000)
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`Proxy exited before readiness: ${stderr}`)) })
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(stdout)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
  })
  const base = `http://127.0.0.1:${port}`
  assert.equal((await (await fetch(`${base}/health`)).json()).api_key_required, true)
  assert.equal((await fetch(`${base}/v1/models`)).status, 401)
  assert.equal(stdout.includes(key), false)
  assert.equal(stderr.includes(key), false)
})
