import { describe, it, expect } from 'vitest';
import { formatReport } from '@/lib/formatter';
import { entry } from '../fixtures/builders';

describe('formatReport', () => {
  it('reports correct counts in text and payload', () => {
    const r = formatReport({
      resolved: [entry({ groupName: 'A' }), entry({ groupName: 'B' })],
      unresolved: [entry({ groupName: 'C' })],
      skipped: [{ groupName: 'D', reason: '過去48小時無訊息' }],
    });
    expect(r.total).toBe(4);
    expect(r.todoCount).toBe(1);
    expect(r.text).toContain('總數：4');
    expect(r.text).toContain('待跟進：1');
    expect(r.html).toContain('WhatsApp 群組跟進報告');
  });

  it('escapes HTML in group/sender names to prevent injection', () => {
    const r = formatReport({
      resolved: [],
      unresolved: [entry({ groupName: '<script>alert(1)</script>', clientSummary: 'a & b "c"' })],
      skipped: [],
    });
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('&amp;');
    expect(r.html).toContain('&quot;');
  });

  it('sorts pending entries by priority 高 → 中 → 低', () => {
    const r = formatReport({
      resolved: [],
      unresolved: [
        entry({ groupName: 'LOW', priority: '低' }),
        entry({ groupName: 'HIGH', priority: '高' }),
        entry({ groupName: 'MID', priority: '中' }),
      ],
      skipped: [],
    });
    const iHigh = r.text.indexOf('HIGH');
    const iMid = r.text.indexOf('MID');
    const iLow = r.text.indexOf('LOW');
    expect(iHigh).toBeLessThan(iMid);
    expect(iMid).toBeLessThan(iLow);
  });

  it('renders the manual-review badge when needsReview is set', () => {
    const r = formatReport({
      resolved: [],
      unresolved: [entry({ needsReview: true })],
      skipped: [],
    });
    expect(r.html).toContain('需人手覆核');
    expect(r.text).toContain('[需人手覆核]');
  });

  it('shows the all-clear message when nothing is pending', () => {
    const r = formatReport({ resolved: [entry()], unresolved: [], skipped: [] });
    expect(r.html).toContain('所有客戶事件已完成跟進');
    expect(r.todoCount).toBe(0);
  });

  it('renders the truncated banner when a partial scan is flagged', () => {
    const r = formatReport({
      resolved: [],
      unresolved: [entry()],
      skipped: [],
      truncated: true,
      scannedGroups: 5,
      totalGroups: 12,
    });
    expect(r.html).toContain('部分掃描');
    expect(r.html).toContain('5 / 12');
    expect(r.text).toContain('5 / 12');
  });

  it('strips emoji (thumbs-up etc.) from displayed message content and summary', () => {
    const r = formatReport({
      resolved: [entry({ messageContent: '[Derek S] 現在ok 👍', clientSummary: '軌道32 54顯示錯誤要更新 🙏' })],
      unresolved: [entry({ messageContent: '[客戶] 機壞咗 😡👍🏽', clientSummary: '故障 🇭🇰' })],
      skipped: [],
    });
    expect(r.html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}☀-➿]/u);
    expect(r.text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}☀-➿]/u);
    // Surrounding text is preserved
    expect(r.html).toContain('現在ok');
    expect(r.text).toContain('機壞咗');
  });

  it('renders a 分類 column and drops the 狀態 column', () => {
    const r = formatReport({
      resolved: [],
      unresolved: [entry({ category: '合約' })],
      skipped: [],
    });
    expect(r.html).toContain('>分類<');
    expect(r.html).not.toContain('>狀態<');
    // category badge text is rendered
    expect(r.html).toContain('合約');
    // and it appears in the text report
    expect(r.text).toContain('分類          : 合約');
  });

  it('highlights colleague names differently from clients', () => {
    // Sam is a colleague (COLLEAGUE_NAMES env); the agent-blue bg #e3f2fd is used.
    const r = formatReport({
      resolved: [entry({ messageContent: '[Sam] 已經幫你搞掂' })],
      unresolved: [],
      skipped: [],
    });
    expect(r.html).toContain('#e3f2fd'); // agent colour
  });
});
