import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Repository-independence gate (contract phase P2, worktree repo-independence-workflows).
//
// OMR must not carry runnable automations that publish or deploy the PARENT project's products
// (code-yeongyu/oh-my-openagent) under the parent's identity. Every guarded parent workflow is
// already inert on GaboEI/oh-my-rigel; the ones that only mirror/publish/deploy the parent's
// products and nothing in this repository needs are RETIRED. This test is the fail-closed gate:
// it fails when a retired parent workflow returns, when a real parent publication/deploy command
// appears without the inert parent-repo guard, when a workflow still invokes a retired reusable
// workflow, or when an OMR publication/validation gate disappears.
//
// It reads machine-consumed workflow structure (files, guards, publication commands), not prose.
// Contract protected: release + repository-independence security boundary. Evidence:
// .omo/evidence/20261011-repo-independence-workflows/ (local, gitignored).

const WORKFLOW_DIR = ".github/workflows"

// The exact inert guard used by every parent-specific job.
const PARENT_GUARD = "github.repository == 'code-yeongyu/oh-my-openagent'"

// Exact retire decision: guard-inert workflows that publish/deploy the parent's products and have
// no consumer in this repository (no test reads them; no conserved workflow needs them).
const RETIRED_PARENT_WORKFLOWS = [
  "npm-dist-tag-rollback.yml",
  "installer-mirror.yml",
  "get-worker-deploy.yml",
  "web-deploy.yml",
] as const

// OMR-owned publication and validation gates that MUST stay.
const REQUIRED_OMR_WORKFLOWS = [
  "web-public.yml",
  "lint-workflows.yml",
  "ci.yml",
  "web-ci.yml",
] as const

// Kept parent workflows: still present, still inert. The guard is pinned so they cannot silently
// become active in GaboEI/oh-my-rigel (their removal is a separate, dedicated follow-up).
const KEPT_INERT_PARENT_WORKFLOWS = [
  "publish.yml",
  "publish-platform.yml",
  "stats.yml",
  "refresh-model-capabilities.yml",
  "macos-signing-canary.yml",
] as const

// Real external publication/deployment commands against the parent's products. A dry run
// ("npm publish --dry-run", used by ci.yml) is NOT a publication and is excluded by lookahead.
const PARENT_PUBLICATION_PRIMITIVES = [
  /npm publish\b(?![^\n]*--dry-run)/,
  /npm dist-tag add\b/,
  /cloudflare\/wrangler-action/,
  /sync-lazycodex-marketplace/,
] as const

function workflowFiles(): readonly string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
}

function readWorkflow(name: string): string {
  return readFileSync(join(WORKFLOW_DIR, name), "utf8")
}

describe("#given the repository workflows #when the P2 independence gate is checked", () => {
  test("#given the retire decision #when the workflow directory is read #then every retired parent workflow is absent", () => {
    // given / when
    const present = workflowFiles()

    // then
    for (const retired of RETIRED_PARENT_WORKFLOWS) {
      expect(present, `${retired} must be retired (it publishes/deploys the parent's products)`).not.toContain(retired)
      expect(existsSync(join(WORKFLOW_DIR, retired)), `${retired} must not exist`).toBe(false)
    }
  })

  test("#given the preserve decision #when the workflow directory is read #then every OMR publication and validation gate is present", () => {
    // given / when
    const present = workflowFiles()

    // then
    for (const required of REQUIRED_OMR_WORKFLOWS) {
      expect(present, `${required} is an OMR-owned gate and must be preserved`).toContain(required)
    }
  })

  test("#given the kept inert parent workflows #when each is read #then it still carries the inert parent guard", () => {
    // given / when / then
    for (const kept of KEPT_INERT_PARENT_WORKFLOWS) {
      expect(existsSync(join(WORKFLOW_DIR, kept)), `${kept} must be preserved`).toBe(true)
      expect(readWorkflow(kept), `${kept} must keep the inert parent guard`).toContain(PARENT_GUARD)
    }
  })

  test("#given every workflow #when a parent publication or deploy command is found #then the inert parent guard is present", () => {
    // given / when
    const offenders: string[] = []
    for (const name of workflowFiles()) {
      const source = readWorkflow(name)
      const publishes = PARENT_PUBLICATION_PRIMITIVES.some((pattern) => pattern.test(source))
      if (publishes && !source.includes(PARENT_GUARD)) offenders.push(name)
    }

    // then
    expect(
      offenders,
      "a workflow runs a parent publication/deploy command without the inert parent guard",
    ).toEqual([])
  })

  test("#given every workflow #when a reusable workflow is invoked #then no retired reusable workflow is referenced", () => {
    // given / when
    const offenders: string[] = []
    for (const name of workflowFiles()) {
      const source = readWorkflow(name)
      for (const retired of RETIRED_PARENT_WORKFLOWS) {
        if (source.includes(`uses: ./.github/workflows/${retired}`)) offenders.push(`${name} -> ${retired}`)
      }
    }

    // then
    expect(offenders, "a workflow still invokes a retired reusable workflow").toEqual([])
  })
})
