/** WSS client with durable request identities and bounded, non-LLM reconnects. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import WebSocket from 'ws';
import { decode, frame, MAX_FRAME, pairing, type Frame, type Pairing, type TerminalState } from './protocol.ts';

interface Journal { events: Frame[]; calls: Record<string, { status: string; text?: string; revision?: string }> }
export interface TerminalDelegate {
  state(): TerminalState;
  catalog(): Promise<Record<string, unknown>>;
  call(world: string, tool: string, args: Record<string, unknown>, signal: AbortSignal, attachments?: unknown, execution?: { id: string; parent_call_id?: string }): Promise<Record<string, unknown>>;
  connected?(online: boolean, reason?: string): void;
  error?(reason: string): void;
  binding?(value: Record<string, unknown>): void;
  lifecycle?(value: Record<string, unknown>): void;
  output?(value: Record<string, unknown>): void;
}

export class TerminalConnection {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private attempts = 0;
  private welcomed = false;
  private revision = '';
  private advertised = '';
  private lastState = '';
  private refreshPending: WebSocket | null = null;
  private catalogAt = 0;
  private catalogDirty = true;
  private lastError = '';
  private serverSeen = 0;
  private readonly requests = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly journal: Journal;
  private pair: Pairing;
  constructor(pair: Pairing, private delegate: TerminalDelegate, private journalFile: string) {
    this.pair = pairing(pair);
    this.journal = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) as Journal : { events: [], calls: {} };
    // A process exit cannot prove whether an external side effect completed.
    for (const record of Object.values(this.journal.calls)) if (record.status === 'running') record.status = 'unknown';
    this.save();
  }
  private save(): void {
    mkdirSync(dirname(this.journalFile), { recursive: true });
    writeFileSync(this.journalFile + '.tmp', JSON.stringify(this.journal), { mode: 0o600 });
    renameSync(this.journalFile + '.tmp', this.journalFile);
  }
  request(kind: 'query' | 'cognition', payload: Record<string, unknown>, timeout = 15000): Promise<Record<string, unknown>> {
    if (!this.welcomed || this.stopped) return Promise.reject(new Error('terminal_offline'));
    if (this.requests.size >= 8) return Promise.reject(new Error('too_many_terminal_requests'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('remote_request_timeout')); }, timeout);
      this.requests.set(id, { resolve, reject, timer }); this.send(frame(kind, id, payload));
    });
  }
  private interruptRequests(): void {
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('terminal_disconnected')); }
    this.requests.clear();
  }
  start(): void { this.stopped = false; this.connect(); }
  stop(): void {
    this.stopped = true;
    this.interruptRequests();
    if (this.welcomed) this.send(frame('state', randomUUID(), {
      ...this.delegate.state(), ready: false, body: false, visible: false, locked: false, suspended: false,
    }));
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.controllers.values()) c.abort();
    this.socket?.close();
    this.socket = null;
    this.welcomed = false;
    this.delegate.connected?.(false);
  }
  async shutdown(): Promise<void> {
    const socket = this.socket;
    this.stop();
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
  private send(message: Frame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  event(payload: Record<string, unknown>): void {
    const durable = ['desktop-pet.message', 'desktop-pet.speech', 'desktop-pet.answer'].includes(String(payload.event_type));
    if (!this.welcomed && !durable) return;
    if (this.journal.events.length >= 100) throw new Error('terminal_outbox_full');
    const id = typeof payload.cursor === 'number' ? 'event-' + createHash('sha256').update(JSON.stringify([payload.store_run, payload.cursor, payload.occurred_at, payload.world, payload.event_type, payload.text, (payload.attachments as Array<{ sha256?: string }> | undefined)?.map((a) => a.sha256)])).digest('hex').slice(0, 40) : randomUUID();
    if (this.journal.events.some((event) => event.id === id)) return;
    const message = frame('event', id, payload);
    this.journal.events.push(message);
    this.save();
    if (this.welcomed) this.send(message);
  }
  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.pair.url, {
      ca: this.pair.ca, rejectUnauthorized: true, maxPayload: MAX_FRAME,
      headers: { Authorization: 'Bearer ' + this.pair.token }, handshakeTimeout: 10000,
    });
    this.socket = socket;
    socket.on('message', (raw) => {
      if (this.socket !== socket) return;
      try { void this.receive(decode(raw.toString()), socket).catch(() => socket.close(1002)); }
      catch { socket.close(1002); }
    });
    socket.on('error', (error: Error & { code?: string }) => {
      this.lastError = /\b(401|403)\b/.test(error.message) ? 'authentication_required' : error.code ?? 'connection_failed';
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.welcomed = false;
      this.interruptRequests();
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const c of this.controllers.values()) c.abort();
      this.delegate.connected?.(false, this.lastError);
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)));
    });
  }
  async refresh(forceCatalog = false): Promise<void> {
    if (forceCatalog) this.catalogDirty = true;
    if (!this.welcomed || !this.socket || this.refreshPending === this.socket) return;
    const socket = this.socket;
    this.refreshPending = socket;
    try {
    const state = this.delegate.state();
    const stateJson = JSON.stringify(state);
    if (stateJson !== this.lastState) {
      this.lastState = stateJson;
      this.send(frame('state', randomUUID(), state as unknown as Record<string, unknown>));
    }
    if (!this.catalogDirty && this.advertised && Date.now() - this.catalogAt < 30000) return;
    this.catalogDirty = false;
    const catalog = await this.delegate.catalog();
    if (!this.welcomed || this.stopped || this.socket !== socket) return;
    this.catalogAt = Date.now();
    const json = JSON.stringify(catalog);
    if (json !== this.advertised) {
      this.advertised = json;
      this.revision = randomUUID();
      this.send(frame('catalog', this.revision, catalog));
    }
    } finally { if (this.refreshPending === socket) this.refreshPending = null; }
  }
  private async receive(message: Frame, socket: WebSocket): Promise<void> {
    if (this.socket !== socket) return;
    this.serverSeen = Date.now();
    if (message.type === 'welcome') {
      if (message.payload.device_id !== this.pair.device_id) throw new Error('device_binding_mismatch');
      this.delegate.binding?.(message.payload);
      this.welcomed = true;
      this.advertised = '';
      this.lastState = '';
      this.lastError = '';
      this.catalogDirty = true;
      this.attempts = 0;
      await this.refresh();
      if (!this.welcomed || this.stopped || this.socket !== socket) return;
      for (const event of this.journal.events) this.send(event);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.serverSeen > 45000) { socket.terminate(); return; }
        this.send(frame('ping', randomUUID(), { state: this.delegate.state() })); void this.refresh();
      }, 20000);
      this.delegate.connected?.(true);
    } else if (message.type === 'query_result' || message.type === 'cognition_result') {
      const pending = this.requests.get(message.id);
      if (pending) { clearTimeout(pending.timer); this.requests.delete(message.id); pending.resolve(message.payload); }
    } else if (message.type === 'lifecycle') {
      this.delegate.lifecycle?.(message.payload);
    } else if (message.type === 'output') {
      this.delegate.output?.(message.payload);
    } else if (message.type === 'reconcile') {
      const ids = message.payload.ids;
      if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== 'string')) throw new Error('invalid_reconciliation');
      for (const id of ids as string[]) {
        const result = this.journal.calls[id];
        this.send(frame('result', id, !result || result.status === 'running' ? { status: 'unknown', text: 'No confirmed result.' } : result));
      }
    } else if (message.type === 'ack') {
      this.delegate.error?.(message.payload.status === 'failed' ? 'message_not_accepted' : '');
      const event = this.journal.events.find((e) => e.id === message.id);
      if (message.payload.status === 'queued' && typeof event?.payload.cursor === 'number') this.delegate.lifecycle?.({ kind: 'accepted', cursor: event.payload.cursor });
      if (['delivered','observed','failed'].includes(String(message.payload.status)) && typeof event?.payload.cursor === 'number') this.delegate.lifecycle?.({ kind: String(message.payload.status), cursor: event.payload.cursor });
      this.journal.events = this.journal.events.filter((e) => e.id !== message.id);
      this.save();
    } else if (message.type === 'error') {
      this.delegate.error?.('terminal_protocol_error');
    } else if (message.type === 'cancel') {
      this.controllers.get(message.id)?.abort();
    } else if (message.type === 'call') {
      const existing = this.journal.calls[message.id];
      if (existing) { if (existing.status !== 'running') this.send(frame('result', message.id, existing)); return; }
      const p = message.payload;
      const state = this.delegate.state();
      if (typeof p.expires_at !== 'number' || p.expires_at * 1000 < Date.now() || p.revision !== this.revision
          || !state.ready || state.locked || state.suspended || state.screen_off) {
        this.send(frame('result', message.id, { status: 'failed', text: 'expired_or_unavailable' }));
        return;
      }
      if (typeof p.world !== 'string' || typeof p.tool !== 'string' || !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) throw new Error('invalid_call');
      const controller = new AbortController();
      this.controllers.set(message.id, controller);
      this.journal.calls[message.id] = { status: 'running' };
      this.save();
      let result: Record<string, unknown>;
      try { result = await this.delegate.call(p.world, p.tool, p.arguments as Record<string, unknown>, controller.signal, p.attachments, { id: message.id, ...(typeof p.parent_call_id === 'string' ? { parent_call_id: p.parent_call_id } : {}) }); }
      catch { result = { status: 'unknown', text: 'tool_execution_outcome_unconfirmed' }; }
      this.journal.calls[message.id] = result as Journal['calls'][string];
      this.save();
      this.controllers.delete(message.id);
      this.send(frame('result', message.id, result));
      void this.refresh(true);
    }
  }
}
