# Prolific Alerts

This is a monorepo containing a browser extension, a Telegram bot, and a backend API.
The extension watches the Prolific.com tab for changes and sends a Telegram notification though API to the end user.s

## Architecture

- apps/extension: The browser extension.
- apps/bot: The notification bot.
- apps/api: The backend service.
- packages/database: Database schema and client.

## Extension Build Setup

The extension lives in `apps/extension`.

- Tooling: Vite + TypeScript
- Build outputs:
  - Chrome: `apps/extension/dist`
  - Firefox: `apps/extension/dist-firefox`
- The manifest root is `apps/extension/public`, not the repo root.

## Extension Commands

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

Load the Firefox build temporarily:

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on...`
3. Select `apps/extension/dist-firefox/manifest.json`

Lint the Firefox build with `web-ext`:

```bash
npx web-ext lint --source-dir dist-firefox
```

Package the Firefox build with `web-ext`:

```bash
npx web-ext build --source-dir dist-firefox
```

If you self-host the API, set `VITE_API_BASE_URL` before building so the runtime API URL and manifest host permissions stay aligned.

## License

This project is released under an open-source license. Feel free to explore and learn from the code.

## Contact

If you have any questions or just want to chat, you can contact me at [bog.kn (at) proton.me].
