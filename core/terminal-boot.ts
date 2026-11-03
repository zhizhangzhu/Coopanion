/** Resolves the staged Cortico runtime before loading the model-free terminal host. */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const app = fileURLToPath(new URL('../', import.meta.url));
const cortico = process.env.CORTICO_COMPANION_ROOT ?? join(app, 'build', 'cortico');
await import(pathToFileURL(join(cortico, 'src', 'extensions', 'runtime.ts')).href);
const { main } = await import('./astrbot/runtime.ts');
await main();
