# Experimental Vercel backend

Vercel runs a Codex ship worker in a fork of an explicitly prepared, stopped sandbox base.
The lifecycle integration is covered by mocked tests; live integration against the Vercel platform is still unverified (see "Live verification status").
Herdr presentation, restart recovery, scouts, secondmates, model overrides, and additional harnesses are not implemented.

Install the optional SDK with `npm ci --prefix bin/vercel` using Node 22 or later.
Prepare a private base containing Git, GitHub CLI, tmux, Node, and Codex with the intended interactive login, then stop it with a current snapshot.
Base preparation and inherited Codex authentication require separate live verification.
Keep `VERCEL_TOKEN` and `GH_TOKEN` in the launching environment, never in configuration or the prepared base.

Create the private `config/vercel.json` with `base_name`, `team_id`, `project_id`, `git_author_name`, `git_author_email`, and finite `timeout_ms` between 60000 and 1800000.
The adapter header in [bin/backends/vercel.sh](../bin/backends/vercel.sh) owns the execution command and configuration contract.
Create an ordinary task brief with a populated `# Task` and `Delivery contract: mode=direct-PR`, plus the normal dispatchable backlog entry.
Launch explicitly:

```sh
bin/fm-spawn.sh task-id projects/project --backend vercel --harness codex --mode direct-PR --yolo off
```

Explicit `FM_BACKEND=vercel` and `config/backend` selection also work; Vercel is never auto-detected.
Only the Task content is uploaded; local launch, status, inbox, and hook instructions are excluded.
Workers start from the GitHub default branch's resolved commit, so local uncommitted and unpushed work is not included.
No local worktree is allocated, inspected as a remote repository, or returned to Treehouse.

Watcher updates use the existing short metadata lock and preserve unrelated fields; stop and teardown wait for the watcher to exit before deletion.
The single SDK watcher verifies the structured completion result against GitHub and publishes a normal run-bound Firstmate status event.
The existing Firstmate watcher and Pi extension deliver that event; the ordinary supervision chain must remain active.
Completion means PR-ready, not merged or CI-green.
A failed stop preserves the verified PR and leaves cleanup unresolved.
Generic supervision reads cached evidence; the adapter's `capture` operation provides explicit bounded remote capture.
`fm-send` refuses durable steering because this backend has no remote inbox.
A Herdr viewer and supported attach workflow remain deferred.

Use `bin/fm-teardown.sh task-id` after the exact recorded head is verified merged.
Use its existing `--force` only with explicit authority to discard remote work.
Teardown coordinates with the watcher before deleting the recorded sandbox and retains metadata on cleanup failure, including under `--force`.
Delivery evidence and final cleanup metadata are archived in the task's private data directory.
The base is never a cleanup target.
The adapter's `stop` operation cancels polling and stops compute while retaining identity for later teardown.

Keep the host awake for prompt reporting; finite provider runtime remains the bound during disconnection.
Stopped persistent storage can remain billable until explicit deletion.
Run `bash tests/vercel.test.sh` for allocation-free execution and lifecycle checks.

## Live verification status

Checked on 2026-09-20 with Vercel CLI 59.23.2, Node 24.20.0, and the captain's logged-in CLI session (teams `hamzas-projects-9e6e8e46` on hobby and `shiva-257d6eb4` on pro).
The CLI login is not usable by the adapter, which reads only `VERCEL_TOKEN` and `GH_TOKEN` from the environment, and neither was exported.

Proven:
- `npm ci --prefix bin/vercel` installs the SDK cleanly and `bash tests/vercel.test.sh` passes.
- `vercel sandbox list` works through the CLI login for both teams and shows no sandboxes, so no base has been prepared yet.
- The doctor operation stops before any provider call when the credentials are absent.
  It now prints its own validation message, such as the missing credentials, instead of only a generic failure; provider errors are still never echoed.

Not yet proven, pending a live base and tokens: doctor against a real stopped base, spawn, a Codex worker running and reporting completion, real authentication failure modes, provider timeout behavior, and stop and teardown against real sandboxes.
The doctor's `live_agent_auth: unverified` field stays accurate until then.

Follow-up work, not implemented and not assessed live:
- Full Claude and Codex parity: only ship, direct-PR, and Codex are supported.
- Durable remote steering inbox: `fm-send` refuses steering because no remote inbox exists.
- Restart reconciliation: a restarted Firstmate cannot recover a running remote worker.
