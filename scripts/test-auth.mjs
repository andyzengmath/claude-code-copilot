import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import fsPromises, { mkdtemp, readFile, writeFile, readdir, rm, stat, chmod, mkdir } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const credentialsUrl = new URL("./credentials.mjs", import.meta.url)
const authUrl = new URL("./auth.mjs", import.meta.url)
// All values below are fixtures, never credentials from the user's environment.
const TOKEN = "test-only-oauth-fixture"
const OTHER_TOKEN = "test-only-replacement-fixture"

async function credentials() {
  assert.ok(existsSync(credentialsUrl), "the shared credentials module must exist")
  return import(credentialsUrl.href)
}

async function authentication() {
  const source = await readFile(authUrl, "utf8")
  assert.ok(/export async function authenticate\b/.test(source),
    "auth.mjs must export the real workflow without running the CLI on import")
  return import(authUrl.href)
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "copilot-auth-test-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, filePath: join(dir, "auth fixture & private.json") }
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function device(overrides = {}) {
  return { device_code: "fixture-device", user_code: "FIXTURE", verification_uri: "https://github.com/login/device",
    interval: 1, expires_in: 120, ...overrides }
}

function scenario({ deviceData = device(), polls = [{ access_token: TOKEN }],
  userStatus = 200, modelsStatus = 200, userReply, modelsReply, deviceReply } = {}) {
  let time = 0
  const sleeps = []
  const requests = []
  let pollIndex = 0
  const options = {
    now: () => time,
    sleep: async (ms) => { sleeps.push(ms); time += ms },
    timeoutMs: 100,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname
      assert.ok(init.signal instanceof AbortSignal, "every request must have an abort signal")
      requests.push({ path, time })
      if (path === "/login/device/code") return deviceReply ? deviceReply(init) : response(deviceData)
      if (path === "/login/oauth/access_token") {
        const next = polls[pollIndex++]
        assert.ok(next, "workflow made an unexpected extra poll")
        return typeof next === "function" ? next(init) : response(next)
      }
      if (path === "/user") return userReply ? userReply(init) : response({ login: "fixture-user" }, userStatus)
      if (path === "/models") return modelsReply ? modelsReply(init) : response({ data: [{ id: "fixture-model" }] }, modelsStatus)
      assert.fail("unexpected network endpoint")
    },
  }
  return { options, sleeps, requests, advance: (ms) => { time += ms } }
}

function hangingRequest(init) {
  return new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  })
}

async function assertPrivate(filePath) {
  if (process.platform !== "win32") {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    return
  }
  // Pass the fixture path through the environment, never interpolate it into a shell command.
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; $acl = [System.IO.File]::GetAccessControl($env:COPILOT_TEST_ACL_PATH); " +
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
    "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); " +
    "[pscustomobject]@{ Protected = $acl.AreAccessRulesProtected; " +
    "OnlyCurrentUser = (@($rules | Where-Object { $_.IdentityReference.Value -ne $sid -or $_.IsInherited }).Count -eq 0); " +
    "RuleCount = $rules.Count } | ConvertTo-Json -Compress",
  ], { env: { ...process.env, COPILOT_TEST_ACL_PATH: filePath } })
  const acl = JSON.parse(stdout)
  assert.equal(acl.Protected, true, "credential ACL must disable inherited access")
  assert.equal(acl.OnlyCurrentUser, true, "credential ACL must grant only the current user")
  assert.ok(acl.RuleCount > 0, "credential ACL must retain owner access")
}

test("shared credential paths honor overrides and home defaults", async () => {
  const { authFilePath, proxyKeyFilePath } = await credentials()
  assert.equal(authFilePath({}), join(homedir(), ".claude-copilot-auth.json"))
  assert.equal(proxyKeyFilePath({}), join(homedir(), ".claude-copilot-proxy-key.json"))
  assert.equal(authFilePath({ COPILOT_AUTH_FILE: "fixture-auth" }), "fixture-auth")
  assert.equal(proxyKeyFilePath({ COPILOT_PROXY_KEY_FILE: "fixture-key" }), "fixture-key")
})

