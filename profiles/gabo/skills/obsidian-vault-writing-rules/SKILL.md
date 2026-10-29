---
name: obsidian-vault-writing-rules
description: "Use whenever a task creates, edits, splits, compacts, modularizes, links, or may otherwise write documentation inside an Obsidian vault. Enforces professional vault writing: no monoliths, explicit hierarchy, bidirectional links, MOC/index updates, language consistency, and post-edit validation. For full vault graph audits, use obsidian-second-brain-audit first; use this skill as the writing standard for any approved edits."
---

# Obsidian Vault Writing Rules

Use this skill before writing to any Obsidian vault. The goal is a durable
knowledge network that future agents and maintainers can navigate quickly, not a
folder full of disconnected or overgrown notes.

This skill does not replace `obsidian-second-brain-audit`. Use
`obsidian-second-brain-audit` for read-only vault discovery, topology metrics,
or full second-brain repair plans. Use this skill whenever the task will write
or may need to write vault documentation, including edits that come out of a
second-brain audit.

## 1. Establish The Vault Contract

Before editing, determine:

- Active vault path.
- Vault language.
- Authoritative hubs: root index, Master Plan, MOCs, memory index, current
  handoff, or equivalent project-specific sources.
- Whether the task is vault-only or also allows repository work.
- Whether the vault is a git repository whose edits must be committed and
  pushed on closure when the project contract requires it.
- Whether this is a full vault topology audit. If yes, load
  `obsidian-second-brain-audit` for the audit workflow and return here before
  any approved writes.

If the project defines stricter rules, those project rules are authoritative. The target standard is 100%
English for persistent vault documentation. From 2026-08-24 onward, every new
persistent vault document and every new prose block must be written in English.
The 70% language threshold is only a temporary legacy bypass to avoid forcing a
full historical translation pass today: if a pre-existing note is about 70%
Spanish, preserve the old Spanish body unless the task explicitly asks for
translation; if a pre-existing note is about 70% English, preserve English. In
both cases, new additions, new summaries, new link descriptions, and new
modular records are English. A pre-existing note below 70% in both languages is
a corruption bug: report it as a bug, do not guess a target language, and do
not edit it without explicit approval. Legacy Spanish or mixed text is accepted
only as temporary inherited debt, not as the long-term standard. Repository
inspection/editing is out of scope during vault-only tasks unless the project maintainer explicitly authorizes it.

Classify each destination from the project's own frontmatter taxonomy or authoritative writing standard before writing. Do not infer a document's role from a filename, folder, title, backlink, or generic words such as `plan`, `route`, or `task`. If no project-specific classification is available or the role is ambiguous, stop and ask the maintainer rather than adding autonomous prose.

## 2. Write In Layers

Do not create or preserve monoliths when the content has multiple purposes.
Use a layered structure:

```text
root index / Master Plan
-> parent note / MOC
-> task, topic, phase, or decision child note
-> validation, evidence, memory, or support note
```

Each layer has one job:

- Root index or Master Plan: compact navigation and current authority.
- Parent note: objective, status, scope boundaries, child map, evidence map,
  memory links, downstream relationships.
- Child note (canonical/route/contract note): specific contract, decisions,
  scope, dependencies, and acceptance criteria. It does not accumulate
  findings, bugs, root-cause narrative, fixes, deferred work, or external
  debt — see "Canonical vs Evidence Separation" below.
- Validation/evidence note: proof index and closure register. It owns
  findings, bugs, root cause, fixes, deferred work, and external debt. It must
  not become a second monolith.
- Memory note: product memory and current facts. It is not a diary or a
  narrative report.

If a section grows because it mixes jobs, split it into the right layer before
adding more prose.

## 2.1 Canonical vs Evidence Separation

This is a hard rule, not a style preference.

- In normal autonomous work, a canonical/parent note (root index, Master Plan,
  parent note, task/route child note) receives only a status marker and its
  exact evidence link. An optional completion date may sit next to an
  `APPROVED` marker. Existing descriptions, contracts, scope, and acceptance
  criteria remain unchanged unless the maintainer explicitly names a change.
- Narrative evidence — what was found, the bug, its root cause, how it was
  fixed, what remains pending, external/infrastructure debt — always goes into
  a dedicated validation/evidence note, never into a canonical/parent note.
- If the evidence note does not exist yet for that child/task, create it in
  its correct hierarchy position (same pattern as its siblings, linked in the
  same pass per section 3) before writing any finding into it. Do not
  improvise a finding into the nearest canonical note because its own
  evidence note is missing.
- This does not restrict where an agent may write in the vault; it restricts
  what kind of content belongs in a canonical note versus an evidence note.
