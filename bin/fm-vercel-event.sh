#!/usr/bin/env bash
# Publish one run-bound remote outcome through the ordinary status stream.
# Usage: fm-vercel-event.sh <meta> <run-id> <line>
# The adapter's watch lock serializes writers; append_once makes crash replay
# idempotent. fm-watch owns status-to-wake delivery, including Pi notification.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=bin/fm-backend.sh
. "$SCRIPT_DIR/fm-backend.sh"
# shellcheck source=bin/fm-parent-channel-lib.sh
. "$SCRIPT_DIR/fm-parent-channel-lib.sh"
META=$1
RUN=$2
LINE=$3
[ "$(fm_meta_get "$META" backend)" = vercel ]
[ "$(fm_meta_get "$META" run_id)" = "$RUN" ]
case "$LINE" in *$'\n'*|*$'\r'*) exit 1 ;; esac
case "$(fm_meta_get "$META" delivery_state):$LINE" in
  completed:done:*|failed:failed:*|missing:failed:*|interrupted:failed:*) ;;
  *) exit 1 ;;
esac
fm_parent_channel_append_once "${META%.meta}.status" "$LINE"
