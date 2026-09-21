import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRecord, readRecord, quote } from '../bin/vercel/fm-vercel.mjs';
test('private atomic metadata roundtrip, preserves equals and rejects newlines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fm-vercel-'));
  try {
    const path = join(dir, 'task.meta');
    await saveRecord(path, { backend: 'vercel', run_id: 'one=two' });
    assert.equal((await readRecord(path)).run_id, 'one=two');
    await assert.rejects(saveRecord(path, { run_id: 'bad\nvalue' }));
    assert.match(await readFile(path, 'utf8'), /one=two/);
    assert.equal(quote("a'b"), "'a'\\''b'");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { createExecution, completionSource, singleAttemptFetch } from '../bin/vercel/fm-vercel.mjs';
import { writeFile, stat } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
const config = { backend: 'vercel', mode: 'ship', delivery: 'direct-PR', harness: 'codex', task_id: 'test',
  base_name: 'prepared', team_id: 'team_test', project_id: 'prj_test', timeout_ms: 60000,
  git_author_name: 'Test', git_author_email: 'test@example.test', origin: 'git@github.com:owner/repo.git' };
const env = { VERCEL_TOKEN: 'control-secret', GH_TOKEN: 'worker-secret' };
const sha = 'a'.repeat(40);
const run = 'b'.repeat(32);
async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fm-vercel-'));
  const path = join(dir, 'task.meta');
  const calls = [];
  let sandbox;
  let now = 1000;
  const base = { name: 'prepared', status: 'stopped', currentSnapshotId: 'snap_base', ...options.base };
  const session = { sessionId: 'session_one',
    async runCommand(params) {
      calls.push(['command', params]);
      if (options.commandFails) throw new Error('worker-secret');
      return { exitCode: options.exitCode || 0, stdout: async () => options.stdout || 'screen\n' };
    },
    async writeFiles(files) { calls.push(['files', files]); if (options.writeFails) throw Error('upload'); },
  };
  const sdk = { Sandbox: {
    async get(params) {
      calls.push(['get', params]);
      assert.equal(params.resume, false);
      assert.ok(params.signal instanceof AbortSignal);
      if (params.name === 'prepared') return base;
      if (options.getFails) throw options.getFails;
      if (!sandbox) throw Object.assign(new Error('not found'), { status: 404 });
      return sandbox;
    },
    async fork(params) {
      calls.push(['fork', params]);
      const intent = await readRecord(path);
      assert.equal(intent.delivery_state, 'allocating');
      assert.equal(intent.sandbox_name, params.name);
      sandbox = { name: params.name, tags: params.tags, sourceSnapshotId: options.wrongSnapshot ? 'other' : 'snap_base',
        status: 'running', currentSession: () => session,
        async stop() { calls.push(['stop', sandbox.name]); if (options.stopFails) throw Error('stop'); sandbox.status = 'stopped'; },
        async delete() { calls.push(['delete', sandbox.name]); if (options.deleteFails) throw Error('delete'); sandbox = undefined; },
      };
      if (options.forkFails) throw Error('ambiguous network outcome');
      return sandbox;
    },
  }, Snapshot: { async get(params) {
    calls.push(['snapshot', params]); return { status: 'created', ...options.snapshot };
  } } };
  const execution = createExecution({ sdk, env: options.env || env, clock: () => now, uuid: () => run,
    sleep: async ms => { now += ms; if (options.onSleep) await options.onSleep(path); },
    fetcher: async (url, request) => {
      calls.push(['github', url, request]);
      return { ok: !options.githubFails, json: async () => url.includes('/pulls/') ? options.pr : url.includes('/commits/') ? { sha } : { default_branch: 'main' } };
    },
  });
  return { path, dir, calls, execution, session, options, get sandbox() { return sandbox; },
    async spawn(overrides = {}) { return execution.spawn(path, { ...config, ...overrides }, 'Make the harmless change.'); },
    async dispose() { await rm(dir, { recursive: true, force: true }); } };
}
async function using(options, body) {
  const f = await fixture(options);
  try { await body(f); } finally { await f.dispose(); }
}

