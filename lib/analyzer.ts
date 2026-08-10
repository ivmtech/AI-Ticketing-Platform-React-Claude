import Anthropic from '@anthropic-ai/sdk';
import type { Priority, Category, EnrichedMessage, ClaudeAnalysisResult } from './types';
import keywords from '@/config/keywords.json';

let anthropic: Anthropic | undefined;

function getClient(): Anthropic {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set — add it to your .env.local file');
    }
    anthropic = new Anthropic();
  }
  return anthropic;
}

// All keyword/category/colour data now lives in config/keywords.json so it can
// be tuned without touching code. The constants below just re-export it with
// the right types, keeping every existing import path unchanged.

// Keyword pre-screen: if the LAST client message clearly signals an
// unresolved issue, we skip the LLM call entirely and route to 待跟進.
export const UNRESOLVED_KEYWORDS: string[] = keywords.unresolved;

export const HIGH_PRIORITY_KEYWORDS: string[] = keywords.highPriority;

export const RESOLVED_KEYWORDS: string[] = keywords.resolved;

const CLIENT_ACK_KEYWORDS: string[] = keywords.clientAck;

// ── Category classification (keyword-only) ──────────────────────────────────
// Each entry is tagged with exactly one 分類. We scan keyword groups IN ORDER
// (as listed in config/keywords.json) and take the first hit, so they are
// ordered most-specific → most-general. '合約' comes first per requirement
// (e.g. "我哋合約好似到30/7,繼約嗎?" → 合約). Falls through to '其他' when nothing
// matches. Note: '機器設定' keywords use the '改*機' wildcard (see matchesKeyword)
// so they cover 改咖啡機價錢, 改飲品機圖片, etc.
export const CATEGORY_KEYWORDS: Array<{ category: Category; keywords: string[] }> =
  keywords.categories as Array<{ category: Category; keywords: string[] }>;

// Per-category badge colours. bg = background, fg = text. 合約 is yellow per
// request, so it needs dark text for contrast; the rest are solid + white text.
export const CATEGORY_COLORS: Record<Category, { bg: string; fg: string }> =
  keywords.categoryColors as Record<Category, { bg: string; fg: string }>;

// Returns EVERY category whose keywords appear in the text (in the order they
// are defined above, so 合約 leads). An entry can therefore carry multiple
// badges. Falls back to ['其他'] when nothing matches.
export function classifyCategories(text: string | null | undefined): Category[] {
  if (!text) return ['其他'];
  const hits: Category[] = [];
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (matchesKeyword(text, keywords)) hits.push(category);
  }
  return hits.length > 0 ? hits : ['其他'];
}

