import { defineConfig, devices } from "@playwright/test";

/**
 * Functional e2e against a PRODUCTION server (`next build` + `next start`):
 * a dev server's console carries HMR and StrictMode noise, and its CSP
 * allows eval, so it would not test what ships.
 *
 * Port 3130, not the 3000/3100 pair soltendogs uses on this machine: with
 * reuseExistingServer, a foreign server already listening on the port would be
 * tested instead of this app. E2E_PORT overrides; PLAYWRIGHT_BASE_URL points
 * the suite at an already-running server and skips webServer entirely.
 */
const PORT = Number(process.env.E2E_PORT ?? 3130);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * GPU-less CI runners need SwiftShader or WebGL context creation fails. On an
 * Apple Silicon machine ANGLE over Metal is far faster and closer to a real
 * player's browser. PLAYWRIGHT_SOFTWARE_GL=1 forces the software path locally.
 */
const SOFTWARE = Boolean(process.env.CI) || process.env.PLAYWRIGHT_SOFTWARE_GL === "1";
const GPU_ARGS = SOFTWARE
  ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
  : ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"];

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // One at a time: every spec drives a WebGL scene, and parallel workers
  // starve each other on the software renderer.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /perf\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, launchOptions: { args: GPU_ARGS } },
    },
    // The same sim in every JS engine: golden replays must hash identically.
    { name: "firefox", testMatch: /replay-engines\.spec\.ts/, use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", testMatch: /replay-engines\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
    {
      // Local only (pnpm test:perf): real-time frame timing needs a real GPU.
      name: "perf",
      testMatch: /perf\.spec\.ts/,
      timeout: 240_000,
      retries: 0,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, launchOptions: { args: GPU_ARGS } },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // `pnpm run build` also copies the decoders (scripts/copy-decoders.mjs).
        // The server runs as a plain node child, not through `pnpm exec`: pnpm
        // puts it in its own process group, so Playwright's group kill misses
        // it and the orphan holds the run open after the last test.
        command: `pnpm run build && node node_modules/next/dist/bin/next start -p ${PORT}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
      },
});