test('doctor validates credentials, remote revision and stopped current snapshot without allocation', () => using({}, async f => {
  const result = await f.execution.preflight(config);
  assert.equal(result.config.repository, 'owner/repo');
  assert.equal(result.base_sha, sha);
  assert.equal(result.base_branch, 'main');
  assert.equal(result.snapshot_id, 'snap_base');
  assert.equal(f.calls.filter(([kind]) => kind === 'fork' || kind === 'command').length, 0);
}));
for (const [name, change] of Object.entries({ implicit: { backend: undefined }, scout: { mode: 'scout' },
  local: { delivery: 'local-only' }, harness: { harness: 'claude' }, identity: { task_id: '../bad' },
  timeout: { timeout_ms: Infinity }, origin: { origin: 'https://user:password@github.com/owner/repo' } })) {
  test(`unsupported ${name} fails before network/allocation`, () => using({}, async f => {
    await assert.rejects(f.spawn(change));
    assert.equal(f.calls.length, 0);
    await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  }));
}
for (const options of [{ env: {} }, { base: { status: 'running' } }, { base: { currentSnapshotId: undefined } },
  { snapshot: { status: 'deleted' } }, { snapshot: { expiresAt: new Date(1) } }, { githubFails: true }]) {
  test(`preflight rejects ${JSON.stringify(options)} without fork`, () => using(options, async f => {
    await assert.rejects(f.spawn());
    assert.equal(f.calls.filter(([kind]) => kind === 'fork').length, 0);
  }));
}

test('spawn persists exact identity, finite timeout and worker-only environment; remote setup launches tmux', () => using({}, async f => {
  const record = await f.spawn();
  assert.equal(record.delivery_state, 'running');
  assert.equal(record.session_id, 'session_one');
  assert.equal(record.remote_repo, '/vercel/sandbox/repo');
  assert.equal(record.branch, `fm/test-${run}`);
  assert.equal(record.base_sha, sha);
  assert.equal(record.deadline, 61000);
  assert.equal(record.team_id, config.team_id);
  assert.equal(record.project_id, config.project_id);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const raw = await readFile(f.path, 'utf8');
  assert.ok(!raw.includes('secret'));
  const fork = f.calls.find(([kind]) => kind === 'fork')[1];
  assert.deepEqual(fork.env, { GH_TOKEN: env.GH_TOKEN });
  assert.equal(fork.timeout, 60000);
  assert.equal(fork.sourceSandbox, 'prepared');
  const commands = f.calls.filter(([kind]) => kind === 'command').map(([, command]) => command);
  assert.ok(commands.some(c => c.cmd === 'tmux' && c.args[0] === 'new-session'));
  assert.ok(commands.some(c => c.cmd === 'tmux' && c.args[0] === 'has-session'));
  assert.ok(commands.every(c => c.signal instanceof AbortSignal && c.timeoutMs === 20000));
  const setup = commands.find(c => c.args?.[1]?.includes('git clone')).args[1];
  assert.match(setup, /gh auth git-credential/);
  assert.match(setup, /git ls-remote/);
  assert.ok(!setup.includes('worker-secret'));
  const files = f.calls.find(([kind]) => kind === 'files')[1];
  assert.equal(files.length, 3);
  assert.ok(files.every(file => file.path.startsWith(record.remote_run_dir + '/')));
  assert.ok(!JSON.stringify(files).includes('control-secret'));
  assert.equal(f.calls.filter(([kind]) => kind === 'stop' || kind === 'delete').length, 0);
  await assert.rejects(f.spawn(), /record already exists/);
}));

