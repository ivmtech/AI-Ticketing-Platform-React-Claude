import Anthropic from '@anthropic-ai/sdk';
import type { Priority, Category, EnrichedMessage, ClaudeAnalysisResult } from './types';

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

// Keyword pre-screen: if the LAST client message clearly signals an
// unresolved issue, we skip the LLM call entirely and route to 待跟進.
export const UNRESOLVED_KEYWORDS = [
  '？', '?',
  '點搞', '點算', '咩事', '咩情況', '搞唔掂', '搞唔到',
  '壞咗', '壞了', '故障', '死機', '當機', '冇反應', '無反應',
  '緊急', '即刻', '快啲', 'ASAP', 'asap', 'urgent', 'URGENT',
  '幫手', '幫幫手', '救命',
  '未得', '唔得', '仲未', '仲係', '依然',
  '幾時', '何時',
];

export const HIGH_PRIORITY_KEYWORDS = [
  '緊急', '即刻', 'ASAP', 'asap', 'urgent', 'URGENT',
  '死機', '當機', '壞咗', '故障', '冇得用', '無得用', '完全用唔到',
  '救命', '幫幫手',
];

export const RESOLVED_KEYWORDS = [
  '搞掂', '已搞掂', '搞好咗', '搞好了', '搞好',
  '已完成', '完成', '妥', '搞定',
  '已處理', '已跟進', '已安排', '已解決',
  'OK', 'Done', 'DONE',
  '冇問題', '無問題', '沒問題',
  'thanks', 'thx', 'Thx', 'Thanks',
  '已更換', '已換', '換過', '已轉換', '已转換', '已转换',
  '已送', '已包邊', '已連接', '已连接',
  '可正常使用', 'ok now', '現在ok', '而家ok', '依家ok',
  '成功',
  '辛苦哂', '辛苦晒',
  '已通知同事', '已通知',
  '同事黎處理', '呢2日同事黎處理', '安排同事', '同事會跟進', '同事跟進', '搵同事處理', '同事處理',
];

const CLIENT_ACK_KEYWORDS = [
  '謝謝', '多謝', '感謝', 'thanks', 'Thanks', 'Thx', 'thz', 'Thz', 'thank you', 'Thank you', 'thx', 'THX',
  '唔使', '唔需要', '不用了', '算了', '算啦', '冇事', '無事', '唔緊要', '不緊要',
  '搞掂', '解決咗', '搞好咗', '搞好了',
  'okok', 'ok ok',
  '唔該', '唔該晒',
  '👌', '🙏',
  '可以了', '可以啊', '可以的',
  '收到', '好的', '好啊', '好呀',
  '已處理', '已解決', '已開櫃', '可以正常',
];

// ── Category classification (keyword-only) ──────────────────────────────────
// Each entry is tagged with exactly one 分類. We scan keyword groups IN ORDER
// and take the first hit, so list them most-specific → most-general. '合約'
// comes first per requirement (e.g. "我哋合約好似到30/7,繼約嗎?" → 合約).
// Falls through to '其他' when nothing matches.
export const CATEGORY_KEYWORDS: Array<{ category: Category; keywords: string[] }> = [
  { category: '合約', keywords: ['合約', '續約', '繼約', '約滿', '約到期', '到期', '約到', 'renew', 'renewal'] },
  // 補貨 covers field/stock operations: restock, transfer goods, price changes, car-plate reports.
  { category: '補貨', keywords: ['補貨', '補水', '補機', '轉貨', '調貨', '換貨', '改價', '改價錢', '改價格', '改飲品價', '修改價格', '飲品價格', '報車牌', '車牌'] },
  { category: '報價', keywords: ['報價', '報個價', '幾錢', '幾多錢', '價錢', '價目', '收費', '月費', '年費', 'quote', 'quotation'] },
  { category: '維修', keywords: ['維修', '整返', '整好', '修理', '壞咗', '壞了', '故障', '死機', '當機', '冇反應', '無反應', '開唔到', '用唔到', '冇得用', '無得用'] },
  { category: '投訴', keywords: ['投訴', '好慢', '好耐', '等咗好耐', '好差', '唔滿意', '態度'] },
  { category: '查詢', keywords: ['查詢', '請問', '點用', '點樣', '可唔可以', '有冇', '係咪', '想問'] },
];

// Per-category badge colours. bg = background, fg = text. 合約 is yellow per
// request, so it needs dark text for contrast; the rest are solid + white text.
export const CATEGORY_COLORS: Record<Category, { bg: string; fg: string }> = {
  '合約': { bg: '#fbc02d', fg: '#4a3b00' }, // yellow / dark text
  '補貨': { bg: '#1565c0', fg: '#ffffff' }, // blue
  '報價': { bg: '#00838f', fg: '#ffffff' }, // teal
  '維修': { bg: '#d84315', fg: '#ffffff' }, // deep orange
  '查詢': { bg: '#6a1b9a', fg: '#ffffff' }, // purple
  '投訴': { bg: '#c62828', fg: '#ffffff' }, // red
  '其他': { bg: '#757575', fg: '#ffffff' }, // grey
};

export function classifyCategory(text: string | null | undefined): Category {
  if (!text) return '其他';
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (matchesKeyword(text, keywords)) return category;
  }
  return '其他';
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

export function matchesKeyword(text: string | null | undefined, keywords: string[]): string | null {
  if (!text) return null;
  for (const kw of keywords) {
    if (text.includes(kw)) return kw;
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
    'Respond with ONLY a valid JSON array of ' + prepared.length + ' objects in the same order as the groups above (no markdown, no extra text):',
    '[{"resolved": true, "clientSummary": "...", "reason": "...", "priority": "中", "confidence": 0.9}, ...]',
  ].join('\n');
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
    const claudeItems = needsClaudeIdx.map((i) => prepared[i]);
    const prompt = buildBatchPrompt(claudeItems);

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
      if (!Array.isArray(parsed) || parsed.length !== claudeItems.length) {
        throw new Error('Array length mismatch: expected ' + claudeItems.length + ', got ' + (Array.isArray(parsed) ? parsed.length : 'non-array'));
      }

      needsClaudeIdx.forEach((origIdx, ci) => {
        claudeResultMap[origIdx] = parsed[ci] as Record<string, unknown>;
      });
    } catch (err) {
      console.warn('  Batch Claude analysis failed (' + (err as Error).message + '). Falling back to individual calls...');
      const fallbackQueue = [...needsClaudeIdx];

      async function fallbackWorker() {
        while (fallbackQueue.length > 0) {
          const origIdx = fallbackQueue.shift();
          if (origIdx == null) return;
          const { groupName, transcript } = prepared[origIdx];
          try {
            const resp = await getClient().messages.create({
              model,
              max_tokens: 400,
              messages: [{ role: 'user', content: buildPrompt(groupName, transcript) }],
            });
            const txt = ((resp.content[0] as { text?: string })?.text ?? '').trim();
            const m = txt.match(/\{[\s\S]*\}/);
            if (!m) throw new Error('No JSON in response');
            claudeResultMap[origIdx] = JSON.parse(m[0]) as Record<string, unknown>;
          } catch (indErr) {
            console.warn('  Individual fallback failed for "' + groupName + '": ' + (indErr as Error).message);
            claudeResultMap[origIdx] = null;
          }
        }
      }
      await Promise.all([fallbackWorker(), fallbackWorker(), fallbackWorker()]);
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
