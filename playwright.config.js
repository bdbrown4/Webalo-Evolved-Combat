// Smoke-test config: build the game, serve the production bundle, drive it in
// headless Chromium. WebGL runs on SwiftShader — slow but real.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // the game needs WebGL; headless Chromium falls back to SwiftShader.
    // CHROMIUM_PATH lets an environment point at a preinstalled browser instead
    // of downloading one (CI runs `playwright install chromium` and leaves it unset).
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
