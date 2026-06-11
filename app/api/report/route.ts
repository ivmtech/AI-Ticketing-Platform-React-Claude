import state from '@/lib/state';

export const dynamic = 'force-dynamic';

const PLACEHOLDER_HTML = `<!DOCTYPE html><html>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8f9fa;color:#aaa">
  <div style="text-align:center">
    <div style="font-size:48px;margin-bottom:16px">📋</div>
    <div style="font-size:16px;font-weight:600;color:#bbb">尚未生成報告</div>
    <div style="font-size:13px;margin-top:8px">點擊左側「Run Now」或等待定時掃描</div>
  </div>
</body></html>`;

export function GET() {
  return new Response(state.lastReportHtml ?? PLACEHOLDER_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
