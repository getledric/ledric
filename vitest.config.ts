import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/gui/web/**/*.test.js',
      'e2e-cli/**/*.test.ts'
    ],
    environment: 'node',
    passWithNoTests: true
  }
});
