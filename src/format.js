import { PingRoomError, PingRoomNetworkError, PingRoomTimeoutError } from '@pingroom/sdk';

export const safeJson = (value) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function errorSummary(error) {
  if (error instanceof PingRoomError) {
    const code = typeof error.code === 'string' && /^[a-z0-9_]+$/.test(error.code) ? error.code : 'request_failed';
    return `PingRoom ${code}${Number.isInteger(error.status) ? ` (HTTP ${error.status})` : ''}.`;
  }
  if (error instanceof PingRoomNetworkError || error instanceof PingRoomTimeoutError) return 'PingRoom request failed or timed out.';
  return error instanceof Error ? error.message : 'The blueprint command stopped.';
}
