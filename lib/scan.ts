import type { Client } from 'whatsapp-web.js';
import state from './state';

declare global {
  // eslint-disable-next-line no-var
  var __whatsappClient: Client | undefined;
  // eslint-disable-next-line no-var
  var __whatsappReady: boolean | undefined;
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
    if (/detached Frame|Session closed|Target closed/i.test(msg)) {
      globalThis.__whatsappReady = false;
      state.scanMissedDueToDisconnect = true;
      console.warn('WhatsApp page lost — waiting for client to reconnect...');
    }
  }

  console.log(`Scan finished in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);

  state.isRunning = false;
  state.progress = { current: 0, total: 0 };
  state.nextRunAt = nextScheduledRun().toISOString();
}
