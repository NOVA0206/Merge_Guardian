import { defineConfig, devices } from "@playwright/test";

/**
 * Two ways to run:
 *   npm run test:e2e                                   full local stack on the PRODUCTION build (needs `npm run build` first)
 *   PLAYWRIGHT_BASE_URL=https://<preview-or-prod> npm run test:e2e
 *       only the deployment-safe @deployed tests run against that URL (no mocks, no writes).
 */
const remote = process.env.PLAYWRIGHT_BASE_URL;
const bypass = process.env.GUARDIAN_PREVIEW_BYPASS_TOKEN;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false, // the full-stack tests share one database and one mock GitHub
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  grep: remote ? /@deployed/ : undefined,
  use: {
    baseURL: remote ?? "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    extraHTTPHeaders: remote && bypass ? { "x-vercel-protection-bypass": bypass } : undefined,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: remote
    ? undefined
    : {
        command: "npx tsx tests/e2e/support/stack.ts",
        url: "http://127.0.0.1:54330/__mock/recorded", // served only once db, app and Inngest are all up
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
