import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBlueprint } from './blueprint.js';
import { offlineClient, offlineManifest } from './offline.js';
import { safeJson } from './format.js';

// Real SDK, local transport only. No environment, credential file, or global
// fetch is used; all demo state is removed on completion.
const root = await mkdtemp(join(tmpdir(), 'pingroom-blueprint-demo-'));
try {
  const { client, model } = offlineClient();
  const options = { client, room: 'TEAM', token: 'offline-token', root };
  const plan = await runBlueprint({ ...options, command: 'plan', manifest: offlineManifest });
  console.log(safeJson({ preview: plan }));
  model.mode = 'after-commit-loss';
  const uncertain = await runBlueprint({ ...options, command: 'apply', hash: plan.plan_hash });
  const recovered = await runBlueprint({ ...options, command: 'recover' });
  console.log(safeJson({ attempted_update: uncertain.status, read_only_recovery: recovered.status, update_requests: model.calls.filter((call) => call.method === 'PUT').length, preserved_sound: model.actions[0].sound, preserved_input_type: model.actions[0].input_type }));
} finally { await rm(root, { recursive: true, force: true }); }