test('ambiguous allocation recovers exact intended name without a second fork', () => using({ forkFails: true }, async f => {
  const record = await f.spawn();
  assert.equal(record.delivery_state, 'running');
  assert.equal(f.calls.filter(([kind]) => kind === 'fork').length, 1);
  assert.ok(f.calls.some(([kind, params]) => kind === 'get' && params.name === record.sandbox_name));
}));
for (const options of [{ commandFails: true }, { writeFails: true }, { wrongSnapshot: true }, { commandFails: true, stopFails: true }]) {
  test(`partial spawn retains identity and stops exact worker: ${JSON.stringify(options)}`, () => using(options, async f => {
    await assert.rejects(f.spawn(), /cleanup identity retained/);
    const record = await readRecord(f.path);
    assert.equal(record.delivery_state, 'failed');
    assert.equal(record.sandbox_name, `fm-test-${run}`);
    assert.equal(record.cleanup_state, options.stopFails ? 'unresolved' : 'stopped');
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'stop'), [['stop', record.sandbox_name]]);
    assert.ok(!(await readFile(f.path, 'utf8')).includes('secret'));
  }));
}

test('stopped, changed-session, and terminal records never execute or resume', () => using({}, async f => {
  const record = await f.spawn();
  f.calls.length = 0;
  f.sandbox.status = 'stopped';
  assert.equal((await f.execution.inspect(record)).state, 'interrupted');
  await assert.rejects(f.execution.capture(record), /not running/);
  f.sandbox.status = 'running';
  f.session.sessionId = 'replacement';
  assert.equal((await f.execution.inspect(record)).state, 'interrupted');
  await assert.rejects(f.execution.send(record, 'hello'), /session changed/);
  const count = f.calls.length;
  assert.deepEqual(await f.execution.inspect({ ...record, delivery_state: 'cancelled' }), { state: 'cancelled' });
  assert.equal(f.calls.length, count);
  assert.equal(f.calls.filter(([kind]) => kind === 'command').length, 0);
}));

test('transport errors are unknown, confirmed absence is missing', () => using({}, async f => {
  const record = await f.spawn();
  f.options.getFails = Error('network');
  assert.deepEqual(await f.execution.inspect(record), { state: 'unknown' });
  f.options.getFails = Object.assign(Error('missing'), { response: new Response('', { status: 404 }) });
  assert.deepEqual(await f.execution.inspect(record), { state: 'missing' });
}));

test('capture validates bounds and limits bytes', () => using({ stdout: 'x'.repeat(40000) }, async f => {
  const record = await f.spawn();
  assert.equal(Buffer.byteLength(await f.execution.capture(record, 200)), 32768);
  await assert.rejects(f.execution.capture(record, 201));
  await assert.rejects(f.execution.capture(record, -1));
}));

test('literal quotes/newlines remain one argv value and submission is separate', () => using({}, async f => {
  const record = await f.spawn();
  f.calls.length = 0;
  const text = "'\"; $(touch /tmp/never)\n--help";
  await f.execution.send(record, text);
  const command = f.calls.find(([kind]) => kind === 'command')[1];
  assert.equal(command.cmd, 'tmux');
  assert.deepEqual(command.args, ['send-keys', '-t', `=${record.tmux_session}`, '-l', '--', text]);
  await f.execution.submit(record);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'command').at(-1)[1].args,
    ['send-keys', '-t', `=${record.tmux_session}`, 'Enter']);
  await assert.rejects(f.execution.send(record, '\0'));
  await assert.rejects(f.execution.send(record, 'a'.repeat(8193)));
}));

test('watch reuses client, re-reads cancellation, and performs no execution probes', () => using({
  onSleep: async path => { const record = await readRecord(path); record.delivery_state = 'cancelled'; await saveRecord(path, record); },
}, async f => {
  await f.spawn();
  f.calls.length = 0;
  const observations = [];
  await f.execution.watch(f.path, item => observations.push(item), 1000);
  assert.deepEqual(observations, [{ state: 'running' }, { state: 'cancelled' }]);
  assert.equal(f.calls.filter(([kind]) => kind === 'command').length, 0);
}));

