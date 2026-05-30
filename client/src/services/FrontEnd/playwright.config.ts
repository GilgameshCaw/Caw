import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for Population-B E2E tests.
 *
 * Targets Chromium only — virtual WebAuthn authenticator is a CDP
 * feature (WebAuthn.addVirtualAuthenticator) that ships in Chromium.
 *
 * baseURL = Vite dev server (yarn dev, port 5274).
 * Start the dev server yourself before running: `yarn dev`
 *
 * Run: yarn test:e2e
 * List: yarn test:e2e --list
 */
export default defineConfig({
  testDir: './e2e',
  /* Each test gets a 60-second default timeout — the sponsor mock
     resolves synchronously so no real I/O waits are expected. */
  timeout: 60_000,
  /* Run tests serially to avoid virtual-authenticator CDP conflicts. */
  workers: 1,
  /* Fail fast in CI so we don't waste time on cascading failures. */
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5274',
    /* Chromium: required for WebAuthn virtual authenticator CDP domain. */
    channel: 'chromium',
    /* Capture screenshot + trace on the first failure only. */
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    /* Headed = false for CI; flip to true locally for debugging. */
    headless: true,
    /* WebAuthn virtual authenticators require a "secure" origin.
       Playwright's test server isn't TLS, so we treat localhost as secure. */
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
