import { PingRoom } from '@pingroom/sdk';
import { join } from 'node:path';
import { loadConnection, loadEnvironment, projectRoot, stateDirectory } from './config.js';
import { readJson } from './storage.js';
import { runBlueprint } from './blueprint.js';
import { errorSummary, safeJson } from './format.js';
import { shutdownSignal } from './signals.js';

const shutdown = shutdownSignal();
try {
  loadEnvironment();
  const [command, hash, ...extra] = process.argv.slice(2);
  if (extra.length || (['plan', 'recover'].includes(command) && hash !== undefined)) throw new Error('Use npm run plan, apply -- HASH, recover, or discard -- HASH.');
  const connection = await loadConnection();
  const manifest = command === 'plan' ? await readJson(join(projectRoot, 'blueprint.json')) : undefined;
  const client = new PingRoom({ token: connection.token, baseUrl: 'https://api.pingroom.io', timeoutMs: 5_000 });
  const result = await runBlueprint({ command, hash, manifest, client, ...connection, root: stateDirectory(), signal: shutdown.signal });
  console.log(safeJson(result));
  if (['unknown', 'conflict', 'baseline_observed'].includes(result.status)) process.exitCode ||= 2;
} catch (error) { console.error(errorSummary(error)); process.exitCode ||= 1; }
finally { shutdown.dispose(); }
