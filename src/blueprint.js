import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { roomCode, sha256 } from './config.js';
import { acquireLock, atomicJson, readJson } from './storage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const states = new Set(['planned', 'stale', 'applying', 'unknown', 'applied', 'baseline_observed', 'conflict', 'abandoned']);
const unresolved = new Set(['applying', 'unknown', 'baseline_observed', 'conflict']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
// Laravel Str::trim's whitespace/default set and INVISIBLE_CHARACTERS,
// verified against the server's installed framework. Test only the edges:
// an interior U+200D joins valid emoji sequences and must remain intact.
const serverTrimCharacter = /^[\p{White_Space}\u0000\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2060-\u2065\u206a-\u206f\u2800\u3164\ufeff\uffa0\u{1d159}\u{1d173}-\u{1d17a}\u{e0020}]$/u;
function text(value, max, empty = true) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error('Text must be bounded, without control characters or surrounding whitespace.');
  const characters = Array.from(value);
  if (serverTrimCharacter.test(characters[0] ?? '') || serverTrimCharacter.test(characters.at(-1) ?? '')) throw new Error('Text must be bounded, without whitespace or server-trimmed invisible characters at its edges.');
  return value;
}
const nullableText = (value, max) => value == null ? null : text(value, max, false);

export function validateManifest(value) {
  if (!keys(value, ['actions']) || !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 4) throw new Error('Blueprint must contain 1–4 action definitions.');
  const used = new Set();
  return { actions: value.actions.map((entry) => {
    if (!keys(entry, ['action_number', 'label', 'icon']) || !Number.isInteger(entry.action_number) || entry.action_number < 1 || entry.action_number > 4 || used.has(entry.action_number)) throw new Error('Use distinct existing action slots 1–4, with only action_number, label, and icon.');
    used.add(entry.action_number);
    const label = text(entry.label, 80, false);
    if (!/^[\x20-\x7e]+$/.test(label)) throw new Error('Blueprint labels must use printable ASCII text, up to 80 characters.');
    return { action_number: entry.action_number, label, icon: text(entry.icon, 32, false) };
  }).sort((a, b) => a.action_number - b.action_number) };
}

function snapshot(rows) {
  if (!Array.isArray(rows) || ![4, 8, 12, 16].includes(rows.length)) throw new Error('Expected a complete accessible action set of 4, 8, 12, or 16 slots.');
  const ids = new Set();
  const result = rows.map((row) => {
    if (!row || !UUID.test(row.id ?? '') || ids.has(row.id) || !Number.isInteger(row.action_number)) throw new Error('Action identities are missing, duplicated, or invalid.');
    ids.add(row.id);
    if (row.requires_ack !== undefined && typeof row.requires_ack !== 'boolean') throw new Error('Unexpected acknowledgement policy.');
    const input = row.input_type ?? 'none';
    if (!['none', 'location', 'link', 'file', 'photo', 'pdf'].includes(input)) throw new Error('Unsupported action input type.');
    return {
      id: row.id, action_number: row.action_number,
      label: text(row.label, 255), icon: text(row.icon, 255),
      sound: nullableText(row.sound, 255), haptic_style: nullableText(row.haptic_style, 50),
      requires_ack: row.requires_ack ?? false, input_type: input,
    };
  }).sort((a, b) => a.action_number - b.action_number);
  if (result.some((row, index) => row.action_number !== index + 1)) throw new Error('Action slots are not contiguous or contain duplicate numbers.');
  return result;
}

function batchFor(baseline, manifest) {
  return manifest.actions.flatMap((target) => {
    const before = baseline.find((entry) => entry.action_number === target.action_number);
    if (!before) throw new Error('Blueprint refers to a missing slot; this starter does not add slots.');
    if (before.label === target.label && before.icon === target.icon) return [];
    // These two omitted fields would be reset to null by the server. Preserve
    // them explicitly. Ack/input policy and unrecognized fields stay omitted.
    return [{ ...target, sound: before.sound, haptic_style: before.haptic_style }];
  });
}

function desiredFor(plan) {
  return plan.baseline.map((before) => {
    const target = plan.manifest.actions.find((entry) => entry.action_number === before.action_number);
    return target ? { ...before, label: target.label, icon: target.icon } : before;
  });
}

function validateState(state, scope, code) {
  if (!keys(state, ['version', 'status', 'plan', 'hash', 'updated_at']) || state.version !== 1 || !states.has(state.status) || !HASH.test(state.hash ?? '') || typeof state.updated_at !== 'string') throw new Error('Saved blueprint state is invalid; restore it before continuing.');
  const plan = state.plan;
  if (!keys(plan, ['version', 'id', 'scope', 'room', 'manifest', 'baseline', 'batch']) || plan.version !== 1 || !UUID.test(plan.id ?? '') || !HASH.test(plan.scope ?? '') || !keys(plan.room, ['id', 'code']) || !UUID.test(plan.room.id ?? '') || roomCode(plan.room.code) !== plan.room.code) throw new Error('Saved plan structure is invalid.');
  if (plan.scope !== scope || plan.room.code !== code) throw new Error('State belongs to another credential or room. Use a separate BLUEPRINT_STATE_DIR; do not delete existing state.');
  const baseline = snapshot(plan.baseline);
  const manifest = validateManifest(plan.manifest);
  if (!equal(plan.baseline, baseline) || !equal(plan.manifest, manifest) || !equal(plan.batch, batchFor(baseline, manifest)) || sha256(JSON.stringify(plan)) !== state.hash) throw new Error('Saved plan was altered or is invalid. Restore it before continuing.');
  return state;
}

