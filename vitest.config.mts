import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Tier 1 — fast, pure-logic unit tests. No WhatsApp, no Chrome, no network.
// Runs in the Node environment in milliseconds. This is the default `npm test`.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // Module-load-time env reads (analyzer COLLEAGUE_NAMES, state REPORT_EMAIL,
    // getClient ANTHROPIC_API_KEY guard). Set deterministic values before any
    // test module loads. The Anthropic SDK is mocked, so this key is never used.
    env: {
      COLLEAGUE_NAMES: 'Sam,Alvin,補貨司機',
      LID_NAMES: '182038447571092:補貨司機, 130086019833871:Regular Client ',
      ANTHROPIC_API_KEY: 'test-key-not-used',
      WHATSAPP_DEVICE_NAME: 'Me',
    },
  },
});
