import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
const { decodePowerSetting, DISPLAY, LID } = createRequire(import.meta.url)('../app/terminal-power.cjs');
const packet = (id: Buffer, value: number) => { const b = Buffer.alloc(24); id.copy(b); b.writeUInt32LE(4,16); b.writeUInt32LE(value,20); return b; };
it('distinguishes an off display, dim display and closed lid using Windows notification values', () => {
  expect(decodePowerSetting(packet(DISPLAY,0))).toEqual({screen_off:true});
  for (const value of [1,2]) expect(decodePowerSetting(packet(DISPLAY,value))).toEqual({screen_off:false});
  expect(decodePowerSetting(packet(LID,0))).toEqual({lid_closed:true});
  expect(decodePowerSetting(packet(LID,1))).toEqual({lid_closed:false});
  expect(decodePowerSetting(packet(DISPLAY,9))).toBeNull();
  expect(decodePowerSetting(Buffer.alloc(20))).toBeNull();
  expect(decodePowerSetting(packet(Buffer.alloc(16),0))).toBeNull();
});
