/** Runs enabled Worlds for AstrBot without a local Persona or model loop. */
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import type { BlobInput, BlobRef, EventEnvelope, ToolOutcome, World, WorldHost, CognitionRequest, CognitionResult, CandidateEventSpec, RunPhase } from 'cortico/core/types.ts';
import type { WorldContext, WorldDefinition, WorldSection } from 'cortico/world.ts';
import type { Language } from 'cortico/core/language.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { PanelSessions } from './panels.ts';
import { SecretVault } from './secrets.ts';
import { configPath, validateValue, assignPath, type PropertySchema } from './configuration.ts';

interface Slot { definition: WorldDefinition<WorldSection>; world: World; enabled: boolean; error?: string }
export interface HostConfig { worlds: Record<string, WorldSection>; name: string; timezone: string; dnd?: boolean }

function assignDeep(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('invalid_config_key');
    if (value === undefined) continue;
    const current = target[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      assignDeep(current as Record<string, unknown>, value as Record<string, unknown>);
    } else target[key] = structuredClone(value);
  }
}

export class TerminalHost {
  private readonly slots = new Map<string, Slot>();
  private readonly failures = new Map<string, { label: string; reason: string }>();
  private readonly calls = new Map<string, { world: string; outputs: Array<Record<string, unknown>> }>();
  private readonly execution = new AsyncLocalStorage<string>();
  private readonly store: JsonlEventStore;
  private readonly log = nullLogger();
  private readonly blobDir: string;
  readonly panels = new PanelSessions();
  private pending = new Map<number, { event: EventEnvelope; offered: boolean; trigger: string; timer?: ReturnType<typeof setTimeout> }>();
  private deferred = new Map<string, Array<() => Promise<void>>>();
  private generation = 0;
  readonly secrets: SecretVault;
  onCognition: ((world: string, request: CognitionRequest, parentCallId?: string) => Promise<CognitionResult>) | null = null;
  onEvent: ((payload: Record<string, unknown>) => void) | null = null;

  constructor(readonly root: string, readonly config: HostConfig, private persist: () => void, secrets?: SecretVault) {
    this.secrets = secrets ?? new SecretVault(join(root, 'world-secrets.dpapi'));
    mkdirSync(root, { recursive: true });
    this.store = new JsonlEventStore({ dataDir: root, run: randomUUID(), timezone: config.timezone });
    this.blobDir = join(root, 'blobs');
    mkdirSync(this.blobDir, { recursive: true });
  }

  private blob(input: BlobInput): BlobRef {
    if ('handle' in input) {
      const blob = this.readBlob(input.handle);
      if (!blob) throw new Error('unknown_blob');
      return { handle: input.handle, mime: blob.mime, fallbackText: input.fallbackText };
    }
    const digest = createHash('sha256').update(input.bytes).digest('hex');
    const path = join(this.blobDir, digest);
    if (!existsSync(path)) {
      writeFileSync(path, input.bytes, { mode: 0o600 });
      writeFileSync(path + '.json', JSON.stringify({ mime: input.mime }), { mode: 0o600 });
    }
    return { handle: 'log:' + digest, mime: input.mime, name: input.name, fallbackText: input.fallbackText };
  }

  readBlob(handle: string): { bytes: Uint8Array; mime: string } | null {
    if (!/^log:[a-f0-9]{64}$/.test(handle)) return null;
    const file = join(this.blobDir, handle.slice(4));
    if (!existsSync(file) || !existsSync(file + '.json')) return null;
    return { bytes: readFileSync(file), mime: (JSON.parse(readFileSync(file + '.json', 'utf8')) as { mime: string }).mime };
  }

  private wireBlob(blob: BlobRef): Record<string, unknown> {
    const value = this.readBlob(blob.handle);
    if (!value || value.bytes.length > 1024 * 1024) throw new Error('attachment_too_large');
    return { mime: value.mime, base64: Buffer.from(value.bytes).toString('base64'),
             sha256: createHash('sha256').update(value.bytes).digest('hex'), name: blob.name,
             fallbackText: blob.fallbackText };
  }