test("readAuthToken reads only the specified fixture and rejects absent/invalid input without secret leakage", async (t) => {
  const { readAuthToken } = await credentials()
  const { filePath } = await fixture(t)
  await assert.rejects(readAuthToken(filePath), (err) => err.code === "ENOENT" && /auth|credential/i.test(err.message))
  for (const content of ["{", `{"access_token":"${TOKEN}"`, "null", "{}", '{"access_token":42}', '{"access_token":"  "}']) {
    await writeFile(filePath, content)
    await assert.rejects(readAuthToken(filePath), (err) =>
      /invalid|nonempty|json/i.test(err.message) && !err.message.includes(TOKEN))
  }
  await writeFile(filePath, JSON.stringify({ access_token: TOKEN }))
  assert.equal(await readAuthToken(filePath), TOKEN)
})

test("private JSON replacement is complete and leaves directory permissions and unrelated files intact", async (t) => {
  const { savePrivateJson, readAuthToken } = await credentials()
  const { dir, filePath } = await fixture(t)
  if (process.platform !== "win32") await chmod(dir, 0o750)
  const before = (await stat(dir)).mode
  await writeFile(join(dir, ".unrelated.tmp"), "leave me")
  await savePrivateJson(filePath, { access_token: TOKEN })
  await assertPrivate(filePath)
  await savePrivateJson(filePath, { access_token: OTHER_TOKEN, complete: true })
  assert.equal(await readAuthToken(filePath), OTHER_TOKEN)
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).complete, true)
  await assertPrivate(filePath)
  assert.equal((await stat(dir)).mode, before)
  assert.deepEqual((await readdir(dir)).sort(), [".unrelated.tmp", "auth fixture & private.json"])
})

test("Windows credential protection removes unexpected explicit grants before publication", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { savePrivateJson, getProxyKey } = await credentials()
  const { dir, filePath } = await fixture(t)
  const originalOpen = fsPromises.open
  const icacls = join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe")
  let seeded = 0
  const interceptedOpen = t.mock.method(fsPromises, "open", async (file, ...options) => {
    const handle = await originalOpen(file, ...options)
    if (typeof file === "string" && dirname(file) === dir && file.endsWith(".tmp")) {
      try {
        assert.equal((await handle.stat()).size, 0)
        await execFileAsync(icacls, [file, "/grant:r", "*S-1-1-0:(R)"], { windowsHide: true })
        seeded++
      } catch (error) {
        await handle.close()
        throw error
      }
    }
    return handle
  })
  syncBuiltinESMExports()
  try {
    await savePrivateJson(filePath, { access_token: TOKEN })
    await assertPrivate(filePath)
    const keyPath = join(dir, "key.json")
    await getProxyKey({ filePath: keyPath })
    await assertPrivate(keyPath)
    assert.equal(seeded, 2)
  } finally {
    interceptedOpen.mock.restore()
    syncBuiltinESMExports()
  }
})

test("readers never observe partial JSON during replacements", async (t) => {
  const { savePrivateJson } = await credentials()
  const { filePath } = await fixture(t)
  await savePrivateJson(filePath, { revision: 0, padding: "x".repeat(65536) })
  let finished = false
  let reads = 0
  const reader = (async () => {
    while (!finished) {
      const data = JSON.parse(await readFile(filePath, "utf8"))
      assert.equal(data.padding.length, 65536)
      assert.ok(Number.isInteger(data.revision))
      reads++
    }
  })()
  try {
    for (let revision = 1; revision <= 4; revision++) {
      await savePrivateJson(filePath, { revision, padding: "x".repeat(65536) })
    }
  } finally {
    finished = true
    await reader
  }
  assert.ok(reads > 0)
})

test("failed writes preserve existing contents and remove only owned temporary files", async (t) => {
  const { savePrivateJson } = await credentials()
  const { dir, filePath } = await fixture(t)
  await writeFile(filePath, "original")
  const circular = {}
  circular.self = circular
  await assert.rejects(savePrivateJson(filePath, circular), /json|serializ/i)
  assert.equal(await readFile(filePath, "utf8"), "original")
  const targetDirectory = join(dir, "not-a-file")
  await mkdir(targetDirectory)
  await assert.rejects(savePrivateJson(targetDirectory, { access_token: TOKEN }))
  assert.deepEqual((await readdir(dir)).sort(), ["auth fixture & private.json", "not-a-file"])
})

