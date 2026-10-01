#!/usr/bin/env node

/**
 * GitHub OAuth device authentication. GitHub authentication and Copilot readiness
 * are separate outcomes: a catalog outage must never discard an OAuth grant.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { authFilePath, readAuthToken, savePrivateJson } from "./credentials.mjs"
import { parseRetryAfterMs } from "./runtime.mjs"

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
const DEVICE_CODE_URL = "https://github.com/login/device/code"
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
const USER_AGENT = "claude-code-copilot-provider/1.0.0"

class RequestError extends Error {
  constructor(message, code, httpStatus, retryAfterMs) {
    super(message)
    this.code = code
    this.httpStatus = httpStatus
    this.retryAfterMs = retryAfterMs
  }
}

function positive(value) {
  return Number.isFinite(value) && value > 0
}

async function requestJson(url, init, options, label, { timeoutMs = options.timeoutMs, oauth = false } = {}) {
  const controller = new AbortController()
  let timer
  const timeoutError = new RequestError(`${label} timed out; try again later.`, "ERR_TIMEOUT")
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError)
      controller.abort(timeoutError)
    }, timeoutMs)
  })
  try {
    // Keep the deadline active through JSON/body consumption, not just headers.
    return await Promise.race([timeout, (async () => {
      let response
      try {
        response = await options.fetchImpl(url, { ...init, redirect: "error", signal: controller.signal })
      } catch (error) {
        if (controller.signal.aborted) throw timeoutError
        if (error instanceof TypeError || error.name === "AbortError" || error.name === "TimeoutError") {
          throw new RequestError(`${label} network request failed; try again later.`, "ERR_NETWORK")
        }
        throw error
      }
      if (!response.ok && !(oauth && response.status === 400)) {
        throw new RequestError(`${label} returned HTTP ${response.status}; credentials were not discarded.`,
          "ERR_HTTP", response.status, parseRetryAfterMs(response.headers.get("retry-after"), options.now()))
      }
      try {
        return await response.json()
      } catch (error) {
        if (controller.signal.aborted) throw timeoutError
        if (error instanceof SyntaxError || error instanceof TypeError) {
          throw new RequestError(`${label} returned an invalid or incomplete JSON response.`, "ERR_RESPONSE")
        }
        throw error
      }
    })()])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function oauthRequest(body) {
  return {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
  }
}

function expired() {
  return new Error("Device code expired. Please run authentication again.")
}

async function pollForToken(device, deadline, options) {
  let intervalMs = device.interval * 1000
  let nextDelayMs = intervalMs
  while (options.now() < deadline) {
    await options.sleep(Math.min(nextDelayMs, deadline - options.now()))
    if (options.now() >= deadline) throw expired()
    let data
    try {
      data = await requestJson(ACCESS_TOKEN_URL, oauthRequest({
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }), options, "GitHub authorization polling", {
        timeoutMs: Math.min(options.timeoutMs, deadline - options.now()), oauth: true,
      })
    } catch (error) {
      if (!(error instanceof RequestError)) throw error
      if (options.now() >= deadline) throw expired()
      if (error.code === "ERR_TIMEOUT" || error.code === "ERR_NETWORK" ||
          error.httpStatus === 429 || error.httpStatus >= 500) {
        // RFC 8628: reduce polling frequency after a connection timeout.
        intervalMs *= 2
        nextDelayMs = Math.max(intervalMs, error.retryAfterMs ?? 0)
        continue
      }
      throw error
    }
    if (options.now() >= deadline) throw expired()
    if (typeof data?.access_token === "string" && data.access_token.trim()) return data.access_token
    switch (data?.error) {
      case "authorization_pending":
        break
      case "slow_down":
        // RFC 8628 §3.5: add five seconds for this AND ALL subsequent requests.
        intervalMs += 5000
        break
      case "expired_token":
        throw expired()
      case "access_denied":
        throw new Error("Authorization was denied by the user.")
      default:
        // Never echo arbitrary upstream bodies/error_description (may contain secrets).
        throw new Error("Unexpected OAuth authorization response; authentication stopped.")
    }
    nextDelayMs = intervalMs
  }
  throw expired()
}

async function verifyToken(token, options) {
  const user = await requestJson("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
  }, options, "GitHub token verification")
  if (!user || typeof user.login !== "string" || !user.login.trim()) {
    throw new RequestError("GitHub token verification returned an invalid user response.", "ERR_RESPONSE")
  }
  // Return only the fields used by the CLI, not arbitrary upstream response data.
  return { login: user.login, name: typeof user.name === "string" ? user.name : null }
}

function unavailable(error) {
  return {
    status: error.httpStatus === 401 ? "unauthorized" : error.httpStatus === 403 ? "forbidden" : "unavailable",
    ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
    message: error.message,
  }
}

async function checkCopilotAccess(token, options) {
  try {
    const catalog = await requestJson("https://api.githubcopilot.com/models", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        "Openai-Intent": "conversation-edits",
      },
    }, options, "Copilot access check")
    if (!catalog || !Array.isArray(catalog.data) ||
        !catalog.data.some((model) => typeof model?.id === "string" && model.id.trim())) {
      throw new RequestError("Copilot returned an unavailable or invalid model catalog.", "ERR_RESPONSE")
    }
    return { status: "ready" }
  } catch (error) {
    if (!(error instanceof RequestError)) throw error
    return unavailable(error)
  }
}

/**
 * Run the real authentication workflow without CLI side effects.
 * Options permit offline callers/tests to inject fetchImpl, now, sleep, timeoutMs
 * and onDeviceCode. Returned statuses never include the access token.
 */
