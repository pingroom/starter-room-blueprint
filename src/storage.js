import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 128 * 1024;
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

// Missing is distinct from JSON null, an empty file, or corrupt JSON.
export async function readJson(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new Error('Local file must be a regular JSON file of 1–131072 bytes.');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new Error('Local file changed while being read. Stop other writers and retry.');
    try {
      const value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON object');
      return value;
    } catch { throw new Error('Local JSON is invalid. Restore the file; it will not be reset automatically.'); }
  } finally { await file.close(); }
}

export async function atomicJson(directory, name, value) {
  await privateDirectory(directory);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Local state exceeds 128 KiB.');
  const temporary = join(directory, `.write-${randomUUID()}`);
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, join(directory, name));
  } finally { await rm(temporary, { force: true }); }
}

export async function acquireLock(directory) {
  await privateDirectory(directory);
  const path = join(directory, '.lock');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Blueprint lock exists. Check .lock/owner.json and confirm its process stopped before removing that lock.');
    throw error;
  }
  const owner = { pid: process.pid, nonce: randomUUID(), started_at: new Date().toISOString() };
  try { await atomicJson(path, 'owner.json', owner); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  return async () => {
    if ((await readJson(join(path, 'owner.json')))?.nonce === owner.nonce) await rm(path, { recursive: true, force: true });
  };
}
