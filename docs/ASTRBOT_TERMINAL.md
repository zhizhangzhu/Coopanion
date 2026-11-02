# AstrBot terminal: app/terminal.cjs and core/astrbot/

This fork adds a Windows terminal that runs desktop-pet Worlds while AstrBot owns the persona, shared conversation, memory and model decisions. The original Coopanion entry remains available.

## Run and pair

Use Node 24.11 and pnpm 11.28.6. After `pnpm install --frozen-lockfile` and `pnpm run build:cortico`, run `pnpm run dev:terminal`. Development uses a separate empty directory supplied through `CORTICO_COMPANION_DATA`; do not use an installed app's data.

Import the private pairing JSON created by the AstrBot desktop plugin through a trusted channel. The file contains a WSS address, a public CA certificate and one revocable device credential. Server private keys, QQ sessions and model credentials remain on the server. For a controlled deployment, `"AstrBot Desktop Pet.exe" --pairing-file <private-file.local.json>` imports the same validated pairing without a file picker; it never accepts credentials on the command line. Delete the transferred plaintext file after import. The installed app encrypts the pairing with Electron safeStorage under `%APPDATA%\AstrBotCoopanion`.

The connection validates TLS and the server's IP or hostname using this connection's CA. It does not modify Windows root certificates or ignore certificate errors. A client has one active server and paired persona/user. Changing the pairing restarts Worlds with a separate device data directory and invalidates the old connection.

## Runtime boundaries

`TerminalConnection` owns protocol v1, reconnection and a durable event/call journal. `TerminalHost` runs real Worlds and provides their local event store, blobs, environment descriptions and tools. There is no local Persona or model loop in terminal mode. Existing desktop figures and local animation run without remote model calls.

`runtime.ts` exposes a token-protected loopback HTTP API for settings and the extension market. The native preload is the only bridge from the settings page to that API; the page cannot read pairing credentials. Native lock/suspend events and World changes update the server's interaction state. Basic state refreshes locally every two seconds; unchanged catalogs do not refresh more than every thirty seconds unless a capability or event changes. None of these refreshes invokes a model.

World schemas (including nested objects and arrays), environment descriptions, deferred events, candidates and lifecycle notifications are supported. Bounded World cognition delegates to the server Companion coordinator and its model budget; nested tool calls retain their parent identity. Output taps receive final generated text after generation, rather than token streaming. A separate handoff/model-loop runtime and local model usage reporting are unavailable in terminal mode. A broken World becomes unavailable without taking healthy Worlds offline. Enabling a World makes its supported tools available to the paired AstrBot; computer use retains the desktop World's own opt-in setting. Text input is available first; ASR defaults off and can use the existing World configuration.

Calls return actual results. Speech and question presentation wait for a matching renderer receipt in terminal mode; an interrupted or disconnected action remains unknown unless confirmed. Existing animation actions can return `submitted`; this is not a completed activity. Reconnection reconciles request IDs instead of replaying uncertain effects. Images carry actual bytes and a digest; one batch is limited to eight attachments and 1 MiB total. GIF bytes remain one attachment.

The server keeps passive replies on their input terminal. Proactive interaction prefers an interactive desktop; hidden, locked, suspended or quiet state waits instead of delivering the same interaction through QQ. Unknown delivery is not immediately retried on QQ. The server's Companion scheduler owns activity admission and model budgets.

The native chat window includes paginated desktop records, image/GIF attachments, option questions and a separate paginated view of the paired AstrBot conversation. Shared records do not invent a source terminal when the historical record lacks one. Settings support declared complex schemas, declared panel actions through the advanced JSON interface, and per-device/per-World secrets encrypted with Windows CurrentUser DPAPI. Secret values are never returned to the settings page. Native custom extension frontends are not embedded; panels use their public invoke/stream contracts. Unconfirmed presentation is not reported as a completed experience.

## Build and upgrade

`.github/workflows/astrbot-terminal-windows.yml` builds a Windows x64 NSIS artifact after the five required checks. It does not publish a Release. On Windows:

```powershell
pnpm install --frozen-lockfile
pnpm run build:cortico
$env:COOPANION_TERMINAL = "1"
$env:PACK_ARCH = "x64"
pnpm exec tsx scripts/pack.ts
```

The build embeds its Git commit and protocol version in the shipped package metadata. The output is `dist/AstrBot-Desktop-Pet-Setup-<version>.exe`, with application ID `io.github.zhizhangzhu.astrbot-coopanion`. The release source is `zhizhangzhu/Coopanion`; automatic update checks are not enabled in terminal mode. Upgrade by installing this fork's new terminal installer; AppData pairing and settings are preserved. Uninstall retains AppData. Never include operator data, pairing files or server keys in a build.

Native Windows installation, upgrade, pairing and lock/suspend tests are required before release. Linux protocol tests are not a substitute for that acceptance.
