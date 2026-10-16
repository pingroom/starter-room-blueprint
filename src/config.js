import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { atomicJson, readJson } from './storage.js';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const credentialDirectory = join(projectRoot, '.pingroom');
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export function roomCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.trim())) throw new Error('A valid room code is required.');
  return value.trim().toUpperCase();
}
export function loadEnvironment() {
  try { process.loadEnvFile('.env'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function stateDirectory(env = process.env) {
  if (env.BLUEPRINT_STATE_DIR !== undefined && !env.BLUEPRINT_STATE_DIR.trim()) throw new Error('BLUEPRINT_STATE_DIR cannot be blank.');
  return env.BLUEPRINT_STATE_DIR ? resolve(env.BLUEPRINT_STATE_DIR) : join(projectRoot, '.blueprint');
}
export async function saveConnection(directory, connection) {
  if (typeof connection.token !== 'string' || !connection.token.trim()) throw new Error('Pairing did not return a credential.');
  await atomicJson(directory, 'credentials.json', { token: connection.token.trim(), room: roomCode(connection.room) });
}
export async function loadConnection(directory = credentialDirectory, env = process.env) {
  let connection;
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) {
    if (!env.PINGROOM_TOKEN?.trim() || !env.PINGROOM_ROOM?.trim()) throw new Error('Set both PINGROOM_TOKEN and PINGROOM_ROOM; blank or partial overrides are refused.');
    connection = { token: env.PINGROOM_TOKEN, room: env.PINGROOM_ROOM };
  } else connection = await readJson(join(directory, 'credentials.json'));
  if (!connection || typeof connection.token !== 'string' || !connection.token.trim()) throw new Error('Run npm run connect, or set both PINGROOM_TOKEN and PINGROOM_ROOM.');
  return { token: connection.token.trim(), room: roomCode(connection.room) };
}
