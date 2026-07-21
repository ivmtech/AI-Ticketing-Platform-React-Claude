import { describe, it, expect } from 'vitest';
import { isPageLostError, MAX_CONSECUTIVE_PAGE_LOST } from '@/lib/scan';

// isPageLostError decides whether a scan failure should force a WhatsApp
// reconnect. It must catch every shape of "the page/CDP context died" while
// NOT reconnecting on unrelated failures (SMTP, formatting, etc.).
describe('isPageLostError', () => {
  it('matches named puppeteer/CDP page-loss errors', () => {
    for (const msg of [
      "Attempted to use detached Frame 'BE8C04664820991AE99CA06A7C451A91'.",
      'Session closed. Most likely the page has been closed.',
      'Protocol error (Runtime.callFunctionOn): Target closed',
      'Protocol error (Runtime.callFunctionOn): Promise was collected',
      'Execution context was destroyed, most likely because of a navigation',
    ]) {
      expect(isPageLostError(msg), msg).toBe(true);
    }
  });

  it('matches a bare minified token thrown from the WhatsApp Web bundle', () => {
    // The 2026-07-20 regression: getChats() failed inside page.evaluate and the
    // whole message was a single minified variable name.
    expect(isPageLostError('r')).toBe(true);
    expect(isPageLostError(' e2 ')).toBe(true);
  });

  it('does NOT reconnect on unrelated failures', () => {
    for (const msg of [
      'SMTP connection failed (smtp.gmail.com:465). If port 465 is blocked, try SMTP_PORT=465 with SMTP_SECURE=true in your .env.local',
      'Cannot read properties of undefined (reading "html")',
      'ANTHROPIC_API_KEY not set — add it to your .env.local file',
      'rate_limit_error: This request would exceed your organization\'s rate limit',
    ]) {
      expect(isPageLostError(msg), msg).toBe(false);
    }
  });

  it('handles empty / nullish messages without reconnecting', () => {
    expect(isPageLostError('')).toBe(false);
    expect(isPageLostError(null)).toBe(false);
    expect(isPageLostError(undefined)).toBe(false);
  });
});

describe('circuit-breaker cap', () => {
  it('is a small positive integer so the reconnect loop is bounded', () => {
    expect(Number.isInteger(MAX_CONSECUTIVE_PAGE_LOST)).toBe(true);
    expect(MAX_CONSECUTIVE_PAGE_LOST).toBeGreaterThan(0);
    expect(MAX_CONSECUTIVE_PAGE_LOST).toBeLessThan(20);
  });
});
