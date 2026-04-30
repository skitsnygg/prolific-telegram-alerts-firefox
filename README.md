# Prolific Alerts

This repository is a Firefox-compatible port/adaptation of the original Prolific Alerts project found here - https://github.com/bogk9/prolific-telegram-alerts. It keeps the original monorepo structure and core idea: a browser extension watches Prolific.com and sends Telegram notifications through the API.

## Monorepo layout

- `apps/extension` — browser extension
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
