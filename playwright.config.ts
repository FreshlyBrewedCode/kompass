import { defineConfig, devices } from "@playwright/test";

// The built app (`bun run e2e` builds it) served by a throwaway static server under a sub-path, the
// way GitHub Pages will host it. Port 7959 (KOMPASS_E2E_PORT=… if taken).
const port = Number(process.env.KOMPASS_E2E_PORT ?? 7959);
export const BASE_PATH = "/kompass/";
// Playwright's downloaded browsers don't run on NixOS: the nix dev shell names its Chromium here.
const executablePath = process.env.KOMPASS_E2E_CHROMIUM;

const launchOptions = {
  ...(executablePath ? { executablePath } : {}),
  // WebGL on the CPU (no GPU on agent machines or CI runners)
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}${BASE_PATH}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      // Mobile first: the phone is the main client (390×844, touch), in Chromium.
      name: "phone",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
        launchOptions,
      },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions },
    },
  ],
  webServer: {
    command: `bun e2e/serve.ts --port ${port} --base ${BASE_PATH}`,
    url: `http://127.0.0.1:${port}${BASE_PATH}`,
    reuseExistingServer: false,
    stdout: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
