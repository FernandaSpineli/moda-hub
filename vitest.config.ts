import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles the tests: Vitest's default transformer does not emit the
// decorator metadata that Nest's dependency injection relies on.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          // Containers start once per file; give them time on a cold machine.
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
    ],
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/**/*.test.ts', 'src/main.ts'] },
  },
});
