# Oh My Rigel

Oh My Rigel is a community fork of
[Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent) focused on
bringing the OmO feature set to the OpenCode V2 plugin runtime. Rigel targets
OpenCode V2 exclusively. It is not a fork or distribution of OpenCode, which
remains an independent dependency.

## Confirmed OmO set before expansion

The confirmed OmO set on OpenCode V2 is the product baseline. Ongoing work
preserves agents, delegation, skills, permissions, tools, context handling, and
continuity as OpenCode V2 and upstream OmO change.

Rigel-specific improvements are welcome only when they do not blur that
baseline. A future upstream change, host API change, or newly reported
regression must be classified against the confirmed set before it is treated as
an enhancement.

## V2 scope and status

The OmO functionality ported to OpenCode V2 is the confirmed product set. The
public web inventory is backed by repository source data and gates that check
coverage, prose, commands, links, and publication consistency. Those web gates do
not prove exhaustive runtime equivalence for every behavior. The confirmed set
includes the public OmO surfaces documented by the web guide for agents,
delegation, skills, permissions, tools, model routing, context handling, and
continuity.

The source installation still has material limits:

- It additionally includes an external beta layer of agents and skills from
  `profiles/gabo`, including a Judge agent, which remains separate from the
  confirmed OmO set.
- OpenCode V2 and its plugin API continue to evolve, so verified integrations
  may need adaptation as the host changes.
- This is a source preview for an evolving OpenCode V2 host, not a production
  support promise.
- The source installation currently requires a POSIX shell, Git, Bun, Node.js,
  and an OpenCode configuration stored as JSON.

Do not use the upstream OmO install command as an installation method for this
V2 preview. It installs the upstream OmO product, not Oh My Rigel.

## Install and run the V2 preview

Rigel is only for OpenCode V2. The recommended path is a clean upgrade to V2,
followed by a source installation of Rigel. Do not keep OpenCode V1 active in
parallel: shared configuration, data, cache, plugin, or goal state can
contaminate V1. If you cannot identify the active OpenCode version and every
state path it uses, stop before installing Rigel.

> **Scope note:** the OmO functionality ported to OpenCode V2 is confirmed. This
> preview installation additionally includes an external **beta** layer of agents
> (including a Judge) and skills from `profiles/gabo`, which is still being
> polished. Keep that extra layer distinct from the confirmed OmO set; it is not a
> finished product surface.

### Agent-first route

Paste this prompt into Codex, OpenCode V2, or another coding agent:

```text
Install and run the Oh My Rigel V2 developer preview from its public source.

Safety requirements:
- Inspect the checkout, AGENTS.md files, repository rules, README.md,
  OH-MY-RIGEL.md, FORK.md, CONTRIBUTING.md, script/agent/setup.sh,
  profiles/gabo/validate-profile.mjs, profiles/gabo/apply-v2-agent-layer.mjs,
  profiles/gabo/switch-live-plugin-to-native-v2.mjs, and
  profiles/gabo/materialize-v2-skills.mjs before changing anything.
- Rigel targets OpenCode V2 only. Detect the installed OpenCode version and
  stop unless it is V2. If OpenCode must be updated, use the current official
  OpenCode installation method and verify the resulting version.
- Confirm that no OpenCode process is running and that this installation will
  not reuse an active V1 installation. Do not create a parallel V1/V2 setup.
- Discover the actual OpenCode V2 config, data, state, cache, plugin, skills,
  and goal-state paths on this machine. Do not assume paths, services,
  credentials, or package managers. Stop and ask for help if ownership or
  isolation is uncertain.
- Never print, copy, or commit credentials or private configuration.

Installation requirements:
1. Use the v2-mirror branch of https://github.com/GaboEI/oh-my-rigel.
2. Run script/agent/setup.sh to verify tools, install dependencies, and build.
3. Run node profiles/gabo/validate-profile.mjs.
4. Set RIGEL_V2_HOME to the confirmed V2 home, RIGEL_V2_CONFIG to the absolute
   path of the active V2 JSON config, and RIGEL_V2_USER_ROOT to a dedicated
   Rigel state directory. The variable name RIGEL_V2_LAB_ROOT is a historical
   spelling of that state directory: do not create or require a laboratory or
   service.
5. With those explicit variables, run the user lifecycle installer:
   node profiles/gabo/rigel-v2-user-install.mjs install --version 1. It
   materializes the native runtime and generated agent manifest, exposes the V2
   skills, and registers the runtime in the selected V2 config. It refuses any
   path that resolves under a V1 root and never launches OpenCode.
6. Verify that the V2 config registers the generated Rigel runtime, launch the
   normal OpenCode V2 command, and confirm that Rigel reports its native V2
   runtime as active. Do not claim unavailable features.

Report the detected OpenCode version, resolved non-secret paths, commands run,
checks passed, and remaining limitations. If any safety condition cannot be
demonstrated, do not install or launch anything; explain the blocker and ask
for help.
```

### Human route

This is the clean source installation currently implemented by the repository.
Run it from a POSIX shell. First close every OpenCode process and update the
existing OpenCode installation to V2 rather than keeping V1 and V2 side by
side.