  async enable(definition: WorldDefinition<WorldSection>): Promise<void> {
    const id = definition.id;
    if (this.slots.has(id)) await this.disable(id);
    const cfg = this.config.worlds[id] ??= definition.defaults();
    const config = this.config;
    const context: WorldContext<WorldSection> = {
      id, cfg, timezone: this.config.timezone, get botName() { return config.name; }, botDir: this.root,
      packageDir: fileURLToPath(new URL('../../', import.meta.url)), dataDir: this.root,
      repoRoot: fileURLToPath(new URL('../../', import.meta.url)),
      secret: (name) => this.secrets.get(id, name),
      storeSecret: (name, value) => { this.secrets.set(id, name, value); },
      persist: (patch) => { assignDeep(cfg as unknown as Record<string, unknown>, patch); this.persist(); },
      restart: async () => { await this.enable(definition); },
    };
    let world: World;
    try {
      definition.preflight?.(context);
      world = definition.create(context);
      if (world.id !== id) throw new Error('world_identity_mismatch');
    } catch (error) {
      this.failures.set(id, { label: definition.label, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.failures.delete(id);
    const slot = { definition, world, enabled: cfg.enabled };
    this.slots.set(id, slot);
    if (!cfg.enabled) return;
    const host: WorldHost = {
      log: this.log, store: this.store,
      modelFacts: { model: () => 'remote', accepts: () => false, contextWindow: () => undefined },
      blob: (handle) => this.readBlob(handle),
      reportUsage: () => { throw new Error('local_model_usage_not_enabled_in_terminal_mode'); },
      drainPendingEvents: async (filter) => {
        const result: EventEnvelope[] = [];
        for (const [cursor, item] of this.pending) if (item.event.source === id && !item.offered && filter(item.event)) {
          clearTimeout(item.timer); this.pending.delete(cursor); result.push(item.event);
        }
        return result;
      },
      withdrawPending: async (cursor) => {
        const item = this.pending.get(cursor);
        if (!item || item.event.source !== id || item.offered) return false;
        clearTimeout(item.timer); this.pending.delete(cursor); return true;
      },
      promotePending: async (cursor) => {
        const item = this.pending.get(cursor);
        if (!item || item.event.source !== id || item.offered) return false;
        clearTimeout(item.timer); this.offer(cursor); return true;
      },
      pushDeferred: (event, options) => {
        const generation = this.generation;
        const queued = this.deferred.get(id) ?? [];
        if (queued.length >= 100) throw new Error('deferred_queue_full');
        queued.push(async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const rendered = await Promise.race([Promise.resolve().then(event.render), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2000); })]).finally(() => clearTimeout(timer));
          if (!rendered || !slot.enabled || generation !== this.generation) return;
          await host.pushEvent({ ...event, source: id, ts: new Date().toISOString(), ...(typeof rendered === 'string' ? { text: rendered } : rendered) }, options);
        });
        this.deferred.set(id, queued);
        queueMicrotask(() => { void this.flushDeferred(id); });
      },
      pushCandidate: async (spec, options) => {
        const sourceEvents = spec.sourceEvents.map((event) => this.store.append({ ...event, source: id, origin: 'external', contextDelivery: 'archive-only' }));
        const candidate: CandidateEventSpec = { source: id, origin: 'external', sourceEvents, gateText: spec.gateText, value: spec.value, project: spec.project };
        const projected = spec.project([candidate]);
        for (const projection of projected) {
          if (projection.candidateIndexes.some((index) => index !== 0)) throw new Error('invalid_candidate_projection');
          await host.pushEvent({ ...projection.event, source: id, ts: new Date().toISOString() }, options);
        }
        return sourceEvents;
      },
      cognition: { request: async (request) => {
        if (!slot.enabled || !this.onCognition) return { error: 'desktop_cognition_unavailable' };
        const names = new Set(world.tools().map((tool) => tool.name));
        if ((request.tools ?? []).some((name) => !names.has(name))) return { error: 'cognition_tool_out_of_scope' };
        try { return await this.onCognition(id, request, this.execution.getStore()); } catch { return { error: 'desktop_cognition_interrupted' }; }
      } },
      pushEvent: async (e, options) => {
        const { blobs, ...rest } = e;
        const saved = this.store.append({ ...rest, source: id, origin: 'external', contextDelivery: options?.deliver === false ? 'archive-only' : 'deliver',
          ...(blobs ? { blobs: blobs.map((b) => this.blob(b)) } : {}) });
        if (options?.deliver === false) {
          const active = this.calls.get(this.execution.getStore() ?? '');
          if (active?.world === id) active.outputs.push({ type: e.type, text: e.text, meta: e.meta });
        } else {
          const pending = { event: saved, offered: false, trigger: options?.trigger ?? 'preempt', timer: undefined as ReturnType<typeof setTimeout> | undefined };
          this.pending.set(saved.cursor, pending);
          if ((options?.trigger ?? 'preempt') === 'debounce') pending.timer = setTimeout(() => this.offer(saved.cursor), 120);
          else this.offer(saved.cursor);
        }
        return saved;
      },
    };
    try { await world.start(host); }
    catch (error) {
      await world.stop().catch(() => {});
      this.slots.set(id, { ...slot, enabled: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async disable(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (slot) { slot.enabled = false; await slot.world.stop(); this.slots.delete(id); }
  }

  async catalog(): Promise<Record<string, unknown>> {
    const worlds = [];
    for (const [id, slot] of this.slots) {
      try {
      let environment = '';
      const tools = slot.enabled ? slot.world.tools().map(({ handler, ...tool }) => tool) : [];
      const names = tools.map((tool) => tool.name);
      if (new Set(names).size !== names.length || names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(name))) throw new Error('invalid_world_tools');
      if (Buffer.byteLength(JSON.stringify(tools)) > 256 * 1024) throw new Error('world_catalog_too_large');
      if (slot.enabled) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const variables = await Promise.race([
          Promise.resolve().then(() => slot.world.envPromptVars()),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('world_snapshot_timeout')), 5000); }),
        ]).finally(() => { clearTimeout(timer); });
        const doc = slot.world.webUi?.('en').promptDocs?.find((d) => d.role === 'envPrompt');
        if (variables && doc?.path && existsSync(doc.path)) {
          environment = renderTemplate(readFileSync(doc.path, 'utf8'), variables);
        } else if (variables) environment = JSON.stringify(variables);
      }
      worlds.push({ id, label: slot.definition.label, supported: slot.enabled, compatibility: 'tools-events-lifecycle',
                    limitations: ['local-model-usage-unavailable', 'output-after-generation', ...(this.onCognition ? [] : ['background-cognition-offline'])],
                    ...(slot.error ? { reason: slot.error } : {}), environment, tools });
      } catch (error) {
        slot.enabled = false;
        void slot.world.stop().catch(() => {});
        worlds.push({ id, label: slot.definition.label, supported: false, tools: [],
                      reason: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const [id, failure] of this.failures) worlds.push({ id, ...failure, supported: false, tools: [] });
    return { worlds };
  }

  async call(worldId: string, toolName: string, arguments_: Record<string, unknown>, signal: AbortSignal, attachments?: unknown, execution?: { id: string; parent_call_id?: string }): Promise<Record<string, unknown>> {
    const slot = this.slots.get(worldId);
    const tool = slot?.enabled ? slot.world.tools().find((t) => t.name === toolName) : undefined;
    if (!slot || !tool) return { status: 'failed', text: 'tool_not_available' };
    if (signal.aborted) return { status: 'cancelled', text: 'cancelled_before_execution' };
    const parent = execution?.parent_call_id ? this.calls.get(execution.parent_call_id) : undefined;
    if ([...this.calls.values()].some((call) => call.world === worldId) && parent?.world !== worldId) return { status: 'failed', text: 'world_busy' };
    const callId = execution?.id ?? randomUUID();
    if (this.calls.has(callId)) return { status: 'failed', text: 'duplicate_active_call' };
    const outputs: Array<Record<string, unknown>> = [];
    if (attachments !== undefined) {
      if (worldId !== 'desktop-pet' || toolName !== 'pet_say' || !Array.isArray(attachments) || attachments.length > 8) throw new Error('invalid_attachments');
      let total = 0;
      arguments_ = { ...arguments_, images: attachments.map((a) => {
        if (!a || typeof a.base64 !== 'string' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(a.mime)) throw new Error('invalid_image');
        const bytes = Buffer.from(a.base64, 'base64'); total += bytes.length;
        if (!bytes.length || total > 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== a.sha256) throw new Error('invalid_image_bytes');
        return this.blob({ bytes, mime: a.mime, fallbackText: String(a.fallbackText ?? a.mime) }).handle;
      }) };
    }
    this.calls.set(callId, { world: worldId, outputs });
    try {
      const value = await this.execution.run(callId, () => tool.handler(arguments_, { role: 'remote', log: this.log, callId, signal }));
      const outcome: ToolOutcome = typeof value === 'string' ? { text: value } : value;
      const blobs = outcome.blobs?.map((b) => this.blob(b));
      // Existing pet speech receipts confirm submission to the renderer, not display completion.
      const confirmed = (outcome as ToolOutcome & { presentationConfirmed?: boolean }).presentationConfirmed === true;
      const submitted = worldId === 'desktop-pet' && ['pet_say', 'pet_ask', 'pet_act'].includes(toolName) && !confirmed;
      return { status: outcome.failed ? 'failed' : signal.aborted ? 'unknown' : submitted ? 'submitted' : 'completed',
               text: outcome.text, outputs, ...(blobs ? { attachments: blobs.map((b) => this.wireBlob(b)) } : {}) };
    } finally { this.calls.delete(callId); }
  }

  async stop(): Promise<void> {
    this.generation++; this.panels.closeAll();
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.pending.clear(); this.deferred.clear();
    await Promise.allSettled([...this.slots.keys()].map((id) => this.disable(id)));
  }

  private offer(cursor: number): void {
    const item = this.pending.get(cursor);
    if (!item || item.offered || !this.onEvent) return;
    const e = item.event;
    this.onEvent({ world: e.source, event_type: e.type, text: typeof e.meta?.text === 'string' ? e.meta.text : e.text,
      occurred_at: e.ts, ...(e.meta && Buffer.byteLength(JSON.stringify(e.meta)) <= 4000 ? { interaction: e.meta } : {}), origin: 'external', trigger: item.trigger, cursor,
      ...(e.blobs?.length ? { attachments: e.blobs.map((blob) => this.wireBlob(blob)) } : {}) });
    item.offered = true;
  }
  private async flushDeferred(world: string): Promise<void> {
    const queue = this.deferred.get(world) ?? []; this.deferred.delete(world);
    for (const render of queue) { try { await render(); } catch { /* An unrenderable event is discarded. */ } }
  }
  lifecycle(payload: Record<string, unknown>): void {
    if (payload.kind === 'delivered' && typeof payload.cursor === 'number') {
      const item = this.pending.get(payload.cursor);
      if (item) { this.pending.delete(payload.cursor); this.slots.get(item.event.source)?.world.onEventsSettled?.([item.event], 'delivered'); }
    }
    const phase: RunPhase = { state: payload.kind === 'finished' ? 'idle' : 'model', running: [], enteredAt: new Date().toISOString() };
    for (const slot of this.slots.values()) if (slot.enabled) {
      try {
        slot.world.onRunPhase?.(phase);
        if (payload.kind === 'finished') { slot.world.outputTap?.()?.onRoundEnd?.(); slot.world.onTurnEnded?.(); }
        if (payload.kind === 'handoff') slot.world.onHandoffEnded?.();
      } catch { slot.error = 'world_lifecycle_failed'; }
    }
  }
  output(event: StreamEvent): void {
    for (const slot of this.slots.values()) if (slot.enabled) {
      try { slot.world.outputTap?.()?.onEvent(event); } catch { slot.error = 'world_output_failed'; }
    }
  }
  panelOpen(world: string, panel: string, language: Language) { return this.panels.open(this.slots.get(world)?.world.webUi?.(language), panel); }
  async invoke(world: string, panel: string, method: string, args: unknown[], language: Language): Promise<unknown> {
    const declaration = this.slots.get(world)?.world.webUi?.(language);
    if (!declaration?.invoke || !declaration.panels?.some((item) => item.id === panel)) throw new Error('unknown_world_panel');
    return declaration.invoke(panel, method, args);
  }
  setSecret(world: string, name: string, value: string): void { if (!this.slots.has(world)) throw new Error('unknown_world'); this.secrets.set(world, name, value); }
  configure(world: string, key: string, value: unknown, language: Language): void {
    const config = this.configuration(world, language);
    const schema = config?.groups.flatMap((group) => Object.entries(group.schema.properties)).find(([name]) => name === key)?.[1];
    if (!config || !schema) throw new Error('unknown_config_key');
    const parts = configPath(world, key); validateValue(value, schema as PropertySchema);
    const previous = structuredClone(config.config);
    assignPath(config.config as unknown as Record<string, unknown>, parts, value);
    try { this.persist(); } catch (error) { Object.assign(config.config, previous); throw error; }
  }

  configuration(id: string, language: import('cortico/core/language.ts').Language) {
    const slot = this.slots.get(id);
    return slot ? { id, label: slot.definition.label, config: this.config.worlds[id],
                    secrets: this.secrets.names(id), panels: slot.world.webUi?.(language).panels ?? [], groups: slot.world.webUi?.(language).config ?? [] } : null;
  }
}
