/** AstrBot connection controls using the original console's components and public panel API. */
import { invokePanel } from '../../base/api.ts';
import { LANGUAGE } from '../../base/language.ts';
import type { PageContext } from '../../base/page.ts';
import { strings } from '../../../app/terminal-strings.cjs';
declare global { interface Window { astrbotTerminal?: { importPairing(): Promise<void> } } }
const S = strings(LANGUAGE);
export async function connectionCard(ctx: Pick<PageContext, 'ui' | 'root' | 'signal' | 'lifecycle'>): Promise<void> {
  const { ui, root, signal } = ctx;
  const card = ui.sheet({ title: 'AstrBot' }), status = ui.h('p'), address = ui.h('p', 'muted'), note = ui.msgline(S[10]!);
  const reconnect = ui.button(S[49]!, { onClick: () => { void invokePanel('world:astrbot-ui', 'connection', 'reconnect', [], { signal }).catch(() => { note.textContent = S[25]!; }); } });
  const actions = ui.h('div', 'home-buttons');
  const importing = ui.button(S[1]!, { onClick: () => { void window.astrbotTerminal?.importPairing().catch(() => { note.textContent = S[11]!; }); } });
  const disconnect = ui.button(S[5]!, { onClick: () => { void invokePanel('world:astrbot-ui', 'connection', 'disconnect', [], { signal }).then(refresh).catch(() => { note.textContent = S[25]!; }); } });
  actions.append(importing, reconnect, disconnect); card.body.append(status, address, note, actions); root.append(card.el);
  async function refresh() {
    try {
      const value = await invokePanel<{ online: boolean; paired: boolean; server: string; binding: { persona_id?: string }; error: string }>('world:astrbot-ui', 'connection', 'status', [], { signal });
      status.textContent = `${value.binding.persona_id ?? 'AstrBot'} · ${value.online ? S[7] : S[8]}`;
      address.textContent = value.server; note.hidden = value.online; disconnect.disabled = !value.online; reconnect.hidden = value.online || !value.paired;
    } catch { status.textContent = S[8]!; }
  }
  await refresh(); ctx.lifecycle.interval(() => { void refresh(); }, 3000);
}

/** The server's shared QQ/desktop conversation, without inventing missing source or time metadata. */
export const sharedHistoryPage: import('../../base/page.ts').Page = {
  route: 'astrbot-history', label: S[34]!, icon: 'message',
  async mount(ctx) {
    const { ui, root, signal } = ctx;
    const card = ui.sheet({ title: S[34]! }), records = ui.h('div'), note = ui.msgline('');
    const older = ui.button(S[29]!, { onClick: () => { void load(before); } });
    let before: number | undefined;
    card.body.append(older, records, note); root.append(card.el);
    async function load(cursor?: number) {
      older.disabled = true;
      try {
        const value = await invokePanel<{ items?: Array<{ role: string; text: string }>; before: number; more: boolean; error?: string }>('world:astrbot-ui', 'connection', 'history', cursor === undefined ? [] : [cursor], { signal });
        if (value.error) throw Error(value.error);
        const fragment = root.ownerDocument.createDocumentFragment();
        for (const item of value.items ?? []) {
          const row = ui.sheet({ title: item.role === 'user' ? S[33]! : 'AstrBot' });
          const text = ui.h('p'); text.style.whiteSpace = 'pre-wrap'; text.textContent = item.text; row.body.append(text); fragment.append(row.el);
        }
        if (cursor === undefined) records.replaceChildren(fragment); else records.prepend(fragment);
        before = value.before; older.hidden = !value.more; note.textContent = '';
      } catch { note.textContent = S[48]!; }
      finally { older.disabled = false; }
    }
    await load();
  },
};
