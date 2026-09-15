// Scoped to the Broker module's React components. The rest of the repo is
// covered by `pnpm test` (node:test over tests/*.test.mjs) and stays that way —
// this config deliberately does not glob tests/.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", "tests/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
