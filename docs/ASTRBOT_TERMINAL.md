# AstrBot terminal: app/terminal.cjs, app/main.cjs and core/astrbot/native.ts

The Windows AstrBot edition uses the original Coopanion native shell and complete `console/` UI. Habits, dressing and figure packs, voice, chat, themes, World panels and the extension market retain their original components and interactions. The default figure is DeepSeek Chan. AstrBot owns the conversational persona, shared memory, models and proactive coordination.

## Run and pair

Use Node 24.11 and pnpm 11.28.6. After `pnpm install --frozen-lockfile` and `pnpm run build:cortico`, set `CORTICO_COMPANION_DATA` to a separate empty directory and run `pnpm run dev:terminal`. Never use another installed app's data for development.

Import the private pairing JSON through the AstrBot card on Home. Alternatively, `"AstrBot Desktop Pet.exe" --pairing-file <private-file.local.json>` imports the same validated file. The file contains the WSS IP address, a public CA certificate and a revocable device credential. Transfer it through trusted SSH/SFTP and delete the plaintext transfer after import. Electron safeStorage encrypts the retained credential under `%APPDATA%\AstrBotCoopanion`.

TLS validates the certificate and the IP/hostname for this connection. Windows root certificates are not changed. QQ sessions, server keys and model credentials stay on Linux. One active server/persona/user is bound to the client. Re-pairing switches to a separate device directory and stops the old Worlds/connection.

## Native UI, remote decisions

`core/boot.ts` selects `native.ts` only for the AstrBot edition. The original Core supplies its HTTP config APIs, World panel streams, extension assets and local event/media records. `NativeBridge` relays events to AstrBot and advances the local recovery watermark. The local model loop receives none of those events; its model client fails closed. No second local Persona or conversational model manages identity or memory.

Home and the advanced model page show the AstrBot connection instead of collecting local model credentials. The original prompt page can display the server-managed persona as a generated section and edit World environment templates. The shared-records page reads the paired server conversation with pagination; it does not invent missing source/time metadata. The usage page receives actual server-reported token counts; missing price quotes are not authoritative billing figures.

World tools and environment descriptions are advertised from active, visible instances. Their standard configuration and frontend bundles remain native. World cognition delegates to AstrBot's admitted scheduler and model budget; nested calls preserve parent identities and execution receipts. Extensions that require a local Cortico Persona or private Core APIs are not automatically compatible. Output taps receive generated text after generation rather than token streaming.

The original voice settings, custom interaction choices, typing key, figure import and extension pages use their public panel contracts. Per-device/per-World secrets use Windows CurrentUser DPAPI, with no secret values returned by settings APIs. Computer use and ASR retain their original opt-in controls; connecting AstrBot does not enable them.

## Delivery and recovery

QQ and desktop share the verified user's recent conversation and memory, while retaining the true source and reply destination. Passive replies stay on the input terminal. Proactive interaction prefers a visible, interactive desktop. Hidden, locked, suspended or quiet state waits instead of sending the same interaction on QQ.

Requests and results have durable identities. Displayed speech waits for its renderer receipt; interrupted or unconfirmed actions remain unknown and are not blindly replayed. Paused/offline chat survives restart in the native pending journal and WSS outbox. Server-queued input is recoverable; already delivered input is not regenerated. Observation acknowledgements clear pending transport state without pretending to be new human dialogue.

The tray Show pet action closes the hidden window and opens it again. Reopening also checks visibility, since a hidden pet can remain connected. This avoids treating a living process as an already-visible window.

Media transfers carry original bytes and a digest: up to eight images and 1 MiB total per batch. GIFs remain animated files and are not silently converted to a static canvas image. Oversized input is rejected.

## Windows build and acceptance

`.github/workflows/astrbot-terminal-windows.yml` checks out the exact source commit, runs the five required suites, builds the x64 NSIS installer, then runs `scripts/accept-astrbot-windows.cjs`. That acceptance installs the real package, opens the original console, pairs to an isolated WSS fixture, sends native chat, checks the display receipt, hides/restores the pet and verifies reinstall preserves encrypted pairing. The artifact includes its report and a native-window screenshot. No real QQ account, model credential or user conversation is used by CI.

```powershell
pnpm install --frozen-lockfile
pnpm run build:cortico
$env:COOPANION_TERMINAL = "1"
$env:PACK_ARCH = "x64"
pnpm exec tsx scripts/pack.ts
```

The output is `dist/AstrBot-Desktop-Pet-Setup-<version>.exe`. Its application ID is `io.github.zhizhangzhu.astrbot-coopanion`; source/protocol metadata records the build's Git commit and protocol v1. Releases belong to `zhizhangzhu/Coopanion`. Automatic self-update is disabled in terminal mode; install a new terminal package to upgrade. Pairing and settings survive reinstall and uninstall. Never include operator data in an installer.

CI cannot establish the user's private Linux/Windows network route or replace acceptance against their actual server. That final pairing and ordinary conversation verification remain separate from the isolated fixture.

## Shared identity

The paired server supplies the Bot name, user address and timezone. Native configuration guards reject local overwrites, and the normal and advanced UI disable those fields. The last verified device-specific identity remains visible offline; a connected client refreshes it every 30 seconds without a model request. Desktop appearance, interaction and local UI language remain local settings. UI references to the companion use Bot.
