import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/state/**/*.ts', 'src/beats/**/*.ts', 'src/combat/**/*.ts'],
      thresholds: {
        lines: 90,
        branches: 90,
      },
    },
  },
});
