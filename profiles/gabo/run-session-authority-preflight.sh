#!/usr/bin/env bash
# Ensures the Rigel-managed third-party Goal owns the Goal surface through its
# server/TUI shims and explicit `-opencode.goal` builtin-disable marker, while the
# retired external state/cache stay absent and delegated-child continuation remains.
#
# No Docker. Docker and every container-based runner are prohibited for this
# project; the previous container-based form of this preflight was historical and
# is intentionally replaced.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

# Goal ownership gate: the checked home must expose the complete managed shim
# shape. `goal.enabled` alone is not evidence that the host builtin is disabled.
goal_mode="$(node "$root/profiles/gabo/lab-goal-gate.mjs" --mode "$HOME")"
if [ "$goal_mode" != "managed" ]; then
  echo "session-authority preflight failed: goal mode is '$goal_mode', expected 'managed'" >&2
  exit 1
fi

# The lifecycle status validates the active runtime's exact goal-state path, one
# server shim, one CLI shim, and the single builtin-disable marker.
state_root="${RIGEL_V2_USER_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/oh-my-rigel}"
config_file="${RIGEL_V2_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json}"
goal_status="$(node "$root/profiles/gabo/rigel-v2-user-install.mjs" status --home "$HOME" --state "$state_root" --config "$config_file" --json)"
if ! node -e 'const status = JSON.parse(process.argv[1]); const needed = new Set(["goal.statePathMatchesRoot", "goal.singleServerEntry", "goal.singleCliEntry", "goal.builtinDisabled"]); const failed = status.checks.filter((check) => needed.has(check.name) && !check.pass).map((check) => check.name); if (!status.pass || failed.length > 0) process.exit(1)' "$goal_status"; then
  echo "session-authority preflight failed: managed Goal lifecycle status is incomplete" >&2
  exit 1
fi

# Behavior of record for the internal Goal command and the stop-continuation
# goal clear (fails if the object-vs-text command-shape regression returns).
bun test \
  "$root/profiles/gabo/opencode/tools/goal.tools.test.mjs" \
  "$root/profiles/gabo/opencode/rigel-v2-native-conditional-tools.test.mjs" \
  "$root/profiles/gabo/opencode/rigel-v2-native-runtime.test.mjs"

echo "Oh My Rigel session-authority preflight passed"