export const COLLEAGUE_NAMES: string[] = (process.env.COLLEAGUE_NAMES ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

export function isColleague(name: string | null | undefined): boolean {
  if (!name || COLLEAGUE_NAMES.length === 0) return false;
  const lower = name.toLowerCase();
  return COLLEAGUE_NAMES.some((c) => c.toLowerCase() === lower);
}

function isAgentMsg(msg: EnrichedMessage): boolean {
  return msg.fromMe === true || isColleague(msg.senderName);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A keyword is "ASCII-wordy" when it contains a Latin letter and no non-ASCII
// characters, e.g. 'OK', 'Done', 'ok now'. Such keywords match on a leading
// word boundary (see matchesKeyword) so a short one like 'ok' never fires
// inside 'book'/'look'/'broke'. Mixed or CJK keywords ('已check', '搞掂') have
// no meaningful word boundary and stay substring matches.
function isAsciiWordKeyword(kw: string): boolean {
  return /[A-Za-z]/.test(kw) && !/[^\x00-\x7F]/.test(kw);
}

// A keyword may contain '*' as a wildcard for any run of characters (including
// none), e.g. '改*機' matches 改咖啡機價錢 / 改售賣機圖片. Matching is
// case-insensitive throughout. ASCII-word keywords additionally require a
// LEADING word boundary — so 'ok' still matches 'ok'/'okok'/'現在ok' (the '在'
// is a boundary) but not 'book'/'look'/'broke'. Everything else is a plain
// (case-insensitive) substring match.
export function matchesKeyword(text: string | null | undefined, keywords: string[]): string | null {
  if (!text) return null;
  const lowerText = text.toLowerCase();
  for (const kw of keywords) {
    if (kw.includes('*')) {
      const re = new RegExp(kw.split('*').map(escapeRegExp).join('[\\s\\S]*'), 'i');
      if (re.test(text)) return kw;
    } else if (isAsciiWordKeyword(kw)) {
      const re = new RegExp('\\b' + escapeRegExp(kw), 'i');
      if (re.test(text)) return kw;
    } else if (lowerText.includes(kw.toLowerCase())) {
      return kw;
    }
  }
  return null;
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function buildPrompt(groupName: string, transcript: string): string {
  return [
    'You are analyzing a WhatsApp group conversation to determine if a client\'s issue or question has been resolved by a support colleague.',
    '',
    'Group: ' + groupName,
    '',
    'Conversation:',
    transcript,
    '',
    'Determine:',
    '1. resolved (boolean) - true ONLY if a support colleague gave a satisfactory final answer OR the client acknowledged the solution. If the LAST message is from the client and contains a question/complaint, resolved must be false.',
    '2. clientSummary - one short sentence IN TRADITIONAL CHINESE (Hong Kong style) describing the client\'s main issue/request',
    '3. reason - brief TRADITIONAL CHINESE explanation of why you ruled resolved/not',
    '4. priority - exactly one of "高" (urgent / system down / blocking business / angry client / explicit urgency words), "中" (normal request needing follow-up within the day), or "低" (informational / casual / non-blocking)',
    '5. confidence (0-1) - how sure are you of the resolved verdict? Use this scale:',
    '   0.9–1.0 : agent gave a clear answer AND client explicitly confirmed (e.g. 多謝, 收到, 搞掂, 👌)',
    '   0.7–0.9 : agent answered clearly but no explicit client confirmation',
    '   0.5–0.7 : ambiguous — last message unclear, conversation cut off, or mixed signals',
    '   0.0–0.5 : strongly ambiguous or conflicting signals (e.g. client asked again after agent replied)',
    '',
    'Respond with ONLY valid JSON (no markdown, no extra text):',
    '{"resolved": true, "clientSummary": "...", "reason": "...", "priority": "中", "confidence": 0.9}',
  ].join('\n');
}

function buildBatchPrompt(prepared: Array<{ groupName: string; transcript: string }>): string {
  const sections = prepared
    .map(({ groupName, transcript }, idx) =>
      '--- GROUP ' + idx + ': ' + groupName + ' ---\n' + transcript
    )
    .join('\n\n');

  return [
    'You are analyzing ' + prepared.length + ' WhatsApp group conversation(s) to determine if each client\'s issue has been resolved by a support colleague.',
    '',
    'For each group, determine:',
    '1. resolved (boolean) - true ONLY if a support colleague gave a satisfactory final answer OR the client acknowledged the solution. If the LAST message is from the client and contains a question/complaint, resolved must be false.',
    '2. clientSummary - one short sentence IN TRADITIONAL CHINESE (Hong Kong style) describing the client\'s main issue/request',
    '3. reason - brief TRADITIONAL CHINESE explanation of your verdict',
    '4. priority - exactly one of "高" (urgent/system down/blocking business/angry client/explicit urgency), "中" (normal request needing follow-up within the day), or "低" (informational/casual/non-blocking)',
    '5. confidence (0-1) - use this scale:',
    '   0.9–1.0 : agent gave a clear answer AND client explicitly confirmed (e.g. 多謝, 收到, 搞掂, 👌)',
    '   0.7–0.9 : agent answered clearly but no explicit client confirmation',
    '   0.5–0.7 : ambiguous — last message unclear, conversation cut off, or mixed signals',
    '   0.0–0.5 : strongly ambiguous or conflicting signals (e.g. client asked again after agent replied)',
    '',
    sections,
    '',
    'Respond with ONLY a valid JSON array (no markdown, no extra text) of exactly ' + prepared.length + ' objects — one per group, do not skip or merge groups. Each object MUST include "idx", the GROUP number it answers for:',
    '[{"idx": 0, "resolved": true, "clientSummary": "...", "reason": "...", "priority": "中", "confidence": 0.9}, ...]',
  ].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Analyze a single group, retrying on 429 (honouring retry-after) — the org
// quota is only ~5 requests/minute, so a rejected call usually succeeds after
// the window resets.
async function analyzeOne(
  model: string,
  groupName: string,
  transcript: string
): Promise<Record<string, unknown> | null> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await getClient().messages.create({
        model,
        max_tokens: 400,
        messages: [{ role: 'user', content: buildPrompt(groupName, transcript) }],
      });
      const txt = ((resp.content[0] as { text?: string })?.text ?? '').trim();
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('No JSON in response');
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 429 && attempt < MAX_ATTEMPTS) {
        const h = (err as { headers?: { get?: (name: string) => string | null } & Record<string, string> }).headers;
        const retryAfter = Number(typeof h?.get === 'function' ? h.get('retry-after') : h?.['retry-after']);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
        console.warn('  Rate limited analyzing "' + groupName + '"; waiting ' + Math.round(waitMs / 1000) + 's (attempt ' + attempt + '/' + MAX_ATTEMPTS + ')');
        await sleep(waitMs);
        continue;
      }
      console.warn('  Individual analysis failed for "' + groupName + '": ' + (err as Error).message);
      return null;
    }
  }
  return null;
}

