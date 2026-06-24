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
