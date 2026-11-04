# Oh My Rigel

Oh My Rigel is a community fork of [Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent) that brings the OmO agent harness to the OpenCode V2 plugin runtime.

The public web guide is published at [omr.gabodev.dev](https://omr.gabodev.dev/).

## What It Provides

Rigel keeps the OmO goal intact for OpenCode V2: agents, delegation, skills, permissions, tools, model routing, context handling, and continuity for long-running work. The project is not a smaller rewrite of OmO and is not a fork or distribution of OpenCode itself.

The OmO functionality ported to OpenCode V2 is the confirmed product set, and the public web inventory is backed by repository source data and gates that check coverage, prose, commands, links, and publication consistency. Those web gates do not prove exhaustive runtime equivalence for every behavior. The source installation also includes an external beta layer from `profiles/gabo`, including a Judge agent and profile skills; keep that layer distinct from the confirmed OmO set. This is still a source preview for an evolving OpenCode V2 host, not a production support promise.

## Compatibility

- Requires OpenCode V2.
- Rigel targets OpenCode V2. If a pre-V2 OpenCode installation is still present, close it before installing Rigel: running both side by side is unsupported because shared configuration, data, and plugin state can contaminate the installation you already use.
- OpenCode V2 and its plugin API are still evolving, so integrations may need updates as the host changes.
- The source install path currently expects a POSIX shell, Git, Bun, Node.js, and an OpenCode V2 configuration stored as JSON.

## Install

Use the canonical installation instructions in [OH-MY-RIGEL.md](OH-MY-RIGEL.md#install-and-run-the-v2-preview). They include both an agent-first route and a human source-install route.

Do not use the upstream OmO install command to install Rigel. It installs the parent product, not this V2 preview.

## Quick start

Rigel installs from source for OpenCode V2; there is no public one-line installer. Start here:

- Web install guide: <https://omr.gabodev.dev/#install>
- Source install steps: [OH-MY-RIGEL.md → Install and run the V2 preview](OH-MY-RIGEL.md#install-and-run-the-v2-preview)

Prerequisites: OpenCode V2, a POSIX shell, Git, Bun, and Node.js, with no other OpenCode installation running in parallel (see [Compatibility](#compatibility)).

Prepare the source checkout the guide describes:

```bash
git clone --branch v2-mirror --single-branch https://github.com/GaboEI/oh-my-rigel.git
cd oh-my-rigel
script/agent/setup.sh
node profiles/gabo/validate-profile.mjs
```

Then continue with the remaining install steps in [OH-MY-RIGEL.md](OH-MY-RIGEL.md#install-and-run-the-v2-preview).

## Contribute

Useful contributions include keeping confirmed OmO surfaces working as OpenCode V2 evolves, adding observable regression tests, reviewing upstream OmO changes for compatible value, reproducing host or beta-layer limitations, and improving public documentation.

Start with:

- [OH-MY-RIGEL.md](OH-MY-RIGEL.md) for status and install paths.
- [FORK.md](FORK.md) for the fork boundary and license split.
- [CONTRIBUTING.md](CONTRIBUTING.md) for development and QA expectations.
- [web/MAINTENANCE.md](web/MAINTENANCE.md) for keeping the published web guide synchronized with product changes.

## Attribution and License

Oh My Rigel is a modified derivative of Oh My OpenAgent, also known as OmO. Inherited OmO code remains under the upstream [Sustainable Use License 1.0](LICENSE.md), which is not an OSI-approved open-source license. Rigel-specific original additions are separately offered under [MIT](LICENSE-RIGEL-ADDITIONS.md). See [NOTICE-RIGEL.md](NOTICE-RIGEL.md) for attribution details.
