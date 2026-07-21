import type { Client, Chat } from 'whatsapp-web.js';
// whatsapp-web.js exposes _data as an undocumented internal property with the raw WA payload.
// We access notifyName from it for display names when the contact hasn't saved this number.
import type { Message as WAMessage } from 'whatsapp-web.js';
type Message = WAMessage & { _data?: { notifyName?: string } };
import type { ScanResult, ScanEntry, SkippedEntry, EnrichedMessage } from './types';
import { analyzeChatBatch, UNRESOLVED_KEYWORDS, HIGH_PRIORITY_KEYWORDS, RESOLVED_KEYWORDS, matchesKeyword, isColleague, classifyCategories } from './analyzer';

const contactNameCache = new Map<string, string | null>();


async function resolveName(client: Client, authorId: string | undefined): Promise<string | null> {
  if (!authorId) return null;
  if (contactNameCache.has(authorId)) return contactNameCache.get(authorId) ?? null;
  try {
    const contact = await client.getContactById(authorId);
    const name = contact.pushname || contact.name || null;
    contactNameCache.set(authorId, name);
    return name;
  } catch {
    // Don't cache failures — retry on next scan
    return null;
  }
}

async function enrichMessages(client: Client, messages: Message[]): Promise<EnrichedMessage[]> {
  const needsLookup = [
    ...new Set(
      messages
        .filter((m) => !(m._data as { notifyName?: string })?.notifyName && m.author)
        .map((m) => m.author as string)
    ),
  ];

  const nameMap: Record<string, string | null> = {};
  await Promise.all(
    needsLookup.map(async (authorId) => {
      nameMap[authorId] = await resolveName(client, authorId);
    })
  );

  const deviceName = process.env.WHATSAPP_DEVICE_NAME;

  return messages.map((msg) => ({
    body: msg.body,
    timestamp: msg.timestamp,
    author: msg.author,
    fromMe: msg.fromMe === true,
    senderName:
      msg.fromMe
        ? (deviceName ?? 'Me')
        : ((msg._data as { notifyName?: string })?.notifyName ||
           (msg.author ? nameMap[msg.author] ?? null : null) ||
           (msg.author ? msg.author.split('@')[0] : 'Unknown') ||
           'Unknown'),
  }));
}

interface ScrapeOptions {
  onProgress?: (current: number, total: number) => void;
}

// When a scan dies with a bare minified message (e.g. "r"), puppeteer has
// serialized an error thrown deep inside WhatsApp Web's own bundle and stripped
// all context. This probe runs INSIDE the page and returns the real cause: it
// checks the module loader and each internal module WWebJS.getChats() depends
// on, then calls getChats() in a try/catch so the true message + stack survive
// (returned as a plain string, which puppeteer will NOT minify). Purely
// diagnostic — no side effects on the session.
export async function diagnosePage(client: Client): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = (client as any).pupPage;
  if (!page) return 'no pupPage available';
  try {
    return await page.evaluate(async () => {
      const lines: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      lines.push('window.require: ' + typeof w.require);
      lines.push('window.WWebJS: ' + typeof w.WWebJS);
      const modules = ['WAWebCollections', 'WAWebChatGetters', 'WAWebWidFactory', 'WAWebGroupMetadataCollection'];
      for (const name of modules) {
        try {
          const mod = w.require(name);
          const keys = mod ? Object.keys(mod).slice(0, 6).join(',') : '(null)';
          lines.push(name + ': ' + (mod ? 'ok [' + keys + ']' : 'NULL'));
        } catch (e) {
          lines.push(name + ': REQUIRE-THREW ' + ((e as Error)?.message ?? String(e)));
        }
      }
      try {
        const chats = await w.WWebJS.getChats();
        lines.push('getChats(): ok, ' + (Array.isArray(chats) ? chats.length + ' chats' : typeof chats));
      } catch (e) {
        const err = e as Error;
        lines.push('getChats() THREW: ' + (err?.message ?? String(e)));
        lines.push('  stack: ' + (err?.stack ?? '(none)').split('\n').slice(0, 4).join(' <<< '));
      }
      return lines.join('\n  ');
    });
  } catch (e) {
    return 'diagnostic evaluate failed (page likely already dead): ' + (e as Error).message;
  }
}

