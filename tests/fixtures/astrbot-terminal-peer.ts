/** A real terminal and pet-page stand-in for the Python WSS integration test. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
await import('../../vendor/cortico/src/extensions/runtime.ts');
const { TerminalHost } = await import('../../core/astrbot/host.ts');
const { TerminalConnection } = await import('../../core/astrbot/connection.ts');
const { desktopPetDefinition } = await import('cortico-world-desktop-pet');
const { FakePage } = await import('../../packages/cortico-world-desktop-pet/tests/helpers/page.ts');
const pair = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = process.argv[3];
let pet: import('cortico-world-desktop-pet').DesktopPetWorld | undefined;
const definition = desktopPetDefinition({ confirmPresentation: true, onCreate: (world) => { pet = world; } });
const cfg = definition.defaults();
cfg.enabled = true; cfg.port = 0; cfg.window.enabled = false; cfg.asr.enabled = false;
const host = new TerminalHost(root, { name: 'Sample', timezone: 'UTC', worlds: { 'desktop-pet': cfg } }, () => {});
await host.enable(definition as import('cortico/world.ts').WorldDefinition<import('cortico/world.ts').WorldSection>);
if (!pet) throw new Error('pet_not_created');
const page = await FakePage.open(pet.petUrl.replace(/\/pet$/, ''));
const connection = new TerminalConnection(pair, {
  state: () => ({ ready: true, body: true, visible: true, locked: false, suspended: false, dnd: false }),
  catalog: () => host.catalog(),
  call: (world, tool, args, signal, attachments) => host.call(world, tool, args, signal, attachments),
  connected: (online) => {
    if (online) {
      page.send({ t: 'text', text: 'A message from the desktop.' });
      console.log(JSON.stringify({ ready: true }));
    }
  },
}, join(root, 'journal.local.json'));
host.onEvent = (event) => connection.event(event);
connection.start();
async function confirm() {
  while (true) {
    const order = await page.next((m) => m.t === 'say' || m.t === 'ask', 60000);
    page.send({ t: 'presented', id: order.id });
  }
}
void confirm().catch(() => {});
process.once('SIGTERM', () => {
  connection.stop();
  void page.close().then(() => host.stop()).finally(() => process.exit(0));
});
