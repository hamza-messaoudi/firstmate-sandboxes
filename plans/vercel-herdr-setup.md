# Firstmate + Vercel Sandbox + Herdr — MVP implementation plan v2

Prepared 20 September 2026. This document replaces the earlier 43-section plan. Implement this document's scope; the earlier plan is background only.

## 1. Assignment and outcome

Modify the existing `kunchenguid/firstmate` checkout to add an experimental, explicitly selected Vercel execution backend. Pi and Firstmate remain local. Each coding worker runs in its own Vercel Sandbox, inside remote tmux. A local Herdr pane attaches to that session. Firstmate receives the worker's verified PR through its existing completion and supervisor mechanisms.

Target one implementation session. Favor a small complete vertical slice over broad backend parity. Do not change Herdr itself, introduce a service, or redesign Firstmate's architecture.

The implementation agent has the repository. Read its applicable instructions and inspect actual backend, spawn, status, supervision, and teardown contracts before editing. Filenames and command names below are suggestions, not claims about the checkout. Preserve unrelated work and existing local backend semantics.

## 2. Scope contract

| Required MVP | Explicitly deferred |
| --- | --- |
| Explicit `--backend vercel`; never auto-selected | Automatic backend selection |
| Direct-PR ordinary workers | Scouts, secondmates, local-only, no-mistakes |
| One agent authenticated and proven end to end | Second agent if it requires substantial additional integration |
| Claude and Codex launch adapters if they share the same simple path | Other harnesses and remote Pi |
| Explicitly prepared base; one independent fork per task | Automatic base refresh, invalidation, prewarming |
| Remote tmux; Herdr interactive viewer | Rich blocked-state detection and viewer recovery |
| Capture; literal text submission if compatible with existing send semantics | Durable inbox, automatic steering retries |
| Verified PR → normal Firstmate status → normal Pi notification | New supervision protocol |
| Stop, explicit teardown, partial-failure handling | Relaunch and restart reconciliation |
| Finite runtime, bounded requests, focused tests | Budgets, autoscaling, multi-cloud abstraction |

Reject unsupported combinations before allocating cloud resources or local worktrees. Never silently fall back to local execution. Unsupported steering must return a clear error, not pretend that the message was delivered.

## 3. Architecture and ownership

- Firstmate owns task identity, lifecycle, completion, and cleanup.
- Vercel owns the remote execution environment.
- tmux owns the running interactive agent session while the VM remains running.
- Herdr is a disposable viewer. Closing it must not stop the worker.
- Existing Firstmate state files remain the supervisor-facing source of truth.

Use one concrete `vercel` backend with optional Herdr presentation. Do not create general execution/presentation interfaces this session. Do not make the official Herdr Vercel plugin a second lifecycle owner; inspect its terminal patterns if helpful.

Persistence preserves filesystem state across sandbox stops. It does not promise a surviving tmux process. No automatic resume/relaunch is part of this MVP.

## 4. Phase 0 — prove the uncertain primitives first

Do this before substantial Firstmate integration. Use an explicitly selected harmless test repository and a short cloud timeout. Record installed versions and exact working commands in the backend documentation.

1. Inspect current Vercel CLI/SDK help and types. Pin the SDK version used; do not mix v1 sandbox-ID assumptions with v2 named-sandbox APIs.
2. Confirm Vercel account, team, and project for both SDK and CLI. CLI login alone must not be assumed to authenticate the SDK. Use a documented SDK credential route; fail clearly if missing. Never print credentials.
3. Prepare a base with `git`, `gh`, `tmux`, and the chosen agent. Check binaries rather than assuming the image contains them.
4. Authenticate the agent interactively using the operator's intended subscription. Do not copy local credential folders or substitute API billing.
5. Stop the base, wait for a saved snapshot, and fork two short-lived workers. Verify both can perform an authenticated agent turn. Inherited authentication is a tested convenience, not a contractual guarantee.
6. If cloned login fails, allow manual login inside each worker. Do not implement credential synchronization. Document the resulting setup requirement.
7. In one worker, launch a detached tmux session and attach from a local terminal using the installed equivalent of:

   ```bash
   sandbox exec --interactive --tty <sandbox-name> -- \
     tmux attach-session -t <session-name>
   ```

