# Experimental Vercel backend

Vercel runs a Codex ship worker in a fork of an explicitly prepared, stopped sandbox base.
The lifecycle integration is covered by mocked tests; live integration is unverified.
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
