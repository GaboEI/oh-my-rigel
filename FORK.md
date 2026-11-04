# Oh My Rigel fork guide

Oh My Rigel is a community fork of
[Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent). It ports the
OmO OpenCode integration to the OpenCode V2 plugin runtime while keeping
OpenCode itself independent and upgradeable.

Rigel targets OpenCode V2 exclusively. Update OpenCode to V2 before installing
Rigel. Running Rigel while retaining an active pre-V2 installation is neither
recommended nor supported because shared state can contaminate the installation
you already use.

## Project boundary

The fork targets feature-completeness on V2, not a smaller reimplementation.
Agents, delegation, skills, permissions, tools, context handling, and
continuity all belong to the compatibility goal. Fork-specific product work
comes after a compatible base has been demonstrated.

The former OmO integration remains a feature reference during migration, but
Rigel is not designed to run on OpenCode V1. A legacy module loading under V2
is not proof that its tools or lifecycle behavior work, so claims must be based
on observable V2 behavior.

## Current availability

Rigel V2 is a developer preview. The source tree contains working foundations
for agents, orchestration, delegation, permissions, model routing, and context
integration, with additional OmO surfaces still being ported or verified.

The upstream OmO installation commands install upstream OmO, not Rigel. Use the
[clean V2 source installation](OH-MY-RIGEL.md#install-and-run-the-v2-preview)
for this preview. Do not interpret the preview as feature-complete or ready for
production use.

OpenCode V2 and its plugin API are evolving dependencies. Contributors should
expect host API changes and should record the OpenCode version and observable
behavior when reporting compatibility results.

## Evaluating or contributing from source

Start with the [clean V2 installation routes](OH-MY-RIGEL.md#install-and-run-the-v2-preview)
and a narrow contribution target. Before changing
anything:

1. Read [OH-MY-RIGEL.md](OH-MY-RIGEL.md) for the current public status and
   compatibility principles.
2. Read [CONTRIBUTING.md](CONTRIBUTING.md) for repository setup, conventions,
   tests, and pull request expectations.
3. Identify the OmO behavior to port and the V2 plugin API surface that can
   represent it.
4. Add or update a test around observable behavior, then document any remaining
   limitation instead of hiding it behind a prompt or a load-time success.

Useful contributions include porting OmO surfaces, V2 behavior tests, focused
QA, documentation, and integration review. If a safe reproduction needs
machine-specific state or credentials, open an issue with a minimal public
description rather than publishing private configuration.

## License and attribution

This repository is a derivative of OmO. Inherited code remains under the
upstream [Sustainable Use License 1.0](LICENSE.md), which restricts use and
distribution to free, non-commercial purposes and is not an OSI-approved
open-source license.

Rigel-specific original additions are separately offered under the
[MIT License](LICENSE-RIGEL-ADDITIONS.md). That permission does not grant rights
to inherited OmO code or turn the combined work into an MIT-licensed project.
See [NOTICE-RIGEL.md](NOTICE-RIGEL.md).
