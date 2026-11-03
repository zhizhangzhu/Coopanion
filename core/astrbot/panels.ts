/** Native-window HTTP bridge for declared World streams; each host owns its sessions. */
import { randomUUID } from 'node:crypto';
import type { WorldWebUiDecl, WorldStreamSocket } from 'cortico/core/types.ts';
interface Session { frames: unknown[]; messages: Array<(text: string) => void>; closed: Array<() => void>; open: boolean; touched: number }
export class PanelSessions {
  private sessions = new Map<string, Session>();
  open(declaration: WorldWebUiDecl | undefined, panel: string): { session: string; frames: unknown[] } {
    if (!declaration?.stream) throw new Error('world_stream_unavailable');
    this.expire();
    if (this.sessions.size >= 16) throw new Error('too_many_panels');
    const id = randomUUID();
    const session: Session = { frames: [], messages: [], closed: [], open: true, touched: Date.now() };
    const socket: WorldStreamSocket = {
      get open() { return session.open; },
      send: (text) => { if (session.open) { if (session.frames.length >= 512) socket.close('panel_backpressure'); else session.frames.push(JSON.parse(text)); } },
      close: (reason) => { if (session.open) { session.open = false; session.frames.push({ t: 'closed', reason }); for (const cb of session.closed) cb(); } },
      onMessage: (cb) => { session.messages.push(cb); }, onClose: (cb) => { session.closed.push(cb); },
    };
    this.sessions.set(id, session);
    declaration.stream(panel, socket);
    return { session: id, frames: this.poll(id) };
  }
  poll(id: string): unknown[] { const session = this.get(id); session.touched = Date.now(); return session.frames.splice(0); }
  send(id: string, frame: Record<string, unknown>): void {
    const session = this.get(id);
    if (!session.open) throw new Error('panel_closed');
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('panel_frame_too_large');
    session.touched = Date.now();
    for (const cb of session.messages) cb(text);
  }
  close(id: string): void { const session = this.sessions.get(id); if (!session) return; session.open = false; for (const cb of session.closed) cb(); this.sessions.delete(id); }
  closeAll(): void { for (const id of this.sessions.keys()) this.close(id); }
  private get(id: string): Session { const session = this.sessions.get(id); if (!session) throw new Error('panel_session_expired'); return session; }
  private expire(): void { for (const [id, session] of this.sessions) if (Date.now() - session.touched > 60000) this.close(id); }
}