export async function authenticate({
  filePath = authFilePath(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  timeoutMs = 10000,
  onDeviceCode = () => {},
} = {}) {
  if (!positive(timeoutMs) || timeoutMs > 2147483647) {
    throw new TypeError("Request timeoutMs must be positive and no greater than 2147483647.")
  }
  const options = { fetchImpl, now, sleep, timeoutMs }
  let token
  try {
    token = await readAuthToken(filePath)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (token) {
    let user
    try {
      user = await verifyToken(token, options)
    } catch (error) {
      // Only confirmed GitHub 401 means reauthentication is appropriate.
      if (!(error instanceof RequestError) || error.httpStatus !== 401) throw error
    }
    if (user) {
      return { source: "existing", filePath, github: { status: "authenticated", user },
        copilot: await checkCopilotAccess(token, options) }
    }
  }

  const startedAt = now()
  const device = await requestJson(DEVICE_CODE_URL, oauthRequest({ scope: "read:user" }),
    options, "GitHub device code request")
  if (!device || !positive(device.expires_in) || !positive(device.interval ?? 5) ||
      !["device_code", "user_code", "verification_uri"].every((key) =>
        typeof device[key] === "string" && device[key].trim())) {
    throw new Error("Invalid GitHub device authorization response.")
  }
  const deadline = startedAt + device.expires_in * 1000
  if (!Number.isFinite(deadline)) throw new Error("Invalid GitHub device authorization expiry.")
  await onDeviceCode({ user_code: device.user_code, verification_uri: device.verification_uri,
    expires_in: device.expires_in })
  token = await pollForToken({ ...device, interval: device.interval ?? 5 }, deadline, options)

  // Persist the successful grant BEFORE any optional user/catalog availability checks.
  await savePrivateJson(filePath, {
    access_token: token, provider: "github-copilot", created_at: new Date(now()).toISOString(),
  })
  let user
  try {
    user = await verifyToken(token, options)
  } catch (error) {
    if (!(error instanceof RequestError)) throw error
    return { source: "device", filePath, github: unavailable(error), copilot: { status: "not_checked" } }
  }
  return { source: "device", filePath, github: { status: "authenticated", user },
    copilot: await checkCopilotAccess(token, options) }
}

async function main() {
  console.log("GitHub Copilot authentication for Claude Code\n")
  const result = await authenticate({
    onDeviceCode: ({ user_code, verification_uri }) => {
      console.log(`Open this URL in your browser: ${verification_uri}`)
      console.log(`Enter the device code: ${user_code}`)
      console.log("Waiting for authorization...")
    },
  })
  console.log(result.source === "device" ? `Token saved to: ${result.filePath}` : `Token file: ${result.filePath}`)
  if (result.github.status !== "authenticated") {
    console.error(`Token saved, but GitHub verification is ${result.github.status}: ${result.github.message}`)
    process.exitCode = 1
    return
  }
  console.log(`GitHub authenticated as: ${result.github.user.login}`)
  if (result.copilot.status === "ready") {
    console.log("Copilot ready: model catalog is accessible.")
  } else {
    console.warn(`Copilot not ready (${result.copilot.status}): ${result.copilot.message}`)
    console.warn("GitHub credentials are saved. Retry later or check your Copilot subscription/access.")
    process.exitCode = 1
  }
  console.log("\nStart the proxy: node scripts/proxy.mjs")
  console.log("To retrieve its private local API key explicitly: node scripts/proxy.mjs --print-api-key")
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(`Authentication failed: ${error.message}`)
    process.exitCode = 1
  })
}
