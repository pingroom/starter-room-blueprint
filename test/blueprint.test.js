import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PingRoom } from '@pingroom/sdk';
import { runBlueprint, validateManifest } from '../src/blueprint.js';
import { acquireLock, readJson } from '../src/storage.js';
import { loadConnection, saveConnection } from '../src/config.js';
import { offlineClient, offlineManifest } from '../src/offline.js';
import { safeJson, errorSummary } from '../src/format.js';

async function fixture(t, mockOptions) {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { client, model } = offlineClient(mockOptions);
  const options = { client, root, token: 'offline-token', room: 'team' };
  return { root, model, options,
    run: (command, more = {}) => runBlueprint({ ...options, command, ...more }),
    plan: () => runBlueprint({ ...options, command: 'plan', manifest: offlineManifest }),
    state: () => readJson(join(root, 'state.json')),
    puts: () => model.calls.filter((call) => call.method === 'PUT'),
  };
}

test('plan uses real SDK read-only list routes, projects a diff, and binds a private saved plan', async (t) => {
  const f = await fixture(t);
  f.model.room.notifications = [{ message: 'do-not-persist-feed' }];
  const plan = await f.plan();
  assert.equal(plan.room, 'TEAM');
  assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.model.calls.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/api/agent/rooms' }, { method: 'GET', path: '/api/agent/rooms/TEAM/actions' },
  ]);
  assert.deepEqual(plan.changes[0].after, { label: 'Ready to review', icon: '👀' });
  const content = await readFile(join(f.root, 'state.json'), 'utf8');
  assert.ok(!content.includes('offline-token'));
  assert.ok(!content.includes('do-not-persist-feed'));
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.root, 'state.json'))).mode & 0o777, 0o600);
});

test('one exact transactional batch preserves sound/haptics, ack/input policy, other slots, and unknown fields', async (t) => {
  const f = await fixture(t, { count: 8 });
  f.model.actions[0].future_setting = 'untouched';
  const before = structuredClone(f.model.actions);
  const plan = await f.plan();
  const result = await f.run('apply', { hash: plan.plan_hash });
  assert.equal(result.status, 'applied');
  assert.equal(f.puts().length, 1);
  assert.deepEqual(f.puts()[0].body, { actions: [{ action_number: 1, label: 'Ready to review', icon: '👀', sound: 'default', haptic_style: 'light' }] });
  assert.deepEqual(f.model.actions.slice(1), before.slice(1));
  for (const key of ['id', 'sound', 'haptic_style', 'requires_ack', 'input_type', 'future_setting']) assert.equal(f.model.actions[0][key], before[0][key]);
  assert.equal((await f.state()).status, 'applied');
});

test('apply verifies exact hash and never reads a changed manifest', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  const count = f.model.calls.length;
  await assert.rejects(f.run('apply', { hash: '0'.repeat(64) }), /hash does not match/);
  assert.equal(f.model.calls.length, count);
  await f.run('apply', { hash: plan.plan_hash, manifest: { actions: [{ action_number: 1, label: 'Unreviewed', icon: '❌' }] } });
  assert.equal(f.model.actions[0].label, 'Ready to review');
});

test('changed action identity or unmanaged policy blocks the saved plan before PUT', async (t) => {
  for (const mutate of [
    (rows) => { rows[0].id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'; },
    (rows) => { rows[3].requires_ack = true; },
    (rows) => { rows[0].haptic_style = 'heavy'; },
  ]) {
    const f = await fixture(t);
    const plan = await f.plan();
    mutate(f.model.actions);
    await assert.rejects(f.run('apply', { hash: plan.plan_hash }), /changed after planning/);
    assert.equal(f.puts().length, 0);
    assert.equal((await f.state()).status, 'stale');
    const next = await f.plan();
    assert.notEqual(next.plan_hash, plan.plan_hash);
  }
});

test('an uncertain committed PUT is never retried; recovery reads desired state', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  f.model.mode = 'after-commit-loss';
  assert.equal((await f.run('apply', { hash: plan.plan_hash })).status, 'unknown');
  await assert.rejects(f.run('apply', { hash: plan.plan_hash }), /cannot be applied again/);
  await assert.rejects(f.plan(), /unresolved/);
  assert.equal((await f.run('recover')).status, 'applied');
  assert.equal(f.puts().length, 1);
  await assert.rejects(f.run('apply', { hash: plan.plan_hash }), /cannot be applied again/);
});

