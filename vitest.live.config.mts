import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Tier 2 — live integration tests. Real WhatsApp + Chrome + Claude + SMTP.
// Slow (minutes): connecting to WhatsApp Web alone can take over a minute, and
// the ready watchdog is 3 min. These are local, on-demand, and gated behind the
// LIVE_TESTS env flag so they never run by accident (see tests/live/setup.ts).
//
// Run with:  LIVE_TESTS=1 npm run test:live
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    setupFiles: ['tests/live/setup.ts'],
    // One shared WhatsApp connection across the whole run — never parallelize.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Generous timeouts: bootstrap/ready and a full scan take minutes.
    testTimeout: 240_000,
    hookTimeout: 300_000,
  },
});
