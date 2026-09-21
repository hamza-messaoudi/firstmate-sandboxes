#!/usr/bin/env bash
# Vercel-only lifecycle helpers sourced by fm-spawn/fm-teardown.
# Spawn reads config/vercel.json (base_name, team_id, project_id, timeout_ms,
# git_author_name, git_author_email), extracts only # Task from the normal
# brief, and derives origin from the read-only project. Only explicit codex,
# ship/direct-PR/yolo=off is supported; no profiles, relaunch, or local worktree.
# Teardown requires a GitHub-verified merged recorded head, or explicit --force
# discard authority. Cancel, then wait for the single watcher before deletion.
# Cloud failures retain metadata and evidence even with --force.

fm_vercel_spawn() {
  local project config brief task config_tmp task_tmp record
  [ "$KIND" = ship ] && [ "$MODE" = direct-PR ] && [ "$YOLO" = off ] \
    && [ "$HARNESS_ARG" = codex ] && [ "$MODEL_SET" = 0 ] && [ "$EFFORT_SET" = 0 ] \
    && [ "${#POS[@]}" -eq 2 ] || {
    echo 'error: Vercel supports only ship --mode direct-PR --yolo off --harness codex, without model/effort overrides' >&2
    return 1
  }
  project=${POS[1]}
  case "$project" in projects/*) project="$PROJECTS/${project#projects/}" ;; esac
  project=$(cd "$project" && pwd -P) || return 1
  config="$CONFIG/vercel.json"
  brief="$DATA/$ID/brief.md"
  record="$STATE/$ID.meta"
  [ ! -e "$record" ] && [ ! -e "$record.cancel" ] || { echo 'error: retained Vercel task identity exists' >&2; return 1; }
  fm_brief_task_content_valid "$brief" && ! fm_brief_task_placeholders_present "$brief" || return 1
  [ "$(sed -n 's/^Delivery contract: mode=//p' "$brief")" = direct-PR ] || return 1
  task=$(fm_brief_heading_body "$brief" '# Task') || return 1
  # Never ship the host-only launch role, inbox, status path, or setup scaffold.
  case "$task" in *"$STATE"*|*'FIRSTMATE_OP:'*|*'fm-session-start.sh'*)
    echo 'error: Task content includes local orchestration instructions' >&2; return 1 ;;
  esac
  local backlog=0 gate
  if fm_backlog_transition_applies "$CONFIG" "$DATA" "$KIND"; then
    backlog=1
    if ! fm_backlog_row_probe "$DATA" "$ID" || ! fm_backlog_row_dispatchable "$FM_BACKLOG_ROW_STATE"; then
      echo 'error: Vercel task needs a dispatchable backlog row' >&2
      return 1
    fi
  else
    gate=$?
    [ "$gate" != 2 ] || return 1
  fi
  config_tmp=$(mktemp "$STATE/.vercel-config.XXXXXX") || return 1
  task_tmp=$(mktemp "$STATE/.vercel-task.XXXXXX") || { rm -f "$config_tmp"; return 1; }
  if ! jq --arg task "$ID" --arg project "$project" \
    --arg origin "$(git -C "$project" remote get-url origin)" \
    '. + {backend:"vercel",mode:"ship",delivery:"direct-PR",harness:"codex",task_id:$task,local_project:$project,origin:$origin}' \
    "$config" >"$config_tmp"; then
    rm -f "$config_tmp" "$task_tmp"
    return 1
  fi
  printf '%s\n' "$task" >"$task_tmp"
  local rc=0
  "$SCRIPT_DIR/backends/vercel.sh" --backend vercel spawn "$record" "$config_tmp" "$task_tmp" >/dev/null || rc=$?
  rm -f "$config_tmp" "$task_tmp"
  [ "$rc" = 0 ] || return "$rc"
  if [ "$backlog" = 1 ]; then
    local lock
    lock=$(fm_meta_lock_path "$record") || return 1
    fm_lock_acquire_wait "$lock" || return 1
    rc=0
    fm_backlog_atomic_transition dispatch "$record" "$DATA" "$ID" "$STATE" || rc=$?
    fm_lock_release "$lock"
    if [ "$rc" != 0 ]; then
      "$SCRIPT_DIR/backends/vercel.sh" --backend vercel stop "$record" >/dev/null || true
      echo 'error: backlog dispatch failed; Vercel identity retained for cleanup' >&2
      return 1
    fi
  fi
  # One detached SDK client owns lifecycle independently of presentation.
  nohup "$SCRIPT_DIR/backends/vercel.sh" --backend vercel reconcile "$record" \
    </dev/null >"$DATA/$ID/vercel-watch.log" 2>&1 &
  local watcher=$! ready=0 attempt
  for ((attempt=0; attempt<50; attempt++)); do
    if [ -n "$(fm_meta_get "$record" watcher_pid)" ]; then ready=1; break; fi
    kill -0 "$watcher" 2>/dev/null || break
    sleep 0.1
  done
  if [ "$ready" != 1 ]; then
    "$SCRIPT_DIR/backends/vercel.sh" --backend vercel stop "$record" >/dev/null || true
    echo 'error: Vercel watcher failed to start; cleanup identity retained' >&2
    return 1
  fi
  if [ "${HERDR_ENV:-}" = 1 ]; then
    "$SCRIPT_DIR/fm-vercel-view.sh" create "$record" || echo 'warning: viewer unavailable; remote worker remains watched' >&2
  fi
  printf 'Manual attach: '
  "$SCRIPT_DIR/fm-vercel-view.sh" command "$record"
  printf 'Vercel worker created for %s; local worktree changes were not included.\n' "$ID"
}

fm_vercel_quiesce() { # <meta>
  local record=$1 lock
  : >"$record.cancel" || return 1
  lock="$record.watch.lock"
  fm_lock_acquire_wait_bounded "$lock" 90 || {
    echo 'error: Vercel watcher is still active; retaining task' >&2
    return 1
  }
  fm_lock_release "$lock"
}
