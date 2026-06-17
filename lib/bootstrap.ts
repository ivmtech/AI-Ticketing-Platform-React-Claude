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
  const d = new Date();
  const h = d.getHours() * 60 + d.getMinutes();
  const next = h < 9 * 60 ? 9 : h < 17 * 60 ? 17 : 9;
  const result = new Date(d);
  result.setMinutes(0, 0, 0);
  result.setHours(next);
  if (next <= d.getHours()) result.setDate(result.getDate() + 1);
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

  client.on('authenticated', () => console.log('WhatsApp authenticated.'));
  client.on('auth_failure', (msg: string) => {
    console.error('WhatsApp auth failed:', msg);
  });

  let cronStarted = false;

  client.on('ready', () => {
    globalThis.__whatsappReady = true;
    console.log('WhatsApp client ready.\n');

    state.nextRunAt = nextScheduledRun().toISOString();

    if (!cronStarted) {
      cronStarted = true;
      const tz = process.env.TZ ?? 'Asia/Hong_Kong';
      const schedule = process.env.CRON_SCHEDULE ?? '0 9,17 * * *';
      console.log(`Scheduler active. Cron: "${schedule}" (${tz})`);
      cron.schedule(
        schedule,
        () => {
          console.log('Cron fired — starting scheduled scan...');
          runScan();
        },
        { timezone: tz }
      );
    } else if (state.scanMissedDueToDisconnect) {
      // WhatsApp reconnected after a mid-scan disconnect — retry the missed scan
      state.scanMissedDueToDisconnect = false;
      console.log('WhatsApp reconnected — retrying missed scan...');
      // Small delay to let WhatsApp finish its internal page reload
      setTimeout(() => runScan(), 5000);
    }
  });

  client.on('disconnected', (reason: string) => {
    globalThis.__whatsappReady = false;
    console.warn('WhatsApp client disconnected:', reason);
  });

  console.log('Starting WhatsApp Group Monitor...');
  client.initialize().catch((err: Error) => {
    console.error('WhatsApp initialize() error:', err.message);
  });
}
