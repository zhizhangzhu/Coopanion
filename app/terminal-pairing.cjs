/** Private pairing is owned by the native shell, never by the console renderer. */
const { dialog, safeStorage, powerMonitor } = require('electron');
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
exports.install = ({ app, ipcMain, core, userData, window: getWindow, open }) => {
  const file = join(userData, 'pairing.encrypted');
  let lastPort = null;
  const power = { locked: false, suspended: false, screen_off: false };
  let sleeping = false, lidClosed = false;
  const publishPower = () => core.send({ type: 'terminal:state', state: { ...power, suspended: sleeping || lidClosed } });
  const allowed = (event) => { const win = getWindow(); if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false; try { return new URL(event.senderFrame.url).origin === `http://127.0.0.1:${core.port}`; } catch { return false; } };
  const load = () => {
    if (!existsSync(file)) return;
    if (!safeStorage.isEncryptionAvailable()) throw new Error('secure_storage_unavailable');
    core.send({ type: 'terminal:pairing', pairing: JSON.parse(safeStorage.decryptString(readFileSync(file))) });
  };
  const importFile = (path) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('secure_storage_unavailable');
    const text = readFileSync(path, 'utf8'), value = JSON.parse(text), url = new URL(value.url);
    if (value.v !== 1 || url.protocol !== 'wss:' || url.pathname !== '/terminal/v1' || url.username || url.password || url.search || url.hash || typeof value.device_id !== 'string' || !/^[\w.-]{1,128}$/.test(value.device_id) || typeof value.token !== 'string' || value.token.length < 32 || value.token.length > 256 || typeof value.ca !== 'string' || value.ca.length > 16384 || !value.ca.includes('BEGIN CERTIFICATE')) throw new Error('invalid_pairing');
    mkdirSync(userData, { recursive: true });
    writeFileSync(file + '.tmp', safeStorage.encryptString(text), { mode: 0o600 }); renameSync(file + '.tmp', file);
    load();
  };
  const argument = (argv) => { const at = argv.indexOf('--pairing-file'); if (at >= 0 && typeof argv[at + 1] === 'string') importFile(argv[at + 1]); };
  ipcMain.handle('terminal:import', async (event) => {
    if (!allowed(event)) throw new Error('forbidden');
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!result.canceled) importFile(result.filePaths[0]);
  });
  core.on('ready', () => {
    publishPower();
    // A paired backend sends a second ready when its device-isolated UI is ready.
    if (lastPort !== null) { lastPort = core.port; return; }
    lastPort = core.port;
    try { const at = process.argv.indexOf('--pairing-file'); if (at >= 0) argument(process.argv); else load(); } catch { open('#/home'); }
    if (!existsSync(file)) open('#/home');
  });
  core.on('state', (state) => { if (['starting','restarting','stopped','failed'].includes(state)) lastPort = null; });
  app.on('second-instance', (_, argv) => { try { argument(argv); } catch { /* Existing pairing survives a rejected import. */ } open('#/home'); });
  app.whenReady().then(() => {
    const locked = () => powerMonitor.getSystemIdleState(1) === 'locked';
    power.locked = locked(); publishPower();
    const handlers = [
      ['lock-screen', () => { power.locked = true; publishPower(); }],
      ['unlock-screen', () => { power.locked = false; publishPower(); }],
      ['suspend', () => { sleeping = true; publishPower(); }],
      ['resume', () => { sleeping = false; power.locked = locked(); publishPower(); }],
    ];
    for (const [event, handler] of handlers) powerMonitor.on(event, handler);
    let stopDisplay = () => {};
    try { stopDisplay = require('./terminal-power.cjs').watchDisplayPower((delta) => {
      if ('lid_closed' in delta) lidClosed = delta.lid_closed;
      if ('screen_off' in delta) power.screen_off = delta.screen_off;
      publishPower();
    }); } catch (error) { console.warn('Display power observation unavailable:', error.message); }
    const poll = setInterval(() => { const value = locked(); if (value !== power.locked) { power.locked = value; publishPower(); } }, 5000);
    poll.unref();
    app.once('will-quit', () => { clearInterval(poll); stopDisplay(); for (const [event, handler] of handlers) powerMonitor.removeListener(event, handler); });
  });
};
