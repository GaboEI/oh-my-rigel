/**
 * Named-RED mutation harness for the Rigel native V2 test suites.
 *
 * A mutation test only proves something when it turns a SPECIFIC, NAMED
 * contract red. This harness enforces exactly that:
 *
 *   1. the contract is confirmed GREEN on the original source (a contract that
 *      is already red, or that always throws, proves nothing);
 *   2. the mutation is applied and the SAME contract must now fail (RED);
 *   3. the original bytes are restored and their `sha256` must be identical to
 *      the pre-mutation hash.
 *
 * The restore runs in a `finally`, so it happens even when the RED assertion
 * throws as expected. `runMutation` returns a receipt naming the contract and
 * both hashes for the evidence ledger.
 *
 * ESM module caching means a contract cannot observe a file that was rewritten
 * under an already-imported specifier. The harness therefore passes the
 * contract a `load()` helper: it copies the CURRENT target bytes to a unique
 * sibling file and imports that copy, so every call re-evaluates the mutated
 * source. The copy is removed after the import resolves. A target with relative
 * imports must keep its dependencies next to it, because the copy resolves
 * imports relative to the target's own directory.
 */

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizeContract(contract) {
  if (typeof contract === "function") {
    if (typeof contract.name !== "string" || contract.name.length === 0) {
      throw new Error("runMutation: a bare contract function must be named; pass { name, run }")
    }
    return { name: contract.name, run: contract }
  }
  if (
    !contract
    || typeof contract.run !== "function"
    || typeof contract.name !== "string"
    || contract.name.length === 0
  ) {
    throw new Error("runMutation: contract must be { name, run } (or a named function)")
  }
  return { name: contract.name, run: contract.run }
}

// Process-wide counter so two `runMutation` calls on the SAME file in one
// process never reuse a mutant sibling name. A per-loader counter collided
// across calls (same pid + same sequence), and bun's module cache then returned
// the first call's stale sibling instead of re-reading the second mutation.
let mutantSequence = 0

function createFreshLoader(file) {
  const directory = path.dirname(file)
  const fallbackExtension = path.extname(file)
  return async function load(specifier = file) {
    const absolute = path.isAbsolute(specifier) ? specifier : path.resolve(directory, specifier)
    const extension = path.extname(absolute) || fallbackExtension
    const base = path.basename(absolute, path.extname(absolute))
    const copy = path.join(directory, `.mutant-${base}-${process.pid}-${mutantSequence}${extension}`)
    mutantSequence += 1
    fs.copyFileSync(absolute, copy)
    try {
      return await import(pathToFileURL(copy).href)
    } finally {
      fs.rmSync(copy, { force: true })
    }
  }
}

/**
 * Apply one mutation, prove it turns a named contract RED, and restore the file.
 *
 * @param {object} spec
 * @param {string} spec.file absolute path to the source file to mutate
 * @param {(source: string) => string} spec.mutate transforms the source; must
 *   return different text, otherwise the harness throws
 * @param {{ name: string, run: (context: { load: (specifier?: string) => Promise<object> }) => unknown }} spec.contract
 *   the NAMED contract this mutation must turn red; `run` throws when the
 *   contract is violated
 * @returns {Promise<{ contract: string, beforeHash: string, afterHash: string, red: true, redError: string, restored: true }>}
 */
export async function runMutation({ file, mutate, contract }) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("runMutation: file must be a non-empty path")
  }
  if (typeof mutate !== "function") {
    throw new Error("runMutation: mutate must be a function")
  }
  const named = normalizeContract(contract)
  const before = fs.readFileSync(file)
  const beforeHash = sha256(before)
  const original = before.toString("utf8")
  const load = createFreshLoader(file)

  let baselineError
  try {
    await named.run({ load })
  } catch (error) {
    baselineError = error
  }
  if (baselineError) {
    throw new Error(`runMutation: contract "${named.name}" is already RED before mutation: ${describeError(baselineError)}`)
  }

  const mutated = mutate(original)
  if (typeof mutated !== "string" || mutated === original) {
    throw new Error(`runMutation: mutate must return changed source for contract "${named.name}"`)
  }

  let redError
  try {
    fs.writeFileSync(file, mutated)
    try {
      await named.run({ load })
    } catch (error) {
      redError = error
    }
    if (!redError) {
      throw new Error(`runMutation: contract "${named.name}" stayed GREEN under mutation; it does not guard this behavior`)
    }
  } finally {
    fs.writeFileSync(file, before)
  }

  const afterHash = sha256(fs.readFileSync(file))
  if (afterHash !== beforeHash) {
    throw new Error(`runMutation: restore was not byte-identical for "${named.name}" (${beforeHash} -> ${afterHash})`)
  }

  return {
    contract: named.name,
    beforeHash,
    afterHash,
    red: true,
    redError: describeError(redError),
    restored: true,
  }
}

