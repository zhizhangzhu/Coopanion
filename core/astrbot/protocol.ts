/** Wire boundary for the authenticated AstrBot terminal connection. */
export const VERSION = 1;
export const MAX_FRAME = 2 * 1024 * 1024;
export interface Pairing { v: 1; url: string; ca: string; device_id: string; token: string }
export interface Frame { v: 1; type: string; id: string; payload: Record<string, unknown> }
export interface TerminalState { ready: boolean; body: boolean; visible: boolean; locked: boolean; suspended: boolean; dnd: boolean }
export function pairing(value: unknown): Pairing {
  const p = value as Partial<Pairing> | null;
  if (!p || p.v !== VERSION || typeof p.url !== 'string' || typeof p.ca !== 'string'
      || !p.ca.includes('-----BEGIN CERTIFICATE-----') || typeof p.token !== 'string' || p.token.length < 32
      || typeof p.device_id !== 'string' || !/^[\w.-]{1,128}$/.test(p.device_id)) throw new Error('invalid_pairing');
  const url = new URL(p.url);
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.search) throw new Error('expected_wss_url');
  return p as Pairing;
}
export function frame(type: string, id: string, payload: Record<string, unknown>): Frame {
  return { v: VERSION, type, id, payload };
}
export function decode(raw: string): Frame {
  if (Buffer.byteLength(raw) > MAX_FRAME) throw new Error('frame_too_large');
  const p = JSON.parse(raw) as Frame;
  if (p?.v !== VERSION || typeof p.type !== 'string' || typeof p.id !== 'string'
      || !/^[\w.:-]{1,128}$/.test(p.id) || !p.payload || typeof p.payload !== 'object' || Array.isArray(p.payload)) throw new Error('invalid_frame');
  return p;
}