8. Detach/close the connection; verify the remote process continues. Reattach and verify keyboard input and terminal resizing.
9. Verify a non-resuming lifecycle inspection and a provider runtime limit. Confirm the viewer does not keep extending the timeout; use the supported no-extension option for the installed CLI. Do not assume a flag supported by `connect` also exists on `exec`.
10. Stop and remove test workers. Preserve only the deliberately prepared base.

If live credentials are unavailable, continue with implementation and mocks but explicitly report “live integration unverified.” If a required primitive is demonstrably unsupported, report the concrete blocker rather than building speculative workarounds or declaring success.

## 5. Explicit base preparation

Use a small configuration containing the explicit base name and Vercel project/team context, using existing configuration conventions where possible. No automatic repository-name hashing is needed.

Provide one documented preparation procedure; a dedicated preparation command is optional if it stays small. The base should contain tools and, if validated, agent login state. It need not contain the project repository. Clone the repository inside each worker; a tool-only base avoids private-repository credentials and shared Git refresh operations in the template.

- Base preparation and refresh are operator actions outside spawning.
- Spawn never resumes, resets, updates, or stops the shared base.
- Require the base to be stopped with a valid current snapshot. Refuse otherwise.
- Do not silently accept the SDK's fresh-create fallback when a source snapshot is absent.
- Never put `GH_TOKEN` or Vercel control credentials in the base.
- An authenticated base contains agent credentials; it is not credential-free. Keep it private and do not distribute its snapshot.
- Refresh the base only when no new spawns are being launched. Distributed locking is out of scope.

## 6. Minimal code structure

Prefer a thin Bash backend adapter plus one Node helper owning the SDK. Reuse existing utilities rather than duplicating task-state writers or Herdr automation.

Suggested additions:

```text
bin/backends/vercel.sh       backend contract adapter
bin/fm-vercel.mjs            SDK operations and polling subcommand
docs/vercel-backend.md       setup, commands, limits, recovery
tests/...                   repository-native focused tests
```

Add separate spawn/view shell files only if they materially clarify existing entry points. Do not create a framework of wrappers solely to match the earlier plan.

The helper should cover the operations actually used: doctor/preflight, spawn, inspect, capture, send if supported, watch, stop, and delete. JSON on stdout for machine operations; diagnostics on stderr. Capture output must be returned in whatever format the existing backend consumer expects. Credentials never appear in argv, logs, or task metadata. Make the transport injectable for tests.

Keep SDK dependencies optional and isolated to this backend. One persistent Node polling process per worker is acceptable for a small crew; avoid launching multiple fresh Node processes every few seconds. Do not claim a RAM target without measuring it.

## 7. Spawn transaction

Perform these steps in order:

1. Validate supported mode/harness and safe task identity. Resolve an ordinary GitHub origin; reject unsupported hosts or URL forms clearly. Never change the local checkout.
2. Resolve the target default branch and exact remote commit SHA. MVP starts from remote committed code only; warn that local uncommitted or unpushed changes are not included. Record the selected SHA.
3. Preflight SDK credentials, base snapshot, chosen agent availability, GitHub token, and deadline configuration before creating the worker.
4. Generate a unique run ID and unique sandbox name; never reuse a task label as the full cleanup identity. Record spawn intent locally before allocation.
5. Fork the prepared base using a unique name, finite provider timeout, and worker-only GitHub credentials passed through the SDK environment. Forks inherit configuration: explicitly control the worker environment rather than accidentally copying unrelated base secrets.
6. Immediately persist the returned identity and provider scope atomically. If creation has an ambiguous network outcome, inspect the exact intended name before retrying; never blindly create another worker.
7. Configure Git authentication without token literals in files or URLs. An environment-backed credential helper can use `gh`; `GH_TOKEN` by itself is not sufficient for ordinary Git HTTPS operations. Verify this path during the smoke test. Configure a Git author through existing conventions.
8. Clone into `/vercel/sandbox/repo`, fetch the selected commit, and create a unique branch such as `fm/<task-id>-<run-id>`. Record the exact branch and base SHA. Refuse conflicting existing remote branches; do not force-push.
9. Create a task directory outside the repository, e.g. `/vercel/sandbox/firstmate/<run-id>/`. Upload the brief and a tiny completion helper.
10. Start the agent inside a new detached tmux session, in the repository directory, using a safely quoted launch script. Use the current supported Firstmate worker flags only where appropriate. Disable incompatible local hooks; do not copy local orchestration files into the worker.
11. Confirm the tmux session exists, record the running session identity, and launch the local watcher independently of the Herdr viewer.
12. Create the Herdr viewer if available; otherwise print an attachment command. Viewer failure is nonfatal.

