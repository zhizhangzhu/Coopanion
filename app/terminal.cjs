/** Windows shell for the AstrBot terminal, with device credentials protected by Electron safeStorage. */
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, safeStorage, powerMonitor } = require('electron');
const { fork } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const { join, delimiter } = require('node:path');
const { pathToFileURL } = require('node:url');
const { systemLanguage } = require('./i18n/index.cjs');
const { strings } = require('./terminal-strings.cjs');

if (process.argv.includes('--pet-host')) {
  require('./main.cjs');
} else {
  const ROOT = join(__dirname, '..');
  const DATA = process.env.CORTICO_COMPANION_DATA ?? join(app.getPath('appData'), 'AstrBotCoopanion');
  app.setPath('userData', DATA);
  app.setName('AstrBot Desktop Pet');
  app.setAppUserModelId('io.github.zhizhangzhu.astrbot-coopanion');
  if (!app.requestSingleInstanceLock()) { app.quit(); }
  else {
    let window = null, child = null, tray = null, address = null, quitting = false, language = 'en';
    const pairFile = join(DATA, 'pairing.encrypted');
    const page = pathToFileURL(join(__dirname, 'terminal.html')).href;
    const allowed = (event) => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === page;
    const open = () => {
      if (window) { window.show(); window.focus(); return; }
      window = new BrowserWindow({ width: 850, height: 650, title: strings(language)[0],
        webPreferences: { preload: join(__dirname, 'terminal-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault(); });
      window.on('closed', () => { window = null; });
      void window.loadURL(page);
    };
    const request = async (path, method = 'GET', body) => {
      if (!address && path === '/terminal/restart' && method === 'POST') { app.relaunch(); app.quit(); return {}; }
      if (!address || !['/terminal/status', '/terminal/show', '/terminal/disconnect', '/terminal/dnd', '/terminal/extensions/search', '/terminal/extensions/install', '/terminal/extensions/remove', '/terminal/worlds', '/terminal/world', '/terminal/restart', '/terminal/chat/open', '/terminal/chat/poll', '/terminal/chat/send', '/terminal/chat/close', '/terminal/chat/blob', '/terminal/chat/shared', '/terminal/panel', '/terminal/secret'].includes(path) || !['GET', 'POST'].includes(method)) throw new Error('terminal_unavailable');
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { Authorization: 'Bearer ' + address.token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error('terminal_request_failed');
      return response.json();
    };
    const loadPair = () => {
      try {
      if (existsSync(pairFile) && safeStorage.isEncryptionAvailable()) {
        child?.send({ type: 'terminal:pairing', pairing: JSON.parse(safeStorage.decryptString(readFileSync(pairFile))) });
      }
      } catch { open(); }
    };
    const importPairing = (file) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(strings(language)[9]);
      const text = readFileSync(file, 'utf8');
      const pair = JSON.parse(text), url = new URL(pair.url);
      if (pair.v !== 1 || url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/terminal/v1' || typeof pair.device_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(pair.device_id) || typeof pair.token !== 'string' || pair.token.length < 32 || pair.token.length > 256 || typeof pair.ca !== 'string' || pair.ca.length > 16384 || !pair.ca.includes('BEGIN CERTIFICATE')) throw new Error('invalid_pairing');
      writeFileSync(pairFile + '.tmp', safeStorage.encryptString(text), { mode: 0o600 });
      renameSync(pairFile + '.tmp', pairFile);
      loadPair();
    };
    const importArgument = (args) => {
      const index = args.indexOf('--pairing-file');
      if (index >= 0 && typeof args[index + 1] === 'string') importPairing(args[index + 1]);
    };
    ipcMain.handle('terminal:strings', (event) => { if (!allowed(event)) throw new Error('forbidden'); return strings(language); });
    ipcMain.handle('terminal:request', (event, path, method, body) => { if (!allowed(event)) throw new Error('forbidden'); return request(path, method, body); });
    ipcMain.handle('terminal:import', async (event) => {
      if (!allowed(event)) throw new Error('forbidden');
      if (!safeStorage.isEncryptionAvailable()) throw new Error(strings(language)[9]);
      const selected = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (selected.canceled) return;
      importPairing(selected.filePaths[0]);
    });
    const dress = async () => { child?.send({ type: 'terminal:open-dress' }); };
    ipcMain.handle('terminal:dress', (event) => { if (!allowed(event)) throw new Error('forbidden'); return dress(); });
    app.on('second-instance', (_, argv) => { try { importArgument(argv); } catch { /* Keep the existing pairing when import fails. */ } open(); });
    app.on('window-all-closed', () => {});
    app.whenReady().then(() => {
      mkdirSync(DATA, { recursive: true });
      const requestedLanguage = process.env.COOPANION_SYSTEM_LANGUAGE;
      language = require('./i18n/index.cjs').LANGUAGES.includes(requestedLanguage) ? requestedLanguage : systemLanguage(app);
      tray = new Tray(join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
      tray.setToolTip(strings(language)[0]);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: strings(language)[14], click: open },
        { label: strings(language)[2], click: () => void request('/terminal/show', 'POST') },
        { label: strings(language)[6], click: () => app.quit() },
      ]));
      tray.on('double-click', open);
      child = fork(join(ROOT, 'core', 'terminal-boot.ts'), [], {
        cwd: ROOT, execArgv: ['--import', 'tsx'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ASTRBOT_TERMINAL_DATA: join(DATA, 'terminal'),
          PATH: [join(ROOT, 'app', 'shims'), process.env.PATH ?? ''].join(delimiter),
          CORTICO_NODE_EXE: process.execPath, CORTICO_PNPM_CJS: join(ROOT, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
          pnpm_config_store_dir: join(DATA, 'pnpm', 'store'), pnpm_config_cache_dir: join(DATA, 'pnpm', 'cache'),
          COOPANION_SYSTEM_LANGUAGE: language, CORTICO_HOME: join(DATA, 'home'), CORTICO_EXTENSIONS_DIR: join(DATA, 'extensions'),
          CORTICO_DESKTOP_PET_HOST: JSON.stringify([process.execPath, ROOT, '--pet-host']) },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.on('message', (message) => {
        if (message?.type === 'terminal:ready') { address = message; loadPair(); }
        if (message?.type === 'terminal:open') open();
        if (message?.type === 'terminal:chat') { open(); window.webContents.once('did-finish-load', () => window.webContents.send('terminal:show-chat')); window.webContents.send('terminal:show-chat'); }
        if (message?.type === 'terminal:quit') app.quit();
        if (message?.type === 'terminal:restart') { app.relaunch(); app.quit(); }
        if (message?.type === 'terminal:dress' && typeof message.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/dress$/.test(message.url)) {
          const dressWindow = new BrowserWindow({ width: 1000, height: 720, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
          dressWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          void dressWindow.loadURL(message.url);
        }
      });
      child.on('exit', () => { address = null; child = null; if (!quitting) open(); });
      for (const [event, state] of [['lock-screen', { locked: true }], ['unlock-screen', { locked: false }], ['suspend', { suspended: true }], ['resume', { suspended: false }]]) {
        powerMonitor.on(event, () => child?.send({ type: 'terminal:state', state }));
      }
      try { importArgument(process.argv); } catch { open(); }
      if (!existsSync(pairFile)) open();
    });
    let exitReady = false;
    app.on('before-quit', (event) => {
      if (exitReady || !child) { quitting = true; tray?.destroy(); return; }
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      const worker = child;
      const finish = () => { exitReady = true; tray?.destroy(); app.quit(); };
      const deadline = setTimeout(() => { worker.kill(); finish(); }, 5000);
      worker.once('exit', () => { clearTimeout(deadline); finish(); });
      worker.send({ type: 'terminal:shutdown' });
    });
  }
}
