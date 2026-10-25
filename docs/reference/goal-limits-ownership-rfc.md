# ADR: Goal limit ownership gap and proposal

## Status

Proposed. Documentation only.

`goal_limits` is unimplemented and rejected by the current unified configuration
schema at the root and in profile overlays. The examples below are proposals, not
working configuration. This ADR records source/test contract evidence rather than
an end-to-end live reproduction. It does not claim that a live incident was
reproduced or that owner-enforced limits are available today.

## Context

Goal defaults answer what happens when a caller omits a value. Owner policy answers
who may choose that value. The current contracts do not provide a unified way for
the owner to reserve that decision for tokens, automatic continuations, and elapsed
goal time. A value named like a limit is not necessarily an owner-enforced ceiling.

There are two distinct goal layers to consider:

| Layer | Current source/test contract | Ownership gap |
|---|---|---|
| Internal OmO goal layer | `GoalConfigSchema` exposes `enabled`, `auto_start`, and `default_max_iterations` (default 100, accepted range 1..1000). Its tests cover defaults and validation. The goal hook options and session-hook wiring do not pass `default_max_iterations` into continuation enforcement; internal goal tools expose objective/status operations, not token, turn, or duration policy. | The iteration value is a legacy default, not a demonstrated owner cap. The schema's numeric range validates configuration; it does not establish a per-goal runtime ceiling. |
| Rigel registration and vendored goal engine | `RIGEL_GOAL_DEFAULTS` supplies `max_auto_turns: 1000` and omits `default_token_budget` and `max_goal_duration_seconds`. `resolveGoalOptions` applies validated overrides over those defaults; registration tests cover that precedence. The pinned engine accepts per-goal `token_budget`, `max_auto_turns`, and `max_duration_seconds`. | Registration values are defaults rather than owner caps. The engine prefers supplied per-goal values to token/duration defaults, and `maybeStopForUsageLimit` selects `goal.maxAutoTurns ?? defaultMaxAutoTurns`, not the minimum of both. |

The vendored engine can enforce the effective per-goal budget or continuation
limit. The missing contract is owner authority over how that effective value is
chosen, not the absence of all runtime stopping behavior. For example, a larger
tool-supplied turn count can replace the registration default; that default is not
an upper bound. Token and duration creation use nullish fallback, so tool `null`
does not mean an explicit unlimited owner choice when a configured fallback exists.

The strict unified root, layer, and profile schemas have no `goal_limits` field.
Their existing unknown-key tests establish rejection at those boundaries. The
opaque `[opencode]` block accepts arbitrary keys in the shared schema, but that is
not implementation or support for this proposal.

