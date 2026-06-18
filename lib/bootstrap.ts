import { Client, LocalAuth } from 'whatsapp-web.js';
import cron from 'node-cron';
import state from './state';

// Puppeteer 20.6+ throws "Function already exists" when exposeFunction is
// called for a name already registered (e.g. after a page reload). The
// whatsapp-web.js helper doesn't handle this, causing attachEventListeners()
// to throw silently and 'ready' to never fire. Patch it here at module load
// time using Node.js module cache — all subsequent require() calls get the
// fixed version.
(function patchExposeFunctionIfAbsent() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteerUtils = require('whatsapp-web.js/src/util/Puppeteer') as {
    exposeFunctionIfAbsent: (page: import('puppeteer').Page, name: string, fn: (...args: unknown[]) => unknown) => Promise<void>;
  };
  puppeteerUtils.exposeFunctionIfAbsent = async (page, name, fn) => {
    const exist: boolean = await page.evaluate((n: string) => !!(window as unknown as Record<string, unknown>)[n], name);
    if (exist) return;
    try {
      await page.exposeFunction(name, fn);
    } catch (err) {
      if ((err as Error).message?.toLowerCase().includes('already')) {
        // Function registered in Puppeteer's internal map but not on window —
        // remove it first then re-expose with the new handler.
        try { await (page as unknown as { removeExposedFunction: (n: string) => Promise<void> }).removeExposedFunction(name); } catch { /* ignore */ }
        await page.exposeFunction(name, fn);
      } else {
        throw err;
      }
    }
  };
})();

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

  // A dev hot-reload / restart replaces the Node process without calling
  // client.destroy(), orphaning the headless Chrome which keeps holding the
  // profile's userDataDir lock. The next initialize() then fails with
  // "The browser is already running for ...". Kill any such leftover Chrome
  // (matched strictly by this project's .wwebjs_auth path so the user's own
  // Chrome is never touched) before launching a fresh one.
  function killStaleBrowsers(): void {
    if (process.platform !== 'win32') return; // resolveChromePath is Windows-only anyway
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path') as typeof import('path');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('child_process') as typeof import('child_process');
      const authDir = path.resolve('.wwebjs_auth');
      const ps =
        `Get-CimInstance Win32_Process | ` +
        `Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${authDir}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { stdio: 'ignore', timeout: 15000 });
      console.log('Cleared any stale WhatsApp Chrome processes before launch.');
    } catch {
      // best-effort; if it fails, initialize() will surface the original error
    }
  }
  killStaleBrowsers();

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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-quic'],
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

        // Check ClientInfo deps — these are what run right after the WWebJS poll
        const connSerialize: string = await page.evaluate(() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const conn = (window as any).require('WAWebConnModel')?.Conn;
            if (!conn) return 'WAWebConnModel.Conn is null';
            conn.serialize();
            return 'ok';
          } catch (e) {
            return 'error: ' + (e as Error).message;
          }
        });
        console.log(`  [diag] WAWebConnModel.Conn.serialize(): ${connSerialize}`);

        const widResult: string = await page.evaluate(() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const prefs = (window as any).require('WAWebUserPrefsMeUser');
            const wid = prefs?.getMaybeMePnUser?.() || prefs?.getMaybeMeLidUser?.();
            return wid ? 'ok: ' + String(wid) : 'null wid';
          } catch (e) {
            return 'error: ' + (e as Error).message;
          }
        });
        console.log(`  [diag] WAWebUserPrefsMeUser wid: ${widResult}`);

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

    // Dynamic import — changes to scan.ts are picked up without server restart
    import('./scan').then(({ nextScheduledRun }) => {
      state.nextRunAt = nextScheduledRun().toISOString();
    });

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
            import('./scan').then(({ runScan }) => runScan());
          },
          { timezone: tz }
        );
      }
    } else if (state.scanMissedDueToDisconnect) {
      // WhatsApp reconnected after a mid-scan disconnect — retry the missed scan
      state.scanMissedDueToDisconnect = false;
      console.log('WhatsApp reconnected — retrying missed scan...');
      // Small delay to let WhatsApp finish its internal page reload
      setTimeout(() => import('./scan').then(({ runScan }) => runScan()), 5000);
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