test("proxy keys are random, private, persistent, and never regenerated on corrupt input", async (t) => {
  const { getProxyKey } = await credentials()
  const { filePath, dir } = await fixture(t)
  await assert.rejects(getProxyKey({ filePath, create: false }), /missing|not found|exist/i)
  const key = await getProxyKey({ filePath })
  assert.match(key, /^[a-f0-9]{64,}$/)
  assert.equal(await getProxyKey({ filePath }), key)
  assert.equal(await getProxyKey({ filePath, create: false }), key)
  await assertPrivate(filePath)
  const second = await getProxyKey({ filePath: join(dir, "second.json") })
  assert.notEqual(second, key)
  for (const content of ["{", "null", "{}", '{"api_key":true}', '{"api_key":" "}']) {
    await writeFile(filePath, content)
    await assert.rejects(getProxyKey({ filePath }), /invalid|json|nonempty/i)
    assert.equal(await readFile(filePath, "utf8"), content)
  }
})

test("concurrent first-time proxy key creators agree on the committed key", async (t) => {
  const { getProxyKey } = await credentials()
  const { filePath, dir } = await fixture(t)
  const keys = await Promise.all(Array.from({ length: 12 }, () => getProxyKey({ filePath })))
  assert.equal(new Set(keys).size, 1)
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).api_key, keys[0])
  assert.deepEqual(await readdir(dir), ["auth fixture & private.json"])
})

test("independent processes agree on one non-overwritten proxy key without printing it", async (t) => {
  await credentials()
  const { filePath } = await fixture(t)
  const code = `import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    const { getProxyKey } = await import(process.env.COPILOT_TEST_MODULE);
    const key = await getProxyKey({ filePath: process.env.COPILOT_TEST_FILE });
    await new Promise(resolve => setTimeout(resolve, 100));
    const stored = JSON.parse(await readFile(process.env.COPILOT_TEST_FILE, "utf8")).api_key;
    assert.ok(key === stored, "all creators must use the committed key");
    console.log("ok");`
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    execFileAsync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, COPILOT_TEST_MODULE: credentialsUrl.href, COPILOT_TEST_FILE: filePath },
      timeout: 15000,
    })))
  for (const result of results) {
    assert.equal(result.stdout.trim(), "ok")
    assert.equal(result.stderr, "")
  }
})

test("credential paths reject unsafe input without starting external commands", async () => {
  const { savePrivateJson, readAuthToken, getProxyKey } = await credentials()
  for (const filePath of ["", "bad\0path", 42]) {
    await assert.rejects(savePrivateJson(filePath, {}), /path/i)
    await assert.rejects(readAuthToken(filePath), /path/i)
    await assert.rejects(getProxyKey({ filePath }), /path/i)
  }
  if (process.platform === "win32") {
    await assert.rejects(savePrivateJson("C:\\fixture.json:stream", {}), /path|stream/i)
  }
})

test("importing auth has no network, filesystem, or CLI side effects", async (t) => {
  await authentication()
  const { filePath } = await fixture(t)
  const code = `globalThis.fetch = () => { throw new Error("import must not fetch") };
    await import(process.env.COPILOT_TEST_MODULE); console.log("imported");`
  const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, COPILOT_AUTH_FILE: filePath, COPILOT_TEST_MODULE: authUrl.href },
    timeout: 5000,
  })
  assert.equal(result.stdout.trim(), "imported")
  assert.equal(result.stderr, "")
  assert.equal(existsSync(filePath), false)
})

test("slow_down permanently adds five seconds to every later polling interval", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ polls: [
    { error: "slow_down" }, { error: "authorization_pending" }, { error: "slow_down" },
    { error: "authorization_pending" }, { access_token: TOKEN },
  ] })
  const seen = []
  const result = await authenticate({ filePath, ...run.options, onDeviceCode: (data) => seen.push(data.user_code) })
  assert.deepEqual(run.sleeps, [1000, 6000, 6000, 11000, 11000])
  assert.deepEqual(seen, ["FIXTURE"])
  assert.equal(result.github.status, "authenticated")
  assert.equal(result.copilot.status, "ready")
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).access_token, TOKEN)
})

test("polling stops at local expiry even if the server never expires the device code", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ deviceData: device({ expires_in: 3 }),
    polls: [{ error: "authorization_pending" }, { error: "authorization_pending" }] })
  await assert.rejects(authenticate({ filePath, ...run.options }), /expired/i)
  assert.deepEqual(run.sleeps, [1000, 1000, 1000])
  assert.equal(run.requests.filter((request) => request.path.endsWith("access_token")).length, 2)
  assert.equal(existsSync(filePath), false)
})