// whatsapp-web.js's WWebJS.getChats() maps EVERY chat through getChatModel()
// inside a single Promise.all, so if getChatModel throws for even one chat the
// whole call rejects and we get zero groups. On current WhatsApp Web builds
// that happens routinely: getChatModel() calls groupMetadata.update() and a
// lastMessage IndexedDB lookup, and a bad/undefined key there throws
//   "Failed to execute 'get' on 'IDBObjectStore': No key or key range specified"
// (surfaced to Node as the minified "Scan error: r"). The scanner never uses
// groupMetadata or lastMessage — only id, name and isGroup — so we replace
// getChats() with a version that recovers each failing chat via a minimal
// model built from the cheap, side-effect-free chat.serialize(). Re-injected
// each scan (idempotent); mirrors the existing monkey-patch style in bootstrap.
async function installResilientGetChats(client: Client): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = (client as any).pupPage;
  if (!page) return;
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (!w.WWebJS || typeof w.WWebJS.getChatModel !== 'function') return;
    w.WWebJS.getChats = async () => {
      const Chat = w.require('WAWebCollections').Chat;
      const chats = Chat.getModelsArray();
      const models = [];
      let recovered = 0;
      for (const chat of chats) {
        try {
          models.push(await w.WWebJS.getChatModel(chat));
        } catch {
          // Full model failed (usually the groupMetadata/lastMessage IDB path).
          // Fall back to the minimal fields the scanner needs.
          try {
            const m = chat.serialize();
            m.isGroup = chat.id?.server === 'g.us' || !!chat.groupMetadata;
            try { m.formattedTitle = chat.formattedTitle; } catch { /* getter may throw */ }
            delete m.msgs;
            models.push(m);
            recovered++;
          } catch { /* unrecoverable chat — skip it entirely */ }
        }
      }
      if (recovered > 0) w.__wwebjsGetChatsRecovered = recovered;
      return models;
    };
  });
}

