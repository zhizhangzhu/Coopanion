/** Original Coopanion UI and native Worlds; AstrBot remains the sole conversational runtime. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBot, type Bot, type BotDefinition } from 'cortico/bot.ts';
import { CORE_DEFAULTS, cloneConfigValue } from 'cortico/core/config.ts';
import { getByPath, type ConfigGroup } from 'cortico/core/config-schema.ts';
import { LANGUAGES, LANGUAGE_NAMES, isLanguage, type Language } from 'cortico/core/language.ts';
import type { CoreConfig, Persona, World } from 'cortico/core/types.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { loadDeployment } from 'cortico/deploy.ts';
import { loadExtensions } from 'cortico/extensions.ts';
import { withWorlds, type WorldDefinition, type WorldSection } from 'cortico/world.ts';
import { CONSOLE } from 'cortico/worlds/console/definition.ts';
import { desktopPetDefinition, type DesktopPetWorld } from 'cortico-world-desktop-pet';
import { bundledWebUiAssets, appWebUiAsset } from '../bundled-panels.ts';
import { followPetLook } from '../console-theme.ts';
import { noticeDefinition, NOTICE_ID } from '../notice.ts';
import { coreText } from '../i18n/index.ts';
import { NativeBridge } from './native-bridge.ts';
import { TerminalConnection } from './connection.ts';
import { pairing, type Pairing, type TerminalState } from './protocol.ts';
import { syncQQAvatar } from './avatar.ts';
const APP = fileURLToPath(new URL('../../', import.meta.url));
interface NativeConfig extends CoreConfig { worlds: Record<string, WorldSection>; companion: { telemetry: boolean; contextRing: boolean; autoUpdate: boolean } }
export interface NativeTerminalOptions { root: string; language?: Language; window?: boolean; onReady?(value: { port: number; dataDir: string; language: Language }): void; onOpen?(route: string): void; onQuit?(): void }
export async function createNativeTerminal(options: NativeTerminalOptions) {
  let bot: Bot<NativeConfig> | null = null, bridge: NativeBridge | null = null, connection: TerminalConnection | null = null;
  let config: NativeConfig, pet: DesktopPetWorld | null = null;
  let online = false, error = '', selected: Pairing | null = null, binding: Record<string, unknown> = {};
  let identity: Record<string, unknown> = {}, identityAt = 0;
  let directory = '', language: Language = options.language ?? 'en';
  const nativeState: TerminalState = { ready: true, body: false, visible: false, locked: false, suspended: false, screen_off: false, dnd: false };
  const state = (): TerminalState => { const body = pet?.petState(); return { ...nativeState, dnd: bot?.core.bus.isPaused() ?? nativeState.dnd, body: body?.connected === true, visible: body?.onDesktop === true }; };
  const status = () => ({ online, error, paired: selected !== null, server: selected ? new URL(selected.url).origin : '', binding, identity, state: state() });
  const service: WorldDefinition<WorldSection> = {
    id: 'astrbot-ui', label: 'AstrBot', defaults: () => ({ enabled: true }), create: () => ({
      id: 'astrbot-ui', envPromptVars: () => null, tools: () => [], start: async () => {}, stop: async () => {},
      webUi: () => ({ panels: [{ id: 'connection', title: 'AstrBot' }], invoke: async (_panel, method, args) => {
        if (method === 'status') return status();
        if (method === 'reconnect') { if (selected && !connection) { const value = selected; queue = queue.then(() => start(value)).catch(() => {}); } return status(); }
        if (method === 'disconnect') { await connection?.shutdown(); connection = null; if (bridge) bridge.onEvent = null; online = false; return status(); }
        if (method === 'history' || method === 'persona' || method === 'usage' || method === 'identity') {
          if (!connection) throw new Error('astrbot_offline');
          return connection.request('query', { kind: method, ...(method === 'history' && typeof args[0] === 'number' ? { before: args[0] } : {}) });
        }
        throw new Error('unknown_astrbot_method');
      } }),
    }),
  };
  const extensions = await loadExtensions(APP, { reserved: [CONSOLE.id, 'desktop-pet', service.id, NOTICE_ID] });
  extensions.webUiAssets.push(...bundledWebUiAssets([{ id: 'desktop-pet', packageName: 'cortico-world-desktop-pet' }]), ...appWebUiAsset(NOTICE_ID, join(APP, 'build/panels/coopanion'), process.env.COOPANION_VERSION ?? 'dev'));
  async function start(pair: Pairing | null) {
    const oldConnection = connection; connection = null; await oldConnection?.shutdown();
    const oldBot = bot;
    if (oldBot && directory) writeFileSync(join(directory, 'dnd.local.json'), JSON.stringify({ dnd: oldBot.core.bus.isPaused() }));
    bot = null; await oldBot?.stop(); bridge = null; pet = null; online = false; binding = {};
    selected = pair; identity = {}; identityAt = 0;
    directory = join(options.root, pair ? 'devices/'+pair.device_id+'/native' : 'unpaired-native');
    mkdirSync(directory, { recursive: true });
    const localBridge = new NativeBridge(directory); bridge = localBridge;
    const presentation = { persona: '', tokens: null as number | null };
    const petDefinition = desktopPetDefinition({ confirmPresentation: true, botName: () => String(identity.bot_name ?? 'Bot'), language: () => language, modelLanguage: () => 'en',
      onCreate: (world) => { pet = world; },
      controls: { isPaused: () => state().dnd, setPaused: (paused) => { bot?.core.bus.setPaused(paused); nativeState.dnd = paused; void connection?.refresh(); },
        openSettings: () => options.onOpen?.('#/pet'), openCuaSettings: () => options.onOpen?.('#/pet?cua=enable'), openChat: () => options.onOpen?.('#/chat'), openDress: () => options.onOpen?.('#/dress'),
        guide: async () => { options.onOpen?.('#/home'); }, quit: () => options.onQuit?.(), quitLabel: () => coreText(language).quit },
    });
    const cfgDefaults = petDefinition.defaults(); cfgDefaults.enabled = true; cfgDefaults.skin.figure = 'whale'; cfgDefaults.skin.scheme = 'deepseek'; cfgDefaults.asr.enabled = false;
    if (options.window === false) cfgDefaults.window.enabled = false;
    const wrappedPet: WorldDefinition<WorldSection> = { ...petDefinition, defaults: () => cfgDefaults } as WorldDefinition<WorldSection>;
    const settings = (lang: Language): ConfigGroup => { const s = coreText(lang).settings; return { id: 'companion', owner: 'persona', schema: { type: 'object', title: 'Coopanion', properties: {
      language: { type: 'string', title: s.language.title, enum: [...LANGUAGES], 'x-options': 'coopanion.language', 'x-hot': true },
      'companion.telemetry': { type: 'boolean', title: s.telemetry.title, description: s.telemetry.description },
      'companion.contextRing': { type: 'boolean', title: s.contextRing.title, description: s.contextRing.description },
    } } }; };
    const group = settings(language);
    const base: BotDefinition<NativeConfig> = { id: 'astrbot-terminal', memoryName: 'AstrBot', declares: [CONSOLE.id, 'desktop-pet', service.id, NOTICE_ID],
      defaults: () => ({ ...cloneConfigValue(CORE_DEFAULTS), displayName: String(binding.persona_id ?? 'AstrBot'), timezone: 'Asia/Shanghai', language,
        web: { host: '127.0.0.1', port: 0, theme: 'mint' }, worlds: {}, companion: { telemetry: false, autoUpdate: false, contextRing: false } }),
      build: (loaded) => {
        config = loaded.config;
        const persona: Persona = { memoryDir: loaded.memoryDir, blobs: { put: () => { throw new Error('memory_managed_by_astrbot'); }, get: () => null, list: () => [] },
          attach: () => {}, systemSegments: async () => presentation.persona ? [{ title: 'AstrBot', text: presentation.persona }] : [], ownToolNames: () => [], declareSessions: () => [{ id: 'main', label: 'AstrBot', persistent: true, receivesEvents: true, tools: () => [], rounds: () => ({ soft: 1, hard: 1 }) }] };
        return { persona, llm: { respond: async () => { throw new Error('local_model_disabled_use_astrbot'); } }, webUi: {
          configGroups: [group], configOptions: (kind) => kind === 'coopanion.language' ? LANGUAGES.map((value) => ({ value, label: LANGUAGE_NAMES[value] })) : [],
          status: () => ({ astrbot: status(), displayName: config.displayName, loop: { estTokens: presentation.tokens, context: { hardTokens: null } }, modelConnection: { ready: online, moduleTitle: 'AstrBot', model: String(identity.model_id || 'AstrBot'), name: String(identity.model_id || 'AstrBot') } }),
        } };
      },
    };
    const notice = noticeDefinition({ version: process.env.COOPANION_VERSION ?? 'dev', notesDir: join(APP, 'docs/releases'), stateFile: join(directory, 'notice.json'), alarmsFile: join(directory, 'alarms.json'), newInstall: () => true, read: (path) => getByPath(config as unknown as Record<string, unknown>, path), petConnected: () => (pet as DesktopPetWorld | null)?.petState().connected === true, guiding: () => false, refreshTools: async () => { await bot?.core.loop.reloadSystemPrefix(); }, label: () => coreText(language).noticeLabel });
    const definitions = [CONSOLE, wrappedPet, service, notice, ...extensions.worlds] as WorldDefinition<WorldSection>[];
    const definition = withWorlds(base, definitions.map((item) => item.id === service.id ? item : localBridge.wrap(item)));
    const loaded = loadDeployment(definition, directory, process.env.CORTICO_COMPANION_ROOT ?? join(APP, 'build/cortico'), APP);
    // Migrate the terminal's own settings only; no persona, conversation or model credentials are copied.
    const previous = join(options.root, pair ? 'devices/'+pair.device_id+'/worlds.local.json' : 'unpaired-worlds.local.json');
    if (!existsSync(join(directory, 'config.json')) && existsSync(previous)) {
      const value = JSON.parse(readFileSync(previous, 'utf8')) as { worlds?: NativeConfig['worlds']; name?: string };
      if (value.worlds) loaded.config.worlds = { ...loaded.config.worlds, ...value.worlds };
      if (value.name) loaded.config.displayName = value.name;
    }
    config = loaded.config;
    const identityFile = join(directory, 'identity.local.json');
    identity = existsSync(identityFile) ? JSON.parse(readFileSync(identityFile, 'utf8')) as Record<string, unknown> : {};
    const managed = (object: object, key: string, field: string, fallback: string) => Object.defineProperty(object, key, { enumerable: true, configurable: false, get: () => String(identity[field] ?? fallback), set: (value: unknown) => { if (value !== String(identity[field] ?? fallback)) throw new Error('astrbot_managed_setting: '+key); } });
    managed(config, 'displayName', 'bot_name', 'Bot');
    managed(config, 'timezone', 'timezone', 'Asia/Shanghai');
    managed(config.worlds['desktop-pet']!, 'user', 'user_name', '');
    language = isLanguage(config.language) ? config.language : language;
    let lang: unknown = language;
    Object.defineProperty(config, 'language', { enumerable: true, configurable: true, get: () => lang, set: (next: unknown) => {
      lang = next; if (isLanguage(next) && next !== language) { language = next; Object.assign(group, settings(next)); pet?.refresh(); process.send?.({ type: 'companion:language', language: next }); }
    } });
    const localBot = createBot(loaded, definition, { extensions }); bot = localBot; localBridge.attach(localBot.core);
    const savedDnd = join(directory, 'dnd.local.json');
    const oldProfile = existsSync(previous) ? JSON.parse(readFileSync(previous, 'utf8')) as { dnd?: boolean } : {};
    nativeState.dnd = existsSync(savedDnd) ? JSON.parse(readFileSync(savedDnd, 'utf8')).dnd === true : oldProfile.dnd === true;
    localBot.core.bus.setPaused(nativeState.dnd);
    const info = await localBot.start(); if (info.port === null) throw new Error('native_console_unavailable');
    if (pair) {
      const terminal = new TerminalConnection(pair, { state, catalog: () => localBridge.catalog(), call: (...args) => localBridge.call(...args),
        connected: (value, reason) => { online = value; error = value ? '' : reason ?? ''; if (value) { localBridge.flush(); void syncIdentity(terminal, localBot); void terminal.request('query', { kind: 'persona' }).then(async (r) => { if (typeof r.text === 'string') { presentation.persona = r.text; await localBot.core.loop.reloadSystemPrefix(); } }).catch(() => {}); void terminal.request('query', { kind: 'usage' }).then((r) => { if (Array.isArray(r.items)) for (const item of r.items) localBridge.usage(item); }).catch(() => {}); } }, error: (reason) => { error = reason; },
        binding: (value) => { binding = value; },
        lifecycle: (value) => localBridge.lifecycle(value), output: (value) => { if (value.event) localBridge.output(value.event as StreamEvent); if (value.usage && typeof value.usage === 'object') { localBridge.usage(value.usage as Record<string, unknown>); presentation.tokens = Number((value.usage as Record<string, unknown>).promptTokens) || null; } },
      }, join(options.root, 'devices', pair.device_id, 'journal.local.json'));
      connection = terminal;
      localBridge.onEvent = (event) => terminal.event(event);
      localBridge.onChange = () => { void terminal.refresh(true); };
      localBridge.onCognition = async (world, request, parent) => {
        const result = await terminal.request('cognition', { world, ...request, ...(parent ? { parent_call_id: parent } : {}) }, 90000);
        return typeof result.text === 'string' ? { text: result.text } : { error: String(result.error ?? 'cognition_unavailable') };
      };
      terminal.start(); localBridge.flush();
    }
    followPetLook(directory, (config.worlds['desktop-pet'] as { skin?: { figure?: string; scheme?: string } })?.skin, (pet as DesktopPetWorld | null)?.packs() ?? [], language);
    options.onReady?.({ port: info.port, dataDir: loaded.dataDir, language });
    return { port: info.port, dataDir: loaded.dataDir, bridge: localBridge, bot: localBot };
  }
  async function syncIdentity(terminal: TerminalConnection, localBot: Bot<NativeConfig>): Promise<void> {
    identityAt = Date.now();
    try {
      const result = await terminal.request('query', { kind: 'identity' });
      if (connection !== terminal || bot !== localBot || result.persona_id !== binding.persona_id || result.user_id !== binding.user_id || typeof result.bot_name !== 'string' || typeof result.user_name !== 'string') return;
      identity = { persona_id: result.persona_id, user_id: result.user_id, bot_name: result.bot_name.slice(0,128), user_name: result.user_name.slice(0,128), timezone: String(result.timezone ?? 'Asia/Shanghai'), model_id: String(result.model_id ?? '') };
      const revision = syncQQAvatar(directory, result.avatar, String(binding.bot_id ?? ''));
      if (revision) identity.avatar_revision = revision;
      writeFileSync(join(directory, 'identity.local.json'), JSON.stringify(identity), { mode: 0o600 });
      writeFileSync(join(directory, 'config.json'), JSON.stringify(config, null, 2)); pet?.refresh();
    } catch { /* Keep the last verified server identity while offline. */ }
  }
  let queue = Promise.resolve<unknown>(undefined);
  const initial = await start(null);
  const timer = setInterval(() => {
    if (bot && bridge) {
      if (nativeState.dnd !== bot.core.bus.isPaused()) { nativeState.dnd = bot.core.bus.isPaused(); writeFileSync(join(directory, 'dnd.local.json'), JSON.stringify({ dnd: nativeState.dnd })); }
      if (!connection) return;
      bridge.flush(); void connection.refresh(); if (online && Date.now() - identityAt >= 30000) void syncIdentity(connection, bot);
    }
  }, 2000);
  return { ...initial, status, connect(value: unknown) { const pair = pairing(value); const result = queue.then(() => start(pair)); queue = result.catch(() => {}); return result; },
    setState(value: Partial<TerminalState>) { Object.assign(nativeState, value); void connection?.refresh(); },
    async stop() { clearInterval(timer); await queue; await connection?.shutdown(); if (bot && directory) writeFileSync(join(directory, 'dnd.local.json'), JSON.stringify({ dnd: bot.core.bus.isPaused() })); await bot?.stop(); },
  };
}
export async function main(): Promise<void> {
  const root = process.env.ASTRBOT_TERMINAL_DATA ?? join(process.env.CORTICO_HOME ?? join(APP, 'build/data/home'), 'astrbot-terminal');
  const runtime = await createNativeTerminal({ root, language: isLanguage(process.env.COOPANION_SYSTEM_LANGUAGE) ? process.env.COOPANION_SYSTEM_LANGUAGE : 'en',
    onReady: (value) => process.send?.({ type: 'companion:ready', ...value, keyMissing: false }),
    onOpen: (path) => process.send?.({ type: 'companion:open', path }), onQuit: () => process.send?.({ type: 'companion:quit' }),
  });
  process.on('message', (message: unknown) => {
    const value = message as { type?: string; pairing?: unknown; state?: Partial<TerminalState> };
    if (value.type === 'terminal:pairing') void runtime.connect(value.pairing).catch(() => process.send?.({ type: 'companion:open', path: '#/home' }));
    if (value.type === 'terminal:state') runtime.setState(value.state ?? {});
    if (value.type === 'companion:shutdown') void runtime.stop().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => { void runtime.stop().finally(() => process.exit(0)); });
}
