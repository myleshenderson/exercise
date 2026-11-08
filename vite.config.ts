/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: ["box"],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
    coverage: {
      provider: "v8",
      include: ["src/**", "api/**", "starkeep/**", "scripts/**"],
      exclude: [
        "**/*.test.*",
        "**/__fixtures__/**",
        "**/test-support.ts",
        "src/setupTests.ts",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      thresholds: { lines: 80, functions: 80 },
      reporter: ["text-summary"],
    },
  },
});
