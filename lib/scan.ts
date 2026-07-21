import type { Client } from 'whatsapp-web.js';
import state from './state';

declare global {
  // eslint-disable-next-line no-var
  var __whatsappClient: Client | undefined;
  // eslint-disable-next-line no-var
  var __whatsappReady: boolean | undefined;
  // eslint-disable-next-line no-var
  var __whatsappReconnect: ((reason: string) => void) | undefined;
}

// Parse CRON_SCHEDULE (";"-separated "min hour" expressions) into sorted
// time-of-day slots. Shared by next/lastScheduledRun.
function buildSlots(): Array<{ h: number; m: number }> {
  const raw = process.env.CRON_SCHEDULE!;
  const expressions = raw.split(';').map(s => s.trim()).filter(Boolean);

  const slots: Array<{ h: number; m: number }> = [];
  for (const expr of expressions) {
    const parts = expr.split(/\s+/);
    if (parts.length < 2) continue;
    const mins = parts[0].split(',').map(Number);
    const hours = parts[1].split(',').map(Number);
    for (const h of hours) for (const m of mins) slots.push({ h, m });
  }
  slots.sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));
  return slots;
}

export function nextScheduledRun(): Date {
  const slots = buildSlots();

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  const next = slots.find(s => s.h * 60 + s.m > nowMins) ?? slots[0];
  const result = new Date(now);
  result.setHours(next.h, next.m, 0, 0);
  if (next.h * 60 + next.m <= nowMins) result.setDate(result.getDate() + 1);
  return result;
}

// The most recent scheduled slot at or before now. Used after a reconnect to
// decide whether a scan slot was missed while the process was suspended.
export function lastScheduledRun(): Date {
  const slots = buildSlots();
  if (slots.length === 0) return new Date(0);

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  const prev = [...slots].reverse().find(s => s.h * 60 + s.m <= nowMins) ?? slots[slots.length - 1];
  const result = new Date(now);
  result.setHours(prev.h, prev.m, 0, 0);
  // No slot earlier today → the latest slot belongs to yesterday.
  if (prev.h * 60 + prev.m > nowMins) result.setDate(result.getDate() - 1);
  return result;
}

// Decide whether a scan failure means the WhatsApp page/CDP context was lost
// and we must reconnect. whatsapp-web.js runs everything through
// page.evaluate(), so a dead page surfaces in many shapes: named
// puppeteer/CDP errors (detached Frame, Target/Session closed, Protocol error,
// destroyed execution context, "Promise was collected"), OR a bare minified
// token thrown from WhatsApp Web's own bundle that carries no readable text at
// all — e.g. "Scan error: r" (observed 2026-07-20), where getChats() failed
// inside the page and the message is a single minified variable name. Matching
// only the first group left the client wedged AND still flagged ready, so the
// next slot scanned a dead page and silently sent nothing.
//
// The named-error list is an allowlist so unrelated failures (e.g. an SMTP
// send error) do NOT spuriously reconnect WhatsApp. The minified-token rule is
// deliberately narrow — no whitespace and ≤3 chars — because real error
// messages are longer sentences and never look like that.
// How many consecutive page-lost scan failures we tolerate before the circuit
// breaker in runScan() stops auto-reconnecting (a reconnect that immediately
// re-fails the same way just loops forever). A single successful scrape resets
// the counter (state.consecutivePageLostFailures).
export const MAX_CONSECUTIVE_PAGE_LOST = parseInt(process.env.MAX_PAGE_LOST_RETRIES ?? '3', 10);

export function isPageLostError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  if (/detached Frame|Session closed|Target closed|Protocol error|Execution context|context was destroyed|Promise was collected|Cannot find context|frame got detached/i.test(msg)) {
    return true;
  }
  const trimmed = msg.trim();
  return trimmed.length > 0 && trimmed.length <= 3 && !/\s/.test(trimmed);
}

