import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import { TerminalHost } from '../core/astrbot/host.ts';
import { validateValue, configPath } from '../core/astrbot/configuration.ts';
import { SecretVault } from '../core/astrbot/secrets.ts';
const dirs: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'astrbot-advanced-')); dirs.push(value); return value; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('keeps nested cognition tool receipts in the correct call and rejects unrelated re-entry', async () => {
  let api!: WorldHost;
  const host = new TerminalHost(root(), { name: 'Sample', timezone: 'UTC', worlds: {} }, () => {});
  await host.enable({ id: 'sample', label: 'Sample', defaults: () => ({ enabled: true }), create: () => ({
    id: 'sample', envPromptVars: () => ({}), start: async (h) => { api = h; }, stop: async () => {},
    tools: () => [
      { name: 'think', description: 'Request reasoning.', parameters: {}, tags: ['act'], handler: async () => api.cognition!.request({ brief: 'Choose an action.', tools: ['say'] }).then((r) => ({ text: JSON.stringify(r) })) },
      { name: 'say', description: 'Speak.', parameters: {}, tags: ['speak'], handler: async (_, ctx) => {
        await api.pushEvent({ source: 'sample', type: 'sample.self', ts: new Date().toISOString(), text: ctx.callId ?? 'missing' }, { deliver: false }); return { text: 'done' };
      } },
    ],
  }) });
  host.onCognition = async (world, _, parent) => {
    expect(parent).toBe('outer');
    expect((await host.call(world, 'say', {}, new AbortController().signal)).text).toBe('world_busy');
    const child = await host.call(world, 'say', {}, new AbortController().signal, undefined, { id: 'inner', parent_call_id: parent });
    expect(child.outputs).toEqual([expect.objectContaining({ text: 'inner' })]); return { text: 'reasoned' };
  };
  const result = await host.call('sample', 'think', {}, new AbortController().signal, undefined, { id: 'outer' });
  expect(result.status).toBe('completed'); expect(result.outputs).toEqual([]); await host.stop();
});
it('supports declared nested arrays and objects without crossing the World namespace', () => {
  const schema = { type: 'object', required: ['targets'], additionalProperties: false, properties: { targets: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 1 } } } };
  expect(() => validateValue({ targets: [1, 2] }, schema)).not.toThrow();
  for (const value of [{ targets: [] }, { targets: [1, 1] }, { targets: [-1] }, { targets: ['x'] }, { targets: [1], other: true }]) expect(() => validateValue(value, schema)).toThrow();
  expect(() => configPath('a', 'worlds.b.value')).toThrow();
  expect(() => configPath('a', 'worlds.a.__proto__.value')).toThrow();
});
it('persists encrypted per-World secrets and never exposes secret values in settings', () => {
  const key = randomBytes(32), path = join(root(), 'secrets');
  const encryption = {
    seal(data: Buffer) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(data), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    open(data: Buffer) { const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]); },
  };
  const vault = new SecretVault(path, encryption); vault.set('a', 'API_KEY', 'private-test-value');
  expect(readFileSync(path).includes(Buffer.from('private-test-value'))).toBe(false);
  const restored = new SecretVault(path, encryption); expect(restored.get('a', 'API_KEY')).toBe('private-test-value'); expect(restored.get('b', 'API_KEY')).toBe('');
  expect(restored.names('a')).toEqual(['API_KEY']); restored.set('a', 'API_KEY', ''); expect(restored.get('a', 'API_KEY')).toBe('');
});
it('forwards lifecycle settlements to the actual World and invalidates its panels on replacement', async () => {
  let api!: WorldHost, settled = 0, ended = 0;
  const host = new TerminalHost(root(), { name: 'Sample', timezone: 'UTC', worlds: {} }, () => {});
  host.onEvent = () => {};
  await host.enable({ id: 'sample', label: 'Sample', defaults: () => ({ enabled: true }), create: () => ({
    id: 'sample', envPromptVars: () => ({}), tools: () => [], start: async (h) => { api = h; }, stop: async () => {},
    onEventsSettled: () => { settled++; }, onTurnEnded: () => { ended++; }, webUi: () => ({ stream: (_, socket) => { socket.onMessage((text) => socket.send(text)); } }),
  }) });
  const event = await api.pushEvent({ source: 'sample', type: 'sample.input', ts: new Date().toISOString(), text: 'hello' });
  host.lifecycle({ kind: 'delivered', cursor: event.cursor }); host.lifecycle({ kind: 'finished' }); expect(settled).toBe(1); expect(ended).toBe(1);
  const panel = host.panelOpen('sample', 'chat', 'en'); host.panels.send(panel.session, { t: 'hello' }); expect(host.panels.poll(panel.session)).toEqual([{ t: 'hello' }]);
  await host.stop(); expect(() => host.panels.poll(panel.session)).toThrow();
});
