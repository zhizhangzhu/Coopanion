/** Original Core Worlds and UI, with all decisions and cognition relayed to AstrBot. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { Core } from 'cortico/core/core.ts';
import type { World, WorldHost, EventEnvelope, CoreConfig, CognitionResult, CognitionRequest, BlobRef, ToolOutcome } from 'cortico/core/types.ts';
import type { WorldStreamSocket } from 'cortico/core/types.ts';
import type { WorldDefinition, WorldSection } from 'cortico/world.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { renderWorldEnvPrompt } from 'cortico/core/prefix.ts';
import { SecretVault } from './secrets.ts';
interface Slot { world: World; host?: WorldHost; active: boolean; label: string }
export class NativeBridge {
  core?: Core<CoreConfig>;
  readonly slots = new Map<string, Slot>();
  readonly vault: SecretVault;
  private readonly usageIds: Set<string>;
  onEvent: ((event: Record<string, unknown>) => void) | null = null;
  onCognition: ((world: string, request: CognitionRequest, parent?: string) => Promise<CognitionResult>) | null = null;
  onChange: (() => void) | null = null;
  private pending = new Map<number, { event: EventEnvelope; offered: boolean; trigger: string; accepted?: boolean }>();
  private chatSockets = new Set<WorldStreamSocket>();
  private execution = new AsyncLocalStorage<string>();
  private calls = new Map<string, { world: string; outputs: Record<string, unknown>[] }>();
  constructor(readonly root: string) { this.vault = new SecretVault(join(root, 'world-secrets.dpapi')); const path = join(root, 'usage-ids.local.json'); this.usageIds = new Set(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as string[] : []); const pending = join(root, 'pending.local.json'); if (existsSync(pending)) for (const item of JSON.parse(readFileSync(pending, 'utf8')) as Array<{ event: EventEnvelope; trigger: string }>) this.pending.set(item.event.cursor, { ...item, offered: false }); }
  wrap(definition: WorldDefinition<WorldSection>): WorldDefinition<WorldSection> {
    const bridge = this;
    return { ...definition, create(context) {
      const world = definition.create({ ...context, secret: (name) => bridge.vault.get(definition.id, name), storeSecret: (name, value) => bridge.vault.set(definition.id, name, value) });
      const slot: Slot = { world, active: false, label: definition.label }; bridge.slots.set(world.id, slot);
      return new Proxy(world, { get(target, key) {
        if (key === 'start') return async (base: WorldHost) => {
          slot.host = base;
          const host: WorldHost = { ...base,
            pushEvent: async (event, options) => {
              if (options?.deliver !== false && (!bridge.onEvent || bridge.pending.size >= 100)) throw new Error('astrbot_unpaired_or_queue_full');
              if (options?.deliver !== false && event.blobs) {
                const bytes = event.blobs.reduce((sum, blob) => sum + ('bytes' in blob ? blob.bytes.length : base.blob(blob.handle)?.bytes.length ?? 0), 0);
                if (event.blobs.length > 8 || bytes > 1024 * 1024) throw new Error('attachment_batch_too_large');
              }
              const saved = await base.pushEvent(event, options);
              const call = bridge.calls.get(bridge.execution.getStore() ?? '');
              if (options?.deliver === false && call?.world === world.id) call.outputs.push({ type: event.type, text: event.text, meta: event.meta });
              return saved;
            },
            modelFacts: { model: () => 'AstrBot', accepts: (mime) => bridge.onEvent !== null && mime.startsWith('image/'), contextWindow: () => undefined },
            cognition: { request: async (request) => {
              if (!slot.active || !bridge.onCognition) return { error: 'astrbot_offline' };
              const names = new Set(world.tools().map((t) => t.name));
              if ((request.tools ?? []).some((name) => !names.has(name))) return { error: 'cognition_tool_out_of_scope' };
              try { return await bridge.onCognition(world.id, request, bridge.execution.getStore()); } catch { return { error: 'cognition_interrupted' }; }
            } },
            drainPendingEvents: async (filter) => {
              const found: EventEnvelope[] = [];
              for (const [cursor, item] of bridge.pending) if (item.event.source === world.id && !item.offered && filter(item.event)) { found.push(item.event); bridge.pending.delete(cursor); }
              bridge.persistPending(); return found;
            },
            withdrawPending: async (cursor) => { const item = bridge.pending.get(cursor); if (!item || item.offered || item.event.source !== world.id) return false; bridge.pending.delete(cursor); bridge.persistPending(); return true; },
            promotePending: async (cursor) => { const item = bridge.pending.get(cursor); if (!item || item.event.source !== world.id || item.offered) return false; bridge.offer(cursor); return true; },
          };
          await world.start(host); slot.active = true; bridge.onChange?.();
        };
        if (key === 'webUi') return (...args: Parameters<NonNullable<World['webUi']>>) => {
          const declaration = world.webUi?.(...args); if (!declaration?.stream) return declaration;
          return { ...declaration, stream(panel: string, socket: import('cortico/core/types.ts').WorldStreamSocket) {
            if (world.id !== 'desktop-pet' || panel !== 'chat') { declaration.stream!(panel, socket); return; }
            bridge.chatSockets.add(socket); socket.onClose(() => bridge.chatSockets.delete(socket));
            declaration.stream!(panel, { get open() { return socket.open; }, close: (reason) => socket.close(reason), onMessage: (callback) => socket.onMessage(callback), onClose: (callback) => socket.onClose(callback),
              send: (text) => {
                const value = JSON.parse(text) as Record<string, unknown>;
                if (value.t === 'init') {
                  const restored = [...bridge.pending.values()].filter((item) => item.event.source === world.id && ['desktop-pet.message','desktop-pet.speech'].includes(item.event.type)).map((item) => item.event.cursor);
                  value.pending = [...new Set([...(Array.isArray(value.pending) ? value.pending : []), ...restored])];
                  value.accepted = [...bridge.pending.values()].filter((item) => item.accepted).map((item) => item.event.cursor);
                }
                socket.send(JSON.stringify(value));
              },
            });
          } };
        };
        if (key === 'stop') return async () => { slot.active = false; await world.stop(); bridge.onChange?.(); };
        // AstrBot's actual lifecycle is delivered below, independently of the UI-only Core.
        if (['onRunPhase', 'onEventsSettled', 'onTurnEnded', 'onHandoffEnded', 'outputTap'].includes(String(key))) return undefined;
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
  }
  attach(core: Core<CoreConfig>): void {
    this.core = core;
    // Never feed the local model loop. Advance its recovery watermark because AstrBot owns delivery.
    core.bus.push = (item, options) => {
      if (item.event) {
        core.loop.acknowledgeDiscarded([item.event]);
        if (this.slots.has(item.event.source)) {
          this.pending.set(item.event.cursor, { event: item.event, offered: false, trigger: options?.trigger ?? 'preempt' });
          this.persistPending();
          queueMicrotask(() => this.offer(item.event!.cursor));
        }
      }
      if (item.deferred) {
        const deferred = item.deferred, slot = this.slots.get(deferred.source);
        void (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const rendered = await Promise.race([Promise.resolve().then(deferred.render), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2000); })]).finally(() => clearTimeout(timer));
          if (rendered && slot?.active) await slot.host?.pushEvent({ ...deferred, ts: new Date().toISOString(), ...(typeof rendered === 'string' ? { text: rendered } : rendered) }, options);
        })().catch(() => {});
      }
      if (item.candidate) {
        const candidate = item.candidate, slot = this.slots.get(candidate.source);
        core.loop.acknowledgeDiscarded(candidate.sourceEvents);
        try {
          for (const projection of candidate.project([candidate])) {
            if (projection.candidateIndexes.some((index) => index !== 0)) throw new Error('invalid_candidate_projection');
            if (slot?.active) void slot.host?.pushEvent({ ...projection.event, source: candidate.source, ts: new Date().toISOString(), origin: candidate.origin }, options).catch(() => {});
          }
        } catch { /* Invalid extension candidates are isolated. */ }
      }
    };
  }
  private offer(cursor: number): void {
    const item = this.pending.get(cursor), send = this.onEvent;
    if (!item || item.offered || !send || this.core?.bus.isPaused()) return;
    const event = item.event, host = this.slots.get(event.source)?.host;
    try {
      send({ world: event.source, event_type: event.type, text: typeof event.meta?.text === 'string' ? event.meta.text : event.text,
        occurred_at: event.ts, store_run: event.run, cursor, trigger: item.trigger, origin: event.origin,
        ...(event.meta && Buffer.byteLength(JSON.stringify(event.meta)) <= 4000 ? { interaction: event.meta } : {}),
        ...(event.blobs?.length && host ? { attachments: event.blobs.map((blob) => this.wireBlob(host, blob)) } : {}) });
      item.offered = true; this.persistPending();
    } catch { /* A durable outbox rejection keeps this item pending. */ }
  }
  private persistPending(): void { const path = join(this.root, 'pending.local.json'); writeFileSync(path + '.tmp', JSON.stringify([...this.pending.values()]), { mode: 0o600 }); renameSync(path + '.tmp', path); }
  flush(): void { for (const cursor of this.pending.keys()) this.offer(cursor); }
  private wireBlob(host: WorldHost, ref: BlobRef): Record<string, unknown> {
    const value = host.blob(ref.handle); if (!value || value.bytes.length > 1024 * 1024) throw new Error('attachment_unavailable');
    return { mime: value.mime, base64: Buffer.from(value.bytes).toString('base64'), sha256: createHash('sha256').update(value.bytes).digest('hex'), name: ref.name, fallbackText: ref.fallbackText };
  }
  async catalog(): Promise<Record<string, unknown>> {
    const worlds = [];
    for (const [id, slot] of this.slots) {
      if (id === 'console' || id === 'astrbot-ui') continue;
      const supported = slot.active && this.core?.isWorldVisible(id) === true;
      try {
        const tools = supported ? slot.world.tools().map(({ handler, ...schema }) => schema) : [];
        const environment = supported ? (await renderWorldEnvPrompt(slot.world, { packageDir: this.root, deploymentDir: this.root })).text : '';
        worlds.push({ id, label: slot.label, supported, environment, tools, compatibility: 'native-world-and-ui', limitations: ['output-after-generation', 'remote-coordinator-controls-cognition'] });
      } catch { worlds.push({ id, label: slot.label, supported: false, tools: [], reason: 'world_catalog_failed' }); }
    }
    return { worlds };
  }
  async call(worldId: string, name: string, args: Record<string, unknown>, signal: AbortSignal, attachments?: unknown, execution?: { id: string; parent_call_id?: string }): Promise<Record<string, unknown>> {
    const slot = this.slots.get(worldId), tool = slot?.active && this.core?.isWorldVisible(worldId) ? slot.world.tools().find((t) => t.name === name) : undefined;
    if (!slot?.host || !tool) return { status: 'failed', text: 'tool_not_available' };
    if (signal.aborted) return { status: 'cancelled', text: 'cancelled_before_execution' };
    const parent = execution?.parent_call_id ? this.calls.get(execution.parent_call_id) : undefined;
    if ([...this.calls.values()].some((call) => call.world === worldId) && parent?.world !== worldId) return { status: 'failed', text: 'world_busy' };
    const id = execution?.id ?? randomUUID(); if (this.calls.has(id)) return { status: 'failed', text: 'duplicate_active_call' };
    if (attachments !== undefined) {
      if (worldId !== 'desktop-pet' || name !== 'pet_say' || !Array.isArray(attachments) || attachments.length > 8) throw new Error('invalid_attachments');
      let total = 0;
      const blobs = attachments.map((a) => { const bytes = Buffer.from(a.base64, 'base64'); total += bytes.length;
        if (!['image/png','image/jpeg','image/webp','image/gif'].includes(a.mime) || !bytes.length || total > 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== a.sha256) throw new Error('invalid_image');
        return { bytes, mime: a.mime, fallbackText: String(a.fallbackText ?? a.mime) }; });
      const saved = await slot.host.pushEvent({ source: worldId, type: 'astrbot.attachments', ts: new Date().toISOString(), text: '', blobs }, { deliver: false });
      args = { ...args, images: saved.blobs?.map((b) => b.handle) ?? [] };
    }
    const outputs: Record<string, unknown>[] = []; this.calls.set(id, { world: worldId, outputs });
    slot.world.onRunPhase?.({ state: 'tools', running: [name], enteredAt: new Date().toISOString() });
    try {
      const value = await this.execution.run(id, () => tool.handler(args, { role: 'remote', log: slot.host!.log, callId: id, signal }));
      const outcome: ToolOutcome = typeof value === 'string' ? { text: value } : value;
      const stored = outcome.blobs?.length ? await slot.host.pushEvent({ source: worldId, type: 'astrbot.tool-result', ts: new Date().toISOString(), text: outcome.text, blobs: outcome.blobs }, { deliver: false }) : null;
      const confirmed = (outcome as ToolOutcome & { presentationConfirmed?: boolean }).presentationConfirmed === true;
      const submitted = worldId === 'desktop-pet' && ['pet_say','pet_ask','pet_act'].includes(name) && !confirmed;
      return { status: outcome.failed ? 'failed' : signal.aborted ? 'unknown' : submitted ? 'submitted' : 'completed', text: outcome.text, outputs,
        ...(stored?.blobs?.length ? { attachments: stored.blobs.map((ref) => this.wireBlob(slot.host!, ref)) } : {}) };
    } finally { this.calls.delete(id); slot.world.onRunPhase?.({ state: 'idle', running: [], enteredAt: new Date().toISOString() }); }
  }
  lifecycle(value: Record<string, unknown>): void {
    if (value.kind === 'accepted' && typeof value.cursor === 'number') {
      const item = this.pending.get(value.cursor);
      if (item) { item.accepted = true; this.persistPending(); }
      for (const socket of this.chatSockets) if (socket.open) socket.send(JSON.stringify({ t: 'transport', cursor: value.cursor, status: 'accepted' }));
      return;
    }
    if (['observed','failed'].includes(String(value.kind)) && typeof value.cursor === 'number') { const item = this.pending.get(value.cursor); if (item) { this.pending.delete(value.cursor); this.persistPending(); if (value.kind === 'failed') this.slots.get(item.event.source)?.world.onEventsSettled?.([item.event], 'discarded'); } return; }
    if (value.kind === 'delivered' && typeof value.cursor === 'number') {
      const item = this.pending.get(value.cursor); if (item) { this.pending.delete(value.cursor); this.persistPending(); this.slots.get(item.event.source)?.world.onEventsSettled?.([item.event], 'delivered'); }
    }
    for (const slot of this.slots.values()) if (slot.active) {
      try {
        slot.world.onRunPhase?.({ state: value.kind === 'finished' ? 'idle' : 'model', running: [], enteredAt: new Date().toISOString() });
        if (value.kind === 'finished') { slot.world.outputTap?.()?.onRoundEnd?.(); slot.world.onTurnEnded?.(); }
        if (value.kind === 'handoff') slot.world.onHandoffEnded?.();
      } catch { /* A World cannot break transport lifecycle. */ }
    }
  }
  usage(record: Record<string, unknown>): void {
    const id = String(record.id ?? ''); if (!id || this.usageIds.has(id)) return;
    const host = this.slots.get('desktop-pet')?.host; if (!host) return;
    const keys = ['promptTokens','completionTokens','cacheHitTokens','cacheMissTokens','reasoningTokens'] as const;
    const counts = Object.fromEntries(keys.map((key) => [key, Math.max(0, Number(record[key]) || 0)])) as { [K in typeof keys[number]]: number };
    if (!this.core) return;
    const timestamp = typeof record.ts === 'number' ? new Date(record.ts * 1000) : new Date();
    this.core.usageLog.append({ ...counts, recordId: id, ts: timestamp.toISOString(), sessionId: 'worlds.desktop-pet', role: 'worlds.desktop-pet', label: 'AstrBot', model: String(record.model ?? 'AstrBot') });
    this.usageIds.add(id); while (this.usageIds.size > 10000) this.usageIds.delete(this.usageIds.values().next().value!);
    writeFileSync(join(this.root, 'usage-ids.local.json'), JSON.stringify([...this.usageIds]));
  }
  output(event: StreamEvent): void { for (const slot of this.slots.values()) if (slot.active) { try { slot.world.outputTap?.()?.onEvent(event); } catch { /* Isolate a broken tap. */ } } }
}
