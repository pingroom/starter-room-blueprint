import { PingRoom } from '@pingroom/sdk';

export const offlineRoomId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const offlineManifest = { actions: [{ action_number: 1, label: 'Ready to review', icon: '👀' }] };
export function offlineClient({ count = 4 } = {}) {
  const model = {
    room: { id: offlineRoomId, invite_code: 'TEAM', type: 'standard', is_public: false },
    actions: Array.from({ length: count }, (_, index) => ({
      id: `${String(index + 1).padStart(8, '0')}-1111-1111-1111-111111111111`,
      action_number: index + 1, label: `Old label ${index + 1}`, icon: '🔔',
      sound: index === 0 ? 'default' : null, haptic_style: index === 0 ? 'light' : null,
      requires_ack: index === 0, input_type: index === 0 ? 'link' : 'none',
    })),
    calls: [], mode: 'normal', hook: null,
  };
  const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const client = new PingRoom({ token: 'offline-token', baseUrl: 'https://offline.invalid', timeoutMs: 1000, async fetch(input, options) {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : undefined;
    const call = { method: options.method, path: url.pathname, body };
    model.calls.push(call);
    if (url.origin !== 'https://offline.invalid' || url.search) throw new Error('Unexpected offline URL.');
    if (model.hook) await model.hook(call, model);
    if (call.method === 'GET' && call.path === '/api/agent/rooms') return respond([model.room]);
    if (call.method === 'GET' && call.path === '/api/agent/rooms/TEAM/actions') {
      if (model.mode === 'fail-read') return respond({ code: 'server_error', message: 'private response detail' }, 503);
      return respond(model.actions);
    }
    if (call.method === 'PUT' && call.path === '/api/agent/rooms/TEAM/actions') {
      if (model.mode === 'before-commit-loss') throw new Error('Private transport detail');
      if (model.mode === 'forbidden') return respond({ code: 'forbidden', message: 'Private response detail' }, 403);
      // Mirrors batch semantics: omitted sound/haptic reset; other omitted
      // action fields stay unchanged. No slot creation is modeled.
      for (const update of body.actions) {
        const row = model.actions.find((entry) => entry.action_number === update.action_number);
        if (!row) throw new Error('This template must not create slots.');
        Object.assign(row, { sound: null, haptic_style: null }, update);
      }
      if (model.mode === 'after-commit-loss') throw new Error('Private transport detail');
      if (model.mode === 'fail-postread') model.mode = 'fail-read';
      return respond(model.actions);
    }
    throw new Error('Unexpected method or path: no creation, join, trigger, or broadcast is implemented.');
  } });
  return { client, model };
}