If initialization fails after allocation, attempt to stop the exact worker and record the failure plus any cleanup error. Preserve metadata for explicit teardown. Never delete a resource based only on a display label. Do not create or clean up a local Treehouse worktree for remote tasks.

## 8. Remote brief and completion contract

Reuse useful task content, but generate a coherent remote brief with local status paths, inbox instructions, and local hooks removed. Do not append contradictory instructions telling the worker to ignore the preceding brief.

The brief must name the remote repository, exact branch, run ID, and completion helper. Required behavior:

1. Implement and test the task.
2. Commit and push the recorded feature branch.
3. Open a PR against the recorded repository/base branch.
4. Call the completion helper with the PR URL after push succeeds.

The helper is a small deterministic script, not a service. It reads the current commit SHA and writes a structured result to a temporary file in the same directory, then renames it atomically. It publishes the done marker last. Example result:

```json
{
  "version": 1,
  "task_id": "auth-redesign",
  "run_id": "unique-run-id",
  "kind": "direct-PR",
  "branch": "fm/auth-redesign-unique-run-id",
  "head_sha": "full-git-commit-sha",
  "pr_url": "https://github.com/owner/repo/pull/123"
}
```

Clear result/marker files in the newly created run directory before launch. Bound result size and validate its schema. Never evaluate remote result text as shell code.

The worker may stay interactive after completing; agent exit is not the success signal. If it forgets the marker, report the incomplete contract. Do not infer success from terminal prose.

## 9. Watcher and completion reconciliation

Use a default polling interval around 10 seconds with a bounded request timeout. One combined remote command can inspect the marker and tmux status when the sandbox is known to be running.

Internal distinctions:

| Observation | Action |
| --- | --- |
| Running, no marker, tmux alive | Continue |
| Marker exists | Read and validate result before considering tmux absence |
| Running, no marker, tmux missing | Record worker failure |
| Sandbox/session unexpectedly stopped | Record interruption; do not auto-resume |
| Resource confirmed missing | Record failure |
| Network, rate-limit, or authentication error | Record observation as unknown/unreachable; bounded backoff, no false success/failure |
| Previously completed/cancelled locally | No further remote execution probes |

Use non-resuming metadata inspection first. SDK file/command operations may auto-resume a stopped sandbox: a check-then-exec race must not lead to silently relaunching the agent. Use a session-bound/non-resuming execution option if available. Otherwise detect a changed session identity, stop any unintended resumed session, and report interruption. Do not turn off provider runtime limits to hide this problem.

For a result, verify through GitHub that the PR belongs to the intended repository, has the expected head branch and commit SHA, and targets the expected base. Require successful retrieval, not just a plausible URL. Transient verification failures retry; mismatched results are failures. PR-ready does not mean merged or CI-green; preserve Firstmate's existing delivery semantics.

Completion order:

1. Save the validated result and a bounded terminal tail locally.
2. Record completion through the existing Firstmate state-writing mechanism exactly once for the run. Use existing locking/atomic conventions.
3. Stop the sandbox and record whether cleanup succeeded. A stop failure must not erase a verified PR result.
4. Update Herdr title/state best-effort, if implemented.
5. Exit the watcher. Existing Firstmate supervision must discover normal completion and wake Pi.