test('baseline recovery stays blocked until explicit local discard; no blind reapply', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  f.model.mode = 'before-commit-loss';
  await f.run('apply', { hash: plan.plan_hash });
  await assert.rejects(f.run('discard', { hash: plan.plan_hash }), /only after/);
  assert.equal((await f.run('recover')).status, 'baseline_observed');
  await assert.rejects(f.plan(), /unresolved/);
  await assert.rejects(f.run('apply', { hash: plan.plan_hash }), /cannot be applied again/);
  const calls = f.model.calls.length;
  assert.equal((await f.run('discard', { hash: plan.plan_hash })).status, 'abandoned');
  assert.equal(f.model.calls.length, calls);
  f.model.mode = 'normal';
  const next = await f.plan();
  assert.notEqual(next.plan_hash, plan.plan_hash);
  assert.equal(f.puts().length, 1);
});

test('read-only recovery classifies a conflicting remote edit without rollback', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  f.model.mode = 'after-commit-loss';
  await f.run('apply', { hash: plan.plan_hash });
  f.model.actions[2].label = 'Teammate edit';
  assert.equal((await f.run('recover')).status, 'conflict');
  assert.equal(f.model.actions[2].label, 'Teammate edit');
  assert.equal(f.puts().length, 1);
});

test('post-read failure preserves unknown outcome; subsequent recovery does not write', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  f.model.mode = 'fail-postread';
  assert.equal((await f.run('apply', { hash: plan.plan_hash })).status, 'unknown');
  await assert.rejects(f.run('recover'));
  assert.equal((await f.state()).status, 'unknown');
  f.model.mode = 'normal';
  assert.equal((await f.run('recover')).status, 'applied');
  assert.equal(f.puts().length, 1);
});

test('HTTP permission failure is conservatively journaled and cannot trigger a retry', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  f.model.mode = 'forbidden';
  const result = await f.run('apply', { hash: plan.plan_hash });
  assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('Private response'));
  assert.equal((await f.run('recover')).status, 'baseline_observed');
  assert.equal(f.puts().length, 1);
});

test('durable applying marker exists before PUT and survives a simulated interrupted invocation', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  f.model.hook = async (call) => { if (call.method === 'PUT') assert.equal((await f.state()).status, 'applying'); };
  await f.run('apply', { hash: plan.plan_hash });
  const state = await f.state();
  state.status = 'applying';
  await writeFile(join(f.root, 'state.json'), JSON.stringify(state));
  await assert.rejects(f.run('apply', { hash: plan.plan_hash }), /cannot be applied again/);
  assert.equal((await f.run('recover')).status, 'applied');
  assert.equal(f.puts().length, 1);
});

test('no-change plan still checks baseline, then performs no PUT', async (t) => {
  const f = await fixture(t);
  Object.assign(f.model.actions[0], offlineManifest.actions[0]);
  const plan = await f.plan();
  assert.deepEqual(plan.changes, []);
  const result = await f.run('apply', { hash: plan.plan_hash });
  assert.equal(result.updated_slots, 0);
  assert.equal(f.puts().length, 0);
});

test('public, personal, managed, and missing room metadata are refused before action reads', async (t) => {
  for (const update of [{ is_public: true }, { type: 'personal' }, { is_agent_inbox: true }, { is_public: undefined }, { type: undefined }]) {
    const f = await fixture(t);
    Object.assign(f.model.room, update);
    await assert.rejects(f.plan(), /standard private room/);
    assert.equal(f.model.calls.length, 1);
    assert.equal(await f.state(), undefined);
  }
});

test('room identity changes and token/room scope mismatch stop before mutation', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  const calls = f.model.calls.length;
  await assert.rejects(f.run('apply', { hash: plan.plan_hash, token: 'changed' }), /another credential or room/);
  await assert.rejects(f.run('recover', { room: 'OTHER' }), /another credential or room/);
  assert.equal(f.model.calls.length, calls);
  f.model.room.id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  await assert.rejects(f.run('apply', { hash: plan.plan_hash }), /same existing/);
  assert.equal(f.puts().length, 0);
});

test('null, malformed, altered, or truncated saved state fails closed without resetting', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  const saved = await f.state();
  const calls = f.model.calls.length;
  const altered = structuredClone(saved);
  altered.plan.batch[0].label = 'Changed';
  for (const text of ['null', '{', '', JSON.stringify(altered), JSON.stringify({ version: 1 })]) {
    await writeFile(join(f.root, 'state.json'), text);
    await assert.rejects(f.run('apply', { hash: plan.plan_hash }));
    await assert.rejects(f.plan());
    assert.equal(await readFile(join(f.root, 'state.json'), 'utf8'), text);
    assert.equal(f.model.calls.length, calls);
  }
});

test('manifest rejects expansion, deletion, unknown fields, duplicate slots, and PHP-normalized whitespace', () => {
  for (const value of [null, {}, { actions: [] },
    { actions: [{ action_number: 5, label: 'New', icon: '🔔' }] },
    { actions: [{ action_number: 1, label: '', icon: '' }] },
    { actions: [{ action_number: 1, label: 'Name', icon: '🔔', requires_ack: false }] },
    { actions: [offlineManifest.actions[0], offlineManifest.actions[0]] },
    { actions: [{ action_number: 1, label: ' Trimmed ', icon: '🔔' }] },
    { actions: [{ action_number: 1, label: 'A\nB', icon: '🔔' }] },
    { actions: [{ action_number: 1, label: 'Révision', icon: '🔔' }] },
  ]) assert.throws(() => validateManifest(value));
});

