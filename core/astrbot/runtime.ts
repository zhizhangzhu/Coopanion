/** Terminal process: local Worlds and HTTP settings, with decisions delegated to AstrBot. */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopPetDefinition, type DesktopPetWorld } from 'cortico-world-desktop-pet';
import { loadExtensions, ExtensionManager } from 'cortico/extensions.ts';
import { isLanguage } from 'cortico/core/language.ts';
import type { WorldDefinition, WorldSection } from 'cortico/world.ts';
import { TerminalHost, type HostConfig } from './host.ts';
import { TerminalConnection } from './connection.ts';
import { pairing, type Pairing, type TerminalState } from './protocol.ts';
import { coreText } from '../i18n/index.ts';

export async function main(): Promise<void> {
  const root = process.env.ASTRBOT_TERMINAL_DATA;
  if (!root) throw new Error('terminal_data_required');
  mkdirSync(root, { recursive: true });
  let path = join(root, 'unpaired-worlds.local.json');
  let config: HostConfig = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as HostConfig
    : { name: '小小情', timezone: 'Asia/Shanghai', worlds: {} };
  const persist = () => {
    writeFileSync(path + '.tmp', JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  };
  const state: TerminalState = { ready: true, body: false, visible: false, locked: false, suspended: false, dnd: false };
  let online = false;
  let lastError = '';
  let connection: TerminalConnection | null = null;
  let pet: DesktopPetWorld | null = null;
  const language = isLanguage(process.env.COOPANION_SYSTEM_LANGUAGE) ? process.env.COOPANION_SYSTEM_LANGUAGE : 'en';
  let host = new TerminalHost(join(root, 'unpaired'), config, persist);
  const definition = desktopPetDefinition({
    confirmPresentation: true,
    language: () => language, modelLanguage: () => 'en',
    onCreate: (value) => { pet = value; },
    controls: {
      isPaused: () => state.dnd,
      setPaused: (paused) => { state.dnd = paused; config.dnd = paused; persist(); void connection?.refresh(); },
      openSettings: () => process.send?.({ type: 'terminal:open' }),
      openDress: () => process.send?.({ type: 'terminal:dress', url: (pet as DesktopPetWorld | null)?.petState().dressUrl }),
      quit: () => process.send?.({ type: 'terminal:quit' }),
      quitLabel: () => coreText(language).quit,
    },
  });
  const terminalDefaults = () => {
    const defaults = definition.defaults();
    defaults.enabled = true;
    defaults.asr.enabled = false;
    return defaults;
  };
  config.worlds[definition.id] ??= terminalDefaults();
  const definitions = new Map<string, WorldDefinition<WorldSection>>([[definition.id, definition as WorldDefinition<WorldSection>]]);
  const extensions = await loadExtensions(root, { reserved: [definition.id] });
  const manager = new ExtensionManager(root, extensions);
  for (const extension of extensions.worlds) definitions.set(extension.id, extension);
  for (const extension of definitions.values()) await host.enable(extension);
  persist();
  const connect = async (value: unknown) => {
    const pair = pairing(value);
    await connection?.shutdown();
    await host.stop();
    const deviceRoot = join(root, 'devices', pair.device_id);
    path = join(deviceRoot, 'worlds.local.json');
    config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as HostConfig
      : { name: '小小情', timezone: 'Asia/Shanghai', worlds: { [definition.id]: terminalDefaults() } };
    state.dnd = config.dnd === true;
    host = new TerminalHost(deviceRoot, config, persist);
    for (const extension of definitions.values()) await host.enable(extension);
    persist();
    const terminalHost = host;
    const terminalPet = pet;
    const terminal = new TerminalConnection(pair, {
      state: () => {
        const body = (terminalPet as DesktopPetWorld | null)?.petState();
        return { ...state, body: body?.connected === true, visible: body?.onDesktop === true };
      },
      catalog: () => terminalHost.catalog(),
      call: (world, tool, arguments_, signal, attachments) => terminalHost.call(world, tool, arguments_, signal, attachments),
      connected: (connected, reason) => { online = connected; lastError = connected ? '' : reason ?? ''; process.send?.({ type: 'terminal:status', online }); },
      error: (reason) => { lastError = reason; },
    }, join(root, 'devices', pair.device_id, 'journal.local.json'));
    connection = terminal;
    terminalHost.onEvent = (event) => { terminal.event(event); void terminal.refresh(true); };
    terminal.start();
  };
  let pairingQueue = Promise.resolve();
  process.on('message', (message: unknown) => {
    const m = message as { type?: string; pairing?: Pairing; state?: Partial<TerminalState> };
    if (m?.type === 'terminal:pairing') pairingQueue = pairingQueue.then(() => connect(m.pairing)).catch(() => { online = false; });
    if (m?.type === 'terminal:state') { Object.assign(state, m.state); void connection?.refresh(); }
    if (m?.type === 'terminal:shutdown') void stop();
    if (m?.type === 'terminal:open-dress') process.send?.({ type: 'terminal:dress', url: (pet as DesktopPetWorld | null)?.petState().dressUrl });
  });
  const token = randomUUID();
  const server = createServer((request, response) => {
    void serve().catch(() => { if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"terminal_operation_failed"}'); });
    async function serve() {
    const origin = request.headers.origin;
    if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '') || request.headers.authorization !== 'Bearer ' + token || origin) {
      response.writeHead(403).end(); return;
    }
    const reply = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET' && request.url === '/terminal/status') {
      reply({ online, state, error: lastError, catalog: await host.catalog(), extensions: manager.list(language) });
    } else if (request.method === 'POST' && request.url === '/terminal/disconnect') {
      connection?.stop(); connection = null; host.onEvent = null; reply({ online: false });
    } else if (request.method === 'POST' && request.url === '/terminal/dnd') {
      state.dnd = !state.dnd; config.dnd = state.dnd; persist(); void connection?.refresh(); reply({ dnd: state.dnd });
    } else if (request.method === 'POST' && request.url === '/terminal/show') {
      (pet as DesktopPetWorld | null)?.openWindow(); reply({});
    } else if (request.method === 'GET' && request.url === '/terminal/extensions/search') {
      reply(await manager.search('world'));
    } else if (request.method === 'GET' && request.url === '/terminal/worlds') {
      reply([...definitions.keys()].map((id) => host.configuration(id, language)).filter(Boolean));
    } else if (request.method === 'POST' && request.url === '/terminal/restart') {
      reply({}); process.send?.({ type: 'terminal:restart' });
    } else if (request.method === 'POST' && ['/terminal/extensions/install', '/terminal/extensions/remove', '/terminal/world'].includes(request.url ?? '')) {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 65536) { reply({ error: 'body_too_large' }, 413); return; } }
      const data = JSON.parse(raw) as { name?: string; id?: string; enabled?: boolean; key?: string; value?: unknown };
      if (request.url === '/terminal/extensions/install') {
        if (typeof data.name !== 'string') throw new Error('package_required');
        const target = { name: data.name };
        await manager.check(target, 'world', language);
        reply({ message: await manager.install(target, language), pending_restart: true });
      } else if (request.url === '/terminal/extensions/remove') {
        if (typeof data.name !== 'string') throw new Error('package_required');
        const record = extensions.records.find((r) => r.name === data.name);
        if (record?.worldId) { await host.disable(record.worldId); definitions.delete(record.worldId); await connection?.refresh(true); }
        reply({ message: await manager.uninstall(data.name, language), pending_restart: true });
      } else {
        const id = data.id;
        const definition = typeof id === 'string' ? definitions.get(id) : undefined;
        if (!definition || !id) throw new Error('unknown_world');
        const cfg = config.worlds[id] ??= definition.defaults();
        if (typeof data.enabled === 'boolean') cfg.enabled = data.enabled;
        if (data.key !== undefined) {
          const prefix = `worlds.${id}.`;
          const schema = host.configuration(id, language)?.groups.flatMap((g) => Object.entries(g.schema.properties ?? {})).find(([key]) => key === data.key)?.[1];
          const key = data.key;
          if (!schema || !key.startsWith(prefix)) throw new Error('unknown_config_key');
          const parts = key.slice(prefix.length).split('.');
          if (parts.some((p) => !p || ['__proto__', 'prototype', 'constructor'].includes(p))) throw new Error('invalid_config_key');
          const value = data.value;
          if (schema.type === 'boolean' ? typeof value !== 'boolean' : schema.type === 'integer' ? typeof value !== 'number' || !Number.isSafeInteger(value)
            : schema.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : schema.type === 'string' ? typeof value !== 'string' || value.length > 4096 : true) throw new Error('invalid_config_value');
          if (schema.enum && !schema.enum.includes(value as never)) throw new Error('invalid_config_option');
          if (typeof value === 'number' && ((typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))) throw new Error('config_out_of_range');
          let target = cfg as unknown as Record<string, unknown>;
          for (const part of parts.slice(0, -1)) { if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {}; target = target[part] as Record<string, unknown>; }
          target[parts.at(-1)!] = value;
        }
        persist(); await host.enable(definition); await connection?.refresh(true); reply({});
      }
    } else reply({ error: 'unknown_route' }, 404);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('terminal_listen_failed');
  process.send?.({ type: 'terminal:ready', port: address.port, token });
  const timer = setInterval(() => { void connection?.refresh(); }, 2000);
  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await connection?.shutdown();
    await host.stop();
    server.close();
    process.exit(0);
  }
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}