// Run ONE batched analysis request over `subset` and return a map from each
// item's position in `subset` to its parsed result object. Results are matched
// by the echoed "idx" when present (so a skipped group doesn't invalidate the
// rest), else positionally when the array length matches. 429s are retried with
// the same retry-after backoff as analyzeOne. On any other failure — or a
// length mismatch with no "idx" to match by — it returns whatever was covered
// (possibly {}), leaving the caller to recover the remainder.
async function runBatchOnce(
  model: string,
  subset: Array<{ groupName: string; transcript: string }>
): Promise<Record<number, Record<string, unknown>>> {
  const out: Record<number, Record<string, unknown>> = {};
  if (subset.length === 0) return out;

  const prompt = buildBatchPrompt(subset);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await getClient().messages.create({
        model,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = ((response.content[0] as { text?: string })?.text ?? '').trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array in response');

      const parsed = JSON.parse(jsonMatch[0]) as unknown[];
      if (!Array.isArray(parsed)) throw new Error('Response is not an array');

      const hasIdx = parsed.length > 0 && parsed.every(
        (o) => o != null && typeof o === 'object' && Number.isInteger((o as { idx?: unknown }).idx)
      );

      if (hasIdx) {
        for (const o of parsed) {
          const li = (o as { idx: number }).idx;
          if (li >= 0 && li < subset.length && out[li] === undefined) {
            out[li] = o as Record<string, unknown>;
          }
        }
      } else if (parsed.length === subset.length) {
        parsed.forEach((o, li) => { out[li] = o as Record<string, unknown>; });
      } else {
        throw new Error('Array length mismatch: expected ' + subset.length + ', got ' + parsed.length + ', and objects carry no "idx" to match by');
      }
      return out;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 429 && attempt < MAX_ATTEMPTS) {
        const h = (err as { headers?: { get?: (name: string) => string | null } & Record<string, string> }).headers;
        const retryAfter = Number(typeof h?.get === 'function' ? h.get('retry-after') : h?.['retry-after']);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
        console.warn('  Rate limited on batch of ' + subset.length + '; waiting ' + Math.round(waitMs / 1000) + 's (attempt ' + attempt + '/' + MAX_ATTEMPTS + ')');
        await sleep(waitMs);
        continue;
      }
      console.warn('  Batch request failed (' + (err as Error).message + ')');
      return out;
    }
  }
  return out;
}

export async function analyzeChatBatch(
  items: Array<{ groupName: string; messages: EnrichedMessage[] }>
): Promise<ClaudeAnalysisResult[]> {
  if (items.length === 0) return [];

  const BATCH_SIZE = 20;
  const results: ClaudeAnalysisResult[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const chunkResults = await _analyzeBatchChunk(chunk);
    results.push(...chunkResults);
  }
  return results;
}

