import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The browser smoke test of the landing page (npm run test:browser) against
// the production build: run `npm run build` first. Chromium from
// PLAYWRIGHT_CHROMIUM_EXECUTABLE when set, else Playwright's own.
const port = Number(process.env.ASK_TEST_PORT || 3134);
export const docsPort = port + 1;
export const dataDir = join(tmpdir(), `flowplan-ask-browser-${port}`);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "tests/browser",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "off",
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: "node --disable-warning=ExperimentalWarning --import tsx tests/browser/start.ts",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(port), ASK_DATA_DIR: dataDir, DOCS_PORT: String(docsPort) },
  },
});
