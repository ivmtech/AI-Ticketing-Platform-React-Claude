import { describe, it, expect } from 'vitest';
import { isConversationalMessage, SYSTEM_MESSAGE_TYPES } from '@/lib/scraper';
import { RESOLVED_KEYWORDS, UNRESOLVED_KEYWORDS, matchesKeyword, isColleague, lidName } from '@/lib/analyzer';

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
    expect(resolvedKw).toBe('thanks'); // → routed to 已解決, not 待跟進
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

// The 2026-08-18 regression: the restock driver's standing notice
// 「Hello All 今天黎補貨，幫手報車牌，車牌：MM3348.Thanks」 was filed as 待跟進 in five
// groups. Two causes stacked: the driver posts from a LID with no notifyName,
// so he was read as a CLIENT, and 「幫手」 (in 幫手報車牌 = "please report the
// plate") hits UNRESOLVED_KEYWORDS. The unresolved pre-screen in scrapeGroups
// runs before the resolved check and short-circuits, so the trailing 「Thanks」
// was never looked at. Mapping the LID to a colleague name is what unblocks it.
describe('restock driver posting from a LID (MM3348)', () => {
  const DRIVER_LID = '182038447571092@lid';
  const notice = 'Hello All 今天黎補貨，幫手報車牌，車牌：MM3348.Thanks';

  it('still matches an unresolved keyword — the text itself is unchanged', () => {
    expect(matchesKeyword(notice, UNRESOLVED_KEYWORDS)).toBe('幫手');
  });

  it('resolves the LID to a colleague, so the last message counts as an agent message', () => {
    const senderName = lidName(DRIVER_LID);
    expect(senderName).toBe('補貨司機');

    // Mirrors scrapeGroups: lastMsgIsAgent decides which pre-screen may fire.
    const lastMsgIsAgent = isColleague(senderName);
    const lastMsgFromClient = !lastMsgIsAgent;
    expect(lastMsgFromClient).toBe(false);

    // The unresolved shortcut needs lastMsgFromClient — now it cannot fire.
    const unresolvedKw = matchesKeyword(notice, UNRESOLVED_KEYWORDS);
    expect(unresolvedKw && lastMsgFromClient).toBe(false);

    // The resolved shortcut needs lastMsgIsAgent — now it does fire.
    const resolvedKw = lastMsgIsAgent ? matchesKeyword(notice, RESOLVED_KEYWORDS) : null;
    expect(resolvedKw).toBe('thanks'); // → 已完成
  });

  it('regresses to 待跟進 when the LID is unmapped', () => {
    const senderName = lidName('999999999999999') ?? '999999999999999';
    const lastMsgFromClient = !isColleague(senderName);
    expect(lastMsgFromClient).toBe(true);
    expect(matchesKeyword(notice, UNRESOLVED_KEYWORDS) && lastMsgFromClient).toBeTruthy();
  });
});