test('watch exits at finite deadline even when provider is unreachable', () => using({}, async f => {
  await f.spawn();
  f.options.getFails = Error('network');
  const observations = [];
  await f.execution.watch(f.path, item => observations.push(item), 60000);
  assert.equal(observations.length, 2);
  assert.ok(observations.every(item => item.state === 'unknown'));
}));

test('stop/delete cancellation persists and repeated delete has one successful effect', () => using({}, async f => {
  const record = await f.spawn();
  assert.equal((await f.execution.cleanup(f.path, 'stop')).cleanup_state, 'stopped');
  assert.equal((await readRecord(f.path)).delivery_state, 'cancelled');
  assert.equal((await f.execution.cleanup(f.path, 'delete')).cleanup_state, 'deleted');
  assert.equal((await f.execution.cleanup(f.path, 'delete')).cleanup_state, 'absent');
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'delete'), [['delete', record.sandbox_name]]);
}));

test('failed cleanup preserves retryable metadata, never targets base', () => using({ deleteFails: true }, async f => {
  const record = await f.spawn();
  await assert.rejects(f.execution.cleanup(f.path, 'delete'), /record retained/);
  assert.equal((await readRecord(f.path)).cleanup_state, 'unresolved');
  f.options.deleteFails = false;
  assert.equal((await f.execution.cleanup(f.path, 'delete')).cleanup_state, 'deleted');
  assert.ok(f.calls.filter(([kind]) => kind === 'delete').every(([, name]) => name === record.sandbox_name));
}));

test('forged local identity and changed provider tags refuse destructive calls', () => using({}, async f => {
  const record = await f.spawn();
  await saveRecord(f.path, { ...record, sandbox_name: 'prepared' });
  await assert.rejects(f.execution.cleanup(f.path, 'delete'), /unsafe cleanup identity/);
  await saveRecord(f.path, record);
  f.sandbox.tags.fm_run = 'other';
  await assert.rejects(f.execution.cleanup(f.path, 'delete'), /cleanup unresolved/);
  assert.equal(f.calls.filter(([kind]) => kind === 'delete' || kind === 'stop').length, 0);
}));

test('adapter rejects implicit backend before loading provider SDK', () => {
  const result = spawnSync('bash', ['bin/backends/vercel.sh', 'doctor', '/unused'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

for (const operation of ['doctor', 'spawn']) {
  test(`${operation} validates missing credentials without the optional SDK`, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'fmv-')));
    try {
      // A standalone CLI copy has no adjacent optional SDK, even on SDK-enabled hosts.
      const helper = join(dir, 'fm-vercel.mjs');
      await writeFile(helper, await readFile(new URL('../bin/vercel/fm-vercel.mjs', import.meta.url)));
      const configPath = join(dir, 'config.json');
      const recordPath = join(dir, 'task.meta');
      await writeFile(configPath, JSON.stringify(config));
      const testEnv = { ...process.env };
      delete testEnv.VERCEL_TOKEN;
      delete testEnv.GH_TOKEN;
      const args = operation === 'doctor' ? [configPath] : [recordPath, configPath, join(dir, 'unused-brief')];
      const result = spawnSync(process.execPath, [helper, operation, ...args], { encoding: 'utf8', env: testEnv });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /VERCEL_TOKEN and GH_TOKEN environment credentials required/);
      assert.equal(result.stdout, '');
      await assert.rejects(readFile(recordPath), { code: 'ENOENT' });
      // Valid local input still hides SDK-loading/provider error details.
      const providerFailure = spawnSync(process.execPath, [helper, operation, ...args], {
        encoding: 'utf8', env: { ...testEnv, ...env },
      });
      assert.equal(providerFailure.status, 1);
      assert.equal(providerFailure.stderr,
        'Vercel operation failed. Check configuration, credentials, and retained cleanup record.\n');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('completion helper publishes a bounded structured result then marker; rejects wrong branch/URL', () => using({}, async f => {
  const bin = join(f.dir, 'fakebin');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), '#!/bin/sh\nif [ "$1" = branch ]; then printf "%s\\n" "$TEST_BRANCH"; else printf "%s\\n" "$TEST_SHA"; fi\n', { mode: 0o700 });
  const record = { task_id: 'test', run_id: run, repository: 'owner/repo', branch: `fm/test-${run}`, remote_run_dir: f.dir };
  // Run the generated executable with its fixed remote cwd mapped into this fixture.
  const helper = join(f.dir, 'complete.mjs');
  await writeFile(helper, completionSource(record).replaceAll('/vercel/sandbox/repo', f.dir));
  const testEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_BRANCH: record.branch, TEST_SHA: sha };
  execFileSync(process.execPath, [helper, 'https://github.com/owner/repo/pull/123'], { env: testEnv });
  const result = JSON.parse(await readFile(join(f.dir, 'result.json'), 'utf8'));
  assert.equal(result.run_id, run);
  assert.equal(result.head_sha, sha);
  assert.equal(result.branch, record.branch);
  assert.equal((await readFile(join(f.dir, 'done'))).length, 0);
  assert.notEqual(spawnSync(process.execPath, [helper, 'https://github.com/other/repo/pull/123'], { env: testEnv }).status, 0);
  assert.notEqual(spawnSync(process.execPath, [helper, 'https://github.com/owner/repo/pull/123'], { env: { ...testEnv, TEST_BRANCH: 'wrong' } }).status, 0);
}));

