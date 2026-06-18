import type { ScanEntry, SkippedEntry, ReportPayload, Priority } from './types';
import { isColleague } from './analyzer';

interface FormatInput {
  resolved: ScanEntry[];
  unresolved: ScanEntry[];
  skipped?: SkippedEntry[];
  truncated?: boolean;
  scannedGroups?: number;
  totalGroups?: number;
}

const TH = 'padding:8px 10px;text-align:left;border:1px solid #ddd;font-size:13px';
const TD = 'padding:8px 10px;border:1px solid #ddd;font-size:13px;vertical-align:top';

function esc(str: string | null | undefined): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightMsg(raw: string | null | undefined, clientName?: string | null): string {
  const text = (raw ?? '').replace('[客戶]', '[' + (clientName ?? '客戶') + ']');
  return text.replace(/\[([^\]]+)\]/g, (_match, name: string) => {
    const isAgent = isColleague(name);
    const bg = isAgent ? '#e3f2fd' : '#fff3e0';
    const color = isAgent ? '#1565c0' : '#e65100';
    return '<span style="background:' + bg + ';color:' + color + ';padding:1px 5px;border-radius:3px;font-weight:600;white-space:nowrap">[' + esc(name) + ']</span>';
  });
}

function statCard(label: string, value: number, color: string): string {
  return (
    '<div style="text-align:center;padding:14px 28px;border:2px solid ' + color + '22;border-radius:8px;min-width:90px;background:' + color + '08">' +
    '<div style="font-size:32px;font-weight:bold;color:' + color + '">' + value + '</div>' +
    '<div style="font-size:12px;color:#666;margin-top:2px;letter-spacing:0.5px">' + label + '</div>' +
    '</div>'
  );
}

function priorityBadge(priority: Priority): string {
  const colorMap: Record<Priority, string> = { '高': '#c62828', '中': '#f57c00', '低': '#2e7d32' };
  const color = colorMap[priority] ?? '#666';
  return '<span style="background:' + color + ';color:#fff;padding:2px 10px;border-radius:4px;font-size:12px;font-weight:bold">' + (priority ?? '中') + '</span>';
}

function reviewBadge(): string {
  return '<span style="display:inline-block;margin-top:4px;background:#fff8e1;color:#6d4c00;border:1px solid #f9a825;padding:1px 6px;border-radius:4px;font-size:11px">需人手覆核</span>';
}

