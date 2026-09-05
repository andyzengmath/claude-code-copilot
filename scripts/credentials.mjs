import { open, readFile, rename, link, unlink } from "node:fs/promises"
import { randomBytes, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export function authFilePath(env = process.env) {
  return env.COPILOT_AUTH_FILE || join(homedir(), ".claude-copilot-auth.json")
}

export function proxyKeyFilePath(env = process.env) {
  return env.COPILOT_PROXY_KEY_FILE || join(homedir(), ".claude-copilot-proxy-key.json")
}

function checkedPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) {
    throw new TypeError("Credential file path must be a nonempty string without NUL characters.")
  }
  const absolute = resolve(filePath)
  // Alternate data streams and ambiguous Win32 names must not bypass file ACLs/publication.
  if (process.platform === "win32") {
    const withoutDrive = absolute.replace(/^[a-z]:/i, "")
    if (/[<>:"|?*\x00-\x1f]/.test(withoutDrive) ||
        withoutDrive.split(/[\\/]/).some((part) => /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new TypeError("Invalid Windows credential file path (including alternate data streams).")
    }
  }
  return absolute
}

function storageError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

async function readPrivateString(filePath, field, label) {
  const target = checkedPath(filePath)
  let text
  try {
    text = await readFile(target, "utf8")
  } catch (error) {
    throw storageError(
      error.code === "ENOENT"
        ? `${label} file not found: ${target}. Run the corresponding setup command first.`
        : `Cannot read ${label} file: ${target} (${error.code || "I/O error"}).`,
      error.code,
    )
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    // SyntaxError messages can contain excerpts of the credential: never forward them.
    throw storageError(`Invalid JSON in ${label} file: ${target}. Repair or remove it explicitly.`, "ERR_CREDENTIAL_FORMAT")
  }
  if (!value || typeof value[field] !== "string" || !value[field] ||
      value[field] !== value[field].trim() || /[^\x20-\x7e]/.test(value[field])) {
    throw storageError(`Invalid ${label} file: ${target}; ${field} must be a nonempty printable ASCII string without surrounding whitespace.`, "ERR_CREDENTIAL_FORMAT")
  }
  return value[field]
}

export async function readAuthToken(filePath = authFilePath()) {
  return readPrivateString(filePath, "access_token", "authentication credential")
}

let windowsSid
async function protectWindowsFile(filePath) {
  const system32 = join(process.env.SystemRoot || "C:\\Windows", "System32")
  windowsSid ??= execFileAsync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true, timeout: 5000,
  }).then(({ stdout }) => {
    const sid = stdout.match(/"(S-\d+(?:-\d+)+)"\s*$/m)?.[1]
    if (!sid) throw new Error("Cannot determine the current Windows SID for private credential storage.")
    return sid
  })
  try {
    const sid = await windowsSid
    // The file is still EMPTY. Reset explicit default-token grants before
    // removing inherited access and granting only the current user.
    // execFile arguments (not shell interpolation) safely handle spaces/metacharacters.
    await execFileAsync(join(system32, "icacls.exe"), [filePath, "/reset"], {
      windowsHide: true, timeout: 5000,
    })
    await execFileAsync(join(system32, "icacls.exe"), [
      filePath, "/inheritance:r", "/grant:r", `*${sid}:(F)`,
    ], { windowsHide: true, timeout: 5000 })
  } catch (error) {
    if (!error.code && !error.killed && !error.signal) throw error
    // Refuse to write secret content if Windows ACL protection is unavailable.
    throw storageError("Cannot protect the Windows credential file ACL; no secret was written.", "ERR_CREDENTIAL_ACL")
  }
}

async function removeOwnedTemp(filePath) {
  try {
    await unlink(filePath)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

function jsonText(value) {
  try {
    const text = JSON.stringify(value, null, 2)
    if (text === undefined) throw new TypeError("No JSON value")
    return `${text}\n`
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw storageError("Cannot serialize credential value as complete JSON.", "ERR_CREDENTIAL_FORMAT")
  }
}

async function privateTemp(target, text) {
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  // Exclusive creation also ensures cleanup can never remove someone else's temp file.
  const handle = await open(temporary, "wx", 0o600)
  try {
    try {
      if (process.platform === "win32") await protectWindowsFile(temporary)
      else await handle.chmod(0o600)
      await handle.writeFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    return temporary
  } catch (error) {
    await removeOwnedTemp(temporary)
    throw error
  }
}

/** Atomic complete-JSON replacement; never changes parent directory permissions. */
export async function savePrivateJson(filePath, value) {
  const target = checkedPath(filePath)
  const temporary = await privateTemp(target, jsonText(value))
  try {
    // Windows can temporarily deny replacement while readers/antivirus hold a
    // handle. Retry only sharing/access errors, bounded to two seconds; never
    // unlink the destination or fall back to an in-place (partial) write.
    const retryDeadline = Date.now() + 2000
    for (;;) {
      try {
        await rename(temporary, target)
        break
      } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
            Date.now() >= retryDeadline) throw error
        await new Promise((done) => setTimeout(done, 25))
      }
    }
  } finally {
    await removeOwnedTemp(temporary)
  }
}

export async function getProxyKey({ filePath = proxyKeyFilePath(), create = true } = {}) {
  const target = checkedPath(filePath)
  try {
    return await readPrivateString(target, "api_key", "proxy API key")
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error
  }
  const apiKey = randomBytes(32).toString("hex")
  const temporary = await privateTemp(target, jsonText({ api_key: apiKey }))
  try {
    try {
      // Hard-link publication is atomic and MUST NOT overwrite an existing winner.
      // Unsupported filesystems fail explicitly rather than risking divergent keys.
      await link(temporary, target)
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    return await readPrivateString(target, "api_key", "proxy API key")
  } finally {
    await removeOwnedTemp(temporary)
  }
}
