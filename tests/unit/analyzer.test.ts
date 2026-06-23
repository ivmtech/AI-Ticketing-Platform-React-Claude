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

import { analyzeChatBatch, classifyCategory } from '@/lib/analyzer';

describe('classifyCategory — keyword classification', () => {
  it('tags contract/renewal messages as 合約', () => {
    expect(classifyCategory('Hello.我哋合約好似到30/7,繼約嗎?')).toBe('合約');
    expect(classifyCategory('想續約')).toBe('合約');
  });

  it('tags restock / transfer / price-change messages as 補貨', () => {
    expect(classifyCategory('Hello All 聽日黎補貨，幫手報車牌，車牌：MM3348.Thanks')).toBe('補貨');
    expect(classifyCategory('收到，最快明天到場地補貨 車牌確認後再send上來')).toBe('補貨');
    expect(classifyCategory('要求修改機器內飲品價格')).toBe('補貨');
    expect(classifyCategory('麻煩轉貨去另一部機')).toBe('補貨');
  });

  it('tags pricing messages as 報價', () => {
    expect(classifyCategory('呢part幾錢?')).toBe('報價');
    expect(classifyCategory('麻煩報個價')).toBe('報價');
  });

  it('tags fault messages as 維修', () => {
    expect(classifyCategory('部機壞咗開唔到')).toBe('維修');
  });

  it('tags complaints as 投訴', () => {
    expect(classifyCategory('等咗好耐都未有人理')).toBe('投訴');
  });

  it('tags general questions as 查詢', () => {
    expect(classifyCategory('請問點用?')).toBe('查詢');
  });

  it('falls back to 其他 when nothing matches and on empty input', () => {
    expect(classifyCategory('好的收到')).toBe('其他');
    expect(classifyCategory('')).toBe('其他');
    expect(classifyCategory(null)).toBe('其他');
  });

  it('prefers 合約 over other matches when both appear', () => {
    // contains both a 合約 keyword and a 報價 keyword; 合約 wins by order
    expect(classifyCategory('續約嘅話幾錢?')).toBe('合約');
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