Prevent duplicate watchers using an existing per-task lock or a minimal single-owner mechanism. Coordinate teardown with that lock/cancellation state. No new database or event bus.

## 10. Herdr presentation and steering

Reuse Firstmate's existing Herdr context discovery and explicit workspace/pane targeting. Do not assume an environment variable or pane-ID format without inspecting the checkout and installed CLI.

- Create one clearly labeled tab or pane in the captain's workspace.
- Run the direct interactive Vercel exec command attaching to remote tmux.
- Never use a viewer option that stops the sandbox on disconnect.
- No shell-profile auto-attach changes, Expect, PTY library, SSH server, or plugin lifecycle integration.
- Persist exact viewer identifiers for best-effort cleanup.
- A simple task label is sufficient. Semantic badges are optional only if an existing helper makes them trivial.
- Closing the viewer does not affect the watcher or sandbox.
- Provide a manual attach command for a still-running task. Refuse attach to a stopped/completed task in this MVP rather than resuming it implicitly.

For orchestrator capture, use remote tmux capture with bounded output and no implicit resume. For send, transmit literal text safely, then submit separately. Do not interpolate untrusted text into shell code. Never automatically retry an ambiguous send, which could duplicate input. If existing `fm-send` requires a durable local inbox, refuse that path and document direct human interaction instead.

## 11. Metadata, cancellation, and teardown

Use the existing metadata format. Add only the fields required to identify and reconcile the worker:

```text
backend, task_id, run_id
provider team/project scope, sandbox name, session identity
base name, remote repository path
GitHub repository, base branch/SHA, worker branch
harness, tmux session, remote run directory
watcher identity, deadline, delivery state, cleanup state
optional Herdr workspace/tab/pane IDs
```

Remote paths are not local directories. Guard all local Git, worktree validation, return, cleanup, and status-inspection paths. Introduce one small backend capability helper if that avoids repeated special cases; avoid a general filesystem abstraction.

Cancellation/teardown must:

1. Follow existing Firstmate delivery checks and explicit cancellation rules.
2. Acquire task coordination, record cancellation/teardown, and stop the watcher so it cannot issue another remote command.
3. Stop/delete only the recorded worker in the recorded scope. Never delete the shared base.
4. Treat an already absent worker as successful cleanup; treat transport/auth errors as unresolved cleanup.
5. Close the exact viewer best-effort.
6. Remove active metadata only after confirmed cloud cleanup. Retain local delivery evidence under normal project conventions.

Teardown must be retryable. Test “one successful deletion effect,” not “exactly one API invocation,” since retries and already-absent resources are normal.

## 12. Runtime and resource limits

Set a finite provider timeout explicitly, compatible with the operator's plan; 30 minutes is a reasonable initial test default, not a promise that real tasks finish within it. Record the deadline and document how to choose a supported duration.

Ensure the viewer does not renew the timeout indefinitely. A local timer is insufficient while the Mac sleeps. If the installed transport cannot satisfy this, report that limitation explicitly and do not claim bounded detached execution.

The Mac must remain awake for prompt completion reporting in this MVP. Workers can continue while disconnected until the provider limit. Persistent filesystem storage may remain billable after compute stops; explicit teardown removes workers when appropriate. Recovery after laptop restart is future work.

## 13. Focused verification

Write tests with the changes; do not defer all testing to the end. Mock SDK/CLI/GitHub/Herdr calls so automated tests allocate no real resources.

Required coverage:

1. Explicit registration, no auto-detection, unsupported modes fail before allocation.
2. No local worktree creation, local remote-path inspection, or Treehouse cleanup.
3. Missing base snapshot refuses spawn; spawn never mutates the base.
4. Exact scope/run/sandbox/branch metadata persisted; partial spawn failure retains cleanup identity.
5. Valid result produces ordinary completion once; wrong run, repository, branch, or SHA is rejected.
6. Marker wins over tmux absence; transient transport errors remain unknown.
7. Stopped or terminal tasks cause no execution probes/implicit agent restart; changed session is handled as interruption.
8. Viewer creation failure and viewer closure do not terminate execution.
9. Stop/delete failures preserve retryable metadata; repeated teardown is safe; base is never deleted.
10. Literal send handling, if implemented, survives quotes/newlines without shell evaluation.

