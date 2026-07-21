import { describe, it, expect } from 'vitest';
import { isConversationalMessage, SYSTEM_MESSAGE_TYPES } from '@/lib/scraper';
import { RESOLVED_KEYWORDS, matchesKeyword } from '@/lib/analyzer';

// A group system notification (member added/removed, call log, encryption
// notice, etc.) has an empty body and fromMe:false, so before this filter it
// masqueraded as the newest client message — suppressing the RESOLVED-keyword
// shortcut and tripping the "客戶最後發言" guard, filing resolved tickets as 待跟進.
describe('isConversationalMessage — system-notification filter', () => {
  it('rejects every known non-conversational WhatsApp message type', () => {
    for (const type of SYSTEM_MESSAGE_TYPES) {
      expect(isConversationalMessage(type), type).toBe(false);
    }
  });

  it('keeps real content types', () => {
    for (const type of ['chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'vcard']) {
      expect(isConversationalMessage(type), type).toBe(true);
    }
  });

  it('keeps messages with an unknown or missing type (never drop genuine content)', () => {
    expect(isConversationalMessage(undefined)).toBe(true);
    expect(isConversationalMessage(null)).toBe(true);
    expect(isConversationalMessage('some_future_type')).toBe(true);
  });
});

// Minimal shape of a raw whatsapp-web.js message as the scraper sees it.
type RawMsg = { body: string; fromMe: boolean; type: string; timestamp: number };

// Mirrors scrapeGroups: within-window messages, drop system types, sort by time.
function lastConversational(msgs: RawMsg[]): RawMsg | undefined {
  const recent = msgs
    .filter((m) => isConversationalMessage(m.type))
    .sort((a, b) => a.timestamp - b.timestamp);
  return recent[recent.length - 1];
}

describe('scan last-message detection with a trailing member-add notification', () => {
  // The 2026-07-21 regression: 富衛 FWD 觀灣上 (IVM) — a rekeyed ticket closed at
  // 09:49 with 「Thanks」, then 「~Js Kong已新增+852 9721 3061」 arrived at 12:29.
  const convo: RawMsg[] = [
    { body: '順豐同事連續兩星期都無#3735條鎖匙，想問下幾時會比到佢地？', fromMe: false, type: 'chat', timestamp: 1000 },
    { body: '已將售賣機鎖匙交比上貨同事', fromMe: false, type: 'chat', timestamp: 2000 }, // colleague
    { body: 'Thanks', fromMe: true, type: 'chat', timestamp: 2001 },
    { body: '', fromMe: false, type: 'gp2', timestamp: 3000 }, // Js Kong 已新增 — system notice
  ];

  it('lands on the closing agent message, not the member-add notice', () => {
    const last = lastConversational(convo);
    expect(last?.body).toBe('Thanks');
    expect(last?.fromMe).toBe(true);
  });

  it("lets the RESOLVED-keyword shortcut fire on the agent's closing message", () => {
    const last = lastConversational(convo);
    const lastIsAgent = last?.fromMe === true;
    const resolvedKw = lastIsAgent ? matchesKeyword(last?.body ?? '', RESOLVED_KEYWORDS) : null;
    expect(resolvedKw).toBe('Thanks'); // → routed to 已解決, not 待跟進
  });

  it('would have mis-detected the client-side notice as last WITHOUT the filter', () => {
    // Guard against regressing the filter: without it, the gp2 notice (fromMe:false,
    // empty body) is newest → treated as client → resolved shortcut never fires.
    const unfiltered = [...convo].sort((a, b) => a.timestamp - b.timestamp);
    const last = unfiltered[unfiltered.length - 1];
    expect(last.type).toBe('gp2');
    expect(last.fromMe).toBe(false);
    expect(matchesKeyword(last.body, RESOLVED_KEYWORDS)).toBeNull();
  });
});