for (const status of [429, 500, 503]) {
  test(`provider transport prevents SDK replay after HTTP ${status}`, async () => {
    const transport = singleAttemptFetch(async () => new Response('untrusted error', { status }));
    await assert.rejects(transport('https://unused.test'), { name: 'AbortError' });
  });
}
test('provider transport sanitizes network failures and preserves confirmed absence', async () => {
  const transport = singleAttemptFetch(async () => { throw Error('control-secret'); });
  await assert.rejects(transport('https://unused.test'), error => error.name === 'AbortError' && !error.message.includes('secret'));
  assert.equal((await singleAttemptFetch(async () => new Response('', { status: 404 }))('https://unused.test')).status, 404);
});
test('literal send never retries an ambiguous remote command', () => using({}, async f => {
  const record = await f.spawn();
  f.calls.length = 0;
  f.options.commandFails = true;
  await assert.rejects(f.execution.send(record, 'hello'));
  assert.equal(f.calls.filter(([kind]) => kind === 'command').length, 1);
}));

test('installed optional SDK does not replay ambiguous fork requests', async t => {
  let Sandbox;
  try { ({ Sandbox } = await import('../bin/vercel/node_modules/@vercel/sandbox/dist/index.js')); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('optional SDK not installed; run npm ci --prefix bin/vercel to exercise SDK transport');
    return;
  }
  for (const failure of ['network', 429, 503]) {
    let calls = 0;
    await assert.rejects(Sandbox.fork({ token: 'mock', teamId: 'team_mock', projectId: 'prj_mock',
      sourceSandbox: 'prepared', name: 'worker', timeout: 60000,
      fetch: singleAttemptFetch(async () => {
        calls++;
        if (failure === 'network') throw Error('ambiguous');
        return new Response('', { status: failure });
      }),
    }));
    assert.equal(calls, 1);
  }
});

