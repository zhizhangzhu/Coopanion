/** Windows session display and lid notifications; no screenshots or idle-time guesses. */
const { createRequire } = require('node:module');
const { join } = require('node:path');
function guid(text) {
  const [a,b,c,d,e] = text.split('-'), out = Buffer.alloc(16);
  out.writeUInt32LE(parseInt(a,16)); out.writeUInt16LE(parseInt(b,16),4); out.writeUInt16LE(parseInt(c,16),6);
  Buffer.from(d+e,'hex').copy(out,8); return out;
}
const DISPLAY = guid('2B84C20E-AD23-4DDF-93DB-05FFBD7EFCA5');
const LID = guid('BA3E0F4D-B817-4094-A2D1-D56379E6A0F3');
function decodePowerSetting(bytes) {
  if (bytes.length < 24 || bytes.readUInt32LE(16) !== 4) return null;
  const value = bytes.readUInt32LE(20), id = bytes.subarray(0,16);
  if (id.equals(DISPLAY) && value <= 2) return { screen_off: value === 0 };
  if (id.equals(LID) && value <= 1) return { lid_closed: value === 0 };
  return null;
}
function watchDisplayPower(changed) {
  if (process.platform !== 'win32') return () => {};
  const { BaseWindow } = require('electron');
  let koffi;
  try { koffi = require('koffi'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    koffi = createRequire(join(__dirname,'../packages/cortico-world-desktop-pet/package.json'))('koffi');
  }
  const user32 = koffi.load('user32.dll');
  const register = user32.func('void * __stdcall RegisterPowerSettingNotification(void *recipient, const void *guid, uint32_t flags)');
  const unregister = user32.func('bool __stdcall UnregisterPowerSettingNotification(void *handle)');
  const win = new BaseWindow({ show: false, width: 1, height: 1, skipTaskbar: true });
  const handles = [];
  const stop = () => {
    for (const handle of handles) unregister(handle);
    handles.length = 0;
    if (!win.isDestroyed()) { win.unhookWindowMessage(0x218); win.destroy(); }
  };
  try {
    win.hookWindowMessage(0x218, (wParam, lParam) => {
      if (wParam.readUInt32LE(0) !== 0x8013) return;
      const pointer = koffi.decode(lParam,'void *');
      if (!pointer) return;
      const head = Buffer.from(koffi.decode(pointer,'uint8_t',20));
      if (head.readUInt32LE(16) !== 4 || ![DISPLAY,LID].some((id) => head.subarray(0,16).equals(id))) return;
      const delta = decodePowerSetting(Buffer.from(koffi.decode(pointer,'uint8_t',24)));
      if (delta) changed(delta);
    });
    const hwnd = koffi.decode(win.getNativeWindowHandle(),'void *');
    for (const id of [DISPLAY,LID]) {
      const handle = register(hwnd,id,0);
      if (!handle) throw Error('power_notification_registration_failed');
      handles.push(handle);
    }
    return stop;
  } catch (error) { stop(); throw error; }
}
module.exports = { watchDisplayPower, decodePowerSetting, DISPLAY, LID };