1. Install or update OpenCode using its
   [official V2 installation method](https://opencode.ai/v2/docs#cli), then verify
   that the selected executable reports V2:

   Use the same installation method that owns your current OpenCode executable
   so the update does not create a second installation. For the official
   standalone installer, the commands are:

   ```bash
   curl -fsSL https://opencode.ai/v2/install | bash
   case "$(opencode --version)" in
     *v2.*) ;;
     *) echo "OpenCode V2 is required" >&2; exit 1 ;;
   esac
   if pgrep -af '[o]pencode'; then
     echo "Close every OpenCode process before installing Rigel" >&2
     exit 1
   fi
   ```

   Stop if you cannot determine whether a listed process belongs to an older
   installation.

2. Clone the preview branch and prepare the checkout:

   ```bash
   git clone --branch v2-mirror --single-branch https://github.com/GaboEI/oh-my-rigel.git
   cd oh-my-rigel
   script/agent/setup.sh
   node profiles/gabo/validate-profile.mjs
   ```

3. Identify the JSON configuration used by your OpenCode V2 installation. Set
   its absolute path explicitly. Do not continue if the file belongs to V1, is
   not JSON, or its ownership is uncertain.

   ```bash
   export RIGEL_V2_HOME="$HOME"
   export RIGEL_V2_CONFIG="/absolute/path/to/the/active-v2/opencode.json"
   export RIGEL_V2_USER_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/oh-my-rigel"
   test -f "$RIGEL_V2_CONFIG"
   ```

   `RIGEL_V2_LAB_ROOT` is the historical spelling of the state directory and is
   still accepted. In this route the state directory is only Rigel's install
   state and generated-runtime directory; no laboratory or service is created.

4. Install the native runtime, the generated agent manifest, the V2 skills and
   the CLI launcher through the user lifecycle installer, then start OpenCode
   normally:

   ```bash
   node profiles/gabo/rigel-v2-user-install.mjs install --version 1
   opencode
   ```

   The installer resolves everything from `RIGEL_V2_HOME`, `RIGEL_V2_CONFIG` and
   `RIGEL_V2_USER_ROOT`, refuses any path that resolves under a V1 root, and
   never launches OpenCode or touches V1. It writes one versioned tree under
   `<RIGEL_V2_USER_ROOT>/versions/<version>/`, records the install in
   `<RIGEL_V2_USER_ROOT>/install-state.json`, and exposes the launcher at
   `<RIGEL_V2_USER_ROOT>/bin/rigel-v2`.

5. Operate and maintain the same installation with the same contract:

   ```bash
   node profiles/gabo/rigel-v2-user-install.mjs status             # first operation / health
   node profiles/gabo/rigel-v2-user-install.mjs install --version 1 # idempotent reinstall
   node profiles/gabo/rigel-v2-user-install.mjs upgrade --version 2 # version transition + state migration
   node profiles/gabo/rigel-v2-user-install.mjs rollback           # revert to the previous version, byte-identical
   node profiles/gabo/rigel-v2-user-install.mjs uninstall          # remove only Rigel-owned state
   ```

   Upgrade materializes the new version and migrates the recorded install state;
   rollback restores the previous version byte for byte; uninstall deregisters
   only Rigel-owned plugin/CLI/skill entries and removes only Rigel-owned state,
   preserving unrelated configuration keys, files and skills.

Keep the checkout available because the generated runtime and skill links refer
to its files. If any step fails, stop and report the command and sanitized error
instead of trying a different config or running a second OpenCode installation.

## How to contribute

Contributors can help maintain the confirmed OmO set while keeping the beta
profile layer and evolving OpenCode V2 host integration distinct:

- Add regression tests for observable behavior on OpenCode V2.
- Exercise an existing V2 surface and report reproducible successes, failures,
  or host API changes.
- Review upstream OmO changes for compatible value before importing them.
- Review integrations for lost context, weakened permissions, or behavior that
  only appears to work because a module loads.
- Improve public documentation, examples, and migration notes while keeping
  maturity claims tied to reproducible behavior.

Start from the source installation above and choose a narrowly scoped
contribution. Open an issue or draft pull request describing the behavior you
are preserving, the V2 API surface you are using, and how another contributor
can reproduce the result. The [contribution guide](CONTRIBUTING.md) covers
repository-wide setup and pull request expectations.

## Developer reading path

1. Read this page for the product goal, V2 scope, and installation paths.
2. Read [FORK.md](FORK.md) for the fork boundary and license constraints.
3. Read [CONTRIBUTING.md](CONTRIBUTING.md) before preparing a change.
4. Use the upstream [OmO documentation](https://omo.dev/docs) to understand the
   behavior being maintained or reviewed, then verify assumptions against this
   repository.

## Upstream, attribution, and license

Rigel preserves upstream notices and is a modified derivative of Oh My
OpenAgent. The inherited code remains under the upstream
[Sustainable Use License 1.0](LICENSE.md), which restricts use and distribution
to free, non-commercial purposes and is not an OSI-approved open-source
license. Rigel-specific original additions are separately offered under the
[MIT License](LICENSE-RIGEL-ADDITIONS.md), without relicensing inherited OmO
code. See [NOTICE-RIGEL.md](NOTICE-RIGEL.md) for the attribution boundary.