function resultValue(record) {
  return { version: 1, task_id: record.task_id, run_id: record.run_id, kind: 'direct-PR',
    branch: record.branch, head_sha: sha, pr_url: 'https://github.com/owner/repo/pull/123' };
}
function prValue(record) {
  return { html_url: 'https://github.com/owner/repo/pull/123', state: 'open',
    head: { repo: { full_name: record.repository }, ref: record.branch, sha },
    base: { repo: { full_name: record.repository }, ref: record.base_branch } };
}
test('result verifies GitHub before completion; marker wins over absent tmux', () => using({}, async f => {
  const record = await f.spawn();
  f.options.stdout = 'result\n' + JSON.stringify(resultValue(record));
  f.options.pr = prValue(record);
  assert.equal((await f.execution.result(record)).state, 'completed');
  assert.ok(f.calls.some(([kind, url]) => kind === 'github' && url.endsWith('/pulls/123')));
}));
for (const key of ['run_id', 'task_id', 'branch', 'head_sha', 'pr_url']) {
  test(`rejects mismatched result ${key}`, () => using({}, async f => {
    const record = await f.spawn();
    f.options.stdout = 'result\n' + JSON.stringify({ ...resultValue(record), [key]: 'wrong' });
    f.options.pr = prValue(record);
    assert.equal((await f.execution.result(record)).state, 'failed');
  }));
}
for (const key of ['repository', 'branch', 'sha', 'base']) {
  test(`rejects GitHub ${key} mismatch`, () => using({}, async f => {
    const record = await f.spawn();
    f.options.stdout = 'result\n' + JSON.stringify(resultValue(record));
    f.options.pr = prValue(record);
    if (key === 'repository') f.options.pr.head.repo.full_name = 'other/repo';
    if (key === 'branch') f.options.pr.head.ref = 'other';
    if (key === 'sha') f.options.pr.head.sha = 'c'.repeat(40);
    if (key === 'base') f.options.pr.base.ref = 'other';
    assert.equal((await f.execution.result(record)).state, 'failed');
  }));
}
test('transient GitHub failure is unknown and oversized result fails closed', () => using({}, async f => {
  const record = await f.spawn();
  f.options.stdout = 'result\n' + JSON.stringify(resultValue(record));
  f.options.githubFails = true;
  assert.equal((await f.execution.result(record)).state, 'unknown');
  f.options.stdout = 'result\n' + 'x'.repeat(4097);
  assert.equal((await f.execution.result(record)).state, 'failed');
}));
test('reconciliation preserves evidence and PR despite stop failure; event replay is exactly once', () => using({ stopFails: true }, async f => {
  const record = await f.spawn();
  f.options.stdout = 'result\n' + JSON.stringify(resultValue(record));
  f.options.pr = prValue(record);
  const notify = async (meta, line) => execFileSync('bash', ['bin/fm-vercel-event.sh', f.path, meta.run_id, line]);
  await f.execution.reconcile(f.path, notify, 1000);
  let saved = await readRecord(f.path);
  assert.equal(saved.delivery_state, 'completed');
  assert.equal(saved.cleanup_state, 'unresolved');
  assert.equal(saved.pr, resultValue(record).pr_url);
  assert.ok((await readRecord(f.path + '.evidence')).result);
  f.calls.length = 0;
  f.options.stopFails = false;
  await f.execution.reconcile(f.path, notify, 1000);
  assert.equal(f.calls.filter(([kind]) => kind === 'command').length, 0);
  assert.equal((await readFile(f.path.replace('.meta', '.status'), 'utf8')).trim().split('\n').length, 1);
  saved = await readRecord(f.path);
  assert.equal(saved.cleanup_state, 'stopped');
  await assert.rejects(f.execution.landed(saved));
  f.options.pr.merged = true;
  assert.deepEqual(await f.execution.landed(saved), { landed: true });
  await f.execution.cleanup(f.path, 'delete');
  assert.equal((await readRecord(f.path)).delivery_state, 'completed');
}));
test('cancel marker halts reconciliation before any provider request', () => using({}, async f => {
  await f.spawn();
  await writeFile(f.path + '.cancel', '');
  f.calls.length = 0;
  await f.execution.reconcile(f.path, () => assert.fail('notification after cancellation'), 1000);
  assert.equal(f.calls.length, 0);
}));
test('remote task metadata has no local worktree and crew-state does not probe local Git', () => using({}, async f => {
  const record = await f.spawn();
  assert.equal(record.worktree, '');
  assert.equal(record.endpoint_task_id, record.task_id);
  assert.equal(record.window, f.path);
  const output = execFileSync('bash', ['bin/fm-crew-state.sh', 'task'], {
    env: { ...process.env, FM_STATE_OVERRIDE: f.dir }, encoding: 'utf8' });
  assert.match(output, /state: working.*source: vercel/);
}));
test('backend registration is explicit and remote endpoint validation refuses local worktree', () => using({}, async f => {
  const record = await f.spawn();
  const invoke = () => spawnSync('bash', ['-c', '. bin/fm-backend.sh; fm_backend_validate_spawn vercel && fm_backend_validate_task_endpoint "$1" test', '_', f.path], { encoding: 'utf8' });
  assert.equal(invoke().status, 0);
  await saveRecord(f.path, { ...record, worktree: '/vercel/sandbox/repo' });
  assert.notEqual(invoke().status, 0);
}));

