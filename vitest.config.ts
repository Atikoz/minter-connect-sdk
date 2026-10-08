import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // e2e-manual.ts требует поднятого relay и запускается вручную
    // (npm run test:e2e), поэтому в автотесты не попадает.
    environment: 'node',
  },
});
