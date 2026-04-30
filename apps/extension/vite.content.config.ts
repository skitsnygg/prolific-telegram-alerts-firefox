import { defineConfig } from "vite";
import { resolve } from "path";

const targetBrowser =
  process.env.TARGET_BROWSER === "firefox" ? "firefox" : "chrome";

export default defineConfig({
  publicDir: false,
  esbuild: {
    drop: process.env.NODE_ENV !== "development" ? ["console", "debugger"] : [],
  },
  build: {
    outDir: targetBrowser === "firefox" ? "dist-firefox" : "dist",
    emptyOutDir: false,
    sourcemap: process.env.NODE_ENV === "development",
    lib: {
      entry: resolve(__dirname, "src/content/index.ts"),
      name: "ProlificAlertsContent",
      formats: ["iife"],
      fileName: () => "content.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
