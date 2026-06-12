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
    console.error('Scan error:', (err as Error).message);
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

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      protocolTimeout: 600000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
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

  client.on('ready', () => {
    globalThis.__whatsappReady = true;
    console.log('WhatsApp client ready.\n');

    const tz = process.env.TZ ?? 'Asia/Hong_Kong';
    const schedule = process.env.CRON_SCHEDULE ?? '0 9,17 * * *';

    state.nextRunAt = nextScheduledRun().toISOString();

    console.log(`Scheduler active. Cron: "${schedule}" (${tz})`);

    cron.schedule(
      schedule,
      () => {
        console.log('Cron fired — starting scheduled scan...');
        runScan();
      },
      { timezone: tz }
    );
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