export async function runScan(): Promise<void> {
  if (state.isRunning) return;

  const client = globalThis.__whatsappClient;
  const ready = globalThis.__whatsappReady === true;
  if (!client || !ready) {
    // Don't drop this tick — flag it so the 'ready' handler retries the scan
    // as soon as the client reconnects.
    state.scanMissedDueToDisconnect = true;
    console.warn('runScan called but WhatsApp client is not ready yet — will retry on reconnect.');
    return;
  }

  state.isRunning = true;
  state.progress = { current: 0, total: 0 };
  state.lastRunAt = new Date().toISOString();

  const start = Date.now();
  console.log(`[${new Date().toLocaleString()}] Scan started`);

  try {
    // Dynamic imports — Turbopack picks up edits to these files in dev mode
    // without needing a server restart.
    const { scrapeGroups } = await import('./scraper');
    const { formatReport } = await import('./formatter');
    const { sendEmail } = await import('./mailer');

    const results = await scrapeGroups(client, {
      onProgress: (current, total) => {
        state.progress = { current, total };
      },
    });
    // Scrape reached the page and returned — WhatsApp is healthy, so clear the
    // page-lost circuit breaker regardless of how the rest of the run goes.
    state.consecutivePageLostFailures = 0;

    const { resolved, unresolved, skipped = [] } = results;
    const total = resolved.length + unresolved.length;

    state.lastResult = {
      resolved: resolved.length,
      unresolved: unresolved.length,
      skipped: skipped.length,
    };

    if (total === 0) {
      console.log('No groups with client activity found. Nothing to send.');
    } else {
      console.log(`Scan complete — Total: ${total} | Finished: ${resolved.length} | To Do: ${unresolved.length}`);

      if (unresolved.length > 0) {
        console.log('Pending groups:');
        unresolved.forEach((r, i) =>
          console.log(`  ${i + 1}. ${r.groupName} — ${r.senderName} at ${r.timestamp.toLocaleTimeString()}`)
        );
      } else {
        console.log('All client issues resolved!');
      }

      const report = formatReport(results);
      state.lastReportHtml = report.html;
      await sendEmail(report);
    }
  } catch (err) {
    const msg = (err as Error).message ?? '';
    console.error('Scan error:', msg);
    if (isPageLostError(msg)) {
      // On the FIRST failure of a streak, while the page is likely still alive
      // (the minified throw is a JS error, not a page crash — the Target only
      // closes later during reconnect), probe the page for the real cause. A
      // bare message like "r" tells us nothing; the diagnostic names the broken
      // internal module so we know which pinned version to try.
      if (state.consecutivePageLostFailures === 0 && client) {
        try {
          const { diagnosePage } = await import('./scraper');
          console.error('  [diag] page probe:\n  ' + (await diagnosePage(client)));
        } catch (e) {
          console.warn('  [diag] probe failed:', (e as Error).message);
        }
      }

      globalThis.__whatsappReady = false;
      state.scanMissedDueToDisconnect = true;
      state.consecutivePageLostFailures += 1;

      // Circuit breaker. A reconnect brings the client back to 'ready' and the
      // 'ready' handler fires a catch-up scan — but if the underlying page is
      // still broken (e.g. getChats() throws the same minified "r"), that scan
      // re-fails identically and we loop forever, respawning Chrome each time.
      // After a few consecutive page-lost failures, stop auto-reconnecting and
      // leave the client not-ready so the loop halts; the ready/reconnect
      // watchdogs and the next scheduled slot can still recover it later, and a
      // single successful scrape resets the counter.
      if (state.consecutivePageLostFailures > MAX_CONSECUTIVE_PAGE_LOST) {
        console.error(
          `WhatsApp page lost ${state.consecutivePageLostFailures}× in a row — reconnecting is not helping; ` +
          `giving up auto-reconnect to stop the loop. Manual restart likely needed (check the pinned WhatsApp Web version).`
        );
      } else {
        // A lost page often does NOT emit a 'disconnected' event, so the client
        // would otherwise stay stuck — either "not ready" forever, or (for bare
        // minified errors) still flagged ready over a dead page. Actively kick
        // off a reconnect; the handler's own guard makes this idempotent if a
        // 'disconnected' event does fire too. The catch-up scan then runs once
        // 'ready' fires again (scanMissedDueToDisconnect is honored there).
        console.warn(
          `WhatsApp page lost — triggering reconnect (${state.consecutivePageLostFailures}/${MAX_CONSECUTIVE_PAGE_LOST})...`
        );
        globalThis.__whatsappReconnect?.('page lost during scan');
      }
    }
  }

  console.log(`Scan finished in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);

  state.isRunning = false;
  state.progress = { current: 0, total: 0 };
  state.nextRunAt = nextScheduledRun().toISOString();
}
