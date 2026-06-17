import { Client, LocalAuth } from 'whatsapp-web.js';
import cron from 'node-cron';
import state from './state';
import { scrapeGroups } from './scraper';
import { formatReport } from './formatter';
import { sendEmail } from './mailer';

declare global {
  // eslint-disable-next-line no-var
  var __whatsappClient: Client | undefined;
  // eslint-disable-next-line no-var
  var __whatsappReady: boolean | undefined;
  // eslint-disable-next-line no-var
  var __bootstrapped: boolean | undefined;
}

export function getWhatsAppClient(): Client | undefined {
  return globalThis.__whatsappClient;
}

export function isWhatsAppReady(): boolean {
  return globalThis.__whatsappReady === true;
}

function nextScheduledRun(): Date {
  const raw = process.env.CRON_SCHEDULE;
  const expressions = raw.split(';').map(s => s.trim()).filter(Boolean);

  // Parse each "min hour * * *" expression into [hour, minute] pairs
  const slots: Array<{ h: number; m: number }> = [];
  for (const expr of expressions) {
    const parts = expr.split(/\s+/);
    if (parts.length < 2) continue;
    const mins = parts[0].split(',').map(Number);
    const hours = parts[1].split(',').map(Number);
    for (const h of hours) for (const m of mins) slots.push({ h, m });
  }
  slots.sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  const next = slots.find(s => s.h * 60 + s.m > nowMins) ?? slots[0];
  const result = new Date(now);
  result.setHours(next.h, next.m, 0, 0);
  if (next.h * 60 + next.m <= nowMins) result.setDate(result.getDate() + 1);
  return result;
}

// Capture all console output into the dashboard activity log
function patchConsole() {
  const _log = console.log.bind(console);
  const _error = console.error.bind(console);
  const _warn = console.warn.bind(console);

  function capture(fn: (...a: unknown[]) => void, ...args: unknown[]) {
    const line = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
    state.logs.push(line);
    if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
    fn(...args);
  }

  console.log = (...a) => capture(_log, ...a);
  console.error = (...a) => capture(_error, ...a);
  console.warn = (...a) => capture(_warn, ...a);
}

export async function runScan(): Promise<void> {
  if (state.isRunning) return;
  const client = getWhatsAppClient();
  if (!client || !isWhatsAppReady()) {
    console.warn('runScan called but WhatsApp client is not ready yet.');
    return;
  }

  state.isRunning = true;
  state.progress = { current: 0, total: 0 };
  state.lastRunAt = new Date().toISOString();

  const start = Date.now();
  console.log(`[${new Date().toLocaleString()}] Scan started`);

  try {
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
    // Puppeteer page/frame was torn down (WA page reload or session refresh).
    // Reset the ready flag so subsequent scans bail out cleanly until the
    // 'ready' event fires again after the client reconnects.
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

export async function bootstrap(): Promise<void> {
  // Guard against double-init in Next.js dev (hot reload can re-run instrumentation)
  if (globalThis.__bootstrapped) return;
  globalThis.__bootstrapped = true;

  patchConsole();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const qrcode = require('qrcode-terminal') as { generate: (text: string, opts?: { small?: boolean }) => void };

  // Resolve Chrome executable: env override → system Chrome → puppeteer default
  function resolveChromePath(): string | undefined {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    const fs = require('fs') as typeof import('fs');
    return candidates.find((p) => fs.existsSync(p));
  }

  const executablePath = resolveChromePath();
  if (executablePath) console.log(`Using Chrome at: ${executablePath}`);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    // Pin to a known-good WhatsApp Web version from the community archive.
    // The live site frequently ships JS module renames that silently break
    // the LoadUtils injection, preventing 'ready' from ever firing.
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
    },
    puppeteer: {
      headless: true,
      protocolTimeout: 600000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      ...(executablePath ? { executablePath } : {}),
    },
  });

  globalThis.__whatsappClient = client;
  globalThis.__whatsappReady = false;

  client.on('qr', (qr: string) => {
    console.log('\nScan this QR code with WhatsApp on your phone:\n');
    qrcode.generate(qr, { small: true });
  });

  let readyWatchdog: ReturnType<typeof setTimeout> | null = null;

  function startReadyWatchdog() {
    if (readyWatchdog) clearTimeout(readyWatchdog);
    readyWatchdog = setTimeout(async () => {
      console.warn('WhatsApp ready watchdog fired — client stuck after authenticated. Reinitializing...');
      try { await client.destroy(); } catch { /* ignore */ }
      client.initialize().catch((err: Error) => {
        console.error('WhatsApp re-initialize() error:', err.message);
      });
    }, 3 * 60 * 1000); // 3 minutes
  }

  client.on('loading_screen', (percent: number) => {
    console.log(`WhatsApp loading: ${percent}%`);
  });

  client.on('authenticated', () => {
    console.log('WhatsApp authenticated. Waiting for page to finish loading...');
    startReadyWatchdog();

    // Diagnostic: 5 seconds after auth, check what the page state actually is
    setTimeout(async () => {
      if (isWhatsAppReady()) return; // already reached ready, no need
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const page = (client as any).pupPage;
        if (!page) { console.warn('  [diag] pupPage not available'); return; }

        const wwebjsDefined: boolean = await page.evaluate(
          () => typeof (window as unknown as Record<string, unknown>).WWebJS !== 'undefined'
        );
        console.log(`  [diag] window.WWebJS defined: ${wwebjsDefined}`);

        const socketState: string = await page.evaluate(() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (window as any).require('WAWebSocketModel')?.Socket?.state ?? 'null';
          } catch (e) {
            return 'module-error: ' + (e as Error).message;
          }
        });
        console.log(`  [diag] WAWebSocket state: ${socketState}`);

        const pageUrl: string = page.url();
        console.log(`  [diag] page URL: ${pageUrl}`);
      } catch (e) {
        console.warn('  [diag] check failed:', (e as Error).message);
      }
    }, 5000);
  });

  client.on('auth_failure', (msg: string) => {
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
    console.error('WhatsApp auth failed:', msg);
  });

  let cronStarted = false;

  client.on('ready', () => {
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
    globalThis.__whatsappReady = true;
    console.log('WhatsApp client ready.\n');

    state.nextRunAt = nextScheduledRun().toISOString();

    if (!cronStarted) {
      cronStarted = true;
      const tz = process.env.TZ ?? 'Asia/Hong_Kong';
      const schedules = process.env.CRON_SCHEDULE!.split(';').map(s => s.trim()).filter(Boolean);
      console.log(`Scheduler active. Cron: ${schedules.map(s => '"' + s + '"').join(', ')} (${tz})`);
      for (const schedule of schedules) {
        cron.schedule(
          schedule,
          () => {
            console.log('Cron fired — starting scheduled scan...');
            runScan();
          },
          { timezone: tz }
        );
      }
    } else if (state.scanMissedDueToDisconnect) {
      // WhatsApp reconnected after a mid-scan disconnect — retry the missed scan
      state.scanMissedDueToDisconnect = false;
      console.log('WhatsApp reconnected — retrying missed scan...');
      // Small delay to let WhatsApp finish its internal page reload
      setTimeout(() => runScan(), 5000);
    }
  });

  client.on('disconnected', (reason: string) => {
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
    globalThis.__whatsappReady = false;
    console.warn('WhatsApp client disconnected:', reason);
  });

  console.log('Starting WhatsApp Group Monitor...');
  client.initialize().catch((err: Error) => {
    console.error('WhatsApp initialize() error:', err.message);
  });
}