test("device initiation and user prompt time count against the local deadline", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ deviceReply: () => { run.advance(2000); return response(device({ expires_in: 3 })) } })
  await assert.rejects(authenticate({ filePath, ...run.options, onDeviceCode: () => run.advance(1000) }), /expired/i)
  assert.deepEqual(run.sleeps, [])
  assert.equal(run.requests.length, 1)
})

for (const error of ["access_denied", "expired_token"]) {
  test(`server ${error} is terminal and never saves a credential`, async (t) => {
    const { authenticate } = await authentication()
    const { filePath } = await fixture(t)
    const run = scenario({ polls: [{ error }] })
    await assert.rejects(authenticate({ filePath, ...run.options }), error === "access_denied" ? /denied/i : /expired/i)
    assert.equal(run.requests.length, 2)
    assert.equal(existsSync(filePath), false)
  })
}

test("device initiation has an explicit timeout", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ deviceReply: hangingRequest })
  await assert.rejects(authenticate({ filePath, ...run.options }), /timed out|timeout/i)
  assert.equal(run.requests.length, 1)
})

test("polling timeouts back off all later polls and still respect local expiry", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ deviceData: device({ expires_in: 7 }),
    polls: [hangingRequest, hangingRequest] })
  await assert.rejects(authenticate({ filePath, ...run.options }), /expired/i)
  assert.deepEqual(run.sleeps, [1000, 2000, 4000])
  assert.equal(run.requests.filter((request) => request.path.endsWith("access_token")).length, 2)
})

test("timeout covers response body consumption, not only response headers", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ deviceReply: () => new Response(new ReadableStream({ start() {} })) })
  await assert.rejects(authenticate({ filePath, ...run.options }), /timed out|timeout/i)
})

test("invalid device responses and unknown OAuth errors fail explicitly", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  for (const deviceData of [device({ expires_in: undefined }), device({ expires_in: 0 }),
    device({ interval: -1 }), device({ device_code: "" })]) {
    const run = scenario({ deviceData })
    await assert.rejects(authenticate({ filePath, ...run.options }), /invalid.*device/i)
    assert.equal(run.requests.length, 1)
  }
  const run = scenario({ polls: [{ error: "unexpected", error_description: TOKEN }] })
  await assert.rejects(authenticate({ filePath, ...run.options }),
    (err) => /unexpected|unrecognized/i.test(err.message) && !err.message.includes(TOKEN))
})

test("existing GitHub 401 permits reauthentication and replaces the fixture only after authorization", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  await writeFile(filePath, JSON.stringify({ access_token: OTHER_TOKEN }))
  let userCalls = 0
  const run = scenario({ userReply: () => response({ login: "fixture-user" }, ++userCalls === 1 ? 401 : 200) })
  const result = await authenticate({ filePath, ...run.options })
  assert.equal(result.source, "device")
  assert.equal(result.github.status, "authenticated")
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).access_token, TOKEN)
})

for (const status of [403, 429, 500, 503]) {
  test(`existing GitHub HTTP ${status} preserves the token and does not start a device flow`, async (t) => {
    const { authenticate } = await authentication()
    const { filePath } = await fixture(t)
    const original = JSON.stringify({ access_token: TOKEN })
    await writeFile(filePath, original)
    const run = scenario({ userStatus: status })
    await assert.rejects(authenticate({ filePath, ...run.options }), new RegExp(String(status)))
    assert.deepEqual(run.requests.map(({ path }) => path), ["/user"])
    assert.equal(await readFile(filePath, "utf8"), original)
  })
}

for (const mode of ["network", "timeout"]) {
  test(`existing GitHub ${mode} failure preserves the token without reauthentication`, async (t) => {
    const { authenticate } = await authentication()
    const { filePath } = await fixture(t)
    const original = JSON.stringify({ access_token: TOKEN })
    await writeFile(filePath, original)
    const run = scenario({ userReply: mode === "timeout" ? hangingRequest : () => { throw new TypeError("offline") } })
    await assert.rejects(authenticate({ filePath, ...run.options }), /network|timed out|timeout/i)
    assert.deepEqual(run.requests.map(({ path }) => path), ["/user"])
    assert.equal(await readFile(filePath, "utf8"), original)
  })
}

test("corrupt saved auth is reported instead of silently starting OAuth", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  await writeFile(filePath, "{")
  const run = scenario()
  await assert.rejects(authenticate({ filePath, ...run.options }), /invalid|json/i)
  assert.equal(run.requests.length, 0)
})

