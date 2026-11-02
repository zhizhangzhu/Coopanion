/** Real NSIS install, original native console, WSS pairing, chat, hide/restore and reinstall. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { WebSocketServer } = require('ws');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astrbot-installer-'));
const install = path.join(root, 'app'), data = path.join(root, 'data');
const output = path.resolve('dist', 'acceptance'); fs.mkdirSync(output, { recursive: true });
let server, socket, debuggerSocket, appProcess;
const children = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, CORTICO_COMPANION_DATA: data, COOPANION_SYSTEM_LANGUAGE: 'en' };
const executable = path.join(install, 'AstrBot Desktop Pet.exe');
const deadline = setTimeout(() => { console.error('Windows acceptance deadline'); process.exit(2); }, 240000);
const run = (file, args) => { const child = spawn(file, args, { env, stdio: 'ignore' }); children.push(child); return child; };
async function wait(check, label, attempts = 80) { for (let i = 0; i < attempts; i++) { try { const value = await check(); if (value) return value; } catch {} await delay(250); } throw Error(label); }
async function main() {
  if (process.platform !== 'win32') throw Error('Windows acceptance requires Windows');
  const openssl = ['openssl.exe', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe')].find((file) => spawnSync(file, ['version'], { stdio: 'ignore' }).status === 0);
  if (!openssl) throw Error('OpenSSL executable not found');
  const cert = path.join(root, 'server.pem'), key = path.join(root, 'server.key');
  if (spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1', '-keyout', key, '-out', cert], { stdio: 'ignore' }).status !== 0) throw Error('Fixture certificate failed');
  const token = randomBytes(32).toString('base64url');
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  const wss = new WebSocketServer({ server });
  let revision = '', observedState = {}, receipt = null;
  const frame = (type, id, payload) => ({ v: 1, type, id, payload });
  wss.on('connection', (peer, request) => {
    if (request.headers.authorization !== 'Bearer '+token) { peer.close(); return; }
    socket = peer;
    peer.send(JSON.stringify(frame('welcome', 'welcome', { device_id: 'windows-ci', persona_id: 'Acceptance', bot_id: 'bot-ci', user_id: 'user-ci' })));
    peer.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'catalog') revision = message.id;
      if (message.type === 'state' || message.type === 'hello') observedState = message.payload;
      if (message.type === 'query') {
        const payload = message.payload.kind === 'identity' ? { persona_id: 'Acceptance', bot_name: 'Acceptance', user_id: 'user-ci', user_name: 'Sample partner', timezone: 'Asia/Shanghai' } : message.payload.kind === 'persona' ? { text: 'This is an isolated acceptance fixture.' } : { items: [], more: false, before: 0 };
        peer.send(JSON.stringify(frame('query_result', message.id, payload)));
      }
      if (message.type === 'ping') peer.send(JSON.stringify(frame('pong', message.id, {})));
      if (message.type === 'event') {
        peer.send(JSON.stringify(frame('ack', message.id, { status: 'queued' })));
        peer.send(JSON.stringify(frame('lifecycle', 'delivered', { kind: 'delivered', cursor: message.payload.cursor })));
        if (message.payload.text === 'Windows native acceptance') peer.send(JSON.stringify(frame('call', 'reply', { world: 'desktop-pet', tool: 'pet_say', arguments: { script: 'Windows native reply received.' }, revision, expires_at: Date.now()/1000+60 })));
      }
      if (message.type === 'result' && message.id === 'reply') receipt = message.payload;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pair = path.join(root, 'fixture.local.json');
  fs.writeFileSync(pair, JSON.stringify({ v: 1, url: `wss://127.0.0.1:${server.address().port}/terminal/v1`, ca: fs.readFileSync(cert, 'utf8'), device_id: 'windows-ci', token }));
  const installer = 'AstrBot-Desktop-Pet-Setup-'+require('../package.json').version+'.exe';
  if (!fs.existsSync(path.join('dist', installer))) throw Error('Installer missing');
  const setup = run(path.resolve('dist', installer), ['/S', '/D='+install]);
  const [exit] = await once(setup, 'exit'); if (exit !== 0 || !fs.existsSync(executable)) throw Error('NSIS installation failed');
  // Silent installers may launch the app. Stop only this isolated installation before pairing it.
  const terminate = () => spawnSync('powershell.exe', ['-NoProfile','-Command', `$p='${executable.replaceAll("'", "''")}'; Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $p} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}`], { stdio: 'ignore' });
  terminate();
  appProcess = run(executable, ['--remote-debugging-port=54832', '--remote-debugging-address=127.0.0.1', '--pairing-file', pair]);
  await wait(() => revision && observedState.ready, 'WSS pairing failed', 160);
  run(executable, []); // Original shell opens its settings on a second launch.
  const target = await wait(async () => (await (await fetch('http://127.0.0.1:54832/json')).json()).find((tab) => tab.url.includes('/coopanion/')), 'Original console did not open', 120);
  debuggerSocket = new WebSocket(target.webSocketDebuggerUrl); await once(debuggerSocket, 'open');
  let id = 0; const pending = new Map();
  debuggerSocket.addEventListener('message', ({ data }) => { const message = JSON.parse(data); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message); } });
  const cdp = (method, params) => new Promise((resolve, reject) => { const current = ++id; pending.set(current, (message) => message.error ? reject(Error(message.error.message)) : resolve(message.result)); debuggerSocket.send(JSON.stringify({ id: current, method, params })); setTimeout(() => { if (pending.delete(current)) reject(Error('CDP request timed out')); }, 10000).unref(); });
  const evaluate = async (expression) => { const value = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result.value; };
  await cdp('Page.bringToFront', {});
  await wait(() => evaluate('!!document.querySelector("#kernel-root") && !!window.astrbotTerminal'), 'Original UI did not initialize');
  await evaluate('location.hash="#/dress"'); await wait(() => evaluate('!!document.querySelector(".companion-dressframe[src]")'), 'Original dressing page failed');
  await evaluate('location.hash="#/pet"'); await wait(() => evaluate('document.querySelectorAll(".featureslot input").length>0'), 'Original habits page failed');
  await wait(() => evaluate("document.querySelector('[data-astrbot-managed=\"bot_name\"]')?.value===\"Acceptance\" && document.querySelector('[data-astrbot-managed=\"user_name\"]')?.value===\"Sample partner\" && [...document.querySelectorAll(\"input[data-astrbot-managed]\")].every(e=>e.disabled)"), 'Shared identity must be server-synced and read-only');
  await evaluate('location.hash="#/chat"'); await wait(() => evaluate('!!document.querySelector(".chatview textarea")'), 'Original chat failed');
  await evaluate('document.querySelector(".chatview textarea").focus()');
  await cdp('Input.insertText', { text: 'Windows native acceptance' });
  await evaluate('document.querySelector(".chatview form").requestSubmit()');
  await wait(() => receipt?.status === 'completed', 'Presentation was not confirmed', 160);
  await wait(() => evaluate('document.querySelector(".chat-thread").textContent.includes("Windows native reply received.")'), 'Chat reply missing');
  const method = (name) => evaluate(`fetch('/api/webui/providers/world%3Adesktop-pet/panels/pet/${name}',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"args":[]}'}).then(r=>r.json())`);
  await method('hideWindow'); await wait(async () => (await method('state')).onDesktop === false, 'Hide failed');
  // Same close/open sequence as the native tray Show pet action.
  await method('closeWindow'); await method('openWindow');
  await wait(async () => { const state = await method('state'); return state.connected && state.onDesktop; }, 'Hidden pet did not return', 120);
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'native-console.png'), Buffer.from(screenshot.data, 'base64'));
  const pairingFile = path.join(data, 'pairing.encrypted'), preserved = fs.readFileSync(pairingFile);
  debuggerSocket.close(); terminate();
  const again = run(path.resolve('dist', installer), ['/S', '/D='+install]); const [reinstalled] = await once(again, 'exit');
  if (reinstalled !== 0 || !fs.readFileSync(pairingFile).equals(preserved)) throw Error('Reinstall replaced pairing');
  terminate();
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ installer: 'passed', original_ui: 'passed', wss_pairing: 'passed', chat_and_receipt: 'passed', hide_restore: 'passed', reinstall_preserves_pairing: 'passed' }, null, 2));
  console.log('Windows installer and native UI acceptance passed.');
}
main().then(() => { clearTimeout(deadline); socket?.close(); server?.close(); process.exit(0); }).catch((error) => { console.error(error.message); clearTimeout(deadline); debuggerSocket?.close(); socket?.close(); server?.close(); for (const child of children) child.kill(); process.exit(1); });