Source locations and the pinned artifact's member names are listed in
[References](#references). They establish the current contract without asserting
live runtime equivalence between the two goal layers.

## Decision summary

Explicit owner configuration wins. Absence of owner configuration leaves the decision to the agent. `unlimited` is an explicit owner decision, not an absence.

## Decision

### Proposed per-dimension contract

Introduce an owner-controlled `goal_limits` block with three independent
dimensions: `token_budget`, `max_auto_turns`, and `max_duration_seconds`. Resolve
each dimension separately; a decision about tokens must not implicitly select a
turn or duration limit.

| Owner value | Proposed effective behavior | Can tool arguments override it? |
|---|---|---|
| Absent | Delegate the choice to the agent. Use a valid tool-supplied value when present; otherwise retain the applicable existing default behavior. | Yes. Only absence permits a tool override. |
| Finite number | Use the owner's explicit finite limit for this dimension. Proposed validation requires a positive finite integer, measured in tokens, automatic continuations, or seconds respectively. | No. Neither a larger nor a smaller tool value replaces the owner's explicit choice. |
| `"unlimited"` | Explicitly select no goal-level limit for this dimension. Do not fall back to a finite engine default. | No. A tool cannot replace it with a finite limit or reinterpret it as absent. |

The finite value is an owner-selected effective limit, not merely a default and
not a tool-negotiated ceiling. A user may change their policy explicitly, but a
goal tool invocation is not a policy edit. Preserve absence versus `"unlimited"`
through loading, merging, persistence, and translation to each goal engine. In
particular, translating both to engine `null` and then applying a finite default
would violate the decision.

Resolve owner authority before processing goal creation or replacement arguments.
Enforce the resolved values at the lifecycle boundary, not just in tool
descriptions. A result should distinguish the effective value and its policy
source so callers can understand why a conflicting tool argument did not win.
Whether conflicts produce rejection or an explicit policy-resolution notice is
an open question; silently honoring the conflicting argument is not permitted.

### Owner and user-profile authority

The trusted authority is the user-owned configuration and its user-owned active
profile, not arbitrary project content. A selected profile authored in the user
configuration may specialize that user's base policy. A project profile with the
same name does not become owner policy merely because it is selected.

Project configuration cannot relax an owner limit, erase an explicit owner value,
or replace a finite owner value with `"unlimited"`. It also cannot convert explicit
owner `"unlimited"` into absence to restore agent overrides. Generic last-writer
deep merging must not discard source provenance before this rule is applied.
Whether a project may impose a separate stricter ceiling is unresolved; until
defined, projects must not replace explicit owner decisions. Project content is
not promoted to owner authority when the owner leaves a dimension absent.

### Proposed examples (unimplemented)

These `jsonc` examples describe a possible future user-configuration shape. They
are **unimplemented and rejected today** at the unified root/profile schema
boundaries. Do not copy them into a current configuration expecting enforcement.

```jsonc
// UNIMPLEMENTED proposal: all dimensions absent, so the agent decides.
{
  "goal_limits": {},
}
```

```jsonc
// UNIMPLEMENTED proposal: explicit finite owner decisions in every dimension.
{
  "goal_limits": {
    "token_budget": 200000,
    "max_auto_turns": 100,
    "max_duration_seconds": 3600,
  },
}
```

```jsonc
// UNIMPLEMENTED proposal: a user-owned profile with independent decisions.
{
  "profiles": {
    "long-running": {
      "goal_limits": {
        "token_budget": "unlimited",
        "max_auto_turns": 250,
        // Duration is absent: its choice remains delegated to the agent.
      },
    },
  },
}
```

## Compatibility

- This ADR changes no runtime behavior, schemas, tools, profiles, generated
  configuration assets, or published configuration reference.
- A future implementation must preserve current behavior when `goal_limits` is
  absent. Existing defaults remain defaults; existing tool arguments retain their
  current meaning for dimensions without owner policy.
- Do not reinterpret existing `default_max_iterations`, `max_auto_turns`,
  `default_token_budget`, or `max_goal_duration_seconds` settings as new owner
  policy. Do not silently migrate an omitted value into `"unlimited"`.
- Preserve the pinned vendor artifact unchanged. Any future integration must
  account for its fallback semantics rather than pretend that the current engine
  already implements the proposed three-state ownership model.
- Do not reset existing goal accounting or remove lifecycle safeguards as a side
  effect of introducing policy. Existing stored goals and policy edits during a
  goal require an explicit migration/application rule before implementation.

## Consequences

### Positive

- Owners can reserve each resource decision without relying on agent compliance
  with prose or tool argument suggestions.
- Explicit unlimited execution is distinguishable from delegating the decision,
  avoiding accidental restoration of finite defaults.
- A provenance-aware policy boundary prevents repository configuration from
  weakening the owner's choices.

### Negative

- Configuration resolution must retain authority and absence information instead
  of reducing every layer to an undifferentiated merged object.
- Both goal layers need explicit integration work; their current schemas and
  lifecycle contracts are not interchangeable.
- Agents lose per-goal discretion for explicitly configured dimensions, including
  the ability to substitute a smaller tool value. Diagnostics must explain this.
- Choosing `"unlimited"` removes that dimension's goal-level resource stop and can
  increase runtime or cost. It is not a promise of infinite execution or a bypass
  of cancellation, permissions, plan-mode restrictions, no-progress protection,
  provider quotas, or other independent safeguards.

## Non-goals

- Implementing `goal_limits`, changing the vendor pin, or advertising supported
  configuration in this documentation-only proposal.
- Unifying all goal implementations or claiming complete live parity.
- Replacing model/provider quotas, security permissions, task scheduling, or
  system-wide spending controls with goal accounting.
- Letting prompts, project files, or tool calls edit trusted owner policy.
- Proving an operational incident through live reproduction.

## Open questions

- Should conflicting tool arguments be rejected or accepted with an explicit
  policy-resolution notice, and what result fields expose provenance?
- Should policy be captured at goal creation or re-evaluated on resume and on
  every continuation? How should existing active and paused goals adopt changes?
- May project configuration apply a separate stricter ceiling, and how would
  that interact with explicit owner `"unlimited"` without overriding ownership?
- How should selected user-profile and harness-specific policies compose while
  preserving their trusted origin across the loader?
- What integration boundary can represent explicit unlimited turns without the
  pinned engine substituting its finite fallback? Is upstream engine support
  required rather than a Rigel-owned adapter change?
- What accounting boundaries and maximum accepted integers should be shared
  across goal layers, particularly for elapsed active time and token totals?

## References

- [Existing ADR style: prompt-async-gate](prompt-async-gate-rfc.md).
- [Internal OmO goal schema](../../packages/omo-opencode/src/config/schema/goal.ts)
  and [schema tests](../../packages/omo-opencode/src/config/schema/goal.test.ts):
  defaults and accepted iteration range.
- [Internal goal hook](../../packages/omo-opencode/src/hooks/goal/index.ts),
  [session-hook wiring](../../packages/omo-opencode/src/plugin/hooks/create-session-hooks.ts),
  [tools](../../packages/omo-opencode/src/hooks/goal/tools.ts), and
  [record schemas](../../packages/omo-opencode/src/hooks/goal/types.ts): no unified
  owner-policy input or enforcement path.
- [Unified configuration schemas](../../packages/omo-config-core/src/schema/config.ts)
  and [unknown-key contract tests](../../packages/omo-config-core/src/schema/unified-config-schema.test.ts):
  strict root/profile boundaries versus the opaque OpenCode block.
- [Rigel registration](../../profiles/gabo/rigel-v2-goal-registration.mjs):
  `RIGEL_GOAL_DEFAULTS`, `GOAL_OPTION_SPECS`, and `resolveGoalOptions`.
- [Registration tests](../../profiles/gabo/rigel-v2-goal-registration.test.mjs):
  default values, omitted token/duration options, and validated override precedence.
- [Vendored engine pin](../../profiles/gabo/vendor/opencode-goal-plugin/pin.json)
  and [pinned 0.1.60 artifact](../../profiles/gabo/vendor/opencode-goal-plugin/tarballs/prevalentware-opencode-goal-plugin-0.1.60.tgz):
  member `package/dist/server.js`, functions `createGoalFromTool`,
  `replaceGoalFromTool`, `maybeStopForUsageLimit`, and `setupV2`; member
  `package/README.md` describes engine options. These are artifact member
  references, not separate files in the repository checkout.
