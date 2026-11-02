import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import type { WorldDefinition, WorldSection } from 'cortico/world.ts';
import { TerminalHost } from '../core/astrbot/host.ts';
import { decode, frame, pairing } from '../core/astrbot/protocol.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'terminal-test-')); dirs.push(dir); return dir; };

describe('terminal wire boundary', () => {
  it.each(['ws://127.0.0.1/terminal/v1', 'https://localhost/', 'wss://user:pass@localhost/', 'wss://localhost/?token=value'])('refuses %s', (url) => {
    expect(() => pairing({ v: 1, url, ca: '-----BEGIN CERTIFICATE-----', token: 'x'.repeat(32), device_id: 'device' })).toThrow();
  });
  it.each(['null', '[]', '{}', '{"v":2}', '{"v":1,"type":"call","id":"x","payload":[]}'])('rejects malformed frame %s', (value) => {
    expect(() => decode(value)).toThrow();
  });
  it('keeps stable identities through serialization', () => {
    const message = frame('event', 'event-one', { text: 'hello', world: 'sample' });
    expect(decode(JSON.stringify(message))).toEqual(message);
  });
});

describe('World terminal host', () => {
  it('keeps sibling settings and live nested references when a World persists a partial change', async () => {
    const nested = { selected: 'initial', retained: 'keep' };
    const section = { enabled: true, nested };
    const host = new TerminalHost(root(), { name: 'Sample', timezone: 'UTC', worlds: { sample: section } }, () => {});
    await host.enable({ id: 'sample', label: 'Sample', defaults: () => section, create: (context) => ({
      id: 'sample', envPromptVars: () => ({}), start: async () => {}, stop: async () => {},
      tools: () => [{ name: 'configure', description: 'Update one setting.', parameters: {}, tags: ['act'], handler: async () => {
        const patch = { enabled: true, nested: { selected: 'changed' } };
        context.persist(patch);
        return { text: 'Setting saved.' };
      } }],
    }) });
    await host.call('sample', 'configure', {}, new AbortController().signal);
    expect(section.nested).toBe(nested);
    expect(nested).toEqual({ selected: 'changed', retained: 'keep' });
    await host.stop();
  });

  it('isolates an extension construction failure from another available World', async () => {
    const host = new TerminalHost(root(), { name: 'Sample', timezone: 'UTC', worlds: {} }, () => {});
    await host.enable({ id: 'broken', label: 'Broken', defaults: () => ({ enabled: true }), create: () => { throw new Error('missing_backend'); } });
    await host.enable({ id: 'healthy', label: 'Healthy', defaults: () => ({ enabled: true }), create: () => ({
      id: 'healthy', envPromptVars: () => ({}), tools: () => [], start: async () => {}, stop: async () => {},
    }) });
    expect((await host.catalog()).worlds).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'broken', supported: false, reason: 'missing_backend' }),
      expect.objectContaining({ id: 'healthy', supported: true }),
    ]));
    await host.stop();
  });
  it('discovers new tools and events, returns actual outcomes and removes stopped capabilities', async () => {
    let worldHost: WorldHost | undefined;
    let stopped = false;
    const definition: WorldDefinition<WorldSection> = {
      id: 'sample', label: 'Sample', defaults: () => ({ enabled: true }),
      create: () => ({
        id: 'sample', envPromptVars: () => ({ environment: 'A sample window is open.' }),
        tools: () => [{ name: 'sample_draw', description: 'Create a sample drawing.', parameters: { type: 'object' }, tags: ['act'],
          handler: async () => ({ text: 'A drawing was saved.', blobs: [{ bytes: Buffer.from('drawing'), mime: 'text/plain', fallbackText: 'drawing' }] }) }],
        start: async (host) => { worldHost = host; }, stop: async () => { stopped = true; },
      }),
    };
    const host = new TerminalHost(root(), { name: 'Sample', timezone: 'UTC', worlds: {} }, () => {});
    const events: Record<string, unknown>[] = []; host.onEvent = (e) => { events.push(e); };
    await host.enable(definition);
    const catalog = await host.catalog() as { worlds: Array<{ id: string; tools: Array<{ name: string }> }> };
    expect(catalog.worlds[0].tools.map((t) => t.name)).toEqual(['sample_draw']);
    await worldHost!.pushEvent({ type: 'sample.touch', source: 'other', ts: new Date().toISOString(), text: 'The person touched the body.' });
    expect(events[0].world).toBe('sample');
    expect(events[0].event_type).toBe('sample.touch');
    const result = await host.call('sample', 'sample_draw', {}, new AbortController().signal);
    expect(result.status).toBe('completed');
    const blobs = result.attachments as Array<{ base64: string }>;
    expect(Buffer.from(blobs[0].base64, 'base64').toString()).toBe('drawing');
    await host.disable('sample');
    expect(stopped).toBe(true);
    expect((await host.catalog()).worlds).toEqual([]);
    expect((await host.call('sample', 'sample_draw', {}, new AbortController().signal)).status).toBe('failed');
  });

  it('preserves self speech as execution evidence without turning it into another user event', async () => {
    let worldHost: WorldHost;
    const host = new TerminalHost(root(), { name: 'Sample', timezone: 'UTC', worlds: {} }, () => {});
    const events: unknown[] = []; host.onEvent = (e) => { events.push(e); };
    await host.enable({ id: 'sample', label: 'Sample', defaults: () => ({ enabled: true }), create: () => ({
      id: 'sample', envPromptVars: () => ({}),
      tools: () => [{ name: 'sample_say', description: 'Speak.', parameters: {}, tags: ['speak'], handler: async () => {
        await worldHost.pushEvent({ source: 'sample', type: 'sample.self', ts: new Date().toISOString(), text: 'Would you like to draw together?' }, { deliver: false });
        return { text: 'Submitted to the renderer.' };
      } }], start: async (value) => { worldHost = value; }, stop: async () => {},
    }) });
    const result = await host.call('sample', 'sample_say', {}, new AbortController().signal);
    expect(result.outputs).toEqual([expect.objectContaining({ text: 'Would you like to draw together?' })]);
    expect(events).toEqual([]);
    await host.stop();
  });

  it('cancels before effects and reports interrupted results as unknown', async () => {
    const host = new TerminalHost(root(), { name: 'Sample', timezone: 'UTC', worlds: {} }, () => {});
    let effects = 0;
    const cancel = new AbortController();
    await host.enable({ id: 'sample', label: 'Sample', defaults: () => ({ enabled: true }), create: () => ({
      id: 'sample', envPromptVars: () => ({}), start: async () => {}, stop: async () => {},
      tools: () => [{ name: 'sample_act', description: 'Act.', parameters: {}, tags: ['act'], handler: async () => {
        effects++; cancel.abort(); return { text: 'Effect started; cancellation requested.' };
      } }],
    }) });
    expect((await host.call('sample', 'sample_act', {}, cancel.signal)).status).toBe('unknown');
    expect((await host.call('sample', 'sample_act', {}, cancel.signal)).status).toBe('cancelled');
    expect(effects).toBe(1);
    await host.stop();
  });
});
