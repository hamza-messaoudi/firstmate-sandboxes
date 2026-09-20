#!/usr/bin/env node
// Explicit Vercel execution primitives. SDK and credentials remain backend-local.
// CLI is entered through ../backends/vercel.sh, which owns record serialization.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export async function saveRecord(path, record) {
  const text = Object.entries(record).map(([key, value]) => {
    if (!/^[a-z_]+$/.test(key) || /[\r\n\0]/.test(String(value))) throw new Error('invalid record');
    return `${key}=${value}\n`;
  }).join('');
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
export async function readRecord(path) {
  const record = {};
  for (const line of (await readFile(path, 'utf8')).trim().split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) throw new Error('invalid record');
    record[line.slice(0, at)] = line.slice(at + 1);
  }
  return record;
}

const REPO_PATH = '/vercel/sandbox/repo';
const REQUEST_MS = 20000;
const OUTPUT_BYTES = 32768;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
const signal = () => AbortSignal.timeout(REQUEST_MS);
const missing = error => error?.status === 404 || error?.statusCode === 404 || error?.response?.status === 404;
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function safeText(value) { return typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value); }

export function configuration(config, env) {
  requireThat(config.backend === 'vercel', 'explicit backend=vercel required');
  requireThat(config.mode === 'ship' && config.delivery === 'direct-PR' && config.harness === 'codex',
    'only ship/direct-PR/codex is supported');
  requireThat(validId(config.task_id) && config.task_id.length <= 30, 'invalid task identity');
  for (const key of ['base_name', 'team_id', 'project_id']) requireThat(validId(config[key]), `invalid ${key}`);
  requireThat(Number.isInteger(config.timeout_ms) && config.timeout_ms >= 60000 && config.timeout_ms <= 1800000,
    'timeout_ms must be finite, between 60000 and 1800000');
  requireThat(safeText(config.git_author_name) && safeText(config.git_author_email), 'Git author required');
  requireThat(env.VERCEL_TOKEN && env.GH_TOKEN, 'VERCEL_TOKEN and GH_TOKEN environment credentials required');
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(config.origin || '');
  requireThat(match && !match[1].split('/').some(part => part === '.' || part === '..'), 'ordinary GitHub origin required');
  return { ...config, repository: match[1] };
}

