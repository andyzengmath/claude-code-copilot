import { chmod, open, readFile, rename, link, unlink, stat, mkdir, rmdir } from "node:fs/promises"
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

// Older versions wrote the token with default permissions (often 0644).
// Restrict such a file to its owner once per process, or say how to.
const modeChecked = new Set()
async function restrictLegacyMode(target) {
  if (process.platform === "win32" || modeChecked.has(target)) return
  modeChecked.add(target)
  let mode
  try { mode = (await stat(target)).mode } catch { return }
  if ((mode & 0o077) === 0) return
  try {
    await chmod(target, 0o600)
    console.warn(`Restricted ${target} to owner-only access; other users could read it.`)
  } catch (error) {
    console.warn(`Warning: other users can read ${target}, and it could not be restricted (${error.code || "error"}). Run: chmod 600 on that file.`)
  }
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
  await restrictLegacyMode(target)
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
// `permissions` is "(F)" for a file, or "(OI)(CI)(F)" for a directory whose new entries inherit it.
async function protectWindowsPath(path, permissions) {
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
    // Nothing secret has been written yet. Reset explicit default-token grants
    // before removing inherited access and granting only the current user.
    // execFile arguments (not shell interpolation) safely handle spaces/metacharacters.
    await execFileAsync(join(system32, "icacls.exe"), [path, "/reset"], {
      windowsHide: true, timeout: 5000,
    })
    await execFileAsync(join(system32, "icacls.exe"), [
      path, "/inheritance:r", "/grant:r", `*${sid}:${permissions}`,
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

async function removeOwnedDirectory(directory) {
  try {
    await rmdir(directory)
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

async function writePrivateFile(filePath, text, protect) {
  // Exclusive creation also ensures cleanup can never remove someone else's temp file.
  const handle = await open(filePath, "wx", 0o600)
  try {
    try {
      await protect(handle)
      await handle.writeFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await removeOwnedTemp(filePath)
    throw error
  }
}

/** Writes `text` to a new private temporary file; returns its path and how to remove it. */
async function privateTemp(target, text) {
  const name = `.${basename(target)}.${randomUUID()}.tmp`
  if (process.platform !== "win32") {
    const path = join(dirname(target), name)
    await writePrivateFile(path, text, (handle) => handle.chmod(0o600))
    return { path, cleanup: () => removeOwnedTemp(path) }
  }
  // A new Windows file starts with its folder's inherited ACL, and a handle
  // opened before that ACL is replaced keeps its access. So the file is
  // created in a staging directory that is private before the file exists.
  const staging = join(dirname(target), name)
  const path = join(staging, "credential.tmp")
  await mkdir(staging)
  try {
    await protectWindowsPath(staging, "(OI)(CI)(F)")
    // Protect the file itself too, so its ACL stays private outside the staging directory.
    await writePrivateFile(path, text, () => protectWindowsPath(path, "(F)"))
  } catch (error) {
    await removeOwnedDirectory(staging)
    throw error
  }
  return {
    path,
    cleanup: async () => {
      await removeOwnedTemp(path)
      await removeOwnedDirectory(staging)
    },
  }
}

// Windows reports replacing a directory with EPERM, the same code as a held
// handle. A directory never becomes replaceable, so it must not be retried.
async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** Atomic complete-JSON replacement; never changes parent directory permissions. */
export async function savePrivateJson(filePath, value) {
  const target = checkedPath(filePath)
  const temporary = await privateTemp(target, jsonText(value))
  try {
    // Windows can temporarily deny replacement while readers/antivirus hold a
    // handle. Retry only sharing/access errors, bounded in time; never unlink
    // the destination or fall back to an in-place (partial) write. Measured on
    // Windows 11 under a hot reader loop: p90 2.6s, max 2.9s blocked, so 2s
    // failed about one write in eight. 10s still fails fast on a real lock.
    const retryDeadline = Date.now() + 10000
    for (;;) {
      try {
        await rename(temporary.path, target)
        break
      } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
            Date.now() >= retryDeadline || await isDirectory(target)) throw error
        await new Promise((done) => setTimeout(done, 25))
      }
    }
  } finally {
    await temporary.cleanup()
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
      await link(temporary.path, target)
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    return await readPrivateString(target, "api_key", "proxy API key")
  } finally {
    await temporary.cleanup()
  }
}
