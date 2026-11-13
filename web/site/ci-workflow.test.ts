import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

// Pipeline contract: the publication workflow must actually EXECUTE the WCAG contrast gate and
// the i18n/render gate, not only source.test.ts. A contrast token that breaks readability has to
// fail a pull request, so the workflow runs the full `web/` suite as a blocking step. This test
// guards that wiring itself, because a green local suite proves nothing if CI never runs it.

const WORKFLOW = readFileSync(new URL("../../.github/workflows/web-public.yml", import.meta.url), "utf8")

describe("#given the web publication workflow #when its test gate is inspected #then the contrast and render suites run and block", () => {
  test("#given the workflow #when the trigger is read #then it runs on pull requests to v2-mirror", () => {
    // given / when / then
    expect(/\bpull_request:/.test(WORKFLOW)).toBe(true)
    expect(/branches:\s*\[v2-mirror\]/.test(WORKFLOW)).toBe(true)
  })

  // Fail-closed trigger: the published web truth is re-derived from web/**, packages/**, profiles/**,
  // package.json and the workflow itself, so ANY change on v2-mirror must run this gate. A `paths`
  // filter would let inventory changes skip it, so its absence is a contract, not a coincidence.
  test("#given the workflow #when its triggers are read #then there is no paths filter on pull_request or push", () => {
    // given / when / then
    expect(/^\s*paths:/m.test(WORKFLOW)).toBe(false)
    expect((WORKFLOW.match(/branches:\s*\[v2-mirror\]/g) || []).length).toBe(2)
  })

  test("#given the workflow #when permissions are read #then they stay minimal (contents: read)", () => {
    // given / when / then
    expect(/permissions:\s*\n\s*contents:\s*read/.test(WORKFLOW)).toBe(true)
  })

  // Fail-closed publication contract: push only builds/uploads an artifact; the live site is
  // updated ONLY by a manual workflow_dispatch of v2-mirror with publish=true, after the gate passed,
  // and only that job carries the Pages write + OIDC permissions.
  const jobBlock = (name: string) => WORKFLOW.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`))?.[1] ?? ""
  const dryRunJob = jobBlock("pages-artifact-dry-run")
  const deployJob = jobBlock("deploy-pages")

  test("#given the push path #when the artifact job is read #then it builds, uploads an artifact and never deploys", () => {
    // given / when / then
    expect(dryRunJob).not.toBe("")
    expect(/run:\s*bun run web:build\s*$/m.test(dryRunJob)).toBe(true)
    expect(/uses:\s*actions\/upload-pages-artifact@/.test(dryRunJob)).toBe(true)
    expect(/deploy-pages/.test(dryRunJob)).toBe(false)
    expect(/pages:\s*write/.test(dryRunJob)).toBe(false)
    expect(/id-token:\s*write/.test(dryRunJob)).toBe(false)
  })

  test("#given the dispatch input #when it is read #then publish defaults to false", () => {
    // given / when / then
    expect(/workflow_dispatch:/.test(WORKFLOW)).toBe(true)
    expect(/^\s+publish:/m.test(WORKFLOW)).toBe(true)
    expect(/default:\s*false/.test(WORKFLOW)).toBe(true)
  })

  test("#given the deploy job #when its guard is read #then it only runs on a manual dispatch of v2-mirror with publish=true, after the gate", () => {
    // given / when / then
    expect(deployJob).not.toBe("")
    expect(/github\.event_name == 'workflow_dispatch'/.test(deployJob)).toBe(true)
    expect(/github\.ref == 'refs\/heads\/v2-mirror'/.test(deployJob)).toBe(true)
    expect(/github\.event\.inputs\.publish == 'true'/.test(deployJob)).toBe(true)
    expect(/needs:\s*build-checks/.test(deployJob)).toBe(true)
  })

  test("#given the deploy job #when permissions and environment are read #then Pages write + OIDC live only here and the github-pages environment exposes the URL", () => {
    // given / when / then
    expect(/pages:\s*write/.test(deployJob)).toBe(true)
    expect(/id-token:\s*write/.test(deployJob)).toBe(true)
    expect(/name:\s*github-pages/.test(deployJob)).toBe(true)
    expect(/url:\s*\$\{\{\s*steps\.deployment\.outputs\.page_url\s*\}\}/.test(deployJob)).toBe(true)
    expect(/uses:\s*actions\/deploy-pages@/.test(deployJob)).toBe(true)
  })

  test("#given the whole workflow #when privileged usage is counted #then deploy-pages, pages:write and id-token:write appear exactly once, inside the gated job", () => {
    // given / when / then
    expect((WORKFLOW.match(/uses:\s*actions\/deploy-pages@/g) || []).length).toBe(1)
    expect(deployJob.includes("actions/deploy-pages@")).toBe(true)
    expect((WORKFLOW.match(/pages:\s*write/g) || []).length).toBe(1)
    expect((WORKFLOW.match(/id-token:\s*write/g) || []).length).toBe(1)
  })

  test("#given the CI steps #when they are read #then the full web suite runs (contrast + render + source), not only source.test.ts", () => {
    // given / when / then
    expect(/run:\s*bun test web\/\s*$/m.test(WORKFLOW)).toBe(true)
  })

  test("#given the gates on disk #when their existence is checked #then the suite path covers them", () => {
    // given / when / then
    expect(existsSync(new URL("./contrast.test.ts", import.meta.url))).toBe(true)
    expect(existsSync(new URL("./render.test.ts", import.meta.url))).toBe(true)
    expect(existsSync(new URL("../data/source.test.ts", import.meta.url))).toBe(true)
  })

  test("#given the workflow #when blocking semantics are checked #then no step disables failure", () => {
    // given / when / then
    expect(/continue-on-error\s*:\s*true/.test(WORKFLOW)).toBe(false)
  })
})

// Audit 66: `profiles/gabo/validate-profile.mjs` is the shipped profile's policy contract
// (optional-MCP isolation, portable paths, quarantined V1 bridge, pinned SSH supply chain), yet no
// workflow invoked it, so a policy regression could merge behind green CI. This pins the wiring
// itself exactly like the publication gates above: the rigel-compatibility job must run the
// validator from the repository root, and its step outcome must feed
// script/ci-leg-tests-guard.mjs, so an accidentally skipped gate fails the leg instead of passing.
const CI_WORKFLOW = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")

const ciJobBlock = (name: string) =>
  CI_WORKFLOW.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`))?.[1] ?? ""
