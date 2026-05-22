import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // extension under test is global; avoid races
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  webServer: {
    command: "node tests/e2e/fixture-server.mjs",
    port: Number(process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174),
    reuseExistingServer: !process.env.CI,
    cwd: here,
    env: { SAVEMEDIA_FIXTURE_PORT: String(process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174) },
  },
  use: {
    baseURL: `http://localhost:${process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            `--disable-extensions-except=${resolve(here, "dist-chrome")}`,
            `--load-extension=${resolve(here, "dist-chrome")}`,
          ],
          headless: false, // Chrome requires a headed window to load MV3 extensions
        },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // Firefox extension loading via web-ext is wired separately; this
        // project is a placeholder that exercises the same fixtures against
        // baseline Firefox so the test file stays the same.
      },
    },
  ],
});
