import { spawn } from "../../shared/bun-spawn-shim"
import { bunWhich } from "../../shared/bun-which-shim"
import { join } from "path"
import { existsSync } from "fs"
import * as fs from "fs"
import { tmpdir } from "os"
import {
  resolveCommentCheckerBinary,
  runCommentChecker as runCommentCheckerCore,
  sendAndCloseStdin,
  type CheckFailure,
  type CheckResult,
  type HookInput,
} from "@oh-my-opencode/comment-checker-core"
import { getCachedBinaryPath, ensureCommentCheckerBinary } from "./downloader"

const DEBUG = process.env.COMMENT_CHECKER_DEBUG === "1"
const DEBUG_FILE = join(tmpdir(), "comment-checker-debug.log")

const FAILURE_NOTICE_MARKER = "[comment-checker] Comment review did not run."

const BINARY_UNAVAILABLE_DETAIL =
  'The comment-checker binary is unavailable (not installed, not on PATH, and the runtime download did not succeed). Install @code-yeongyu/comment-checker or put "comment-checker" on PATH to enable comment review.'

/**
 * A checker that cannot run keeps failing for the whole session, so the notice is emitted at most
 * once per session. Without that bound a broken binary would repeat the same warning on every
 * single edit (#8850).
 */
const failureNotifiedSessions = new Set<string>()

/** Sessions whose checker failed to start: re-running it would fail the same way (#8850). */
const inertSessions = new Set<string>()

function debugLog(...args: unknown[]) {
  if (DEBUG) {
    const msg = `[${new Date().toISOString()}] [comment-checker:cli] ${args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')}\n`
    fs.appendFileSync(DEBUG_FILE, msg)
  }
}

function getBinaryName(): string {
  return process.platform === "win32" ? "comment-checker.exe" : "comment-checker"
}

export function resolveCommentCheckerPathFromPath(binaryName: string, which: (binary: string) => string | null = bunWhich): string | null {
  try {
    return which(binaryName)
  } catch (error) {
    debugLog("PATH lookup failed:", error)
    return null
  }
}

function findCommentCheckerPathSync(): string | null {
  const binaryName = getBinaryName()
  const resolvedPath = resolveCommentCheckerBinary({
    binaryName,
    cachedBinaryPath: getCachedBinaryPath(),
    existsSync,
    importMetaUrl: import.meta.url,
  })
  if (resolvedPath !== null) {
    debugLog("resolved binary path:", resolvedPath)
    return resolvedPath
  }

  const pathBinary = resolveCommentCheckerPathFromPath(binaryName)
  if (pathBinary !== null && existsSync(pathBinary)) {
    debugLog("resolved PATH binary:", pathBinary)
    return pathBinary
  }

  debugLog("no binary found in known locations")
  return null
}

// Cached resolved path
let resolvedCliPath: string | null = null
let initPromise: Promise<string | null> | null = null

/**
 * Asynchronously get comment-checker binary path.
 * Will trigger lazy download if binary not found.
 */
export async function getCommentCheckerPath(): Promise<string | null> {
  // Return cached path if already resolved
  if (resolvedCliPath !== null) {
    return resolvedCliPath
  }

  // Return existing promise if initialization is in progress
  if (initPromise) {
    return initPromise
  }

  initPromise = (async () => {
    // First try sync path resolution
    const syncPath = findCommentCheckerPathSync()
    if (syncPath && existsSync(syncPath)) {
      resolvedCliPath = syncPath
      debugLog("using sync-resolved path:", syncPath)
      return syncPath
    }

    // Lazy download if not found
    debugLog("triggering lazy download...")
    const downloadedPath = await ensureCommentCheckerBinary()
    if (downloadedPath) {
      resolvedCliPath = downloadedPath
      debugLog("using downloaded path:", downloadedPath)
      return downloadedPath
    }

    debugLog("no binary available")
    return null
  })()

  return initPromise
}

/**
 * Synchronously get comment-checker path (no download).
 * Returns cached path or searches known locations.
 */
