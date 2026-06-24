import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentMsg, clientMsg } from '../fixtures/builders';

// Mock the Anthropic SDK so no real API call is made in Tier 1. createMock
// stands in for `anthropic.messages.create`.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { analyzeChatBatch, classifyCategories } from '@/lib/analyzer';

describe('classifyCategories — keyword classification', () => {
  it('tags contract/renewal messages as 合約', () => {
    expect(classifyCategories('Hello.我哋合約好似到30/7,繼約嗎?')).toEqual(['合約']);
    expect(classifyCategories('想續約')).toEqual(['合約']);
  });

  it('tags agreement-signing messages as 合約', () => {
    expect(classifyCategories('已簽Agreement')).toEqual(['合約']);
    expect(classifyCategories('客戶要求建立帳戶觀看銷售數據及簽署協議')).toEqual(['合約']);
  });

  it('tags restock / transfer / price-change messages as 補貨', () => {
    expect(classifyCategories('Hello All 聽日黎補貨，幫手報車牌，車牌：MM3348.Thanks')).toEqual(['補貨']);
    expect(classifyCategories('收到，最快明天到場地補貨 車牌確認後再send上來')).toEqual(['補貨']);
    expect(classifyCategories('要求修改機器內飲品價格')).toEqual(['補貨']);
    expect(classifyCategories('麻煩轉貨去另一部機')).toEqual(['補貨']);
  });

  it('tags pricing messages as 報價', () => {
    expect(classifyCategories('呢part幾錢?')).toEqual(['報價']);
    expect(classifyCategories('麻煩報個價')).toEqual(['報價']);
  });

  it('tags fault messages as 維修', () => {
    expect(classifyCategories('部機壞咗開唔到')).toEqual(['維修']);
  });

  it('tags complaints as 投訴', () => {
    expect(classifyCategories('等咗好耐都未有人理')).toEqual(['投訴']);
  });

  it('tags general questions as 查詢', () => {
    expect(classifyCategories('請問點用?')).toEqual(['查詢']);
  });

  it('falls back to [其他] when nothing matches and on empty input', () => {
    expect(classifyCategories('好的收到')).toEqual(['其他']);
    expect(classifyCategories('')).toEqual(['其他']);
    expect(classifyCategories(null)).toEqual(['其他']);
  });

  it('returns multiple categories (in defined order) when several match', () => {
    // contains a 合約 keyword AND a 報價 keyword → both badges, 合約 first
    expect(classifyCategories('續約嘅話幾錢?')).toEqual(['合約', '報價']);
    // restock + fault
    expect(classifyCategories('部機壞咗，順便補貨')).toEqual(['補貨', '維修']);
  });
});

// Build a fake Anthropic response carrying `text` as the first content block.
function reply(text: string) {
  return { content: [{ type: 'text', text }] };
}
function batchReply(objs: unknown[]) {
  return reply(JSON.stringify(objs));
}

beforeEach(() => {
  createMock.mockReset();
});

describe('analyzeChatBatch — happy path', () => {
  it('maps a well-formed batch array onto items in order', async () => {
    createMock.mockResolvedValueOnce(
      batchReply([
        { resolved: true, clientSummary: '門鎖問題', reason: '同事已處理', priority: '中', confidence: 0.9 },
        { resolved: false, clientSummary: '送貨查詢', reason: '客戶仍在等', priority: '中', confidence: 0.8 },
      ])
    );

    const results = await analyzeChatBatch([
      { groupName: 'G1', messages: [clientMsg('個門點開'), agentMsg('我而家睇緊')] },
      { groupName: 'G2', messages: [clientMsg('幾時送貨')] },
    ]);

    expect(createMock).toHaveBeenCalledTimes(1); // single batch call
    expect(results).toHaveLength(2);
    expect(results[0].resolved).toBe(true);
    expect(results[1].resolved).toBe(false);
    expect(results[0].clientSummary).toBe('門鎖問題');
  });
});

