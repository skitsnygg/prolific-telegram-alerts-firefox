# Prolific / Connect - Telegram Alerts

This repo is a Firefox-focused fork/adaptation of the original project by `bogk9`, the chromium based browser files in this repo are untested and from the original fork. I left them in this repo as they should still function however I cannot guarantee any type of stability:

Again, this is a port of the following repo, If you want to run the stable version requiring no local environment, added features, or browser compatibility:
- Original project (for Chromium based browsers): https://github.com/bogk9/prolific-telegram-alerts
- Original developer contact: `bog.kn (at) proton.me`

This local branch adds practical self-hosted development support around the same core idea:

- Firefox support
- Prolific alerts
- CloudResearch Connect alerts
- local API + local Telegram bot support
- Telegram messages with study/project links
- Optional opening of the normal study/project page in a new browser window after a real alert is sent

This extension is alerts-only. It does not auto-click, auto-accept, reserve, submit, or otherwise interact with studies/projects. When window opening is enabled, the extension opens the normal study/project page only. It does not auto-accept or interact with studies/projects.

## What works in this branch

- Prolific alerts from `https://app.prolific.com/studies`
- CloudResearch Connect alerts from `https://connect.cloudresearch.com/participant/dashboard`
- Telegram notifications through the local/self-hosted API and bot
- Study/project links included in Telegram messages
- Optional new-window opening for real Prolific and CloudResearch alerts
- Prolific device support in alerts when desktop/mobile data is available
- CloudResearch auto-refresh at `10–15 seconds`

## Repo layout

- `apps/extension` — Firefox/Chrome extension
- `apps/api` — local/self-hosted API
- `apps/bot` — Telegram bot
- `packages/database` — shared database package

## Local setup

### 1. Neon Postgres

Use a Neon Postgres database and keep the connection string in local `.env` files only.

You will need:

- one Neon Postgres `DATABASE_URL`
- one Telegram bot token from BotFather
- the bot username from BotFather

### 2. API env file

Create `apps/api/.env`:

```env
DATABASE_URL=...
TELEGRAM_BOT_TOKEN=...
PORT=3001
API_KEY=
```

Notes:

- `PORT=3001` matches the current local API setup for this branch.
- `API_KEY` is optional if you use it locally.

### 3. Bot env file

Create `apps/bot/.env`:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=...
DATABASE_URL=...
API_BASE_URL=http://127.0.0.1:3001
```

Do not commit either `.env` file.

## Start the local API and bot

Run from the repo root:

```bash
cd ~/prolific-telegram-alerts-firefox
pnpm --filter api build
pnpm --filter bot build
pnpm --filter api start
pnpm --filter bot start
```

The local API should be reachable at:

```text
http://127.0.0.1:3001
```

## Build the Firefox extension against the local API

Run from the repo root:

```bash
cd ~/prolific-telegram-alerts-firefox
cd apps/extension
VITE_API_BASE_URL=http://127.0.0.1:3001 npm run build:firefox
npx web-ext lint --source-dir dist-firefox
```

Load it temporarily in Firefox:

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on...`
3. Select `apps/extension/dist-firefox/manifest.json`

For local use, build the extension with:

```bash
VITE_API_BASE_URL=http://127.0.0.1:3001 npm run build:firefox
```

## Alert behavior

### Prolific

- watches `https://app.prolific.com/studies`
- sends Telegram alerts for visible studies
- includes desktop/mobile device support when available
- can open the normal `https://app.prolific.com/studies/<id>` page in a new browser window after a real alert is sent

### CloudResearch Connect

- watches `https://connect.cloudresearch.com/participant/dashboard`
- sends Telegram alerts for visible projects
- uses dashboard auto-refresh with randomized jitter at `10–15 seconds`
- can open the normal project details page when available, otherwise the dashboard URL already present in the alert payload

### Popup settings

- `Open new window for Prolific alerts` defaults to ON
- `Open new window for CloudResearch alerts` defaults to ON
- Manual popup test alerts do not open browser windows

## macOS local startup scripts

If `scripts/local` exists, you can use the local macOS startup helpers there:

- `scripts/local/start-local-services.sh`
- `scripts/local/stop-local-services.sh`
- `scripts/local/install-macos-launch-agent.sh`
- `scripts/local/uninstall-macos-launch-agent.sh`

This is separate from Linux or production deployment.

Install auto-start at login:

```bash
./scripts/local/install-macos-launch-agent.sh
```

Stop the local services:

```bash
./scripts/local/stop-local-services.sh
```

Disable auto-start:

```bash
./scripts/local/uninstall-macos-launch-agent.sh
```

Logs:

- `~/Library/Logs/prolific-alerts-api.log`
- `~/Library/Logs/prolific-alerts-bot.log`

## Packaging

Build a Firefox package:

```bash
cd apps/extension
npx web-ext build --source-dir dist-firefox
```

Create a Mozilla source zip from the repo root:

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

Regular Firefox requires a signed XPI for permanent installation. Unsigned builds are for temporary developer loading.

## Troubleshooting

- Temporary Firefox add-ons disappear after restart:
  reload the extension from `about:debugging`; this is normal for temporary installs.
- Local API/bot must be running:
  linking, status checks, and Telegram alerts depend on the local API and bot being up.
- Do not commit `.env` files:
  keep `DATABASE_URL`, bot tokens, usernames, and any API keys local only.
- Telegram format looks stale:
  restart the local API and bot after changing message formatting or backend alert code.

## License

This project remains based on the original open-source project. Review the upstream repository for original licensing context.
