import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `apps/app/test` holds the parts of the app that are pure functions —
    // units, measurements, the draft slot, the file readers. Anything that
    // touches a canvas or the DOM is covered by `scripts/smoke.mjs` instead,
    // because a fake DOM proves nothing about a real renderer.
    include: ["packages/*/test/**/*.test.ts", "apps/app/test/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