test('spawn entrypoint refuses unsupported modes before provider or worktree allocation', () => using({}, async f => {
  const { mkdir } = await import('node:fs/promises');
  const home = join(f.dir, 'home');
  await mkdir(join(home, 'state'), { recursive: true });
  await mkdir(join(home, 'data'), { recursive: true });
  await mkdir(join(home, 'config'), { recursive: true });
  for (const args of [ ['--scout'], ['--mode', 'local-only', '--yolo', 'off'],
    ['--mode', 'direct-PR', '--yolo', 'on'], ['--secondmate'] ]) {
    const output = spawnSync('bash', ['bin/fm-spawn.sh', 'remote-test', f.dir, '--backend', 'vercel', '--harness', 'codex', ...args], {
      env: { ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: process.cwd() }, encoding: 'utf8' });
    assert.notEqual(output.status, 0, output.stdout + output.stderr);
    assert.match(output.stderr, /Vercel.*(supports only|does not support)/);
    await assert.rejects(readFile(join(home, 'state', 'remote-test.meta')), { code: 'ENOENT' });
  }
}));
test('single watcher lock refuses a competing watcher before SDK loading', () => using({}, async f => {
  await f.spawn();
  const { mkdir } = await import('node:fs/promises');
  const lock = f.path + '.watch.lock';
  await mkdir(lock);
  await writeFile(join(lock, 'pid'), String(process.pid) + '\n');
  const output = spawnSync('bash', ['bin/backends/vercel.sh', '--backend', 'vercel', 'reconcile', f.path], { encoding: 'utf8' });
  assert.notEqual(output.status, 0);
  assert.match(output.stderr, /record busy/);
  assert.equal((await readFile(join(lock, 'pid'), 'utf8')).trim(), String(process.pid));
}));

