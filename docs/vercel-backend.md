# Experimental Vercel backend

Vercel runs a ship worker in a fork of an explicitly prepared, stopped sandbox base, using the Codex or Claude Code CLI as the remote harness.
The lifecycle integration is covered by mocked tests; live integration against the Vercel platform has now been proven for the Codex harness end to end (see "Live verification status"), while the Claude Code harness remains live-unverified.
Restart recovery, scouts, secondmates, and model overrides are not implemented.

Install the optional SDK with `npm ci --prefix bin/vercel` using Node 22 or later.
Prepare a private base containing Git, GitHub CLI, tmux, Node, and the intended harness (Codex, Claude Code, or both) with their interactive login, then stop it with a current snapshot.
Base preparation and inherited harness authentication require separate live verification per harness; the harness's login is never baked into config or shipped as a secret.
Keep `VERCEL_TOKEN` and `GH_TOKEN` in the launching environment, never in configuration or the prepared base.

Create the private `config/vercel.json` with `base_name`, `team_id`, `project_id`, `git_author_name`, `git_author_email`, and finite `timeout_ms` between 60000 and 1800000.
The adapter header in [bin/backends/vercel.sh](../bin/backends/vercel.sh) owns the execution command and configuration contract.
Create an ordinary task brief with a populated `# Task` and `Delivery contract: mode=direct-PR`, plus the normal dispatchable backlog entry.
Launch explicitly:

```sh
bin/fm-spawn.sh task-id projects/project --backend vercel --harness codex --mode direct-PR --yolo off
```

`--harness codex` and `--harness claude` are the only accepted values; the base must have that exact CLI installed and logged in.

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
The optional Herdr viewer is independent of this watcher.

Use `bin/fm-teardown.sh task-id` after the exact recorded head is verified merged.
Use its existing `--force` only with explicit authority to discard remote work.
Teardown coordinates with the watcher before deleting the recorded sandbox and retains metadata on cleanup failure, including under `--force`.
Delivery evidence and final cleanup metadata are archived in the task's private data directory.
The base is never a cleanup target.
The adapter's `stop` operation cancels polling and stops compute while retaining identity for later teardown.

Keep the host awake for prompt reporting; finite provider runtime remains the bound during disconnection.
Stopped persistent storage can remain billable until explicit deletion.
Run `bash tests/vercel.test.sh` for allocation-free execution and lifecycle checks.

## Interactive viewer

Launch from an existing Herdr pane to create an unfocused tab labeled `Vercel: <task-id> (viewer)` in the launcher workspace.
The viewer uses the optional SDK installed above and Node's built-in WebSocket client; it needs no Sandbox CLI, plugin, SSH server, or local PTY dependency.
Its terminal must inherit `VERCEL_TOKEN`; credentials are never placed in the pane command or task metadata.
Viewer creation failure leaves the worker and watcher running and prints a manual attachment command.

For manual attachment or recovery after closing a viewer, run the printed command in an interactive terminal:

```sh
bin/backends/vercel.sh --backend vercel attach "$FM_HOME/state/task-id.meta"
```

Attachment verifies the running worker and recorded session, then opens that exact SDK Session without resuming it.
Stopped, completed, missing, expired, or changed-session workers refuse attachment.
The connection never extends the provider timeout.
Detach with tmux's `Ctrl-b d`, or close the viewer tab; both leave remote execution and the local watcher independent.
The terminal connection can be reopened manually while the recorded worker is still running.
Do not substitute `sandbox exec`: the inspected CLI automatically resumes stopped sandboxes.

[bin/fm-vercel-view.sh](../bin/fm-vercel-view.sh) owns viewer creation, exact identifier persistence, safe disconnect, and manual-command printing.
Teardown closes the recorded viewer best-effort after cloud cleanup.
Automatic viewer recovery and completion badges are not implemented.
Interactive keyboard, resizing, and Herdr presentation are proven live for a still-running worker (see "Live verification status"); disconnect survival across a real network drop remains mock-tested only.

