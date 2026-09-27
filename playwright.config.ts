import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/web', timeout: 60_000, workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:4173',
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
    },
  },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: 'pnpm preview --host 127.0.0.1 --port 4173', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