export function planSummary(state) {
  return {
    status: state.status, plan_hash: state.hash, room: state.plan.room.code,
    changes: state.plan.batch.map((after) => {
      const before = state.plan.baseline.find((entry) => entry.action_number === after.action_number);
      return { action_number: after.action_number, before: { label: before.label, icon: before.icon }, after: { label: after.label, icon: after.icon }, preserved: { sound: after.sound, haptic_style: after.haptic_style, requires_ack: before.requires_ack, input_type: before.input_type } };
    }),
  };
}

async function readRoom(client, code, signal, expectedId) {
  signal?.throwIfAborted();
  // Resolve the room from the granted rooms list; feed content is never retained.
  const rooms = await client.rooms.list();
  signal?.throwIfAborted();
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Unexpected or oversized rooms list.');
  const matches = rooms.filter((room) => typeof room?.invite_code === 'string' && room.invite_code.toUpperCase() === code);
  if (matches.length !== 1) throw new Error('The configured room is missing or ambiguous in the granted rooms list.');
  const room = matches[0];
  if (!UUID.test(room.id ?? '') || room.type !== 'standard' || room.is_public !== false || room.is_agent_inbox === true || room.is_agent_managed === true || (expectedId && room.id !== expectedId)) throw new Error('Use the same existing standard private room; public, personal, and managed rooms are refused.');
  const actions = await client.actions.list(code);
  signal?.throwIfAborted();
  return { room: { id: room.id, code }, actions: snapshot(actions) };
}

/** Commands write only actions.updateMany; recovery and planning only read. */
export async function runBlueprint({ command, hash, manifest, client, room, token, root, signal }) {
  const code = roomCode(room);
  if (typeof token !== 'string' || !token.trim()) throw new Error('A credential is required.');
  if (!['plan', 'apply', 'recover', 'discard'].includes(command)) throw new Error('Use plan, apply HASH, recover, or discard HASH.');
  if (['apply', 'discard'].includes(command) && !HASH.test(hash ?? '')) throw new Error('Supply the exact 64-character plan hash.');
  const scope = sha256(JSON.stringify({ token: sha256(token), room: code }));
  const normalizedManifest = command === 'plan' ? validateManifest(manifest) : null;
  signal?.throwIfAborted();
  const release = await acquireLock(root);
  try {
    let state = await readJson(join(root, 'state.json'));
    if (state !== undefined) state = validateState(state, scope, code);
    const save = async (status) => {
      state.status = status;
      state.updated_at = new Date().toISOString();
      await atomicJson(root, 'state.json', state);
    };
    if (command === 'plan') {
      if (state && unresolved.has(state.status)) throw new Error('An attempted update is unresolved. Run recover; do not create a replacement plan.');
      const current = await readRoom(client, code, signal, state?.plan.room.id);
      const plan = { version: 1, id: randomUUID(), scope, room: current.room, manifest: normalizedManifest, baseline: current.actions, batch: batchFor(current.actions, normalizedManifest) };
      state = { version: 1, status: 'planned', plan, hash: sha256(JSON.stringify(plan)), updated_at: new Date().toISOString() };
      await save('planned');
      return planSummary(state);
    }
    if (!state) throw new Error('No saved plan. Run npm run plan first.');
    if (hash !== undefined && hash !== state.hash) throw new Error('Plan hash does not match the saved plan. Review a fresh plan.');
    if (command === 'discard') {
      if (!['baseline_observed', 'conflict'].includes(state.status)) throw new Error('Discard is allowed only after read-only recovery reports baseline_observed or conflict.');
      await save('abandoned');
      return { status: state.status, plan_hash: state.hash, message: 'Local attempt abandoned. No room changes were made by discard.' };
    }
    if (command === 'recover') {
      if (!unresolved.has(state.status)) throw new Error('There is no unresolved write to recover.');
      const current = await readRoom(client, code, signal, state.plan.room.id);
      const status = equal(current.actions, desiredFor(state.plan)) ? 'applied' : equal(current.actions, state.plan.baseline) ? 'baseline_observed' : 'conflict';
      await save(status);
      return { status, plan_hash: state.hash, message: status === 'applied' ? 'The saved desired configuration was observed.' : 'No writes retried. Inspect the room and confirm any earlier request has stopped before explicitly discarding this attempt.' };
    }
    if (state.status !== 'planned') throw new Error('This plan cannot be applied again. Recover an unresolved write or make a fresh plan.');
    const current = await readRoom(client, code, signal, state.plan.room.id);
    if (!equal(current.actions, state.plan.baseline)) {
      await save('stale');
      throw new Error('Room actions changed after planning. Nothing was written; make and review a fresh plan.');
    }
    signal?.throwIfAborted();
    if (state.plan.batch.length === 0) {
      await save('applied');
      return { status: 'applied', plan_hash: state.hash, updated_slots: 0 };
    }
    // Persist before the one mutating request. A crash at any later point
    // forces read-only recovery; neither timeouts nor HTTP errors retry PUT.
    await save('applying');
    try {
      signal?.throwIfAborted();
      await client.actions.updateMany(code, state.plan.batch);
      const after = await readRoom(client, code, signal, state.plan.room.id);
      if (!equal(after.actions, desiredFor(state.plan))) {
        await save('conflict');
        return { status: 'conflict', plan_hash: state.hash, message: 'Post-read differs from the saved desired state. No rollback was attempted.' };
      }
      await save('applied');
      return { status: 'applied', plan_hash: state.hash, updated_slots: state.plan.batch.length };
    } catch {
      await save('unknown');
      return { status: 'unknown', plan_hash: state.hash, message: 'Update outcome is uncertain. Run npm run recover; this request will not be retried automatically.' };
    }
  } finally { await release(); }
}
