import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionRoot = path.resolve(__dirname, "..");

const target = process.argv[2] === "firefox" ? "firefox" : "chrome";
const outDir = path.join(
  extensionRoot,
  target === "firefox" ? "dist-firefox" : "dist",
);
const baseManifestPath = path.join(extensionRoot, "public", "manifest.json");

const DEFAULT_API_BASE_URL = "https://prolificapi.notifyme.top";
const FIREFOX_GECKO_ID =
  "prolific-connect-telegram-alerts@brian-migliore.local";
const FIREFOX_STRICT_MIN_VERSION = "112.0";

const baseManifest = JSON.parse(await readFile(baseManifestPath, "utf8"));
const apiBaseUrl = (
  process.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL
).replace(/\/+$/, "");
const apiHostPermission = `${new URL(apiBaseUrl).origin}/*`;

const hostPermissions = new Set(baseManifest.host_permissions ?? []);
hostPermissions.add(apiHostPermission);

const manifest = {
  ...baseManifest,
  host_permissions: Array.from(hostPermissions),
};

if (target === "firefox") {
  manifest.permissions = (manifest.permissions ?? []).filter(
    (permission) => permission !== "offscreen",
  );
  manifest.background = {
    scripts: ["background.js"],
    type: "module",
  };
  manifest.browser_specific_settings = {
    gecko: {
      id: FIREFOX_GECKO_ID,
      strict_min_version: FIREFOX_STRICT_MIN_VERSION,
      data_collection_permissions: {
        required: [
          "authenticationInfo",
          "personalCommunications",
          "websiteActivity",
        ],
      },
    },
  };
}

await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