test("valid existing GitHub auth is reused and Copilot 401 is not success", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  await writeFile(filePath, JSON.stringify({ access_token: TOKEN }))
  const run = scenario({ modelsStatus: 401 })
  const result = await authenticate({ filePath, ...run.options })
  assert.equal(result.source, "existing")
  assert.equal(result.github.status, "authenticated")
  assert.equal(result.copilot.status, "unauthorized")
  assert.deepEqual(run.requests.map(({ path }) => path), ["/user", "/models"])
})

for (const status of [401, 403, 429, 500, 503]) {
  test(`new OAuth grant is already persisted when Copilot returns HTTP ${status}`, async (t) => {
    const { authenticate } = await authentication()
    const { filePath } = await fixture(t)
    const run = scenario({ modelsReply: async () => {
      assert.equal(JSON.parse(await readFile(filePath, "utf8")).access_token, TOKEN)
      return response({}, status)
    } })
    const result = await authenticate({ filePath, ...run.options })
    assert.equal(result.github.status, "authenticated")
    assert.equal(result.copilot.status, status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "unavailable")
    assert.equal(result.copilot.httpStatus, status)
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).access_token, TOKEN)
  })
}

for (const mode of ["network", "timeout", "invalid-json"]) {
  test(`Copilot ${mode} failure is explicit and nonfatal to the saved OAuth grant`, async (t) => {
    const { authenticate } = await authentication()
    const { filePath } = await fixture(t)
    const modelsReply = mode === "timeout" ? hangingRequest :
      mode === "invalid-json" ? () => new Response("{") : () => { throw new TypeError("offline") }
    const run = scenario({ modelsReply })
    const result = await authenticate({ filePath, ...run.options })
    assert.equal(result.github.status, "authenticated")
    assert.equal(result.copilot.status, "unavailable")
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).access_token, TOKEN)
    assert.ok(!JSON.stringify(result).includes(TOKEN), "workflow results must not expose the token")
  })
}

test("new OAuth grant survives a subsequent GitHub verification outage without claiming readiness", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ userStatus: 503 })
  const result = await authenticate({ filePath, ...run.options })
  assert.equal(result.github.status, "unavailable")
  assert.equal(result.copilot.status, "not_checked")
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).access_token, TOKEN)
})

test("save failures are fatal and do not continue to access checks", async (t) => {
  const { authenticate } = await authentication()
  const { dir, filePath } = await fixture(t)
  const run = scenario()
  await assert.rejects(authenticate({
    filePath, ...run.options,
    onDeviceCode: async () => { await rm(dir, { recursive: true }) },
  }), /save|write|directory|ENOENT/i)
  assert.deepEqual(run.requests.map(({ path }) => path), ["/login/device/code", "/login/oauth/access_token"])
})

test("auth CLI errors are safe and nonzero, using only a corrupt fixture", async (t) => {
  await authentication()
  const { filePath } = await fixture(t)
  await writeFile(filePath, `{"access_token":"${TOKEN}"`)
  await assert.rejects(execFileAsync(process.execPath, [fileURLToPath(authUrl)], {
    env: { ...process.env, COPILOT_AUTH_FILE: filePath }, timeout: 5000,
  }), (err) => err.code === 1 && /invalid|json/i.test(err.stderr) && !err.stderr.includes(TOKEN))
})

test("malformed catalog entries never report Copilot ready", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  await writeFile(filePath, JSON.stringify({ access_token: TOKEN }))
  for (const data of [[], [null], [{}], [{ id: "" }]]) {
    const run = scenario({ modelsReply: () => response({ data }) })
    const result = await authenticate({ filePath, ...run.options })
    assert.equal(result.github.status, "authenticated")
    assert.equal(result.copilot.status, "unavailable")
  }
})

test("a polling response arriving after local expiry cannot save a late grant", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ deviceData: device({ expires_in: 2 }), polls: [
    () => { run.advance(2000); return response({ access_token: TOKEN }) },
  ] })
  await assert.rejects(authenticate({ filePath, ...run.options }), /expired/i)
  assert.equal(existsSync(filePath), false)
})

test("server OAuth errors on HTTP 400 remain terminal", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ polls: [() => response({ error: "expired_token" }, 400)] })
  await assert.rejects(authenticate({ filePath, ...run.options }), /expired/i)
  assert.equal(run.requests.length, 2)
})

