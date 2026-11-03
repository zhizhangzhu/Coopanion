import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createNativeTerminal } from '../core/astrbot/native.ts';
const panelRoute = (page: string, panel: string, method: string) => `/api/webui/providers/${encodeURIComponent(page)}/panels/${panel}/${method}`;
const panelStreamRoute = (page: string, panel: string) => `/ws/providers/${encodeURIComponent(page)}/panels/${panel}`;
it('serves original configuration, panels and chat while bypassing every local model decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'astrbot-native-'));
  const oldDisplay = process.env.DISPLAY;
  if (process.platform === 'linux' && !oldDisplay) process.env.DISPLAY = ':99';
  const oldExtensions = process.env.CORTICO_EXTENSIONS_DIR;
  process.env.CORTICO_EXTENSIONS_DIR = join(root, 'extensions');
  const opened: string[] = [];
  const runtime = await createNativeTerminal({ root, language: 'zh', window: false, onOpen: (route) => opened.push(route) });
  const base = `http://127.0.0.1:${runtime.port}`;
  let socket: WebSocket | undefined;
  try {
    const get = async (path: string) => { const response = await fetch(base + path); expect(response.ok).toBe(true); return response.json() as Promise<Record<string, any>>; };
    const manifest = await get('/api/webui/manifest');
    expect(manifest.providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'world:desktop-pet', availability: 'active', client: expect.objectContaining({ js: expect.any(String) }) })]));
    expect((await get('/api/config')).groups).toEqual(expect.any(Array));
    expect((await get('/api/status')).astrbot).toMatchObject({ online: false, paired: false });
    const connection = await fetch(base+panelRoute('world:astrbot-ui','connection','status'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: [] }) });
    expect(connection.ok).toBe(true); expect(await connection.json()).toMatchObject({ online: false });
    const config = await fetch(base+'/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group: 'world:desktop-pet', values: { 'worlds.desktop-pet.roam': 'calm' } }) });
    expect(config.ok).toBe(true);
    for (const [group, key] of [['core','displayName'],['core','timezone'],['world:desktop-pet','worlds.desktop-pet.user']]) {
      const locked = await fetch(base+'/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({group,values:{[key!]: 'Local override'}}) });
      expect(locked.ok).toBe(false); expect(await locked.text()).toContain(key === 'timezone' ? 'timezone' : 'astrbot_managed_setting');
    }
    const available = (await runtime.bridge.catalog()).worlds as Array<{ id: string; tools: Array<{ name: string }> }>;
    const desktop = available.find((world) => world.id === 'desktop-pet')!;
    expect(desktop.tools.some((tool) => tool.name === 'pet_cua_open_settings')).toBe(true);
    expect(desktop.tools.some((tool) => tool.name === 'pet_cua_key')).toBe(false);
    const settingsResult = await runtime.bridge.call('desktop-pet', 'pet_cua_open_settings', {}, new AbortController().signal);
    expect(settingsResult.status).toBe('completed');
    expect(opened).toContain('#/pet?cua=enable');
    const received: Record<string, unknown>[] = []; runtime.bridge.onEvent = (event) => { received.push(event); };
    const model = vi.spyOn(runtime.bot.core.llm, 'respond');
    socket = new WebSocket(base.replace('http','ws')+panelStreamRoute('world:desktop-pet','chat')+'?language=zh', { headers: { Origin: base } });
    await new Promise<void>((resolve,reject) => { socket!.once('open',resolve);socket!.once('error',reject); });
    const frames: Record<string, any>[] = []; socket.on('message', (data) => frames.push(JSON.parse(String(data))));
    socket.send(JSON.stringify({ t: 'hello' }));
    socket.send(JSON.stringify({ t: 'send', id: 1, text: 'Native original chat input', images: [] }));
    await expect.poll(() => received.some((e) => e.text === 'Native original chat input')).toBe(true);
    const event = received.find((e) => e.text === 'Native original chat input')!;
    runtime.bridge.lifecycle({ kind: 'accepted', cursor: event.cursor });
    await expect.poll(() => frames.some((f) => f.t === 'transport' && f.status === 'accepted')).toBe(true);
    expect(frames.some((f) => f.t === 'settled')).toBe(false);
    runtime.bridge.lifecycle({ kind: 'delivered', cursor: event.cursor });
    await expect.poll(() => frames.some((f) => f.t === 'settled')).toBe(true);
    expect(runtime.bot.core.bus.pendingImmediate()).toBe(0); expect(model).not.toHaveBeenCalled();
    expect((await runtime.bridge.catalog()).worlds).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'desktop-pet', supported: true })]));
  } finally { socket?.close(); await runtime.stop(); if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay; if (oldExtensions === undefined) delete process.env.CORTICO_EXTENSIONS_DIR; else process.env.CORTICO_EXTENSIONS_DIR = oldExtensions; rmSync(root, { recursive: true, force: true }); }
}, 30000);
it('restores paused chat input and its pending indicator across a full native runtime restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'astrbot-native-recovery-'));
  const previous = process.env.CORTICO_EXTENSIONS_DIR; process.env.CORTICO_EXTENSIONS_DIR = join(root,'extensions');
  let runtime = await createNativeTerminal({ root, language: 'en', window: false });
  let socket: WebSocket | undefined;
  try {
    runtime.bridge.onEvent = () => { throw Error('Paused input must not be transmitted'); };
    runtime.bot.core.bus.setPaused(true);
    const connect = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}`+panelStreamRoute('world:desktop-pet','chat'), { headers: { Origin: `http://127.0.0.1:${runtime.port}` } });
      await new Promise<void>((resolve,reject) => { ws.once('open',resolve);ws.once('error',reject); });return ws;
    };
    socket = await connect(); const frames: Record<string, any>[] = []; socket.on('message', (data) => frames.push(JSON.parse(String(data))));
    socket.send(JSON.stringify({ t:'send', id:1, text:'Queued before restart', images:[] }));
    await expect.poll(() => frames.some((f) => f.t==='sent')).toBe(true);
    const cursor = frames.find((f) => f.t==='sent')!.cursor;
    socket.close(); await runtime.stop();
    runtime = await createNativeTerminal({ root, language:'en', window:false });
    expect(runtime.bot.core.bus.isPaused()).toBe(true);
    socket = await connect(); const recovered: Record<string, any>[] = []; socket.on('message', (data) => recovered.push(JSON.parse(String(data))));
    socket.send(JSON.stringify({ t:'hello' }));
    await expect.poll(() => recovered.some((f) => f.t==='init' && f.pending.includes(cursor))).toBe(true);
    const delivered: Record<string, unknown>[] = []; runtime.bridge.onEvent = (event) => { delivered.push(event); };
    runtime.bridge.flush(); expect(delivered).toEqual([]);
    runtime.bot.core.bus.setPaused(false); runtime.bridge.flush();
    expect(delivered).toEqual([expect.objectContaining({ cursor, text:'Queued before restart' })]);
    runtime.bridge.lifecycle({ kind:'delivered',cursor });
  } finally { socket?.close(); await runtime.stop(); if (previous===undefined) delete process.env.CORTICO_EXTENSIONS_DIR;else process.env.CORTICO_EXTENSIONS_DIR=previous;rmSync(root,{recursive:true,force:true}); }
},30000);
