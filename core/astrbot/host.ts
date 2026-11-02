/** Runs enabled Worlds for AstrBot without a local Persona or model loop. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import type { BlobInput, BlobRef, EventEnvelope, ToolOutcome, World, WorldHost } from 'cortico/core/types.ts';
import type { WorldContext, WorldDefinition, WorldSection } from 'cortico/world.ts';

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
  private readonly outputs = new Map<string, Array<Record<string, unknown>>>();
  private readonly store: JsonlEventStore;
  private readonly log = nullLogger();
  private readonly blobDir: string;
  onEvent: ((payload: Record<string, unknown>) => void) | null = null;
  constructor(readonly root: string, readonly config: HostConfig, private persist: () => void) {
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

  private readBlob(handle: string): { bytes: Uint8Array; mime: string } | null {
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
    const context: WorldContext<WorldSection> = {
      id, cfg, timezone: this.config.timezone, botName: this.config.name, botDir: this.root,
      packageDir: fileURLToPath(new URL('../../', import.meta.url)), dataDir: this.root,
      repoRoot: fileURLToPath(new URL('../../', import.meta.url)),
      secret: (name) => process.env[name] ?? '',
      storeSecret: () => { throw new Error('terminal_secret_storage_not_supported'); },
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
      drainPendingEvents: async () => { throw new Error('world_requires_event_handoff_support'); },
      pushDeferred: () => { throw new Error('world_requires_deferred_delivery_support'); },
      pushEvent: async (e, options) => {
        const { blobs, ...rest } = e;
        const saved = this.store.append({ ...rest, source: id, origin: 'external',
          ...(blobs ? { blobs: blobs.map((b) => this.blob(b)) } : {}) });
        if (options?.deliver === false) {
          const active = this.outputs.get(id);
          active?.push({ type: e.type, text: e.text, meta: e.meta });
        } else {
          this.onEvent?.({ world: id, event_type: e.type,
                          text: typeof e.meta?.text === 'string' ? e.meta.text : e.text, occurred_at: e.ts,
                          ...(e.meta && Buffer.byteLength(JSON.stringify(e.meta)) <= 4000 ? { interaction: e.meta } : {}),
                          origin: 'external', trigger: options?.trigger ?? 'preempt', cursor: saved.cursor,
                          ...(saved.blobs ? { attachments: saved.blobs.map((b) => this.wireBlob(b)) } : {}) });
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
      worlds.push({ id, label: slot.definition.label, supported: slot.enabled, compatibility: 'tools-and-immediate-events',
                    limitations: ['deferred-delivery', 'handoff', 'output-stream', 'background-cognition'],
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

  async call(worldId: string, toolName: string, arguments_: Record<string, unknown>, signal: AbortSignal, attachments?: unknown): Promise<Record<string, unknown>> {
    const slot = this.slots.get(worldId);
    const tool = slot?.enabled ? slot.world.tools().find((t) => t.name === toolName) : undefined;
    if (!slot || !tool) return { status: 'failed', text: 'tool_not_available' };
    if (signal.aborted) return { status: 'cancelled', text: 'cancelled_before_execution' };
    if (this.outputs.has(worldId)) return { status: 'failed', text: 'world_busy' };
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
    this.outputs.set(worldId, outputs);
    try {
      const value = await tool.handler(arguments_, { role: 'remote', log: this.log, callId: randomUUID(), signal });
      const outcome: ToolOutcome = typeof value === 'string' ? { text: value } : value;
      const blobs = outcome.blobs?.map((b) => this.blob(b));
      // Existing pet speech receipts confirm submission to the renderer, not display completion.
      const confirmed = (outcome as ToolOutcome & { presentationConfirmed?: boolean }).presentationConfirmed === true;
      const submitted = worldId === 'desktop-pet' && ['pet_say', 'pet_ask', 'pet_act'].includes(toolName) && !confirmed;
      return { status: outcome.failed ? 'failed' : signal.aborted ? 'unknown' : submitted ? 'submitted' : 'completed',
               text: outcome.text, outputs, ...(blobs ? { attachments: blobs.map((b) => this.wireBlob(b)) } : {}) };
    } finally { this.outputs.delete(worldId); }
  }

  async stop(): Promise<void> { for (const id of [...this.slots.keys()]) await this.disable(id); }

  configuration(id: string, language: import('cortico/core/language.ts').Language) {
    const slot = this.slots.get(id);
    return slot ? { id, label: slot.definition.label, config: this.config.worlds[id],
                    groups: slot.world.webUi?.(language).config ?? [] } : null;
  }
}