test('spawn and teardown entrypoints retain cleanup identity on failure, avoid local worktrees', () => using({}, async f => {
  const { mkdir } = await import('node:fs/promises');
  const home = join(f.dir, 'home');
  const bin = join(f.dir, 'bin');
  for (const directory of [bin, join(home, 'state'), join(home, 'data/test'), join(home, 'config')]) await mkdir(directory, { recursive: true });
  await writeFile(join(home, 'config/backlog-backend'), 'manual\n');
  await writeFile(join(home, 'config/vercel.json'), JSON.stringify(config));
  await writeFile(join(home, 'data/test/brief.md'), '# Task\n## Captain\'s intent\nMake a harmless change.\n## Firstmate spec\nTest it.\n# Setup\nLOCAL SCAFFOLD MUST NOT TRAVEL\nDelivery contract: mode=direct-PR\n');
  const project = join(f.dir, 'project');
  await mkdir(project);
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['-C', project, 'remote', 'add', 'origin', config.origin]);
  const mock = join(f.dir, 'mock.mjs');
  const helperURL = new URL('../bin/vercel/fm-vercel.mjs', import.meta.url).href;
  await writeFile(mock, `import {readFile,appendFile} from 'node:fs/promises';
import {saveRecord,readRecord} from ${JSON.stringify(helperURL)};
const [op,path,...args]=process.argv.slice(2);
await appendFile(process.env.TEST_LOG,op+'\\n');
if(op==='spawn') {
const c=JSON.parse(await readFile(args[0],'utf8'));
const brief=await readFile(args[1],'utf8');
if(brief.includes('LOCAL SCAFFOLD')) throw Error('host scaffold leaked');
await saveRecord(path,{backend:'vercel',task_id:c.task_id,endpoint_task_id:c.task_id,window:path,worktree:'',project:c.local_project,kind:'ship',mode:'direct-PR',yolo:'off',harness:'codex',spawn_gen:'s123.4.5',run_id:'run',delivery_state:'running',cleanup_state:'pending'});
} else if(op==='reconcile') {
const r=await readRecord(path); await saveRecord(path,{...r,watcher_pid:process.pid});
} else if(op==='delete') {
if(process.env.TEST_DELETE_FAIL==='1') process.exit(1);
const r=await readRecord(path); await saveRecord(path,{...r,delivery_state:'cancelled',cleanup_state:'deleted'});
} else if(op==='landed') process.exit(1);
`);
  await writeFile(join(bin, 'node'), `#!/bin/bash\nif [[ "$1" == */vercel/fm-vercel.mjs ]]; then shift; exec ${quote(process.execPath)} ${quote(mock)} "$@"; fi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  for (const tool of ['treehouse', 'tmux']) await writeFile(join(bin, tool), '#!/bin/sh\necho LOCAL_ALLOCATION >> "$TEST_LOG"\nexit 99\n', { mode: 0o700 });
  const log = join(f.dir, 'calls');
  const testEnv = { ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: process.cwd(), FM_TEARDOWN_GUARD_DONE: '1', PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log };
  const spawned = spawnSync('bash', ['bin/fm-spawn.sh', 'test', project, '--backend', 'vercel', '--harness', 'codex', '--mode', 'direct-PR', '--yolo', 'off'], { env: testEnv, encoding: 'utf8' });
  assert.equal(spawned.status, 0, spawned.stdout + spawned.stderr);
  const meta = join(home, 'state/test.meta');
  assert.equal((await readRecord(meta)).worktree, '');
  const refused = spawnSync('bash', ['bin/fm-teardown.sh', 'test'], { env: testEnv, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not verified merged/);
  const failed = spawnSync('bash', ['bin/fm-teardown.sh', 'test', '--force'], { env: { ...testEnv, TEST_DELETE_FAIL: '1' }, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /cleanup unresolved/);
  assert.ok(await readRecord(meta));
  await assert.rejects(readFile(join(home, 'state/test.backlog-close')), { code: 'ENOENT' });
  const removed = spawnSync('bash', ['bin/fm-teardown.sh', 'test', '--force'], { env: testEnv, encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  await assert.rejects(readFile(meta), { code: 'ENOENT' });
  assert.equal((await readRecord(join(home, 'data/test/vercel-final.meta'))).cleanup_state, 'deleted');
  assert.ok(!(await readFile(log, 'utf8')).includes('LOCAL_ALLOCATION'));
}));

test('watcher update uses normal metadata serialization and preserves unrelated fields', () => using({}, async f => {
  const record = await f.spawn();
  await saveRecord(f.path, { ...record, unrelated: 'preserve' });
  const update = (patch) => spawnSync('bash', ['bin/backends/vercel.sh', '--backend', 'vercel', 'update', f.path], { input: JSON.stringify(patch), encoding: 'utf8' });
  assert.equal(update({ ...record, delivery_state: 'completed', unrelated: 'overwrite' }).status, 0);
  assert.equal((await readRecord(f.path)).unrelated, 'preserve');
  assert.equal((await readRecord(f.path)).delivery_state, 'completed');
  assert.notEqual(update({ ...record, run_id: 'wrong' }).status, 0);
}));
