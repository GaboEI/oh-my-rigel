#!/usr/bin/env bash
# Acceptance validation against the isolated V2 laboratory service
# (opencode-v2-lab.service). Never launches OpenCode and never uses a container
# runner, and never addresses or mutates the real user installation. Read-only
# integrity checks of the real installation wrap the run.
#
#   bash run-lab-acceptance.sh            validate the running lab
#   bash run-lab-acceptance.sh --refresh  refresh the runtime first through
#                                         apply-v2-runtime-service.sh, then validate
set -uo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
service="opencode-v2-lab.service"
lab_root="${RIGEL_V2_LAB_ROOT:-$HOME/.local/share/opencode-v2-lab}"
secret_file="$lab_root/secret.env"
evidence_dir="$root/.omo/evidence/$(date +%Y%m%d)-rigel-lab-acceptance"
fail=0
pass() { echo "lab: $1: PASS"; }
bad() { echo "lab: $1: FAIL" >&2; fail=$((fail + 1)); }

# Path-segment containment: /a/opencode must never match /a/opencode-v2-lab.
under() { case "$2" in "$1"|"$1"/*) return 0;; *) return 1;; esac; }

v1_roots=(
  "$HOME/.config/opencode"
  "$HOME/.local/share/opencode"
  "$HOME/.local/share/opencode-goal-plugin"
  "$HOME/.cache/opencode"
)

goal_gate="$root/profiles/gabo/lab-goal-gate.mjs"
goal_mode=$(node "$goal_gate" --mode "$HOME")
goal_probe() { node "$goal_gate" --probe "$HOME"; }

mkdir -p "$evidence_dir"
echo "== Rigel lab acceptance =="

before_goals=$(goal_probe)
before_config_hash=$(sha256sum "$HOME/.config/opencode/opencode.json" 2>/dev/null | cut -d' ' -f1)
before_protected=$(node "$root/profiles/gabo/v1-protected-surfaces.mjs" --digest "$HOME")
echo "real-install: config_hash=${before_config_hash:0:16} goal_mode=$goal_mode goal_state=$before_goals protected=${before_protected:0:16}"

if [ "${1:-}" = "--refresh" ]; then
  echo "-- refresh through apply-v2-runtime-service.sh (only touches $service) --"
  if bash "$root/profiles/gabo/apply-v2-runtime-service.sh"; then pass "runtime refresh"; else bad "runtime refresh"; fi
fi

[ "$(systemctl --user is-active "$service" 2>/dev/null)" = "active" ] && pass "service active" || bad "service active"

unit_env=$(systemctl --user show "$service" -p Environment --value 2>/dev/null)
case "$unit_env" in *"opencode-lan.service"*) bad "unit references the real installation service";; *) pass "unit does not reference the real installation service";; esac
unit_values=$(printf '%s' "$unit_env" | tr ' ' '\n' | sed -n 's/^[A-Za-z_]*=//p')
unit_leak=0
for value in $unit_values; do
  case "$value" in /*) for r in "${v1_roots[@]}"; do under "$r" "$value" && unit_leak=1; done;; esac
done
[ "$unit_leak" = 0 ] && pass "unit environment resolves no real-installation root" || bad "unit environment touches a real-installation root"
unit_lab=0
for value in $unit_values; do
  case "$value" in /*) under "$lab_root" "$value" && unit_lab=1;; esac
done
[ "$unit_lab" = 1 ] && pass "unit environment is rooted in $lab_root" || bad "unit environment is not rooted in the lab"

exec_line=$(systemctl --user show "$service" -p ExecStart --value 2>/dev/null)
case "$exec_line" in *"$HOME/.opencode/bin/opencode"*) pass "service uses the V2 binary";; *) bad "service binary is not the isolated V2 binary";; esac
case "$exec_line" in *"--port 4097"*) pass "service listens on the lab port 4097";; *) bad "service port is not 4097";; esac

password=$(grep -m1 '^OPENCODE_PASSWORD=' "$secret_file" 2>/dev/null | cut -d= -f2-)
[ -n "${password:-}" ] && pass "lab credentials available" || bad "lab credentials unavailable"

# The credential file must be owner-only (no group/other bits). It is refreshed
# by apply-v2-runtime-service.sh; this asserts the hardening held.
secret_mode=$(stat -c '%a' "$secret_file" 2>/dev/null || echo "")
if [ -n "$secret_mode" ] && [ $((8#$secret_mode & 077)) -eq 0 ]; then
  pass "lab credentials are owner-only (mode $secret_mode)"
else
  bad "lab credentials permissions are too broad (mode ${secret_mode:-missing})"
fi
curl_json() { curl -fsS -u "opencode:${password}" "http://127.0.0.1:4097$1" 2>/dev/null; }

ready=0
for _ in $(seq 1 60); do
  if curl -fsS -u "opencode:${password}" "http://127.0.0.1:4097/openapi.json" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" = 1 ] && pass "lab API ready" || bad "lab API never became ready"

openapi=$(curl_json /openapi.json)
case "$openapi" in *'"openapi":"3'*|*'"openapi": "3'*) pass "lab API openapi 3";; *) bad "lab API did not answer openapi 3";; esac

# V2 identity, not port identity: the lab must answer /api/info with its own
# version and pid. A port number is never treated as proof of the server.
info=$(curl_json /api/info)
case "$info" in
  *'"version"'*'"pid"'*) pass "lab API identifies as V2 via /api/info";;
  *) bad "lab API /api/info did not return a V2 identity document";;
esac

curl_json /api/config > "$evidence_dir/api-config.json"
if [ -s "$evidence_dir/api-config.json" ]; then
  verdicts=$(python3 - "$lab_root" "$HOME" "$evidence_dir/api-config.json" <<'PY'
import json, sys
lab, home, path = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(path))
v1 = [home + "/.config/opencode", home + "/.local/share/opencode", home + "/.local/share/opencode-goal-plugin", home + "/.cache/opencode"]
def under(p, r): return p == r or p.startswith(r + "/")
paths = [s.get("path", "") for s in data if isinstance(s, dict)]
print("sources", len(paths))
print("real_hits", sum(1 for p in paths if any(under(p, v) for v in v1)))
print("lab_hits", sum(1 for p in paths if under(p, lab)))
PY
)
  echo "config-sources: $(printf '%s' "$verdicts" | tr '\n' ' ')"
  case "$verdicts" in *"real_hits 0"*) pass "config sources resolve no real-installation path";; *) bad "config sources touch a real-installation path";; esac
  case "$verdicts" in *"lab_hits 0"*) bad "config sources are not rooted in the lab";; *) pass "config sources include the lab root";; esac
else
  bad "lab API did not return config"
fi

# Installed CLI acceptance: drives the launcher materialized by the authorized
# refresh (not the source file) and proves it resolves inside the lab while the
# real installation stays byte-identical.
if [ -x "$lab_root/rigel/bin/rigel-v2" ] && command -v bun >/dev/null 2>&1; then
  if bun "$root/profiles/gabo/qa-v2-cli-installed.mjs"; then pass "installed CLI acceptance"; else bad "installed CLI acceptance"; fi
else
  bad "installed CLI launcher missing at $lab_root/rigel/bin/rigel-v2"
fi

# Hermetic native rules-injector contract: proves the shipped runtime injects a
# matched project rule into the same tool result the next provider request reads.
# It spawns NO OpenCode and uses NO --standalone (protect-opencode-v1.md); the
# live provider turn stays owned by this lab service.
if node "$root/profiles/gabo/qa-v2-native-rules-injector-contract.mjs" >/dev/null 2>&1; then
  pass "native rules-injector contract (hermetic)"
else
  bad "native rules-injector contract (hermetic)"
fi

# Hermetic user-install lifecycle contract (P2-1): proves the productized user
# route installs, operates, reinstalls idempotently, upgrades between two real
# versions with state migration, rolls back byte-identically and uninstalls while
# preserving foreign data in an isolated HOME/XDG. No OpenCode spawn, no access
# to the real installation.
if node "$root/profiles/gabo/qa-v2-user-install-contract.mjs" >/dev/null 2>&1; then
  pass "user install lifecycle contract (hermetic)"
else
  bad "user install lifecycle contract (hermetic)"
fi

# P3 atomicity: a fault injected at EVERY write boundary of install/upgrade/
# rollback/uninstall must restore config/cli/state byte-identically and leave no
# partial version. No OpenCode spawn, no access to the real installation.
if node "$root/profiles/gabo/qa-v2-user-install-transaction-contract.mjs" >/dev/null 2>&1; then
  pass "user install transaction contract (hermetic)"
else
  bad "user install transaction contract (hermetic)"
fi

after_goals=$(goal_probe)
after_config_hash=$(sha256sum "$HOME/.config/opencode/opencode.json" 2>/dev/null | cut -d' ' -f1)
after_protected=$(node "$root/profiles/gabo/v1-protected-surfaces.mjs" --digest "$HOME")

[ "$before_config_hash" = "$after_config_hash" ] && pass "real installation config hash unchanged" || bad "real installation config hash changed"
[ "$before_protected" = "$after_protected" ] && pass "real installation protected surfaces unchanged (manifest digest)" || bad "real installation protected surfaces changed"
if goal_verdict=$(node "$goal_gate" --verify "$goal_mode" "$before_goals" "$after_goals" 2>&1); then
  pass "goal invariant ($goal_mode): $goal_verdict"
else
  bad "goal invariant ($goal_mode): $goal_verdict"
fi

{
  echo "service=$service"
  echo "lab_root=$lab_root"
  echo "v1_config_hash_before=$before_config_hash"
  echo "v1_config_hash_after=$after_config_hash"
  echo "v1_protected_before=$before_protected"
  echo "v1_protected_after=$after_protected"
  echo "goal_mode=$goal_mode"
  echo "goal_state_before=$before_goals"
  echo "goal_state_after=$after_goals"
  echo "goal_verdict=${goal_verdict:-}"
  echo "failed_steps=$fail"
} > "$evidence_dir/lab-acceptance.txt"

if [ "$fail" -gt 0 ]; then
  echo "Rigel lab acceptance FAILED: $fail step(s). Evidence: $evidence_dir/lab-acceptance.txt" >&2
  exit 1
fi
echo "Rigel lab acceptance passed (isolated V2 service; real installation intact). Evidence: $evidence_dir/lab-acceptance.txt"
