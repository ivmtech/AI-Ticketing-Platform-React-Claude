import { describe, it, expect } from 'vitest';
import {
  matchesKeyword,
  isColleague,
  UNRESOLVED_KEYWORDS,
  RESOLVED_KEYWORDS,
  HIGH_PRIORITY_KEYWORDS,
} from '@/lib/analyzer';

describe('matchesKeyword', () => {
  it('returns the matched keyword when present', () => {
    expect(matchesKeyword('個機壞咗喇', UNRESOLVED_KEYWORDS)).toBe('壞咗');
  });

  it('returns null when no keyword matches', () => {
    expect(matchesKeyword('多謝晒', UNRESOLVED_KEYWORDS)).toBeNull();
  });

  it('returns null for empty/nullish input', () => {
    expect(matchesKeyword('', RESOLVED_KEYWORDS)).toBeNull();
    expect(matchesKeyword(null, RESOLVED_KEYWORDS)).toBeNull();
    expect(matchesKeyword(undefined, RESOLVED_KEYWORDS)).toBeNull();
  });

  it('detects high-priority urgency words', () => {
    expect(matchesKeyword('好緊急呀', HIGH_PRIORITY_KEYWORDS)).toBe('緊急');
  });

  it('detects resolved confirmations', () => {
    expect(matchesKeyword('已搞掂晒', RESOLVED_KEYWORDS)).toBe('搞掂');
  });

  it('detects colleague resolution phrases (辛苦哂 / 已通知同事 / 現在ok)', () => {
    expect(matchesKeyword('辛苦哂', RESOLVED_KEYWORDS)).toBe('辛苦哂');
    expect(matchesKeyword('已通知同事', RESOLVED_KEYWORDS)).toBe('已通知同事');
    expect(matchesKeyword('現在ok', RESOLVED_KEYWORDS)).toBe('現在ok');
  });

  it('treats a colleague "你可以找我" offer as a resolution phrase', () => {
    expect(matchesKeyword('你可以找我', RESOLVED_KEYWORDS)).toBe('你可以找我');
  });

  it('treats a colleague dispatch confirmation (將會安排 / 已派期 / 師傅到場) as resolved', () => {
    expect(matchesKeyword('收到. 將會安排更換火牛', RESOLVED_KEYWORDS)).toBe('將會安排');
    expect(matchesKeyword('已派期會有師傅到場處理', RESOLVED_KEYWORDS)).toBe('已派期');
  });

  it('treats a colleague completion/final answer (已加 / 可以正常 / 唔需要) as resolved', () => {
    expect(matchesKeyword('已加上其他付款方式', RESOLVED_KEYWORDS)).toBe('已加');
    expect(matchesKeyword('岩岩試左付款功能都可以正常，我地會密切留意', RESOLVED_KEYWORDS)).toBe('可以正常');
    expect(matchesKeyword('唔需要的', RESOLVED_KEYWORDS)).toBe('唔需要');
  });

  it('supports * wildcard keywords spanning arbitrary text', () => {
    expect(matchesKeyword('改咖啡機價錢', ['改*機'])).toBe('改*機');
    expect(matchesKeyword('改飲品機圖片', ['改*機'])).toBe('改*機');
    expect(matchesKeyword('改機', ['改*機'])).toBe('改*機'); // wildcard may match empty
    expect(matchesKeyword('部機要改嘢', ['改*機'])).toBeNull(); // order matters: 機 before 改
    expect(matchesKeyword('咖啡機壞咗', ['改*機'])).toBeNull(); // no 改 at all
  });
});

describe('isColleague', () => {
  // COLLEAGUE_NAMES is set to "Sam,Alvin" in vitest.config.mts env.
  it('matches a configured colleague name (case-insensitive)', () => {
    expect(isColleague('Sam')).toBe(true);
    expect(isColleague('alvin')).toBe(true);
  });

  it('does not match unknown names', () => {
    expect(isColleague('Client')).toBe(false);
  });

  it('returns false for nullish names', () => {
    expect(isColleague(null)).toBe(false);
    expect(isColleague(undefined)).toBe(false);
    expect(isColleague('')).toBe(false);
  });
});
