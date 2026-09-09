import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  workers: 2,
  use: { baseURL: "http://127.0.0.1:5174", trace: "retain-on-failure" },
  outputDir: "artifacts/browser-tests",
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: !process.env.CI,
  },
});