/**
 * Apply one mutation and prove it turns a named contract RED in a CHILD process.
 *
 * {@link runMutation} observes the mutated source through the runtime's own
 * dynamic-import cache. That cache is not a fresh-module guarantee: on one
 * Windows target it served an earlier module instance, so the mutation was
 * invisible and the contract stayed GREEN while proving nothing (the harness
 * reported "stayed GREEN", which is the one outcome it exists to catch). A child
 * process has its own module registry, so what it loads is exactly what is on
 * disk, on every host - a stronger guarantee than a uniquely named copy.
 *
 * `check` is the source of a small module that runs inside that child. It is
 * given `MUTANT` (a specifier for the mutated file, relative to the check module
 * itself) and `here(name)` for a sibling of the mutated file; it must THROW when
 * the contract is violated, and that message becomes the receipt's `redError`.
 *
 * @param {object} spec
 * @param {string} spec.file absolute path to the source file to mutate
 * @param {(source: string) => string} spec.mutate transforms the source; must
 *   return different text, otherwise the harness throws
 * @param {string} spec.check child-process module source for the named contract
 * @returns {Promise<{ contract: string, beforeHash: string, afterHash: string, red: true, redError: string, restored: true }>}
 */
export async function runMutationInChild({ file, mutate, contract, check = contract?.check, timeoutMs = 183_000 }) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("runMutationInChild: file must be a non-empty path")
  }
  if (typeof mutate !== "function") {
    throw new Error("runMutationInChild: mutate must be a function")
  }
  if (typeof check !== "string" || check.trim().length === 0) {
    throw new Error("runMutationInChild: check must be child-process module source")
  }
  // Only the NAME is used here: the contract body runs in the child, not in this
  // process, so it is `check` source rather than a callable.
  const contractName = typeof contract === "string" ? contract : contract?.name
  if (typeof contractName !== "string" || contractName.length === 0) {
    throw new Error("runMutationInChild: contract must be a name or { name }")
  }
  const directory = path.dirname(file)
  const scriptName = `mutation-check-${path.basename(file, path.extname(file))}-${process.pid}-${mutantSequence}.mjs`
  mutantSequence += 1
  const script = path.join(directory, scriptName)
  // The check module lives next to the target, so its specifiers are plain
  // relative ones: no URL translation and no absolute-specifier portability
  // question for the child.
  fs.writeFileSync(
    script,
    [
      `const MUTANT = ${JSON.stringify(`./${path.basename(file)}`)}`,
      'const here = (name) => new URL(name, import.meta.url).href',
      check,
      "",
    ].join("\n"),
  )
  const runCheck = () => spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8", timeout: timeoutMs })
  const before = fs.readFileSync(file)
  const beforeHash = sha256(before)
  const original = before.toString("utf8")
  let redError
  try {
    const baseline = runCheck()
    if (baseline.status !== 0) {
      throw new Error(`runMutationInChild: contract "${contractName}" is already RED before mutation: ${baseline.stderr || baseline.stdout}`)
    }
    const mutated = mutate(original)
    if (typeof mutated !== "string" || mutated === original) {
      throw new Error(`runMutationInChild: mutate must return changed source for contract "${contractName}"`)
    }
    try {
      fs.writeFileSync(file, mutated)
      const red = runCheck()
      if (red.status === 0) {
        throw new Error(`runMutationInChild: contract "${contractName}" stayed GREEN under mutation; it does not guard this behavior`)
      }
      redError = red.stderr || red.stdout
    } finally {
      fs.writeFileSync(file, before)
    }
    const afterHash = sha256(fs.readFileSync(file))
    if (afterHash !== beforeHash) {
      throw new Error(`runMutationInChild: restore was not byte-identical for "${named.name}" (${beforeHash} -> ${afterHash})`)
    }
  } finally {
    fs.rmSync(script, { force: true })
  }
  return {
    contract: contractName,
    beforeHash,
    afterHash: beforeHash,
    red: true,
    redError: String(redError ?? ""),
    restored: true,
  }
}
