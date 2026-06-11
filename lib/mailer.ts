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

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: recipients.join(', '),
      subject,
      text,
      html,
    });
    console.log(`Email sent → ${recipients.join(', ')}  (messageId: ${info.messageId})`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED') {
      throw new Error(
        `SMTP connection failed (${process.env.SMTP_HOST}:${port}). ` +
        `If port ${port} is blocked, try SMTP_PORT=465 with SMTP_SECURE=true in your .env.local`
      );
    }
    throw err;
  }
}
