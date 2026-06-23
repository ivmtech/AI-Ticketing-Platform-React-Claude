import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextScheduledRun, lastScheduledRun } from '@/lib/scan';

// These functions parse process.env.CRON_SCHEDULE at call time and compare
// against "now". We pin "now" with fake timers so assertions are deterministic.
// IMPORTANT: this is independent of the real 9am/5pm production schedule — the
// tests inject their own CRON_SCHEDULE, so editing the real config never breaks
// them and these never wait for a real cron tick.

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso));
}

describe('nextScheduledRun', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the next slot later today (9am/5pm schedule)', () => {
    process.env.CRON_SCHEDULE = '0 9;0 17';
    setNow('2026-06-22T08:00:00');
    const r = nextScheduledRun();
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes()).toBe(0);
    expect(r.getDate()).toBe(22);
  });

  it('picks the afternoon slot when morning has passed', () => {
    process.env.CRON_SCHEDULE = '0 9;0 17';
    setNow('2026-06-22T12:00:00');
    const r = nextScheduledRun();
    expect(r.getHours()).toBe(17);
    expect(r.getDate()).toBe(22);
  });

  it('wraps to the first slot tomorrow when all slots have passed', () => {
    process.env.CRON_SCHEDULE = '0 9;0 17';
    setNow('2026-06-22T18:00:00');
    const r = nextScheduledRun();
    expect(r.getHours()).toBe(9);
    expect(r.getDate()).toBe(23); // tomorrow
  });

  it('handles comma minute lists within an hour', () => {
    process.env.CRON_SCHEDULE = '0,30 9';
    setNow('2026-06-22T09:10:00');
    const r = nextScheduledRun();
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes()).toBe(30);
  });
});

describe('lastScheduledRun', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the most recent slot earlier today', () => {
    process.env.CRON_SCHEDULE = '0 9;0 17';
    setNow('2026-06-22T12:00:00');
    const r = lastScheduledRun();
    expect(r.getHours()).toBe(9);
    expect(r.getDate()).toBe(22);
  });

  it('returns yesterday last slot when nothing has fired today yet', () => {
    process.env.CRON_SCHEDULE = '0 9;0 17';
    setNow('2026-06-22T08:00:00');
    const r = lastScheduledRun();
    expect(r.getHours()).toBe(17);
    expect(r.getDate()).toBe(21); // yesterday
  });

  it('detects a missed slot: last scheduled run is after the recorded lastRunAt', () => {
    process.env.CRON_SCHEDULE = '0 9;0 17';
    setNow('2026-06-22T17:30:00');
    // Suppose the last actual scan ran this morning before the 17:00 slot.
    const lastRunAt = new Date('2026-06-22T09:05:00').getTime();
    const missed = lastScheduledRun().getTime() > lastRunAt;
    expect(missed).toBe(true);
  });
});
