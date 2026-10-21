# src/hooks/comment-checker/ (AI Slop Comment Review)

**Generated:** 2026-07-17 (7d664b96b)

## OVERVIEW

Tool Guard tier hook. Runs after `write`/`edit` tools to detect AI-generated comment patterns in code. It WARNS: the findings are appended to the tool output, and the tool call is never blocked, rejected, or turned into an error. Backed by the comment-checker binary downloaded from the pinned GitHub release on first use; no npm dependency or lifecycle-script trust is required.

## WHAT IT FLAGS

AI slop comment smells:
- Restating what code literally does (`// increment counter`)
- Filler phrases (`// obviously`, `// clearly`, `// simply`)
- Decorative separators without purpose
- JSDoc on trivially-named functions
- `// TODO:` without context
- Comments contradicting surrounding code

See `@code-yeongyu/comment-checker` for the authoritative blocklist.

## EXECUTION FLOW

```
tool.execute.before (write | edit | multiedit)
  → register pending call (filePath + old/new strings) keyed by callID
tool.execute.after (same callID, or apply_patch)
  → take pending call (or extract apply_patch edits from metadata)
  → resolve comment-checker CLI path (node_modules / PATH / cached download)
  → run CLI on changed content, parse JSON findings (line ranges + category)
  → if findings → append the warning to the tool output (the edit is NOT blocked)
```

## WHEN THE CHECKER CANNOT RUN

A missing or broken binary must never look like "no comments found". When the binary cannot be resolved, or the run reports a failure, the hook appends one notice per session to the tool output:

```
[comment-checker] Comment review did not run. AI-slop comments in this edit were NOT checked. ...
```

The notice never changes the tool status (the edit already happened) and never throws. After a failed run the session is marked inert, so a broken checker is not re-spawned on every following edit (`cli.ts` owns the session state; `cli-runner.ts` owns the inert switch).

## KEY FILES

| File | Purpose |
|------|---------|
| `hook.ts` | `createCommentCheckerHooks()`: main factory. `tool.execute.before` registers pending calls; `tool.execute.after` runs the CLI check. Accepts an optional `cliRunner` for dependency injection (defaults to `cli-runner.ts` exports) |
| `cli-runner.ts` | CLI orchestration: resolve path, `processWithCli` / `processApplyPatchEditsWithCli`, per-session dedup, run lock, failure notice |
| `cli.ts` | Resolve `comment-checker` binary path (node_modules / PATH / cached download), spawn `runCommentChecker`, own the failure notice and the per-session state |
| `downloader.ts` | Own `COMMENT_CHECKER_VERSION`; download + cache the matching host-platform release (`getCachedBinaryPath`, `ensureCommentCheckerBinary`) |
| `initialization-gate.ts` | `ensureCommentCheckerInitialization()`: run CLI init once |
| `pending-calls.ts` | Pending-call registry between `tool.execute.before` and `after` (TTL cleanup) |
| `types.ts` | `PendingCall` and config types |

## CONFIG

The whole `comment_checker` block has exactly one key (`packages/omo-opencode/src/config/schema/comment-checker.ts`):

```jsonc
// .omo/omo.jsonc
{
  "comment_checker": {
    "custom_prompt": "optional replacement for the default warning message"
  }
}
```

There is no `enabled` and no `severity` key: the hook is on by default, it always warns, and it never blocks. The only opt-out is the global hook list:

```jsonc
{ "disabled_hooks": ["comment-checker"] }
```

## BYPASS FOR LEGITIMATE COMMENTS

Prefix with `// @allow` or mark file scope with `// comment-checker-disable-file` at top. Use sparingly; it defeats the purpose.

## RELATED

- Doctor check: `src/cli/doctor/checks/tools.ts` verifies `comment-checker` binary availability
- Lazy initialization: first tool hook invocation downloads the binary if missing; when the download fails the hook stays on and reports, once per session, that comment review did not run.
