import nodemailer from 'nodemailer';
import type { ReportPayload } from './types';
import state from './state';

export async function sendEmail({ html, text, todoCount, total }: ReportPayload): Promise<void> {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(', ')} — copy .env.example to .env.local and fill them in`);
  }

  const recipients = state.reportEmails;
  if (!recipients.length) {
    throw new Error('No email recipients configured. Add at least one in the dashboard.');
  }

  const port = parseInt(process.env.SMTP_PORT ?? '587', 10);
  const secure = process.env.SMTP_SECURE === 'true';

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 15000,
    socketTimeout: 60000,
    greetingTimeout: 15000,
  });

  const now = new Date();
  const date = now.toLocaleDateString('zh-HK');
  const time = now.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false });
  const subject = `[WhatsApp 群組跟進報告] 待跟進 ${todoCount} / 總數 ${total} — ${date} ${time}`;

  // A scan can take tens of minutes (WhatsApp scrape + Claude analysis), so the
  // report represents a lot of work. A single transient SMTP hiccup (network
  // blip, Gmail throttling) must not discard it — retry connection-level
  // failures with backoff before giving up.
  const maxAttempts = 3;
  const transientCodes = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ESOCKET', 'EDNS', 'EAI_AGAIN']);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const info = await transporter.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
        to: recipients.join(', '),
        subject,
        text,
        html,
      });
      console.log(`Email sent → ${recipients.join(', ')}  (messageId: ${info.messageId})`);
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const transient = e.code != null && transientCodes.has(e.code);

      // Non-transient errors (auth failure, bad recipient, etc.) won't get
      // better by retrying — fail fast.
      if (!transient) throw err;

      if (attempt < maxAttempts) {
        const waitMs = 5000 * attempt; // 5s, 10s
        console.warn(
          `SMTP send failed (${e.code}) on attempt ${attempt}/${maxAttempts} — retrying in ${waitMs / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // Exhausted retries: surface an accurate, actionable message.
      const altHint = port === 465
        ? 'Port 465 may be firewalled on this network; try SMTP_PORT=587 with SMTP_SECURE=false.'
        : 'Try SMTP_PORT=465 with SMTP_SECURE=true.';
      throw new Error(
        `SMTP connection to ${process.env.SMTP_HOST}:${port} failed after ${maxAttempts} attempts (${e.code}). ${altHint}`
      );
    }
  }
}
