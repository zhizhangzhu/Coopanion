/** Chat records use the desktop World's stream and the bound AstrBot history API. */
window.startTerminalChat = (t) => {
  const pane = document.querySelector('#chat-pane'), records = document.querySelector('#chat-records');
  const composer = document.querySelector('#chat-compose'), input = document.querySelector('#chat-text');
  const files = document.querySelector('#chat-files'), notice = document.querySelector('#chat-notice');
  const older = document.querySelector('#chat-older'), source = document.querySelector('#chat-source');
  document.querySelector('#chat-send').textContent = t[28];
  document.querySelector('#chat-attach').textContent = t[30];
  input.placeholder = t[31]; input.setAttribute('aria-label', t[31]);
  older.textContent = t[29]; source.options[0].textContent = t[35]; source.options[1].textContent = t[34];
  let session = '', items = new Map(), shared = [], sharedBefore = null, bot = t[0], openAsk = null;
  let busy = false, lastSignature = '', pending = new Set(), more = false, attachments = [];
  const blobCache = new Map(), withdrawn = new Set(), delivered = new Set();
  const api = (path, body = {}) => window.terminal.request('/terminal/chat/' + path, 'POST', body);
  const showNotice = (text) => { notice.textContent = text; };
  function reset() { items.clear(); withdrawn.clear(); delivered.clear(); shared = []; sharedBefore = null; pending.clear(); blobCache.clear(); lastSignature = ''; openAsk = null; records.replaceChildren(); }
  async function connect() {
    const opened = await api('open'); session = opened.session;
    await consume(opened.frames); await api('send', { session, frame: { t: 'hello' } });
  }
  async function image(ref, parent) {
    const handle = typeof ref === 'string' ? ref : ref.ref;
    let value = blobCache.get(handle);
    if (!value) { value = await api('blob', { handle }); blobCache.set(handle, value); }
    if (!['image/png','image/jpeg','image/gif','image/webp'].includes(value.mime)) return;
    const img = document.createElement('img'); img.alt = typeof ref === 'object' ? ref.name ?? t[30] : t[30];
    img.src = `data:${value.mime};base64,${value.base64}`; img.loading = 'lazy'; parent.append(img);
  }
  function row(role, text, terminal, ts) {
    const article = document.createElement('article'); article.className = 'message ' + role;
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const name = document.createElement('strong'); name.textContent = role === 'user' ? t[33] : bot;
    const where = document.createElement('span'); where.textContent = terminal === 'desktop' ? t[35] : t[34];
    meta.append(name, where);
    if (ts) { const time = document.createElement('time'); const date = new Date(ts); if (!Number.isNaN(date.valueOf())) { time.dateTime = date.toISOString(); time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); meta.append(time); } }
    const body = document.createElement('div'); body.className = 'message-body'; body.textContent = text;
    article.append(meta, body); return article;
  }
  async function render(force = false) {
    const rows = source.value === 'shared' ? shared : [...items.values()].sort((a,b) => a.cursor - b.cursor);
    const signature = JSON.stringify([source.value, rows, [...pending], openAsk, bot]);
    if (!force && signature === lastSignature) return; lastSignature = signature;
    const atEnd = records.scrollHeight - records.scrollTop - records.clientHeight < 80;
    const fragment = document.createDocumentFragment();
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'chat-empty'; empty.textContent = t[32]; fragment.append(empty); }
    for (const item of rows) {
      const user = item.role === 'user' || item.kind === 'user' || item.kind === 'answer';
      const text = item.text ?? item.question ?? (item.beats ?? []).map((beat) => beat.text).join('');
      const message = row(user ? 'user' : 'assistant', text, item.terminal ?? 'desktop', item.ts);
      if (item.kind === 'touch') message.querySelector('.message-body').textContent = item.text || [item.touch?.kind, item.touch?.count].filter(Boolean).join(' · ');
      if (item.kind === 'figure') message.querySelector('.message-body').textContent = item.figure?.name?.zh ?? item.figure?.name?.en ?? item.figure?.name?.id ?? '';
      if (item.kind === 'activity') message.querySelector('.message-body').textContent = (item.steps ?? []).join(' · ');
      if (pending.has(item.cursor)) { const status = document.createElement('small'); status.textContent = t[42]; message.append(status); }
      const media = document.createElement('div'); media.className = 'message-images'; message.append(media);
      for (const ref of item.images ?? []) { void image(ref, media).catch(() => {}); }
      if (item.kind === 'ask' && item.askId === openAsk) {
        const choices = document.createElement('div'); choices.className = 'chat-choices';
        for (const [index, option] of (item.options ?? []).entries()) {
          const button = document.createElement('button'); button.textContent = option;
          button.onclick = async () => { await api('send', { session, frame: { t: 'answer', askId: item.askId, index } }); await poll(); };
          choices.append(button);
        }
        message.append(choices);
      }
      fragment.append(message);
    }
    records.replaceChildren(fragment); older.hidden = !more;
    if (atEnd || force) records.scrollTop = records.scrollHeight;
  }
  async function consume(frames) {
    for (const frame of frames ?? []) {
      if (frame.t === 'init') { items.clear(); bot = frame.bot || bot; openAsk = frame.askId; pending = new Set(frame.pending ?? []); more = frame.more; }
      for (const cursor of frame.refs?.withdrawn ?? []) withdrawn.add(cursor);
      for (const [cursor] of frame.refs?.delivered ?? []) delivered.add(cursor);
      if (frame.t === 'init' || frame.t === 'items' || frame.t === 'older') for (const item of frame.items ?? []) if (!withdrawn.has(item.cursor)) items.set(item.cursor, item);
      for (const cursor of withdrawn) { items.delete(cursor); pending.delete(cursor); }
      for (const cursor of delivered) pending.delete(cursor);
      if (frame.t === 'older') more = frame.more;
      if (frame.t === 'item' && frame.item) { items.set(frame.item.cursor, frame.item); if (frame.pending) pending.add(frame.item.cursor); }
      if (frame.t === 'settled') for (const cursor of frame.cursors ?? []) pending.delete(cursor);
      if (frame.t === 'withdrawn') { items.delete(frame.cursor); pending.delete(frame.cursor); }
      if (frame.t === 'ask') openAsk = frame.askId;
      if (frame.t === 'notice' || frame.t === 'rejected') showNotice(frame.text ?? frame.reason ?? t[25]);
      if (frame.t === 'closed') { session = ''; reset(); }
    }
    await render();
  }
  async function poll() {
    if (busy || pane.hidden || document.hidden || source.value === 'shared') return;
    busy = true;
    try { if (!session) await connect(); await consume((await api('poll', { session })).frames); }
    catch { session = ''; reset(); showNotice(t[25]); }
    finally { busy = false; }
  }
  async function loadShared(before) {
    try {
      const data = await api('shared', { before });
      if (data.error) throw Error(data.error);
      shared = before === undefined ? data.items ?? [] : [...(data.items ?? []), ...shared];
      sharedBefore = data.before; more = data.more; await render(true); showNotice('');
    } catch { showNotice(t[48]); }
  }
  source.onchange = async () => { lastSignature = ''; if (source.value === 'shared') await loadShared(); else await poll(); };
  older.onclick = async () => {
    if (source.value === 'shared') return loadShared(sharedBefore);
    const before = Math.min(...items.keys()); if (Number.isFinite(before)) await api('send', { session, frame: { t: 'more', before } });
    await poll();
  };
  files.onchange = async () => {
    const selected = [...files.files];
    if (selected.length > 8 || selected.reduce((sum, file) => sum + file.size, 0) > 1024 * 1024) { files.value = ''; showNotice(t[25]); return; }
    attachments = await Promise.all(selected.map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve({ mime: file.type, name: file.name, base64: String(reader.result).split(',')[1] }); reader.readAsDataURL(file);
    })));
    showNotice(selected.map((file) => file.name).join(' · '));
  };
  composer.onsubmit = async (event) => {
    event.preventDefault(); if (!input.value.trim() && !attachments.length) return;
    try {
      if (!session) await connect();
      await api('send', { session, frame: { t: 'send', id: crypto.randomUUID(), text: input.value, images: attachments } });
      input.value = ''; attachments = []; files.value = ''; showNotice(''); source.value = 'desktop'; await poll();
    } catch { showNotice(t[25]); }
  };
  input.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); } };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  setInterval(poll, 1000); void poll();
  return { open: () => { pane.hidden = false; void poll(); }, reset };
};