describe('analyzeChatBatch — keyword short-circuits (no Claude call)', () => {
  it('resolves via colleague RESOLVED keyword without calling Claude', async () => {
    const results = await analyzeChatBatch([
      { groupName: 'G', messages: [clientMsg('個機壞咗'), agentMsg('已搞掂')] },
    ]);
    expect(createMock).not.toHaveBeenCalled();
    expect(results[0].resolved).toBe(true);
    expect(results[0].confidence).toBe(0.95);
  });

  it('resolves via client acknowledgement keyword without calling Claude', async () => {
    const results = await analyzeChatBatch([
      { groupName: 'G', messages: [clientMsg('多謝晒')] },
    ]);
    expect(createMock).not.toHaveBeenCalled();
    expect(results[0].resolved).toBe(true);
  });

  it('resolves when a client signs off with 現在ok / 辛苦哂 / 明白', async () => {
    const results = await analyzeChatBatch([
      { groupName: 'G1', messages: [clientMsg('部機壞咗'), agentMsg('幫你重啟咗'), clientMsg('現在ok')] },
      { groupName: 'G2', messages: [agentMsg('已派人跟進'), clientMsg('辛苦哂')] },
      { groupName: 'G3', messages: [agentMsg('要先暫停飲品貨道'), clientMsg('Ok, 明白')] },
    ]);
    expect(createMock).not.toHaveBeenCalled();
    expect(results.every((r) => r.resolved)).toBe(true);
  });

  it('resolves when a colleague offers 你可以找我', async () => {
    const results = await analyzeChatBatch([
      { groupName: 'G', messages: [clientMsg('合約更新及機型轉換'), agentMsg('你可以找我')] },
    ]);
    expect(createMock).not.toHaveBeenCalled();
    expect(results[0].resolved).toBe(true);
  });
});

describe('analyzeChatBatch — verdict overrides', () => {
  it('forces needsReview + unresolved when confidence is below threshold', async () => {
    // Default CONFIDENCE_THRESHOLD is 0.7.
    createMock.mockResolvedValueOnce(
      batchReply([{ resolved: true, clientSummary: 's', reason: 'r', priority: '中', confidence: 0.5 }])
    );
    const results = await analyzeChatBatch([
      { groupName: 'G', messages: [clientMsg('問題'), agentMsg('睇緊')] },
    ]);
    expect(results[0].needsReview).toBe(true);
    expect(results[0].resolved).toBe(false);
    expect(results[0].reason).toContain('需人手覆核');
  });

  it('forces unresolved when Claude says resolved but the client spoke last without ack', async () => {
    createMock.mockResolvedValueOnce(
      batchReply([{ resolved: true, clientSummary: 's', reason: 'r', priority: '中', confidence: 0.95 }])
    );
    const results = await analyzeChatBatch([
      { groupName: 'G', messages: [clientMsg('仲要等幾耐')] }, // last msg from client, no ack word
    ]);
    expect(results[0].resolved).toBe(false);
    expect(results[0].reason).toContain('客戶最後發言');
  });

  it('upgrades priority to 高 when a high-priority keyword is present', async () => {
    createMock.mockResolvedValueOnce(
      batchReply([{ resolved: false, clientSummary: 's', reason: 'r', priority: '低', confidence: 0.8 }])
    );
    const results = await analyzeChatBatch([
      { groupName: 'G', messages: [clientMsg('個系統死機喇好緊急'), agentMsg('睇緊')] },
    ]);
    expect(results[0].priority).toBe('高');
  });
});

describe('analyzeChatBatch — resilience', () => {
  it('falls back to individual calls when the batch response is malformed', async () => {
    createMock
      .mockResolvedValueOnce(reply('sorry, I cannot do that')) // bad batch
      .mockResolvedValueOnce(reply('{"resolved": true, "clientSummary": "s", "reason": "r", "priority": "中", "confidence": 0.9}'));

    const results = await analyzeChatBatch([
      { groupName: 'G', messages: [clientMsg('問題'), agentMsg('睇緊')] },
    ]);
    expect(createMock).toHaveBeenCalledTimes(2); // batch + 1 individual
    expect(results[0].resolved).toBe(true);
  });

  it('falls back when the batch array length does not match item count', async () => {
    createMock
      .mockResolvedValueOnce(batchReply([{ resolved: true, clientSummary: 's', reason: 'r', priority: '中', confidence: 0.9 }])) // only 1
      .mockResolvedValue(reply('{"resolved": false, "clientSummary": "s", "reason": "r", "priority": "中", "confidence": 0.8}'));

    const results = await analyzeChatBatch([
      { groupName: 'G1', messages: [clientMsg('問題一'), agentMsg('睇緊')] },
      { groupName: 'G2', messages: [clientMsg('問題二'), agentMsg('睇緊')] },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].resolved).toBe(false);
    expect(results[1].resolved).toBe(false);
  });

  it('marks needsReview when both batch and individual fallback fail', async () => {
    createMock
      .mockResolvedValueOnce(reply('garbage')) // bad batch
      .mockRejectedValue(new Error('API down')); // individual fallback fails too

    const results = await analyzeChatBatch([
      { groupName: 'G', messages: [clientMsg('問題'), agentMsg('睇緊')] },
    ]);
    expect(results[0].needsReview).toBe(true);
    expect(results[0].confidence).toBe(0);
  });
});
