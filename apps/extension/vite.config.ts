import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  esbuild: {
    drop: process.env.NODE_ENV !== "development" ? ["console", "debugger"] : [],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        popup: resolve(__dirname, "src/popup/popup.html"),
        content: resolve(__dirname, "src/content/index.ts"),
        offscreen: resolve(__dirname, "src/offscreen/offscreen.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
    sourcemap: process.env.NODE_ENV === "development",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
