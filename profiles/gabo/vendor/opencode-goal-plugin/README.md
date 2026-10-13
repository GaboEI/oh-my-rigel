# Vendored community goal engine (dark vendor)

This directory ships the pinned community goal engine and its exact runtime closure
in-tree, so an install materializes it **offline** with no registry access. Nothing
in this repository references it yet: the engine is **dark**. There is no entry in
`opencode.json` or `cli.json`, no goal key, no state, no command, no tool, no hook,
no listener and no live TUI. The inherited Goal is untouched and the community engine
is not activated. Activation is a separate, atomic change.

## Pinned provenance

| Field | Value |
|---|---|
| package | `@prevalentware/opencode-goal-plugin` |
| version | `0.1.60` |
| git tag | `v0.1.60` |
| commit | `cf22feaaa7ab3367053a9a99913cbc40e5c3224e` |
| license | MIT (upstream text travels byte-identical in `LICENSE`) |
| `dist.integrity` | `sha512-mDEwq3DdZtUPtty26FFf7SptSnTATeJYZGXOYEMVt/utjB7YwTzxiZwur6D65hxYEzhC6Qw7uSMi2wrP3OK0og==` |
| tarball sha256 | `292680c8a777113f92c82811a8683c4f9da368023d966fb0ead059c5243c9689` |

`pin.json` is the recorded snapshot of that provenance plus the closure, and
`NOTICE` is its deterministic attribution. The vendorizer refuses to run when the
recorded pin, the vendored bytes, the shipped `LICENSE` or the shipped `NOTICE`
disagree with each other or with the frozen constants in the vendorizer module.

## Layout

| Path | Content |
|---|---|
| `pin.json` | provenance: artifact, closure, integrity, sha256, tree digests, notice digest |
| `NOTICE` | deterministic third-party attribution (package, version, license, integrity, path) |
| `LICENSE` | the upstream MIT license from the pinned tarball, byte-identical |
| `tarballs/` | the pinned tarball plus one tarball per closure package (M2 acquisition form) |
| `../../goal-vendor-tarball.mjs` | deterministic ustar reader, integrity helpers, tree digests |
| `../../goal-vendor-notice.mjs` | deterministic NOTICE renderer |
| `../../goal-vendor-fetch.mjs` | maintainer-only acquisition over HTTPS (never loaded by an install) |
| `../../rigel-v2-goal-vendor.mjs` | the vendorizer seam: verify, acquire, seal, materialize |

## Closure

The closure is the artifact's declared runtime dependency set — two runtime
dependencies plus two peer dependencies, as upstream publishes them — together with
the nested runtime closure of the plugin-owned dependency `effect-goal-state`
(`fast-check`, `pure-rand`), placed exactly where npm places them so the dependency
is self-contained.

- runtime dependencies (self-contained): `zod`, `effect-goal-state` (npm alias of
  `effect`), which itself resolves `fast-check` and `pure-rand` from its own nested
  `node_modules`.
- peer dependencies (host-provided, pinned and vendored so the TUI entry specifiers
  resolve): `@opentui/solid`, `solid-js`.

A full npm re-resolution of the artifact pulls 146 packages (babel, typescript and
per-platform native binaries). That graph is deliberately **not** re-vendored: peer
subgraphs belong to the host TUI, and the plugin-owned graph above is the part that
must be self-contained for an offline install.

## Offline model

Acquisition (M2) happens once, here, by a maintainer. Materialization (M1) happens at
install time from these tarballs and never touches the network: it verifies every
integrity, extracts deterministically, and reports a content-only tree digest. The
QA proof runs materialization in a child process whose DNS and TCP attempts fail
loudly (`goal-vendor-offline-preload.mjs`).

## Commands

```bash
node profiles/gabo/rigel-v2-goal-vendor.mjs verify
node profiles/gabo/rigel-v2-goal-vendor.mjs acquire                 # maintainer only, needs network
node profiles/gabo/rigel-v2-goal-vendor.mjs seal --artifact-tarball <pinned.tgz>
node profiles/gabo/rigel-v2-goal-vendor.mjs materialize --out <runtimeDir>
```

`verify` and `materialize` are local-only and safe to repeat. Upgrades happen only by
a maintainer PR that re-pins the artifact and re-seals this directory; the vendored
bytes are never patched.
