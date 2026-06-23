import type { EnrichedMessage, ScanEntry, Priority, Category } from '@/lib/types';

let seq = 0;

// Minimal EnrichedMessage builder. Defaults to a client (not-me) text message.
// Pass `senderName` matching COLLEAGUE_NAMES (or fromMe: true) to make it an agent.
export function msg(partial: Partial<EnrichedMessage> = {}): EnrichedMessage {
  return {
    body: 'hello',
    timestamp: Math.floor(Date.now() / 1000) + seq++, // keep ordering stable
    author: '85291234567@c.us',
    senderName: 'Client',
    fromMe: false,
    ...partial,
  };
}

// A colleague/agent message (Sam is in the test COLLEAGUE_NAMES).
export function agentMsg(body: string, partial: Partial<EnrichedMessage> = {}): EnrichedMessage {
  return msg({ body, senderName: 'Sam', author: '85299999999@c.us', ...partial });
}

export function clientMsg(body: string, partial: Partial<EnrichedMessage> = {}): EnrichedMessage {
  return msg({ body, ...partial });
}

// Minimal ScanEntry builder for formatter tests.
export function entry(partial: Partial<ScanEntry> = {}): ScanEntry {
  return {
    groupName: 'Acme Corp',
    senderName: 'Client',
    senderNumber: '85291234567',
    messageContent: '[客戶] 個系統壞咗',
    timestamp: new Date('2026-06-22T10:00:00+08:00'),
    clientSummary: '系統故障',
    reason: '客戶報告故障',
    priority: '中' as Priority,
    category: '維修' as Category,
    confidence: 0.8,
    needsReview: false,
    ...partial,
  };
}
