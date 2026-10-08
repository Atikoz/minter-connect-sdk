import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // e2e-manual.ts вимагає піднятого relay і запускається руками
    // (npm run test:e2e), тому в автотести не потрапляє.
    environment: 'node',
  },
});