## Live verification status

Checked on 2026-09-22 with Vercel CLI 59.23.2, Node 24.20.0, real `VERCEL_TOKEN`/`GH_TOKEN` exported to the launching environment, team `hamzas-projects-9e6e8e46`, and project `hybrid-factory`.

Proven, against the real Vercel provider and the real `hamza-messaoudi/firstmate-sandboxes` GitHub repository:
- `npm ci --prefix bin/vercel` installs the SDK cleanly and `bash tests/vercel.test.sh` passes (67 tests).
- A base named `poc-unit` was created fresh, provisioned with Git, GitHub CLI, tmux, Node 24, the Codex CLI, and the Claude Code CLI (no credentials or login baked in), then stopped with a current snapshot; the doctor operation accepted it and returned a real snapshot id and base commit SHA.
- Real Codex sign-in inside a forked sandbox (ChatGPT device-code flow), followed by the remote Codex worker autonomously implementing the assigned one-file task, committing, pushing, and opening a real GitHub pull request, proven twice end to end (`fm-vlv3-live4`/PR #5 pre-Claude-Code-work, and after adding the Claude harness, `fm-vlv3-live6`/PR #6 and `fm-vlv3-live7`/PR #7 in the same session): each PR's `head.sha` and repository identity matched the adapter's recorded result exactly, and the completion watcher auto-stopped the sandbox immediately after verifying it against GitHub. All three probe PRs were closed (not merged) as disposable smoke-test artifacts and their branches deleted.
- Provider timeout/stop behavior: an unattended test sandbox (`fm-vlv3-live`) was left at the Codex sign-in screen until its recorded deadline; the watcher independently detected `deadline expired`, marked the task `interrupted`, and a subsequent attach attempt was correctly refused ("task is not running") without resuming it.
- Deletion/teardown: every short-lived test sandbox (`fm-vlv3-live` through `fm-vlv3-live8`) was torn down through `bin/fm-teardown.sh --force` and confirmed absent from a live `Sandbox.list`; only the prepared base `poc-unit` remains, in `stopped` status with a current snapshot.
- The Herdr interactive viewer was exercised fully automatically (no manual captain timing) against a still-running worker (`fm-vlv3-live8`, tmux session `fm-6b444e91a0f14b5aaca56bd8c6c4ea82`, remote SDK session `2f66fcf8-506...`): `fm-vercel-view.sh create` attached one client and showed live pane content, `disconnect` closed exactly that pane and left the remote tmux session and sandbox running with zero attached clients, and a fresh manual-attach reconnect showed the identical session id and pane content, proving continuity across detach/reattach with no resume of a stopped worker. Attaching to an already-completed or already-stopped task was independently confirmed refused.
- Real authentication failure mode observed live (not injected): the Codex account under test hit its own usage/rate limit mid-run and Codex reported it directly in the pane; the adapter took no incorrect action on that condition, and it resolved on retry.

Not yet proven:
- Claude Code as the live remote harness: two attempts to complete an interactive Claude Code login inside the sandbox lifetime did not finish before either the provider deadline or the operator's availability window closed, so its login/execution/completion path is implemented and unit-tested but still live-unverified. The Codex path above stands in for the shared spawn/watch/result/cleanup machinery both harnesses use.
- Real authentication *failure* (invalid/expired token) end to end; only the credential-absent path and a live usage-limit condition were observed.
- Disconnect survival across an actual dropped network connection to the viewer (only an explicit close/detach was exercised).

Follow-up work, not implemented and not assessed live:
- Full harness parity beyond Codex and Claude Code: only ship, direct-PR, and those two harnesses are supported.
- Durable remote steering inbox: `fm-send` refuses steering because no remote inbox exists.
- Restart reconciliation: a restarted Firstmate cannot recover a running remote worker.
