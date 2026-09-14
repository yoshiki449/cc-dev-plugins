import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: 'http://localhost:3987',
    viewport: { width: 1920, height: 1080 },
    video: 'on',
    screenshot: 'on',
    trace: 'on',
  },
  webServer: {
    command: 'npm start',
    port: 3987,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
