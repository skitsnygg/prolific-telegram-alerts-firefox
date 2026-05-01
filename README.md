# Prolific Alerts / Study Alerts

This repository is a Firefox-compatible port/adaptation of the original Prolific Alerts project found here - https://github.com/bogk9/prolific-telegram-alerts.

It now supports two alert providers through the same extension, API, bot, and database stack:

- Prolific
- CloudResearch Connect

The extension only sends alerts. It does not auto-accept, reserve, click, submit, or otherwise interact with studies/projects.

## Monorepo layout

- `apps/extension` — browser extension for Prolific + CloudResearch Connect alerts
- `apps/bot` — Telegram bot
- `apps/api` — backend API
- `packages/database` — database schema and client

## Extension build setup

The extension lives in `apps/extension`.

- Tooling: Vite + TypeScript
- Chrome build output: `apps/extension/dist`
- Firefox build output: `apps/extension/dist-firefox`
- Manifest source/root: `apps/extension/public`

The manifest is not at the repo root.

## Firefox-specific notes

- Firefox build output: `apps/extension/dist-firefox`
- Firefox manifest is generated through `apps/extension/scripts/build-manifest.mjs`
- Firefox manifest includes `browser_specific_settings.gecko`
- Firefox packaging uses `web-ext`
- Temporary loading path in Firefox:
  - `about:debugging#/runtime/this-firefox`
  - Select `apps/extension/dist-firefox/manifest.json`

## Supported pages

- Prolific detection runs on `https://app.prolific.com/studies` and keeps the existing Prolific alert flow intact.
- CloudResearch detection runs only on `https://connect.cloudresearch.com/participant/dashboard`.

CloudResearch support is alerts-only:

- No auto-clicking
- No auto-accepting
- No reserving
- No submitting
- No project interaction

## Extension commands

Run these from `apps/extension`:

```bash
npm install
```

Build the Chrome package:

```bash
npm run build:chrome
```

Build the Firefox package:

```bash
npm run build:firefox
```

Lint the Firefox build:

```bash
npx web-ext lint --source-dir dist-firefox
```

Package the Firefox build:

```bash
npx web-ext build --source-dir dist-firefox
```

Load the Firefox build temporarily:

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on...`
3. Select `apps/extension/dist-firefox/manifest.json`

If you self-host the API, set `VITE_API_BASE_URL` before building so the runtime API URL and manifest host permissions stay aligned.

## CloudResearch local testing

1. Build and load the Firefox extension:

```bash
cd apps/extension
npm install
npm run build:firefox
npx web-ext lint --source-dir dist-firefox
```

2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click `Load Temporary Add-on...`.
4. Select `apps/extension/dist-firefox/manifest.json`.
5. Open and sign in to:

```text
https://connect.cloudresearch.com/participant/dashboard
```

6. Keep the dashboard open on the `Available` view so visible project cards can be detected.
7. Use the popup button `Send CloudResearch Test Alert` to verify the background/API/Telegram path.
8. Optionally enable `Enable CloudResearch auto-refresh` in the popup. It is off by default and only refreshes the dashboard page every 10-15 seconds while you are not typing in a form field.

## Detection notes

- Prolific uses the existing deterministic DOM selectors and state-machine cache.
- CloudResearch only reads visible project card text on the participant dashboard and extracts title, payment, estimated time, spots/places when visible, and a project URL when one is present.
- If a CloudResearch project URL exposes a stable `/participant/project/<id>` path segment, that value is used as the project key.
- If no stable ID is visible, the extension falls back to a deterministic key derived from:

```text
cloudresearch:title:reward:time:url
```

## macOS local service startup

This section is only for local macOS startup of `apps/api` and `apps/bot`. It is separate from Linux or production deployment.

The local startup scripts live under `scripts/local/`:

- `scripts/local/start-local-services.sh`
- `scripts/local/stop-local-services.sh`
- `scripts/local/install-macos-launch-agent.sh`
- `scripts/local/uninstall-macos-launch-agent.sh`

Before using them, create these env files yourself:

- `apps/api/.env`
- `apps/bot/.env`

Do not commit those `.env` files. The scripts do not contain `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, or other secrets.

The local service scripts run the compiled Node entrypoints, so build the API and bot first:

```bash
pnpm --filter api build
pnpm --filter bot build
```

Install auto-start at login on macOS:

```bash
./scripts/local/install-macos-launch-agent.sh
```

Start the local services manually:

```bash
./scripts/local/start-local-services.sh
```

Stop the local services:

```bash
./scripts/local/stop-local-services.sh
```

Disable auto-start and remove the LaunchAgent:

```bash
./scripts/local/uninstall-macos-launch-agent.sh
```

Service logs are written to:

- `~/Library/Logs/prolific-alerts-api.log`
- `~/Library/Logs/prolific-alerts-bot.log`

PID files are written to:

- `/tmp/prolific-alerts-api.pid`
- `/tmp/prolific-alerts-bot.pid`

The LaunchAgent plist is installed at:

- `~/Library/LaunchAgents/com.brian.prolific-alerts-local.plist`

## Mozilla submission notes

Reviewer reproduction steps from `apps/extension`:

```bash
npm install
npm run build:firefox
npx web-ext lint --source-dir dist-firefox
npx web-ext build --source-dir dist-firefox
```

## Creating a clean AMO source archive

Run this from the repo root:

```bash
zip -r ~/prolific-telegram-alerts-firefox-source.zip . \
  -x ".git/*" \
  -x ".idea/*" \
  -x ".venv/*" \
  -x ".agents/*" \
  -x "*/.DS_Store" \
  -x ".DS_Store" \
  -x "apps/extension/node_modules/*" \
  -x "apps/extension/dist/*" \
  -x "apps/extension/dist-firefox/*" \
  -x "apps/extension/web-ext-artifacts/*" \
  -x "node_modules/*" \
  -x "package-lock.json" \
  -x "apps/extension/package-lock.json"
```

Verify the archive contents:

```bash
unzip -l ~/prolific-telegram-alerts-firefox-source.zip | grep -E "\.agents|\.DS_Store|node_modules|dist-firefox|web-ext-artifacts|package-lock" || echo "Clean source zip looks good"
```

## Contact

- Original developer - `bog.kn (at) proton.me`
- Firefox  port - `selfsabotage (at) proton.me`

## License

This project is released under an open-source license. Feel free to explore and learn from the code.
