import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalConnection } from '../core/astrbot/connection.ts';
const sockets = vi.hoisted(() => [] as any[]);
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; static CLOSED = 3;
    readyState = 1; sent: any[] = []; terminated = false;
    constructor() { super(); sockets.push(this); }
    send(text: string) { this.sent.push(JSON.parse(text)); }
    terminate() { this.terminated = true; this.close(); }
    close() { this.readyState = 3; this.emit('close'); }
  } };
});
afterEach(() => { sockets.length = 0; vi.useRealTimers(); });
it('attests current screen state on heartbeats and reconnects after a silent connection or sleep', async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(),'presence-'));
  const state = {ready:true,body:true,visible:true,locked:false,suspended:false,screen_off:false,dnd:false};
  const connection = new TerminalConnection({v:1,url:'wss://127.0.0.1/terminal/v1',ca:'-----BEGIN CERTIFICATE-----',token:'x'.repeat(32),device_id:'sample'},
    {state:()=>state,catalog:async()=>({worlds:[]}),call:async()=>({status:'completed'})},join(root,'journal.json'));
  try {
    connection.start(); const socket = sockets[0];
    socket.emit('message',Buffer.from(JSON.stringify({v:1,type:'welcome',id:'hello',payload:{device_id:'sample'}})));
    await vi.advanceTimersByTimeAsync(0);
    state.screen_off = true;
    await vi.advanceTimersByTimeAsync(20000);
    expect(socket.sent.find((f:any)=>f.type==='ping').payload.state.screen_off).toBe(true);
    vi.setSystemTime(Date.now()+6*3600*1000);
    await vi.advanceTimersByTimeAsync(20000);
    expect(socket.terminated).toBe(true);
  } finally { connection.stop(); rmSync(root,{recursive:true,force:true}); }
});