test('legacy empty or whitespace sound/haptic values fail before writes instead of being normalized to null', async (t) => {
  for (const update of [{ sound: '' }, { haptic_style: ' light ' }]) {
    const f = await fixture(t);
    Object.assign(f.model.actions[0], update);
    await assert.rejects(f.plan(), /Text must be bounded/);
    assert.equal(f.puts().length, 0);
  }
});

test('Laravel-trimmed invisible icon edges and invisible-only icons are refused before API traffic', async (t) => {
  const f = await fixture(t);
  for (const icon of ['\u200b🔔\u200b', '\u200b', '🔔\u034f', '\u2800🔔', '\u00ad🔔', '\u{1d173}🔔', '🔔\u{e0020}']) {
    await assert.rejects(f.run('plan', { manifest: { actions: [{ action_number: 1, label: 'Review', icon }] } }), /server-trimmed invisible/);
    assert.equal(f.model.calls.length, 0);
    assert.equal(await f.state(), undefined);
  }
});

test('invisible-normalized legacy baseline is rejected, while interior emoji ZWJ is preserved through apply', async (t) => {
  const f = await fixture(t);
  f.model.actions[0].icon = '\u200b🔔';
  await assert.rejects(f.plan(), /server-trimmed invisible/);
  assert.equal(f.puts().length, 0);
  f.model.actions[0].icon = '👨\u200d💻';
  const manifest = { actions: [{ action_number: 1, label: 'Review', icon: '👩\u200d💻' }] };
  const plan = await f.run('plan', { manifest });
  assert.equal((await f.run('apply', { hash: plan.plan_hash })).status, 'applied');
  assert.equal(f.puts()[0].body.actions[0].icon, '👩\u200d💻');
  assert.equal(f.model.actions[0].icon, '👩\u200d💻');
});

test('cancellation before PUT writes nothing; cancellation after PUT requires recovery', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  const before = new AbortController();
  before.abort();
  await assert.rejects(f.run('apply', { hash: plan.plan_hash, signal: before.signal }));
  assert.equal(f.puts().length, 0);
  const after = new AbortController();
  f.model.hook = async (call) => { if (call.method === 'PUT') after.abort(); };
  assert.equal((await f.run('apply', { hash: plan.plan_hash, signal: after.signal })).status, 'unknown');
  f.model.hook = null;
  assert.equal((await f.run('recover')).status, 'applied');
  assert.equal(f.puts().length, 1);
});

test('exclusive local lock refuses another writer without API traffic', async (t) => {
  const f = await fixture(t);
  const release = await acquireLock(f.root);
  await assert.rejects(f.plan(), /lock exists/);
  assert.equal(f.model.calls.length, 0);
  await release();
  assert.equal((await f.plan()).status, 'planned');
});

test('complete environment pair overrides private credentials; blank/partial/null files fail', async (t) => {
  const f = await fixture(t);
  await saveConnection(f.root, { token: 'saved', room: 'team' });
  assert.deepEqual(await loadConnection(f.root, {}), { token: 'saved', room: 'TEAM' });
  assert.equal((await stat(join(f.root, 'credentials.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await loadConnection(f.root, { PINGROOM_TOKEN: ' other ', PINGROOM_ROOM: ' room2 ' }), { token: 'other', room: 'ROOM2' });
  for (const env of [{ PINGROOM_TOKEN: '' }, { PINGROOM_ROOM: 'TEAM' }, { PINGROOM_TOKEN: 'ok', PINGROOM_ROOM: ' ' }]) await assert.rejects(loadConnection(f.root, env), /both/);
  await writeFile(join(f.root, 'credentials.json'), 'null');
  await assert.rejects(loadConnection(f.root, {}), /invalid/);
});

test('SDK response and network errors are sanitized; JSON output escapes terminal controls', async () => {
  const client = new PingRoom({ token: 'secret', baseUrl: 'https://offline.invalid', async fetch() { return new Response(JSON.stringify({ message: 'secret credential' }), { status: 403 }); } });
  try { await client.rooms.list(); assert.fail('Expected rejection'); }
  catch (error) { assert.ok(!errorSummary(error).includes('secret')); }
  const output = safeJson({ label: '\u001b[31m\u009b\u2028' });
  assert.ok(!output.includes('\u001b'));
  assert.ok(output.includes('\\u001b'));
  assert.ok(output.includes('\\u009b'));
  assert.ok(output.includes('\\u2028'));
});
