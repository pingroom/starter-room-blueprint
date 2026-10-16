import { PingRoom } from '@pingroom/sdk';
import { credentialDirectory, saveConnection } from './config.js';
import { errorSummary } from './format.js';
import { shutdownSignal } from './signals.js';

const shutdown = shutdownSignal();
try {
  console.log('Install or open PingRoom and sign in: https://pingroom.io/i');
  console.log('Choose an existing standard private room where you are owner or admin.');
  const client = new PingRoom({ baseUrl: 'https://api.pingroom.io', timeoutMs: 5_000 });
  const pairing = await client.auth.startPairing({ agent_label: 'Room blueprint' });
  console.log(`Approve this connection and grant the room: ${pairing.pair_browser_url ?? pairing.pair_url}`);
  const active = await client.auth.waitForPairing(pairing, { signal: shutdown.signal });
  const room = active.home_room ?? active.room;
  if (!room?.invite_code) throw new Error('No private room returned. Select an existing private room when connecting.');
  await saveConnection(credentialDirectory, { token: active.credential, room: room.invite_code });
  console.log('Saved .pingroom/credentials.json. Edit blueprint.json, then run npm run plan.');
} catch (error) { console.error(errorSummary(error)); process.exitCode ||= 1; }
finally { shutdown.dispose(); }
