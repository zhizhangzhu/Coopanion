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

it('publishes changed capabilities before a completed receipt permits an immediate next call', async () => {
  vi.useFakeTimers();
  const root=mkdtempSync(join(tmpdir(),'catalog-receipt-'));
  const state={ready:true,body:true,visible:true,locked:false,suspended:false,screen_off:false,dnd:false};
  let environment='before',executed=0;
  const connection=new TerminalConnection({v:1,url:'wss://127.0.0.1/terminal/v1',ca:'-----BEGIN CERTIFICATE-----',token:'x'.repeat(32),device_id:'sample'},
    {state:()=>state,catalog:async()=>({worlds:[{id:'sample',environment,tools:[]}]}),call:async()=>{executed++;environment='after';return {status:'completed'};}},join(root,'journal.json'));
  try {
    connection.start();const socket=sockets[0];let knownRevision='';
    const receive=(id:string,revision:string)=>socket.emit('message',Buffer.from(JSON.stringify({v:1,type:'call',id,payload:{world:'sample',tool:'act',arguments:{},revision,expires_at:Date.now()/1000+10}})));
    const original=socket.send.bind(socket);
    socket.send=(raw:string)=>{const message=JSON.parse(raw);original(raw);if(message.type==='catalog')knownRevision=message.id;
      if(message.type==='result'&&message.id==='first'){const nextRevision=knownRevision;setTimeout(()=>receive('second',nextRevision),0);}};
    socket.emit('message',Buffer.from(JSON.stringify({v:1,type:'welcome',id:'welcome',payload:{device_id:'sample'}})));
    await vi.advanceTimersByTimeAsync(0);receive('first',knownRevision);await vi.advanceTimersByTimeAsync(10);
    expect(executed).toBe(2);
    expect(socket.sent.find((m:any)=>m.type==='result'&&m.id==='second').payload.status).toBe('completed');
  } finally {connection.stop();rmSync(root,{recursive:true,force:true});}
});

it('waits for an in-flight capability refresh before acknowledging an executed action', async () => {
  vi.useFakeTimers();const root=mkdtempSync(join(tmpdir(),'catalog-flight-'));
  let hold: Promise<void> | null=null,release: () => void=()=>{},environment='before';
  const connection=new TerminalConnection({v:1,url:'wss://127.0.0.1/terminal/v1',ca:'-----BEGIN CERTIFICATE-----',token:'x'.repeat(32),device_id:'sample'},
    {state:()=>({ready:true,body:true,visible:true,locked:false,suspended:false,screen_off:false,dnd:false}),
      catalog:async()=>{if(hold)await hold;return {worlds:[{id:'sample',environment,tools:[]}]};},
      call:async()=>{environment='after';return {status:'completed'};}},join(root,'journal.json'));
  try {
    connection.start();const socket=sockets[0];
    socket.emit('message',Buffer.from(JSON.stringify({v:1,type:'welcome',id:'welcome',payload:{device_id:'sample'}})));
    await vi.advanceTimersByTimeAsync(0);const revision=socket.sent.find((m:any)=>m.type==='catalog').id;
    hold=new Promise<void>(resolve=>{release=resolve});const flight=connection.refresh(true);
    socket.emit('message',Buffer.from(JSON.stringify({v:1,type:'call',id:'action',payload:{world:'sample',tool:'act',arguments:{},revision,expires_at:Date.now()/1000+10}})));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.some((m:any)=>m.type==='result'&&m.id==='action')).toBe(false);
    hold=null;release();await flight;await vi.advanceTimersByTimeAsync(0);
    const changed=socket.sent.findIndex((m:any)=>m.type==='catalog'&&m.payload.worlds[0].environment==='after');
    const receipt=socket.sent.findIndex((m:any)=>m.type==='result'&&m.id==='action');
    expect(changed).toBeGreaterThan(-1);expect(receipt).toBeGreaterThan(changed);
  }finally{connection.stop();rmSync(root,{recursive:true,force:true});}
});