Run relevant existing backend/spawn/supervision/teardown tests. Broaden only if a changed integration path creates a concrete regression risk.

One live direct-PR smoke test must demonstrate:

- Spawn a harmless change from Firstmate inside Herdr.
- See and interact with the real remote agent.
- Close and reattach the viewer while the worker continues.
- Agent pushes a branch and opens a PR; result is verified locally.
- Ordinary Firstmate completion wakes Pi through the existing path.
- Worker stops; a later status check does not restart it.
- Teardown removes the worker and leaves the base intact.
- Local processes show connection/orchestration clients, not the heavy coding worker.

Do not merge the smoke-test PR automatically. A second harness needs its own authenticated launch check before being described as verified, but not a duplicate full PR smoke unless behavior differs.

## 14. Session sequence and stopping rule

Implement sequentially; parallel agents are unnecessary for this tightly coupled slice.

| Phase | Exit evidence |
| --- | --- |
| A. Inspect checkout and prove primitives | Actual integration points, API versions, authentication/attach feasibility |
| B. Backend spawn and metadata | Isolated worker runs; failures remain cleanable; focused tests |
| C. Completion and lifecycle | Verified PR reaches existing status/wake path; stop is final for polling |
| D. Herdr viewer | Interactive attachment and disconnect survival |
| E. Regression and live smoke | Tests pass; evidence recorded; concise setup/recovery docs |

If time gets tight, cut the second harness, scouts, semantic badges, and automatic preparation wrappers. Do not cut timeout behavior, exact cleanup identity, completion validation, or basic lifecycle tests. Do not implement future features before the complete required path works.

If live verification is blocked, finish authorized code, tests, and documentation, then report exactly what remains unverified. Do not label mocked integration as a working live MVP.

## 15. Future suggestions — do not implement this session

- Scout report collection: reuse the result protocol with a bounded downloaded report.
- Full Claude/Codex parity if the first session proves only one.
- Durable remote steering inbox and message acknowledgments.
- Restart reconciliation, explicit resume/relaunch, and automatic viewer recovery.
- Rich Herdr agent states and activity metadata.
- Automatic base refresh, dependency snapshots, invalidation, and authentication renewal.
- General execution/presentation separation and remote filesystem/workspace capabilities.
- Additional task modes, secondmates, and harnesses.
- Event-driven supervision, shared watcher optimization after measurement.
- Ephemeral scoped GitHub credentials, spend budgets, concurrency controls, other cloud backends.

## 16. Required handoff from the implementation agent

Report changed files, exact setup/spawn/attach/teardown commands, supported harnesses, tests executed, live smoke evidence, and any remaining limitations. Separate delivered PR status from cloud cleanup status. List any resources deliberately retained, including the prepared base.

## Reference material

These sources were checked during the preceding review. Recheck the installed versions and current API contracts before implementation; repository internals were not fully inspected during planning.

- [Firstmate repository](https://github.com/kunchenguid/firstmate)
- [Vercel Sandbox JavaScript SDK](https://vercel.com/docs/sandbox/sdk-reference): fork uses the current snapshot and inherits configuration; verify installed signatures.
- [Vercel persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes): filesystem snapshots, sessions, and automatic resume.
- [Vercel CLI reference](https://vercel.com/docs/sandbox/cli-reference): interactive command execution and lifecycle commands.
- [Official Herdr integration](https://vercel.com/docs/sandbox/ecosystem/herdr): useful terminal/authentication precedent; its patch-apply lifecycle is not this plan's direct-PR contract.
- [Herdr socket API](https://herdr.dev/docs/socket-api/): confirm exact current pane/workspace operations.

