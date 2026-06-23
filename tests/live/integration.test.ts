import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrap, getWhatsAppClient, isWhatsAppReady } from '@/lib/bootstrap';
import state from '@/lib/state';

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — LIVE integration tests against the REAL WhatsApp account.
//
// Gated behind LIVE_TESTS so they never run by accident:
//     LIVE_TESTS=1 npm run test:live
//
// Prerequisites:
//   • A valid persisted session in .wwebjs_auth (run `npm run dev` once and scan
//     the QR first). These tests fail fast with a clear message if there isn't.
//   • Real Chrome installed (bootstrap resolves it automatically).
//   • .env populated (ANTHROPIC_API_KEY, SMTP_*, CRON_SCHEDULE, etc.).
//   • LIVE_TEST_EMAIL=you@example.com — the runScan test redirects the report
//     here so real recipients are never emailed during tests.
//
// They share ONE WhatsApp connection (singleFork) and run in file order. The
// disconnect/reconnect test is intentionally last because it tears the page
// down and brings it back up.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = !!process.env.LIVE_TESTS;
const READY_DEADLINE_MS = 120_000;

async function waitForReady(deadlineMs: number): Promise<void> {
  const client = getWhatsAppClient();
  if (!client) throw new Error('bootstrap() did not create a WhatsApp client');

  let sawQr = false;
  client.on('qr', () => { sawQr = true; });

  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (isWhatsAppReady()) return;
    if (sawQr) {
      throw new Error(
        'WhatsApp emitted a QR code — no valid session. Run `npm run dev` once and ' +
        'scan the QR with your phone, then re-run the live tests.'
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`WhatsApp did not reach "ready" within ${deadlineMs}ms`);
}

describe.skipIf(!LIVE)('LIVE WhatsApp integration', () => {
  beforeAll(async () => {
    await bootstrap();
    await waitForReady(READY_DEADLINE_MS);
  }, READY_DEADLINE_MS + 30_000);

  afterAll(async () => {
    const client = getWhatsAppClient();
    try { await client?.destroy(); } catch { /* ignore */ }
  });

  // 1 ── Connect & ready (the flaky path you care about) ──────────────────────
  it('reaches the ready state with a live session', () => {
    expect(isWhatsAppReady()).toBe(true);
  });

  // 2 ── Real scrape smoke test ───────────────────────────────────────────────
  it('scrapes real groups and returns a well-formed ScanResult', async () => {
    const client = getWhatsAppClient()!;
    const { scrapeGroups } = await import('@/lib/scraper');

    const result = await scrapeGroups(client);

    expect(result.scannedGroups).toBe(result.totalGroups);
    for (const entry of [...result.resolved, ...result.unresolved]) {
      expect(entry.groupName).toBeTruthy();
      expect(['高', '中', '低']).toContain(entry.priority);
      expect(entry.confidence).toBeGreaterThanOrEqual(0);
      expect(entry.confidence).toBeLessThanOrEqual(1);
      expect(entry.timestamp instanceof Date).toBe(true);
    }
  }, 180_000);

  // 3 ── Full pipeline: real WhatsApp → real Claude → email to TEST inbox ──────
  it('runs the full scan pipeline and emails the report to the test inbox', async () => {
    const testInbox = process.env.LIVE_TEST_EMAIL;
    if (!testInbox) {
      throw new Error('Set LIVE_TEST_EMAIL=you@example.com to run the full-pipeline test safely.');
    }

    // Redirect the report so real recipients are never contacted.
    const originalRecipients = [...state.reportEmails];
    state.reportEmails = [testInbox];

    const logsBefore = state.logs.length;
    try {
      const { runScan } = await import('@/lib/scan');
      await runScan();
    } finally {
      state.reportEmails = originalRecipients;
    }

    expect(state.lastResult).not.toBeNull();
    expect(state.lastRunAt).toBeTruthy();
    expect(state.isRunning).toBe(false);

    const newLogs = state.logs.slice(logsBefore).join('\n');
    // Either an email went out, or there was simply nothing to report.
    expect(/Email sent|Nothing to send|No groups/.test(newLogs)).toBe(true);
  }, 240_000);

  // 4 ── Disconnect → reconnect → ready again (last; it tears down the page) ───
  it('recovers readiness after a disconnect', async () => {
    const client = getWhatsAppClient()!;

    // Simulate the real disconnect event the bootstrap handler listens for.
    // This exercises scheduleReconnect() → destroy() → initialize() → ready.
    state.scanMissedDueToDisconnect = true; // mark a missed tick for catch-up
    client.emit('disconnected', 'TEST_FORCED_DISCONNECT');

    // readiness should flip false, then come back on reconnect.
    await waitForReady(READY_DEADLINE_MS);
    expect(isWhatsAppReady()).toBe(true);
  }, READY_DEADLINE_MS + 30_000);
});
