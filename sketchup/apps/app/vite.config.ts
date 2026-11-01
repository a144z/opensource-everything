import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { port: 5199, strictPort: false },
  build: { target: "es2022", outDir: "dist", sourcemap: true },
});