export function formatReport({
  resolved,
  unresolved,
  skipped = [],
  truncated = false,
  scannedGroups,
  totalGroups,
}: FormatInput): ReportPayload {
  const now = new Date();
  const dateStr =
    now.toLocaleDateString('zh-HK', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }) +
    ' ' +
    now.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: true });

  const priorityOrder: Record<Priority, number> = { '高': 0, '中': 1, '低': 2 };
  const sortedPending = [...unresolved].sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 1;
    const pb = priorityOrder[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return a.timestamp.getTime() - b.timestamp.getTime();
  });

  const total = resolved.length + unresolved.length + skipped.length;

  const truncatedNote = truncated
    ? '[部分掃描：已檢查 ' + scannedGroups + ' / ' + totalGroups + ' 個群組 — 請再次執行以完成餘下部分]\n'
    : '';

  const textSkippedRows = skipped.map((r) => '  • ' + r.groupName + '（' + r.reason + '）');

  const textPendingRows = sortedPending.map(
    (r, i) =>
      (i + 1) + '. [' + r.priority + ']' + (r.needsReview ? ' [需人手覆核]' : '') + ' ' + r.groupName + '\n' +
      '   客戶          : ' + r.senderName + ' (' + r.senderNumber + ')\n' +
      '   優先級        : ' + r.priority + '\n' +
      '   時間          : ' + r.timestamp.toLocaleTimeString('zh-HK') + '\n' +
      '   事件摘要      : ' + r.clientSummary + '\n' +
      '   最後訊息      : ' + r.messageContent
  );

  const textFinishedRows = resolved.map(
    (r, i) =>
      (i + 1) + '. ' + r.groupName + '\n' +
      '   客戶          : ' + (r.senderName || '—') + '\n' +
      '   時間          : ' + (r.timestamp ? r.timestamp.toLocaleTimeString('zh-HK') : '—') + '\n' +
      '   事件摘要      : ' + r.clientSummary + '\n' +
      '   最後訊息      : ' + r.messageContent
  );

  const text = [
    'WhatsApp 群組跟進報告 — ' + dateStr,
    truncatedNote,
    '總數：' + total + '  |  已完成：' + resolved.length + '  |  待跟進：' + unresolved.length + '  |  已略過：' + skipped.length,
    '',
    sortedPending.length > 0 ? '── 待跟進群組 ──' : '所有客戶事件已完成跟進！',
    ...textPendingRows,
    '',
    resolved.length > 0 ? '── 已完成群組 ──' : '',
    ...textFinishedRows,
    '',
    skipped.length > 0 ? '── 已略過群組（' + skipped.length + '）──' : '',
    ...textSkippedRows,
    '',
    '建立時間：' + now.toLocaleString('zh-HK'),
  ].filter(Boolean).join('\n');

  // ── HTML ──────────────────────────────────────────────────────────────────
  const truncatedBanner = truncated
    ? '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px 16px;margin-bottom:16px;font-size:13px">⚠ <strong>部分掃描：</strong>於時間上限前已檢查 ' + scannedGroups + ' / ' + totalGroups + ' 個群組，請再次執行以完成餘下部分。</div>'
    : '';

  const highBanner = '';
  const reviewBanner = '';

  const statBlock =
    '<div style="display:flex;gap:16px;margin:16px 0;flex-wrap:wrap">' +
    statCard('總數', total, '#333333') +
    statCard('已完成', resolved.length, '#2e7d32') +
    statCard('待跟進', unresolved.length, '#c62828') +
    statCard('已略過', skipped.length, '#888888') +
    '</div>';

  const pendingRows = sortedPending
    .map(
      (r, i) =>
        '<tr style="background:' + (i % 2 === 0 ? '#ffffff' : '#f7f7f7') + '">' +
        '<td style="' + TD + '">' + (i + 1) + '</td>' +
        '<td style="' + TD + '">' + priorityBadge(r.priority) + (r.needsReview ? '<br>' + reviewBadge() : '') + '</td>' +
        '<td style="' + TD + '"><strong>' + esc(r.groupName) + '</strong></td>' +
        '<td style="' + TD + ';color:#555;min-width:180px">' + esc(r.clientSummary) + '</td>' +
        '<td style="' + TD + ';min-width:220px">' + highlightMsg(r.messageContent, r.senderName) + '</td>' +
        '<td style="' + TD + ';white-space:nowrap">' + r.timestamp.toLocaleDateString('zh-HK') + '<br>' + r.timestamp.toLocaleTimeString('zh-HK') + '</td>' +
        '<td style="' + TD + ';white-space:nowrap"><span style="background:#c62828;color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">待跟進</span></td>' +
        '</tr>'
    )
    .join('');

  const pendingSection =
    sortedPending.length === 0
      ? '<p style="color:#2e7d32;font-weight:bold;font-size:15px">所有客戶事件已完成跟進！</p>'
      : '<h3 style="margin:24px 0 8px;color:#c62828">待跟進群組（' + sortedPending.length + '）</h3>' +
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;min-width:900px">' +
        '<thead><tr style="background:#f0f0f0">' +
        '<th style="' + TH + '">#</th>' +
        '<th style="' + TH + '">優先級</th>' +
        '<th style="' + TH + '">群組</th>' +
        '<th style="' + TH + ';min-width:180px">事件摘要</th>' +
        '<th style="' + TH + ';min-width:220px">最後訊息</th>' +
        '<th style="' + TH + '">時間</th>' +
        '<th style="' + TH + '">狀態</th>' +
        '</tr></thead><tbody>' + pendingRows + '</tbody></table></div>';

  const finishedRows = resolved
    .map(
      (r, i) =>
        '<tr style="background:' + (i % 2 === 0 ? '#ffffff' : '#f7f7f7') + '">' +
        '<td style="' + TD + '">' + (i + 1) + '</td>' +
        '<td style="' + TD + '"><strong>' + esc(r.groupName) + '</strong></td>' +
        '<td style="' + TD + ';color:#555;min-width:180px">' + esc(r.clientSummary) + '</td>' +
        '<td style="' + TD + ';min-width:220px">' + highlightMsg(r.messageContent, r.senderName) + '</td>' +
        '<td style="' + TD + ';white-space:nowrap">' + (r.timestamp ? r.timestamp.toLocaleDateString('zh-HK') + '<br>' + r.timestamp.toLocaleTimeString('zh-HK') : '—') + '</td>' +
        '<td style="' + TD + ';white-space:nowrap"><span style="background:#2e7d32;color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">已完成</span></td>' +
        '</tr>'
    )
    .join('');

  const finishedSection =
    resolved.length === 0
      ? ''
      : '<h3 style="margin:32px 0 8px;color:#2e7d32">已完成群組（' + resolved.length + '）</h3>' +
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;min-width:900px">' +
        '<thead><tr style="background:#f0f0f0">' +
        '<th style="' + TH + '">#</th>' +
        '<th style="' + TH + '">群組</th>' +
        '<th style="' + TH + ';min-width:180px">事件摘要</th>' +
        '<th style="' + TH + ';min-width:220px">最後訊息</th>' +
        '<th style="' + TH + '">時間</th>' +
        '<th style="' + TH + '">狀態</th>' +
        '</tr></thead><tbody>' + finishedRows + '</tbody></table></div>';

  const skippedRows = skipped
    .map(
      (r, i) =>
        '<tr style="background:' + (i % 2 === 0 ? '#ffffff' : '#f7f7f7') + '">' +
        '<td style="' + TD + '">' + (i + 1) + '</td>' +
        '<td style="' + TD + '">' + esc(r.groupName) + '</td>' +
        '<td style="' + TD + ';color:#888">' + esc(r.reason) + '</td>' +
        '</tr>'
    )
    .join('');

  const skippedSection =
    skipped.length === 0
      ? ''
      : '<details style="margin-top:32px"><summary style="cursor:pointer;font-size:15px;font-weight:bold;color:#888">已略過群組（' + skipped.length + '）</summary>' +
        '<div style="overflow-x:auto;margin-top:8px"><table style="width:100%;border-collapse:collapse;min-width:400px">' +
        '<thead><tr style="background:#f0f0f0">' +
        '<th style="' + TH + '">#</th>' +
        '<th style="' + TH + '">群組</th>' +
        '<th style="' + TH + '">略過原因</th>' +
        '</tr></thead><tbody>' + skippedRows + '</tbody></table></div></details>';

  const html =
    '<!DOCTYPE html><html lang="zh-HK"><body style="font-family:\'Microsoft JhengHei\',\'PingFang HK\',\'Noto Sans TC\',Arial,sans-serif;max-width:980px;margin:0 auto;padding:20px;color:#333">' +
    '<h2 style="margin-bottom:4px">WhatsApp 群組跟進報告</h2>' +
    '<p style="color:#666;margin-top:0">' + dateStr + '</p>' +
    truncatedBanner + highBanner + reviewBanner + statBlock + pendingSection + finishedSection + skippedSection +
    '<p style="color:#aaa;font-size:11px;margin-top:24px">由 WhatsApp Group Monitor 自動產生 &middot; 建立時間：' + now.toLocaleString('zh-HK') + '</p>' +
    '</body></html>';

  return { html, text, todoCount: unresolved.length, total };
}