// A step entry starts at six spaces + "- "; everything below it belongs to that step.
const ciJobSteps = (job: string) => job.split(/^ {6}- /m).slice(1)

const PROFILE_VALIDATION_COMMAND = "node profiles/gabo/validate-profile.mjs"
const rigelJob = ciJobBlock("rigel-compatibility")
const profileValidationStep =
  ciJobSteps(rigelJob).find((step) => step.includes(`run: ${PROFILE_VALIDATION_COMMAND}`)) ?? ""
const profileValidationStepId = profileValidationStep.match(/^ {8}id: (\S+)$/m)?.[1] ?? ""

describe("#given the Oh My Rigel CI workflow #when the profile policy gate is inspected #then the hermetic validator runs and reports its outcome", () => {
  test("#given the rigel-compatibility job #when its steps are read #then the profile validator runs from the repository root", () => {
    // given / when / then
    expect(rigelJob).not.toBe("")
    expect(profileValidationStep).not.toBe("")
    // The script path is relative, so a `working-directory` would move it off the repo root.
    expect(/working-directory\s*:/.test(profileValidationStep)).toBe(false)
  })

  test("#given the validation step #when its slot is read #then it declares the id the leg guard accounts for", () => {
    // given / when / then
    expect(profileValidationStepId).not.toBe("")
  })

  test("#given the leg guard #when its outcome accounting is read #then a skipped validation step fails the leg", () => {
    // given / when
    const guardStep =
      ciJobSteps(rigelJob).find((step) => step.includes("script/ci-leg-tests-guard.mjs")) ?? ""

    // then
    expect(guardStep).not.toBe("")
    expect(/if: always\(\)/.test(guardStep)).toBe(true)
    expect(guardStep).toContain(`steps.${profileValidationStepId}.outcome`)
  })
})