export async function scrapeGroups(client: Client, { onProgress }: ScrapeOptions = {}): Promise<ScanResult> {
  const now = new Date();
  // How far back to scan, in hours. Default 168h (= 7 days).
  const LOOKBACK_HOURS = Math.max(1, parseInt(process.env.SCAN_LOOKBACK_HOURS ?? '168'));
  const cutoff = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);

  const MSG_LIMIT = parseInt(process.env.MESSAGE_HISTORY_LIMIT ?? '10');
  const CONCURRENCY = Math.max(1, parseInt(process.env.SCAN_CONCURRENCY ?? '5'));

  await installResilientGetChats(client);
  const chats: Chat[] = await client.getChats();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = (client as any).pupPage;
  if (page) {
    try {
      const recovered = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const n = w.__wwebjsGetChatsRecovered ?? 0;
        w.__wwebjsGetChatsRecovered = 0;
        return n;
      });
      if (recovered > 0) console.warn('  getChats: recovered ' + recovered + ' chat(s) via minimal model (full serialize failed)');
    } catch { /* diagnostic only */ }
  }
  const groups = chats.filter((c) => c.isGroup);
  console.log(
    'Found ' + groups.length + ' group(s). Scanning last ' + LOOKBACK_HOURS + 'h' +
    ' (concurrency=' + CONCURRENCY + ', msg_limit=' + MSG_LIMIT + ')...'
  );
  if (onProgress) onProgress(0, groups.length);

  const resolved: ScanEntry[] = [];
  const unresolved: ScanEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const pendingClaude: Array<{ groupName: string; messages: EnrichedMessage[] }> = [];
  let scannedGroups = 0;
  const scanStart = Date.now();

  const queue = [...groups];

  async function worker() {
    while (queue.length > 0) {
      const group = queue.shift();
      if (!group) return;

      scannedGroups++;
      if (onProgress) onProgress(scannedGroups, groups.length);

      try {
        const messages: Message[] = await group.fetchMessages({ limit: MSG_LIMIT });

        const recent = messages
          .filter((m) => m.timestamp * 1000 >= cutoff.getTime())
          .sort((a, b) => a.timestamp - b.timestamp);

        const rawClientMsgs = recent.filter((m) => !m.fromMe && m.body);
        if (rawClientMsgs.length === 0) {
          skipped.push({ groupName: group.name, reason: '過去' + LOOKBACK_HOURS + '小時無客戶訊息' });
          continue;
        }

        const lastRawClient = rawClientMsgs[rawClientMsgs.length - 1];
        const lastRawMsg = recent[recent.length - 1];
        const lastMsgIsFromMe = lastRawMsg?.fromMe === true;
        // Colleagues often post from personal numbers (LIDs) that carry no
        // notifyName; fall back to the (cached) contact lookup like
        // enrichMessages does, or their routine broadcasts get treated as
        // client messages and auto-routed to 待跟進 by the keyword pre-screen.
        const lastRawSenderName = !lastRawMsg || lastMsgIsFromMe
          ? null
          : ((lastRawMsg._data as { notifyName?: string })?.notifyName ||
             (await resolveName(client, lastRawMsg.author)) ||
             null);
        const lastMsgIsAgent = !lastRawMsg || lastMsgIsFromMe || isColleague(lastRawSenderName);
        const lastMsgFromClient = !lastMsgIsAgent;
        const unresolvedKw = matchesKeyword(lastRawClient.body, UNRESOLVED_KEYWORDS);
        const highKw = matchesKeyword(lastRawClient.body, HIGH_PRIORITY_KEYWORDS);
        const resolvedKw = lastMsgIsAgent ? matchesKeyword(lastRawMsg?.body ?? '', RESOLVED_KEYWORDS) : null;

        if (unresolvedKw && lastMsgFromClient) {
          const elapsed = ((Date.now() - scanStart) / 1000).toFixed(0);
          console.log('  [' + elapsed + 's] Keyword hit "' + unresolvedKw + '" in "' + group.name + '" — skipping Claude');

          const body = lastRawClient.body ?? '';
          const senderName =
            (lastRawClient._data as { notifyName?: string })?.notifyName ||
            (await resolveName(client, lastRawClient.author)) ||
            (lastRawClient.author ? lastRawClient.author.split('@')[0] : 'Unknown');

          unresolved.push({
            groupName: group.name,
            senderName: senderName ?? 'Unknown',
            senderNumber: lastRawClient.author ? lastRawClient.author.split('@')[0] : 'Unknown',
            messageContent: body ? '[客戶] ' + body : '[Non-text message]',
            timestamp: new Date(lastRawClient.timestamp * 1000),
            clientSummary: body.length > 50 ? body.slice(0, 50) + '…' : body,
            reason: '客戶最後訊息含「' + unresolvedKw + '」且客服未回覆',
            priority: highKw ? '高' : '中',
            categories: classifyCategories(body),
            confidence: 0.95,
            needsReview: false,
          });
          continue;
        }

        if (resolvedKw && lastRawMsg) {
          const elapsed = ((Date.now() - scanStart) / 1000).toFixed(0);
          const colName = lastMsgIsFromMe ? (process.env.WHATSAPP_DEVICE_NAME ?? 'Me') : (lastRawSenderName ?? 'Unknown');
          console.log('  [' + elapsed + 's] Colleague resolved "' + group.name + '" ("' + colName + '": "' + resolvedKw + '") — skipping Claude');

          const body = lastRawClient.body ?? '';
          const senderName =
            (lastRawClient._data as { notifyName?: string })?.notifyName ||
            (await resolveName(client, lastRawClient.author)) ||
            (lastRawClient.author ? lastRawClient.author.split('@')[0] : 'Unknown');

          const msgBody = lastRawMsg.body ?? '';
          resolved.push({
            groupName: group.name,
            senderName: senderName ?? 'Unknown',
            senderNumber: lastRawClient.author ? lastRawClient.author.split('@')[0] : 'Unknown',
            messageContent: msgBody ? '[' + colName + '] ' + msgBody : '[Non-text message]',
            timestamp: new Date(lastRawClient.timestamp * 1000),
            clientSummary: body.length > 50 ? body.slice(0, 50) + '…' : body,
            reason: '同事「' + colName + '」以「' + resolvedKw + '」確認完成',
            priority: '低',
            categories: classifyCategories(body),
            confidence: 0.85,
            needsReview: false,
          });
          continue;
        }

        const enriched = await enrichMessages(client, recent);
        pendingClaude.push({ groupName: group.name, messages: enriched });
      } catch (err) {
        console.warn('  Could not scan "' + group.name + '": ' + (err as Error).message);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (pendingClaude.length > 0) {
    const elapsed = ((Date.now() - scanStart) / 1000).toFixed(0);
    console.log('  [' + elapsed + 's] Batch analyzing ' + pendingClaude.length + ' group(s) with Claude...');

    const analyses = await analyzeChatBatch(pendingClaude);

    for (let i = 0; i < pendingClaude.length; i++) {
      const analysis = analyses[i];
      const { groupName } = pendingClaude[i];

      const lc = analysis.lastClientMsg;
      if (!lc) {
        skipped.push({ groupName, reason: '無客戶訊息（分析後）' });
        continue;
      }

      const lastOverall = analysis.lastOverallMsg;
      const useLastOverall = !!(lastOverall?.body);
      const lastBody = useLastOverall ? (lastOverall!.body) : (lc?.body || '');
      const isLastAgent = useLastOverall && isColleague(lastOverall!.senderName);
      const lastSenderLabel = isLastAgent
        ? (lastOverall!.senderName ?? 'Unknown')
        : '客戶';
      const lastMsgContent = lastBody
        ? '[' + lastSenderLabel + '] ' + lastBody
        : '[Non-text message]';

      const entry: ScanEntry = {
        groupName,
        senderName: lc.senderName || 'Unknown',
        senderNumber: lc.author ? lc.author.split('@')[0] : 'Unknown',
        messageContent: lastMsgContent,
        timestamp: new Date((lastOverall ? lastOverall.timestamp : lc.timestamp) * 1000),
        clientSummary: analysis.clientSummary,
        reason: analysis.reason,
        priority: analysis.priority ?? '中',
        categories: (() => {
          const fromBody = classifyCategories(lc.body);
          // If the client message alone yields nothing, fall back to the summary.
          return fromBody.length === 1 && fromBody[0] === '其他'
            ? classifyCategories(analysis.clientSummary)
            : fromBody;
        })(),
        confidence: analysis.confidence,
        needsReview: Boolean(analysis.needsReview),
      };

      if (analysis.resolved) {
        resolved.push(entry);
      } else {
        unresolved.push(entry);
      }
    }
  }

  return { resolved, unresolved, skipped, scannedGroups, totalGroups: groups.length };
}