export function getCommentCheckerPathSync(): string | null {
  return resolvedCliPath ?? findCommentCheckerPathSync()
}

/**
 * Start background initialization.
 * Call this early to trigger download while other init happens.
 */
export function startBackgroundInit(): void {
  if (!initPromise) {
    initPromise = getCommentCheckerPath()
    initPromise.then(path => {
      debugLog("background init complete:", path || "no binary")
    }).catch(err => {
      debugLog("background init error:", err)
    })
  }
}

export type { HookInput, CheckResult }

/**
 * Turns a checker failure into a sentence the agent can act on.
 */
export function formatCommentCheckerFailureDetail(failure: CheckFailure): string {
  const reason = failure.exitCode === null
    ? "the checker never started"
    : `the checker exited with code ${failure.exitCode}`
  const stderr = failure.stderr.trim()
  const detail = stderr.length > 0 ? `: ${stderr}` : ""
  return `The comment-checker binary could not complete the check (${reason}${detail}). Fix or reinstall @code-yeongyu/comment-checker to enable comment review.`
}

/**
 * Appends the "comment review did not run" notice to the tool output. The notice never changes the
 * tool status: the edit already happened, and the only honest signal left is the tool output itself.
 * Returns false when this session was already notified.
 */
export function appendCommentCheckerFailureNotice(
  output: { output: string },
  sessionID: string,
  detail: string,
): boolean {
  if (failureNotifiedSessions.has(sessionID)) return false
  failureNotifiedSessions.add(sessionID)
  output.output += `\n\n${FAILURE_NOTICE_MARKER} AI-slop comments in this edit were NOT checked. ${detail}`
  return true
}

export function appendCommentCheckerUnavailableNotice(
  output: { output: string },
  sessionID: string,
): boolean {
  return appendCommentCheckerFailureNotice(output, sessionID, BINARY_UNAVAILABLE_DETAIL)
}

export function markCommentCheckerInertForSession(sessionID: string): void {
  inertSessions.add(sessionID)
}

export function isCommentCheckerInertForSession(sessionID: string): boolean {
  return inertSessions.has(sessionID)
}

/**
 * Run comment-checker CLI with given input.
 * @param input Hook input to check
 * @param cliPath Optional explicit path to CLI binary
 * @param customPrompt Optional custom prompt to replace default warning message
 */
export async function runCommentChecker(input: HookInput, cliPath?: string, customPrompt?: string): Promise<CheckResult> {
  const binaryPath = cliPath ?? resolvedCliPath ?? getCommentCheckerPathSync()

  if (!binaryPath || !existsSync(binaryPath)) {
    debugLog("comment-checker binary not found")
    return {
      hasComments: false,
      message: "",
      failure: { exitCode: null, stderr: BINARY_UNAVAILABLE_DETAIL },
    }
  }

  try {
    const result = await runCommentCheckerCore(
      { hookInput: input, binaryPath, customPrompt },
      {
        existsSync,
        spawn: (args: readonly string[]) => {
          const subprocess = spawn([...args], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          })
          return {
            stdin: { send: (hookInput: string) => sendAndCloseStdin(subprocess.stdin, hookInput) },
            stdout: subprocess.stdout,
            stderr: subprocess.stderr,
            exited: subprocess.exited,
            kill: (signal) => subprocess.kill(signal),
          }
        },
      },
    )
    return result
  } catch (error) {
    debugLog("failed to run comment-checker:", error)
    return {
      hasComments: false,
      message: "",
      failure: {
        exitCode: null,
        stderr: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Check if CLI is available (sync check, no download).
 */
export function isCliAvailable(): boolean {
  const path = getCommentCheckerPathSync()
  return path !== null && existsSync(path)
}

/**
 * Check if CLI will be available (async, may trigger download).
 */
export async function ensureCliAvailable(): Promise<boolean> {
  const path = await getCommentCheckerPath()
  return path !== null && existsSync(path)
}