- Apply this rule to all vault work, not only to phases where evidence
  separation was explicitly designed for a specific task.

## 2.2 Roadmaps: Never Add On Your Own, Never Delete Content

A roadmap (Master Plan, phase/map, task/route document) is a state index, not a
log, report, checklist, or evidence record. On your own initiative (autonomous,
agent-initiated edits) you must NOT ADD narrative content inside a roadmap or
inside any gate block: no explanations, reasons, decisions, findings or causes;
no command, test, audit or CI results; no chronologies, "what changed", debt,
limitations or correction plans. That detail lives in the dedicated evidence
document, which the roadmap links to.

Allowed and expected in a roadmap:
- the brief objective state of a task/gate (`OPEN`, `IN PROGRESS`, `CLOSED`,
  `APPROVED`, ...);
- a direct link to the dedicated evidence document;
- the content already present — including each gate's contract and acceptance
  criteria. Preserve it.

Never DELETE or strip existing roadmap content. Gate contracts, acceptance
criteria, and pre-existing descriptions are legitimate roadmap content; an
autonomous edit must never remove them, shorten them, or "clean them up".
Removing existing content is allowed only when the user explicitly directs that
specific removal.

If the evidence document does not exist, create or use a separate evidence
document and link it from the roadmap. When unsure, add only `state + link` and
change nothing else — and never remove.

Scope: the "do not add" restriction governs autonomous, agent-initiated edits
only. It does not apply when the user explicitly directs a specific roadmap
change — naming the section to add or modify, or supplying the content. In that
case the user's instruction governs; the "do not delete" rule still requires an
explicit user request to remove anything.

## 2.3 Prose Formatting

Do not hard-wrap ordinary prose. Keep each ordinary paragraph as a natural
line; use deliberate line breaks only for Markdown structure such as lists,
tables, block quotes, and code blocks.

## 3. Link Every Note As A Graph Node

Every created, split, or structurally modified note must be connected in the
same pass:

- Add or update `## Links`.
- Link to the origin note: where this note came from.
- Link to the relevant destination: root index, MOC, memory index, or parent.
- Add a backlink from the origin note to the new note.
- Link peer notes directly when they share the same real identity: phase,
  task, date, ticket, finding, evidence package, or decision.
- Update applicable MOCs or indexes in the same pass.

Do not rely only on shared indexes. A vault can have clean metrics and still be
hard to use if related notes do not link directly to each other.

When detecting plain-text mentions that should become links, ignore anything
inside backticks or fenced code blocks. Literal paths and commands must stay
literal.

## 4. Preserve Meaning While Compacting

Compaction is not rewriting history and not deleting facts. Preserve:

- Contracts and acceptance criteria.
- Decisions and rationale.
- Commands, paths, IDs, filenames, package names, commit hashes, and exact
  technical identifiers.
- Findings, fixes, validation results, deferred work, and explicit non-goals.
- Security, privacy, compatibility, and operational boundaries.

Remove or reduce:

- Repeated narrative filler.
- Diary-style chronology that does not change current understanding.
- Duplicate summaries once the authoritative target exists.
- Ambiguous wording that can be made factual without changing meaning.

When unsure whether text is historical evidence or disposable prose, preserve
it in a child/support note and link it. If that historical evidence is a
finding/bug/fix narrative rather than a contract, it belongs in the
validation/evidence note for that child, per section 2.1, not in the
canonical child note itself.

## 5. Mutation Boundaries

Do not move, delete, rename, or merge existing notes unless the user explicitly
approves that specific action.

Do not convert literal paths or commands inside code spans/fenced blocks into
wikilinks. Preserve code, shell commands, routes, URLs, credentials markers,
and technical identifiers exactly.

Do not expose secret values in chat or generated summaries. Report only the
file and kind of sensitive material if a scan discovers one.

For large vault changes, watch for hygiene problems that affect navigation:
duplicate basenames, double extensions such as `name.md.md`, empty notes, and
default template notes. Report ambiguous cases instead of guessing.

## 6. Required Validation

After vault edits:

- Run the project's local link audit when available, using the exact command defined by the project contract.
- Run the project's local language audit when available, using the exact command defined by the project contract.
- When structure or topology changes, run the project's topology/graph audit when available, using the exact command defined by the project contract.
- Scan touched files for language drift according to the project's language contract. Preserve inherited legacy text only when that contract permits it.
- Scan touched files for known corrupted prose patterns if the project has identified any.

A closure is not complete if a new note is isolated, orphaned, dead-end, or
linked only through a weak index when a direct peer link exists.

Metrics are necessary but not sufficient. If the graph still looks like
separate clusters, add real identity links between matching memory, evidence,
phase, task, decision, or support notes instead of arguing that the numeric
audit is already clean.