export function completionSource(record) {
  // No credentials or local orchestration paths are embedded in the remote helper.
  const identity = JSON.stringify({ version: 1, task_id: record.task_id, run_id: record.run_id,
    kind: 'direct-PR', branch: record.branch });
  return `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
const result = ${identity};
const directory = ${JSON.stringify(record.remote_run_dir)};
const git = (...args) => execFileSync('git', args, { cwd: ${JSON.stringify(REPO_PATH)}, encoding: 'utf8' }).trim();
if (git('branch', '--show-current') !== result.branch) throw Error('wrong branch');
result.head_sha = git('rev-parse', 'HEAD');
result.pr_url = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(result.head_sha) || !result.pr_url?.startsWith(${JSON.stringify(`https://github.com/${record.repository}/pull/`)})) throw Error('invalid result');
const suffix = result.pr_url.slice(${JSON.stringify(`https://github.com/${record.repository}/pull/`)}.length);
if (!/^[1-9][0-9]*$/.test(suffix)) throw Error('invalid PR URL');
const text = JSON.stringify(result) + '\\n';
if (Buffer.byteLength(text) > 4096) throw Error('result too large');
const temp = directory + '/result.' + process.pid + '.tmp';
writeFileSync(temp, text, { mode: 0o600 });
renameSync(temp, directory + '/result.json');
writeFileSync(directory + '/done.tmp', '', { mode: 0o600 });
renameSync(directory + '/done.tmp', directory + '/done');
`;
}

// The SDK retries network/429/5xx failures even for POSTs. Its fetch seam must
// fail with AbortError to prevent replay of an ambiguously accepted mutation.
export function singleAttemptFetch(fetcher) {
  return async (...args) => {
    try {
      const response = await fetcher(...args);
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        throw new Error('ambiguous provider response');
      }
      return response;
    } catch {
      throw new DOMException('provider request failed; no automatic retry', 'AbortError');
    }
  };
}

export function createExecution({ sdk, env = process.env, fetcher = fetch, providerFetch = fetch, clock = Date.now,
  uuid = randomUUID, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const transport = singleAttemptFetch(providerFetch);
  const credentials = record => {
    requireThat(env.VERCEL_TOKEN, 'VERCEL_TOKEN environment credential required');
    return { token: env.VERCEL_TOKEN, teamId: record.team_id, projectId: record.project_id, fetch: transport };
  };
  const get = (record, name) => sdk.Sandbox.get({ ...credentials(record), name, resume: false, signal: signal() });
  async function github(path) {
    const response = await fetcher(`https://api.github.com/repos/${path}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: signal(),
    });
    requireThat(response.ok, 'GitHub preflight failed');
    return response.json();
  }
  async function preflight(input) {
    const config = configuration(input, env);
    const repo = await github(config.repository);
    requireThat(safeText(repo.default_branch), 'GitHub default branch missing');
    const commit = await github(`${config.repository}/commits/${encodeURIComponent(repo.default_branch)}`);
    requireThat(/^[a-f0-9]{40}$/.test(commit.sha), 'GitHub commit invalid');
    const base = await get(config, config.base_name);
    requireThat(base.status === 'stopped' && base.currentSnapshotId, 'base must be stopped with a current snapshot');
    const snapshot = await sdk.Snapshot.get({ ...credentials(config), snapshotId: base.currentSnapshotId, signal: signal() });
    requireThat(snapshot.status === 'created' && (!snapshot.expiresAt || +snapshot.expiresAt > clock()), 'base snapshot unavailable');
    return { config, base, base_branch: repo.default_branch, base_sha: commit.sha, snapshot_id: base.currentSnapshotId };
  }
  function identity(record, sandbox) {
    requireThat(record.backend === 'vercel' && validId(record.run_id) && validId(record.task_id) &&
      validId(record.team_id) && validId(record.project_id) && validId(record.base_name) &&
      record.sandbox_name === `fm-${record.task_id}-${record.run_id}` && record.sandbox_name !== record.base_name,
    'unsafe cleanup identity');
    requireThat(sandbox.name === record.sandbox_name && sandbox.tags?.fm_run === record.run_id &&
      sandbox.tags?.fm_task === record.task_id, 'provider identity mismatch');
  }
  async function worker(record) {
    // Validate local identity before *any* provider access, including destructive retries.
    identity(record, { name: record.sandbox_name, tags: { fm_run: record.run_id, fm_task: record.task_id } });
    const sandbox = await get(record, record.sandbox_name);
    identity(record, sandbox);
    return sandbox;
  }
  async function session(record) {
    requireThat(record.delivery_state === 'running' || record.delivery_state === 'initializing', 'task is terminal or cancelled');
    requireThat(Number(record.deadline) > clock(), 'worker deadline expired');
    const sandbox = await worker(record);
    requireThat(sandbox.status === 'running', 'worker interrupted: sandbox is not running');
    const current = sandbox.currentSession();
    requireThat(current?.sessionId === record.session_id, 'worker interrupted: session changed');
    // Session methods target one VM and never use Sandbox's auto-resume wrapper.
    return current;
  }
  async function command(record, cmd, args, options = {}) {
    const current = await session(record);
    const result = await current.runCommand({ cmd, args, timeoutMs: REQUEST_MS, signal: signal(), ...options });
    requireThat(result.exitCode === 0, 'remote command failed');
    return result;
  }
  async function stopAllocated(record) {
    const sandbox = await worker(record);
    await sandbox.stop({ signal: signal() });
  }
  async function spawn(path, input, brief) {
    try { await readFile(path); throw new Error('record already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    requireThat(typeof brief === 'string' && Buffer.byteLength(brief) <= 65536 && !brief.includes('\0'), 'invalid task brief');
    const { config, base_branch, base_sha, snapshot_id } = await preflight(input);
    const run_id = uuid().replaceAll('-', '');
    requireThat(/^[a-f0-9]{32}$/.test(run_id), 'invalid run ID');
    const record = { backend: 'vercel', task_id: config.task_id, run_id, team_id: config.team_id,
      project_id: config.project_id, sandbox_name: `fm-${config.task_id}-${run_id}`, base_name: config.base_name,
      base_snapshot: snapshot_id, repository: config.repository, base_branch, base_sha,
      branch: `fm/${config.task_id}-${run_id}`, harness: config.harness, tmux_session: `fm-${run_id}`,
      remote_repo: REPO_PATH, remote_run_dir: `/vercel/sandbox/firstmate/${run_id}`,
      deadline: clock() + config.timeout_ms, delivery_state: 'allocating', cleanup_state: 'pending' };
    await saveRecord(path, record);
    try {
      let sandbox;
      try {
        sandbox = await sdk.Sandbox.fork({ ...credentials(record), sourceSandbox: record.base_name,
          name: record.sandbox_name, timeout: config.timeout_ms, env: { GH_TOKEN: env.GH_TOKEN },
          tags: { fm_run: run_id, fm_task: record.task_id }, signal: signal() });
      } catch {
        // A timeout may follow successful allocation. Recover only the exact intent;
        // never create again. If lookup also fails, retain intent for explicit cleanup.
        sandbox = await worker(record);
      }
      identity(record, sandbox);
      record.session_id = sandbox.currentSession()?.sessionId || '';
      record.delivery_state = 'initializing';
      await saveRecord(path, record);
      requireThat(sandbox.sourceSnapshotId === snapshot_id, 'fork did not use validated base snapshot');
      requireThat(record.session_id && sandbox.status === 'running', 'fork has no running session');
      // Verify actual worker binaries before repository setup. The stopped base is never executed.
      await command(record, 'sh', ['-ceu', 'for tool in git gh tmux node codex; do command -v "$tool" >/dev/null; done']);
      const setup = `set -eu
umask 077
git config --global credential.https://github.com.helper '!gh auth git-credential'
git config --global user.name ${quote(config.git_author_name)}
git config --global user.email ${quote(config.git_author_email)}
test ! -e ${quote(REPO_PATH)}
git clone --no-checkout ${quote(`https://github.com/${record.repository}.git`)} ${quote(REPO_PATH)}
cd ${quote(REPO_PATH)}
existing=$(git ls-remote --heads origin ${quote(record.branch)})
test -z "$existing"
git fetch origin ${quote(base_sha)}
git checkout -b ${quote(record.branch)} ${quote(base_sha)}
mkdir -p ${quote(record.remote_run_dir)}
rm -f ${quote(record.remote_run_dir + '/done')} ${quote(record.remote_run_dir + '/result.json')}
`;
      await command(record, 'sh', ['-ceu', setup]);
      const remoteBrief = `You are an autonomous implementation worker. Work in ${REPO_PATH} on branch ${record.branch}.
Run ID: ${run_id}. Repository: ${record.repository}. Base branch: ${base_branch}.
Implement and test the task, commit, push this branch, and open a direct PR against the recorded base.
After a successful push and PR creation, run: node ${record.remote_run_dir}/complete.mjs <full-PR-URL>
Do not merge. Do not run local Firstmate supervision or use local orchestration hooks.
\nTask:\n${brief}\n`;
      const launch = `#!/bin/sh\nset -eu\ncd ${quote(REPO_PATH)}\nexec codex --dangerously-bypass-approvals-and-sandbox "$(cat ${quote(record.remote_run_dir + '/brief.md')})"\n`;
      const current = await session(record);
      await current.writeFiles([
        { path: `${record.remote_run_dir}/brief.md`, content: remoteBrief, mode: 0o600 },
        { path: `${record.remote_run_dir}/complete.mjs`, content: completionSource(record), mode: 0o600 },
        { path: `${record.remote_run_dir}/launch.sh`, content: launch, mode: 0o700 },
      ], { signal: signal() });
      await command(record, 'tmux', ['new-session', '-d', '-s', record.tmux_session, '-c', REPO_PATH,
        `sh ${quote(record.remote_run_dir + '/launch.sh')}`]);
      await command(record, 'tmux', ['has-session', '-t', `=${record.tmux_session}`]);
      record.delivery_state = 'running';
      await saveRecord(path, record);
      return record;
    } catch {
      record.delivery_state = 'failed';
      record.failure = 'spawn failed; inspect cleanup state';
      try { await stopAllocated(record); record.cleanup_state = 'stopped'; }
      catch { record.cleanup_state = 'unresolved'; }
      await saveRecord(path, record);
      throw new Error('spawn failed; cleanup identity retained');
    }
  }
  async function inspect(record) {
    if (!['running', 'initializing', 'allocating'].includes(record.delivery_state)) return { state: record.delivery_state };
    try {
      const sandbox = await worker(record);
      if (sandbox.status !== 'running') return { state: 'interrupted', provider_state: sandbox.status };
      if (sandbox.currentSession()?.sessionId !== record.session_id) return { state: 'interrupted', reason: 'session changed' };
      if (Number(record.deadline) <= clock()) return { state: 'interrupted', reason: 'deadline expired' };
      return { state: 'running' };
    } catch (error) { return { state: missing(error) ? 'missing' : 'unknown' }; }
  }
  async function capture(record, lines = 100) {
    requireThat(Number.isInteger(lines) && lines >= 1 && lines <= 200, 'capture lines must be 1..200');
    // Bound remotely before SDK buffers stdout; tmux history may contain huge lines.
    const result = await command(record, 'sh', ['-ceu',
      `tmux capture-pane -p -t ${quote('=' + record.tmux_session)} -S -${lines} | tail -c ${OUTPUT_BYTES}`]);
    const output = await result.stdout();
    return Buffer.from(output).subarray(-OUTPUT_BYTES).toString('utf8');
  }
  async function send(record, text) {
    requireThat(typeof text === 'string' && Buffer.byteLength(text) <= 8192 && !text.includes('\0'), 'literal input must be at most 8192 bytes without NUL');
    // argv transport, literal flag, and separate submit. Never retry ambiguous input.
    await command(record, 'tmux', ['send-keys', '-t', `=${record.tmux_session}`, '-l', '--', text]);
    return { sent: true };
  }
  async function submit(record) {
    await command(record, 'tmux', ['send-keys', '-t', `=${record.tmux_session}`, 'Enter']);
    return { submitted: true };
  }
  async function cleanup(path, operation) {
    requireThat(operation === 'stop' || operation === 'delete', 'invalid cleanup operation');
    const record = await readRecord(path);
    // Cancellation is durable before provider IO. Existing watchers reread this record.
    identity(record, { name: record.sandbox_name, tags: { fm_run: record.run_id, fm_task: record.task_id } });
    record.delivery_state = 'cancelled';
    record.cleanup_state = 'pending';
    await saveRecord(path, record);
    try {
      const sandbox = await worker(record);
      if (operation === 'stop') await sandbox.stop({ signal: signal() });
      else await sandbox.delete({ signal: signal(), deleteOrphanSnapshots: true });
      record.cleanup_state = operation === 'stop' ? 'stopped' : 'deleted';
    } catch (error) {
      record.cleanup_state = missing(error) ? 'absent' : 'unresolved';
    }
    await saveRecord(path, record);
    requireThat(record.cleanup_state !== 'unresolved', 'cleanup unresolved; record retained for retry');
    return record;
  }
  async function watch(path, emit, interval = 10000) {
    requireThat(Number.isInteger(interval) && interval >= 1000 && interval <= 60000, 'watch interval must be 1000..60000');
    while (true) {
      const record = await readRecord(path);
      const observation = await inspect(record);
      emit(observation);
      if (observation.state !== 'running' && observation.state !== 'unknown') return;
      if (Number(record.deadline) <= clock()) return;
      await sleep(Math.min(interval, Math.max(0, Number(record.deadline) - clock())));
    }
  }
  return { preflight, spawn, inspect, capture, send, submit, cleanup, watch };
}

async function main() {
  const [operation, path, ...args] = process.argv.slice(2);
  requireThat(path && ['doctor', 'spawn', 'inspect', 'capture', 'send', 'submit', 'watch', 'stop', 'delete'].includes(operation), 'use bin/backends/vercel.sh --backend vercel <operation> <record>');
  const sdk = await import('@vercel/sandbox');
  const execution = createExecution({ sdk });
  const json = result => process.stdout.write(JSON.stringify(result) + '\n');
  if (operation === 'doctor') {
    const result = await execution.preflight(JSON.parse(await readFile(path, 'utf8')));
    json({ ready: true, base_snapshot: result.snapshot_id, base_sha: result.base_sha,
      tools: 'checked on fork before launch', live_agent_auth: 'unverified' });
  } else if (operation === 'spawn') {
    const result = await execution.spawn(path, JSON.parse(await readFile(args[0], 'utf8')), await readFile(args[1], 'utf8'));
    process.stderr.write('Worker starts from remote committed code; local changes are not included.\n');
    json(result);
  } else if (operation === 'watch') await execution.watch(path, json, args[0] === undefined ? 10000 : Number(args[0]));
  else if (operation === 'stop' || operation === 'delete') json(await execution.cleanup(path, operation));
  else {
    const record = await readRecord(path);
    if (operation === 'capture') process.stdout.write(await execution.capture(record, args[0] === undefined ? 100 : Number(args[0])));
    else if (operation === 'send') {
      let text = '';
      for await (const chunk of process.stdin) {
        text += chunk.toString('utf8');
        requireThat(Buffer.byteLength(text) <= 8192, 'input too large');
      }
      json(await execution.send(record, text));
    } else json(await execution[operation](record));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // SDK/remote errors may contain request headers, tokens, command output, or URLs.
    process.stderr.write('Vercel operation failed. Check configuration, credentials, and retained cleanup record.\n');
    process.exitCode = 1;
  });
}
