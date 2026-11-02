/** Reuses Coopanion's complete native shell; only its backend runtime changes. */
const { app } = require('electron');
const { join } = require('node:path');
process.env.COOPANION_ASTRBOT_TERMINAL = '1';
process.env.CORTICO_COMPANION_DATA ??= join(app.getPath('appData'), 'AstrBotCoopanion');
require('./main.cjs');