test("an omitted device interval uses the RFC five-second default", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ deviceData: device({ interval: undefined }) })
  await authenticate({ filePath, ...run.options })
  assert.deepEqual(run.sleeps, [5000])
})

test("a denied replacement flow leaves the previous GitHub 401 credential untouched", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const original = JSON.stringify({ access_token: OTHER_TOKEN })
  await writeFile(filePath, original)
  const run = scenario({ userStatus: 401, polls: [{ error: "access_denied" }] })
  await assert.rejects(authenticate({ filePath, ...run.options }), /denied/i)
  assert.equal(await readFile(filePath, "utf8"), original)
})

test("unexpected implementation errors are not converted to outage or fallback success", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  await writeFile(filePath, JSON.stringify({ access_token: TOKEN }))
  const run = scenario({ modelsReply: () => { throw new Error("fixture implementation failure") } })
  await assert.rejects(authenticate({ filePath, ...run.options }), /fixture implementation failure/)
})

test("Windows ACL setup failure refuses secret writes and cleans owned temporary files", {
  skip: process.platform !== "win32",
}, async (t) => {
  await credentials()
  const { filePath, dir } = await fixture(t)
  await writeFile(filePath, "original fixture")
  const code = `import assert from "node:assert/strict";
    process.env.SystemRoot = process.env.COPILOT_TEST_ROOT;
    const { savePrivateJson } = await import(process.env.COPILOT_TEST_MODULE);
    await assert.rejects(savePrivateJson(process.env.COPILOT_TEST_FILE, {access_token:"never-written-fixture"}),
      error => error.code === "ERR_CREDENTIAL_ACL");
    console.log("refused");`
  const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, COPILOT_TEST_ROOT: dir, COPILOT_TEST_MODULE: credentialsUrl.href, COPILOT_TEST_FILE: filePath },
    timeout: 15000,
  })
  assert.equal(result.stdout.trim(), "refused")
  assert.equal(result.stderr, "")
  assert.equal(await readFile(filePath, "utf8"), "original fixture")
  assert.deepEqual(await readdir(dir), ["auth fixture & private.json"])
})

test("authentication requests never follow redirects with OAuth grants or authorization headers", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario()
  const fetchImpl = run.options.fetchImpl
  await authenticate({
    filePath, ...run.options,
    fetchImpl: (url, init) => {
      assert.equal(init.redirect, "error", "all authentication endpoints must reject HTTP redirects")
      return fetchImpl(url, init)
    },
  })
  assert.equal(run.requests.length, 4)
})

test("stored credentials reject values that cannot safely round-trip through HTTP headers and key output", async (t) => {
  const { readAuthToken, getProxyKey } = await credentials()
  const { filePath } = await fixture(t)
  for (const field of ["access_token", "api_key"]) {
    for (const value of [` ${TOKEN}`, `${TOKEN} `, `${TOKEN}\nline`, `${TOKEN}\u0000`, `${TOKEN}\u0100`]) {
      const original = JSON.stringify({ [field]: value })
      await writeFile(filePath, original)
      await assert.rejects(field === "access_token" ? readAuthToken(filePath) : getProxyKey({ filePath }),
        (error) => error.code === "ERR_CREDENTIAL_FORMAT" && !error.message.includes(TOKEN))
      assert.equal(await readFile(filePath, "utf8"), original)
    }
  }
})

test("OAuth polling honors the complete HTTP Retry-After hint without changing later normal polling", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ polls: [
    () => new Response("busy", { status: 429, headers: { "retry-after": "90" } }),
    { error: "authorization_pending" },
    { access_token: TOKEN },
  ] })
  await authenticate({ filePath, ...run.options })
  assert.deepEqual(run.sleeps, [1000, 90000, 2000])
})

test("a polling Retry-After beyond expiry never causes an early extra authorization attempt", async (t) => {
  const { authenticate } = await authentication()
  const { filePath } = await fixture(t)
  const run = scenario({ deviceData: device({ expires_in: 7 }), polls: [
    () => new Response("busy", { status: 429, headers: { "retry-after": "90" } }),
  ] })
  await assert.rejects(authenticate({ filePath, ...run.options }), /expired/i)
  assert.deepEqual(run.sleeps, [1000, 6000])
  assert.equal(run.requests.filter((request) => request.path.endsWith("access_token")).length, 1)
})
