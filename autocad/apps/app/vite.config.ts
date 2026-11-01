import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  server: { port: 5201, strictPort: false },
  build: { target: "es2022", outDir: "dist", sourcemap: true },
  resolve: {
    alias: {
      // The engine is one file; the app imports it by package name so the
      // future split into modules does not touch a single app import.
      "@apexus/cad": fileURLToPath(new URL("../../packages/cad/src/cad.ts", import.meta.url)),
    },
  },
});