async function _analyzeBatchChunk(
  items: Array<{ groupName: string; messages: EnrichedMessage[] }>
): Promise<ClaudeAnalysisResult[]> {
  const model = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
  const threshold = parseFloat(process.env.CONFIDENCE_THRESHOLD ?? '0.7');

  const prepared = items.map(({ groupName, messages }) => {
    const clientMessages = messages.filter((m) => !isAgentMsg(m) && m.body);
    const lastClientMsg = clientMessages.length > 0 ? clientMessages[clientMessages.length - 1] : null;
    const lastBody = lastClientMsg ? (lastClientMsg.body ?? '') : '';
    const highKw = matchesKeyword(lastBody, HIGH_PRIORITY_KEYWORDS);

    const lastMsg = messages[messages.length - 1] ?? null;
    const lastMsgIsAgent = lastMsg != null && isAgentMsg(lastMsg);
    const lastMsgFromClient = !lastMsgIsAgent;
    const resolvedKw = lastMsgIsAgent ? matchesKeyword(lastMsg.body ?? '', RESOLVED_KEYWORDS) : null;
    const lastMsgSenderName = (lastMsg?.senderName) ?? 'ME';

    const transcript = messages
      .map((m) => {
        const time = new Date(m.timestamp * 1000).toLocaleTimeString('en-HK', {
          hour: '2-digit',
          minute: '2-digit',
        });
        const sender = m.senderName || (isAgentMsg(m) ? 'COLLEAGUE' : 'CLIENT');
        return '[' + time + '] ' + sender + ': ' + (m.body || '[media/sticker]');
      })
      .join('\n');

    const clientAckKw = lastMsgFromClient ? matchesKeyword(lastBody, CLIENT_ACK_KEYWORDS) : null;

    return { groupName, lastClientMsg, lastMsg, lastBody, highKw, transcript, resolvedKw, clientAckKw, lastMsgSenderName, lastMsgFromClient };
  });

  const needsClaudeIdx = prepared.reduce<number[]>((acc, p, i) => {
    if (!p.resolvedKw && !p.clientAckKw) acc.push(i);
    return acc;
  }, []);

  const claudeResultMap: Record<number, Record<string, unknown> | null> = {};

  if (needsClaudeIdx.length > 0) {
    const claudeItems = needsClaudeIdx.map((i) => ({
      groupName: prepared[i].groupName,
      transcript: prepared[i].transcript,
    }));
    const delayMs = parseInt(process.env.FALLBACK_DELAY_MS ?? '13000', 10);

    // Primary batch over everything that needs Claude.
    const first = await runBatchOnce(model, claudeItems);
    for (const [li, r] of Object.entries(first)) {
      claudeResultMap[needsClaudeIdx[Number(li)]] = r;
    }

    // Whatever the primary batch didn't cover (Claude skipped it, or the whole
    // call failed) is retried as ONE more batched request — NOT one call per
    // group. At the org's ~5 requests/minute that is the difference between a
    // single request and dozens, and dozens become 429s that surface as
    // "分析失敗，需人手覆核". A last-resort individual pass then mops up anything
    // the re-batch still misses (should be rare and small).
    let missingLocal = claudeItems
      .map((_, li) => li)
      .filter((li) => claudeResultMap[needsClaudeIdx[li]] === undefined);

    if (missingLocal.length > 0) {
      console.warn('  Batch left ' + missingLocal.length + '/' + needsClaudeIdx.length + ' group(s) uncovered; retrying them as one re-batch...');
      await sleep(delayMs);
      const second = await runBatchOnce(model, missingLocal.map((li) => claudeItems[li]));
      for (const [si, r] of Object.entries(second)) {
        claudeResultMap[needsClaudeIdx[missingLocal[Number(si)]]] = r;
      }
      missingLocal = missingLocal.filter((li) => claudeResultMap[needsClaudeIdx[li]] === undefined);
    }

    if (missingLocal.length > 0) {
      console.warn('  ' + missingLocal.length + ' group(s) still uncovered after re-batch; running those individually...');
      for (let i = 0; i < missingLocal.length; i++) {
        if (i > 0) await sleep(delayMs);
        const { groupName, transcript } = claudeItems[missingLocal[i]];
        claudeResultMap[needsClaudeIdx[missingLocal[i]]] = await analyzeOne(model, groupName, transcript);
      }
    }
  }

  return prepared.map(({ lastClientMsg, lastMsg, lastBody, highKw, resolvedKw, clientAckKw, lastMsgSenderName, lastMsgFromClient }, idx) => {
    if (resolvedKw) {
      return {
        resolved: true,
        clientSummary: truncate(lastClientMsg?.body, 50),
        reason: '同事「' + lastMsgSenderName + '」以「' + resolvedKw + '」確認完成',
        priority: '低' as Priority,
        confidence: 0.95,
        needsReview: false,
        lastClientMsg,
        lastOverallMsg: lastMsg,
      };
    }

    if (clientAckKw) {
      return {
        resolved: true,
        clientSummary: truncate(lastBody, 50),
        reason: '客戶以「' + clientAckKw + '」確認完成',
        priority: '低' as Priority,
        confidence: 0.9,
        needsReview: false,
        lastClientMsg,
        lastOverallMsg: lastMsg,
      };
    }

    const r = claudeResultMap[idx];
    if (!r) {
      return {
        resolved: false,
        clientSummary: '分析失敗，需人手覆核',
        reason: '[需人手覆核] 分析失敗',
        priority: (highKw ? '高' : '中') as Priority,
        confidence: 0,
        needsReview: true,
        lastClientMsg,
        lastOverallMsg: lastMsg,
      };
    }

    let priority: Priority = (['高', '中', '低'].includes(r.priority as string) ? r.priority : '中') as Priority;
    if (highKw) priority = '高';

    const confidence = typeof r.confidence === 'number'
      ? Math.max(0, Math.min(1, r.confidence))
      : 0.5;

    let resolved = Boolean(r.resolved);
    let needsReview = false;
    let reason = (r.reason as string) ?? '';

    if (confidence < threshold) {
      needsReview = true;
      resolved = false;
      reason = '[需人手覆核] AI 信心 ' + Math.round(confidence * 100) + '% - ' + reason;
    }

    if (resolved && lastMsgFromClient && !matchesKeyword(lastBody, CLIENT_ACK_KEYWORDS)) {
      resolved = false;
      reason = '[客戶最後發言，未確認完成] ' + reason;
    }

    return {
      resolved,
      clientSummary: (r.clientSummary as string) ?? '未知',
      reason,
      priority,
      confidence,
      needsReview,
      lastClientMsg,
      lastOverallMsg: lastMsg,
    };
  });
}
