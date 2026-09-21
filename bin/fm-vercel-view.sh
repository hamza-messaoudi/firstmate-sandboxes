#!/usr/bin/env bash
# Usage: fm-vercel-view.sh <create|disconnect|command> <task.meta>
# create resolves the launcher's Herdr workspace and creates one unfocused tab.
# Exact viewer_session/workspace/tab/pane identifiers are patched into task.meta.
# Repeated create refuses recorded viewers; disconnect closes only the recorded
# pane after verifying its tab/workspace membership, never the worker or watcher.
# command prints the safe manual attach command; running it revalidates lifecycle.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/fm-backend.sh"
. "$SCRIPT_DIR/backends/herdr.sh"
op=${1:-}
record=${2:-}
[ -f "$record" ] && [ "$(fm_meta_get "$record" backend)" = vercel ] || exit 1
record=$(cd "$(dirname "$record")" && pwd -P)/$(basename "$record")
printf -v command '%q --backend vercel attach %q' "$SCRIPT_DIR/backends/vercel.sh" "$record"
case "$op" in
  command) printf '%s\n' "$command"; exit 0 ;;
  create|disconnect) ;;
  *) echo 'usage: fm-vercel-view.sh <create|disconnect|command> <task.meta>' >&2; exit 2 ;;
esac
STATE=$(dirname "$record")
FM_STATE_OVERRIDE=$STATE
. "$SCRIPT_DIR/fm-wake-lib.sh"
lock="$record.viewer.lock"
fm_lock_acquire_wait_bounded "$lock" 5 || exit 1
trap 'fm_lock_release "$lock"' EXIT
session=$(fm_meta_get "$record" viewer_session)
pane=$(fm_meta_get "$record" viewer_pane)
if [ "$op" = disconnect ]; then
  [ -n "$session" ] && [ -n "$pane" ] || exit 0
  info=$(fm_backend_herdr_cli "$session" pane get "$pane") || exit 1
  printf '%s' "$info" | jq -e --arg pane "$pane" \
    --arg tab "$(fm_meta_get "$record" viewer_tab)" --arg ws "$(fm_meta_get "$record" viewer_workspace)" \
    '.result.pane | .pane_id == $pane and .tab_id == $tab and .workspace_id == $ws' >/dev/null || exit 1
  fm_backend_herdr_cli "$session" pane close "$pane" >/dev/null
  exit 0
fi
[ -z "$pane" ] || { echo 'error: viewer already recorded; use the manual attach command' >&2; exit 1; }
[ ! -e "$record.cancel" ] && [ "$(fm_meta_get "$record" delivery_state)" = running ] || exit 1
"$SCRIPT_DIR/backends/vercel.sh" --backend vercel inspect "$record" | jq -e '.state == "running"' >/dev/null
session=${HERDR_SESSION:-default}
fm_backend_herdr_workspace_ensure "$session" "$SCRIPT_DIR/.." >/dev/null
ws=$FM_BACKEND_HERDR_WS_ID
out=$(fm_backend_herdr_cli "$session" tab create --workspace "$ws" --cwd "$SCRIPT_DIR/.." \
  --label "Vercel: $(fm_meta_get "$record" task_id) (viewer)" --no-focus)
tab=$(printf '%s' "$out" | jq -er '.result.tab.tab_id | select(type == "string" and length > 0)')
pane=$(printf '%s' "$out" | jq -er '.result.root_pane.pane_id | select(type == "string" and length > 0)')
# Persist before starting the disposable connection; never close by label.
if ! jq -n --arg run "$(fm_meta_get "$record" run_id)" --arg session "$session" --arg ws "$ws" --arg tab "$tab" --arg pane "$pane" \
  '{run_id:$run, viewer_session:$session, viewer_workspace:$ws, viewer_tab:$tab, viewer_pane:$pane}' |
  "$SCRIPT_DIR/backends/vercel.sh" --backend vercel update "$record"; then
  fm_backend_herdr_cli "$session" pane close "$pane" >/dev/null 2>&1 || true
  exit 1
fi
fm_backend_herdr_cli "$session" pane run "$pane" "$command" >/dev/null
