/** Settings use the terminal process's HTTP API through the native bridge. */
(async () => {
  const t = await window.terminal.strings();
  document.title = t[0]; document.querySelector('h1').textContent = t[0];
  document.querySelector('#help').textContent = t[10];
  document.querySelector('#extensions-title').textContent = t[13];
  const actions = document.querySelector('#actions');
  for (const [label, action] of [
    [t[1], () => window.terminal.importPairing()],
    [t[2], () => window.terminal.request('/terminal/show', 'POST')],
    [t[3], () => window.terminal.dress()],
    [t[4], () => window.terminal.request('/terminal/dnd', 'POST')],
    [t[5], () => window.terminal.request('/terminal/disconnect', 'POST')],
    [t[21], () => window.terminal.request('/terminal/restart', 'POST')],
  ]) {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = async () => { try { await action(); await refresh(); } catch { document.querySelector('#status').textContent = t[25]; } };
    actions.append(button);
  }
  async function refresh() {
    try {
      const data = await window.terminal.request('/terminal/status');
      document.querySelector('#status').textContent = (data.online ? t[7] : t[8]) + (data.state?.dnd ? ' · ' + t[4] : '') + (data.error ? ' · ' + t[25] : '');
      const rows = document.querySelector('#extensions'); rows.replaceChildren();
      for (const world of data.catalog?.worlds ?? []) {
        const row = document.createElement('p'); row.textContent = `${world.label ?? world.id} · ${world.supported ? t[24] : t[23]}`;
        const config = document.createElement('button'); config.textContent = t[20];
        config.onclick = () => { void configure(world.id); }; row.append(' ', config); rows.append(row);
      }
      for (const item of data.extensions?.extensions ?? []) {
        const row = document.createElement('p'); row.textContent = item.name + (item.state === 'pending-restart' ? ' · ' + t[21] : '');
        const remove = document.createElement('button'); remove.textContent = t[18];
        remove.onclick = async () => {
          remove.disabled = true;
          try { await window.terminal.request('/terminal/extensions/remove', 'POST', { name: item.name }); await refresh(); }
          catch { document.querySelector('#status').textContent = t[25]; }
          finally { remove.disabled = false; }
        }; row.append(' ', remove); rows.append(row);
      }
    } catch { document.querySelector('#status').textContent = t[12]; }
  }
  async function configure(id) {
    const worlds = await window.terminal.request('/terminal/worlds');
    const world = worlds.find((w) => w.id === id); if (!world) return;
    const section = document.querySelector('#world-config'); section.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = world.label; section.append(heading);
    const enable = document.createElement('input'); enable.type = 'checkbox'; enable.checked = world.config.enabled;
    const label = document.createElement('label'); label.append(enable, ' ' + t[19]); section.append(label);
    enable.onchange = async () => { await window.terminal.request('/terminal/world', 'POST', { id, enabled: enable.checked }); await refresh(); };
    const prefix = `worlds.${id}.`;
    for (const group of world.groups) for (const [key, schema] of Object.entries(group.schema.properties ?? {})) {
      if (!key.startsWith(prefix) || !['string', 'boolean', 'integer', 'number'].includes(schema.type) || schema['x-secret']) continue;
      const parts = key.slice(prefix.length).split('.'); let value = world.config;
      for (const part of parts) value = value?.[part];
      const line = document.createElement('p'), title = document.createElement('label'); title.textContent = schema.title ?? key;
      const input = document.createElement(schema.enum ? 'select' : 'input');
      if (schema.enum) for (const option of schema.enum) { const e = document.createElement('option'); e.value = JSON.stringify(option); e.textContent = String(option); input.append(e); }
      else input.type = schema.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(schema.type) ? 'number' : 'text';
      if (input.type === 'checkbox') input.checked = value === true;
      else input.value = schema.enum ? JSON.stringify(value) : value ?? '';
      if (schema.minimum !== undefined) input.min = schema.minimum;
      if (schema.maximum !== undefined) input.max = schema.maximum;
      input.title = schema.description ?? ''; title.append(' ', input); line.append(title);
      const save = document.createElement('button'); save.textContent = t[22];
      save.onclick = async () => {
        const value = schema.enum ? JSON.parse(input.value) : input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
        try { await window.terminal.request('/terminal/world', 'POST', { id, key, value }); await refresh(); }
        catch { document.querySelector('#status').textContent = t[25]; }
      }; line.append(' ', save); section.append(line);
    }
  }
  const market = document.querySelector('#market');
  const title = document.createElement('h2'); title.textContent = t[15]; market.append(title);
  const query = document.createElement('input'); query.setAttribute('aria-label', t[16]); market.append(query);
  const search = document.createElement('button'); search.textContent = t[16]; market.append(' ', search);
  const results = document.createElement('div'); market.append(results);
  search.onclick = async () => {
    search.disabled = true;
    try {
      const found = await window.terminal.request('/terminal/extensions/search'); results.replaceChildren();
      for (const item of found.filter((x) => JSON.stringify(x).toLowerCase().includes(query.value.toLowerCase())).slice(0, 80)) {
        const row = document.createElement('p'); row.textContent = item.name;
        const install = document.createElement('button'); install.textContent = t[17];
        install.onclick = async () => {
          install.disabled = true;
          try { await window.terminal.request('/terminal/extensions/install', 'POST', { name: item.name }); document.querySelector('#status').textContent = t[21]; }
          catch { document.querySelector('#status').textContent = t[25]; }
          finally { install.disabled = false; }
        }; row.append(' ', install); results.append(row);
      }
    } catch { document.querySelector('#status').textContent = t[25]; }
    finally { search.disabled = false; }
  };
  await refresh(); setInterval(refresh, 3000);
})();
