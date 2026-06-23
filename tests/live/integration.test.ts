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
  let originalRecipients: string[];

  beforeAll(async () => {
    // SAFETY: redirect ALL email for the whole live run so no real recipient is
    // ever contacted — not just by test 3, but also by any catch-up runScan()
    // the reconnect test (4) triggers. If LIVE_TEST_EMAIL is unset we fall back
    // to an EMPTY list, which makes sendEmail() throw "no recipients" (caught by
    // runScan) → nothing is sent.
    originalRecipients = [...state.reportEmails];
    state.reportEmails = process.env.LIVE_TEST_EMAIL ? [process.env.LIVE_TEST_EMAIL] : [];

    await bootstrap();
    await waitForReady(READY_DEADLINE_MS);
  }, READY_DEADLINE_MS + 30_000);

  afterAll(async () => {
    state.reportEmails = originalRecipients;
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
    // Recipients were already redirected to LIVE_TEST_EMAIL in beforeAll. Require
    // it here so this test actually exercises a real send (not the empty-list path).
    if (!process.env.LIVE_TEST_EMAIL) {
      throw new Error('Set LIVE_TEST_EMAIL=you@example.com to run the full-pipeline test safely.');
    }

    const logsBefore = state.logs.length;
    const { runScan } = await import('@/lib/scan');
    await runScan();

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
