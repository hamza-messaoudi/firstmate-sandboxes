#!/usr/bin/env bash
# Explicit Vercel execution adapter and single-owner lifecycle watcher.
# Usage: bin/backends/vercel.sh --backend vercel <operation> <record> [arguments]
# Install optional SDK: npm ci --prefix bin/vercel (Node >=22).
# Credentials are environment-only: VERCEL_TOKEN and GH_TOKEN.
# doctor: record is a config JSON file with backend=vercel, mode=ship,
# delivery=direct-PR, harness=codex|claude, task_id, base_name, team_id, project_id,
# origin (ordinary GitHub URL), git_author_name, git_author_email,
# and timeout_ms (60000..1800000). The base must be stopped with a snapshot.
# Tool and interactive Codex or Claude Code login preparation remain operator responsibilities.
# spawn accepts task content only, not a local Firstmate launch brief or host inbox contract.
# spawn: record is a NEW private .meta path; arguments: config.json task.md.
# attach: interactive terminal viewer; session-bound, never resumes or extends timeout.
# inspect|capture|send|steer|submit|watch|stop|delete: record is the spawn .meta path.
# capture accepts a line count (1..200); send reads literal UTF-8 text on stdin.
# steer reads literal UTF-8 text on stdin and durably appends one remote inbox record.
# watch accepts interval milliseconds (1000..60000) and polls without reconciliation.
# reconcile owns result verification, evidence, normal status, and completion stop.
# landed is a read-only exact-PR merge check; update is a run-bound local-only
# metadata patch on stdin under the existing meta lock (internal watcher use).
# stop/delete cancel future probes before contacting the provider and retain records.
# Records use fm_meta_get-compatible key=value lines and same-directory rename.
# The existing portable lock owner serializes mutations. Watch has a separate
# single-owner lock; session-bound execution cannot resume during a stop race.
# These primitives do not grant Firstmate delivery/teardown authority.
# Sourcing registers no process and requires no optional SDK.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi
set -eu

VERCEL_BIN=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [ "${1:-}" != --backend ] || [ "${2:-}" != vercel ] || [ "$#" -lt 4 ]; then
  echo 'usage: vercel.sh --backend vercel <doctor|spawn|inspect|capture|send|steer|submit|watch|stop|delete|attach> <record> [arguments]' >&2
  exit 2
fi
shift 2
VERCEL_OP=$1
VERCEL_RECORD=$2
shift 2
case "$VERCEL_OP" in doctor|spawn|inspect|capture|send|steer|submit|watch|stop|delete|reconcile|landed|update|attach) ;; *) exit 2 ;; esac
VERCEL_PARENT=$(cd "$(dirname "$VERCEL_RECORD")" && pwd -P)
VERCEL_RECORD="$VERCEL_PARENT/$(basename "$VERCEL_RECORD")"
# Scope the lock library's directory initialization to this explicit record.
STATE=$VERCEL_PARENT
FM_STATE_OVERRIDE=$VERCEL_PARENT
# shellcheck source=bin/fm-wake-lib.sh
. "$VERCEL_BIN/fm-wake-lib.sh"
VERCEL_LOCK=
VERCEL_CHILD=
VERCEL_WATCH_LOCK=
# shellcheck disable=SC2329 # Invoked by EXIT trap.
vercel_finish() {
  if [ -n "$VERCEL_CHILD" ]; then
    kill "$VERCEL_CHILD" 2>/dev/null || true
    wait "$VERCEL_CHILD" 2>/dev/null || true
  fi
  [ -z "$VERCEL_LOCK" ] || fm_lock_release "$VERCEL_LOCK"
  [ -z "$VERCEL_WATCH_LOCK" ] || fm_lock_release "$VERCEL_WATCH_LOCK"
}
trap vercel_finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
case "$VERCEL_OP" in
  spawn|send|steer|submit|stop|delete|update) VERCEL_LOCK=$(fm_meta_lock_path "$VERCEL_RECORD") ;;
  watch|reconcile) VERCEL_LOCK="$VERCEL_RECORD.watch.lock" ;;
esac
case "$VERCEL_OP" in
  stop|delete)
    # Cancel cooperatively, never kill a PID that may have been reused.
    : >"$VERCEL_RECORD.cancel"
    VERCEL_WATCH_LOCK="$VERCEL_RECORD.watch.lock"
    fm_lock_acquire_wait_bounded "$VERCEL_WATCH_LOCK" 90 || { VERCEL_WATCH_LOCK=; exit 1; }
    ;;
  send|submit)
    VERCEL_WATCH_LOCK="$VERCEL_RECORD.watch.lock"
    fm_lock_try_acquire "$VERCEL_WATCH_LOCK" || { VERCEL_WATCH_LOCK=; echo 'error: use the interactive viewer while watched' >&2; exit 1; }
    ;;
esac
if [ -n "$VERCEL_LOCK" ]; then
  fm_lock_acquire_wait_bounded "$VERCEL_LOCK" 5 || { VERCEL_LOCK=; echo 'error: execution record busy' >&2; exit 1; }
fi
# The SDK watcher inherits the lock-owner PID through exec. A killed shell
# cannot leave an unowned polling child. The portable lock reclaims its stale
# directory after exit; no PID-based watcher kill is needed.
case "$VERCEL_OP" in
  watch|reconcile|attach) exec node "$VERCEL_BIN/vercel/fm-vercel.mjs" "$VERCEL_OP" "$VERCEL_RECORD" "$@" ;;
esac
# Explicit stdin redirection preserves piped literal input for the background child.
node "$VERCEL_BIN/vercel/fm-vercel.mjs" "$VERCEL_OP" "$VERCEL_RECORD" "$@" <&0 &
VERCEL_CHILD=$!
VERCEL_RC=0
wait "$VERCEL_CHILD" || VERCEL_RC=$?
VERCEL_CHILD=
exit "$VERCEL_RC"
