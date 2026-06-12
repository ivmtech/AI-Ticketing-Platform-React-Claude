'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface ScanProgress { current: number; total: number; }
interface LastResult { resolved: number; unresolved: number; skipped: number; }
interface StatusData {
  isRunning: boolean;
  whatsAppReady: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: LastResult | null;
  progress: ScanProgress;
  logs: string[];
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-HK', {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function Dashboard() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [emails, setEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState('');
  const [runBtnLabel, setRunBtnLabel] = useState('Run Now');
  const logRef = useRef<HTMLDivElement>(null);
  const prevLogsLen = useRef(0);
  const prevLastRunAt = useRef<string | null>(null);
  const initialized = useRef(false);
  const reportFrameRef = useRef<HTMLIFrameElement>(null);

  const refresh = useCallback(async () => {
    try {
      const d: StatusData = await fetch('/api/status').then((r) => r.json());
      setStatus(d);

      // Scroll log to bottom when new lines arrive
      if (logRef.current && d.logs.length !== prevLogsLen.current) {
        prevLogsLen.current = d.logs.length;
        const el = logRef.current;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
        if (atBottom || prevLogsLen.current <= 5) {
          setTimeout(() => { el.scrollTop = el.scrollHeight; }, 0);
        }
      }

      if (!initialized.current) {
        prevLastRunAt.current = d.lastRunAt;
        initialized.current = true;
      }

      // Reload report iframe when a new scan finishes
      if (d.lastRunAt && d.lastRunAt !== prevLastRunAt.current && !d.isRunning) {
        prevLastRunAt.current = d.lastRunAt;
        if (reportFrameRef.current) {
          reportFrameRef.current.src = '/api/report?' + Date.now();
        }
      }

      if (!d.isRunning) setRunBtnLabel('Run Now');
    } catch {
      // ignore transient network errors
    }
  }, []);

  // Load email list once on mount
  useEffect(() => {
    fetch('/api/emails')
      .then((r) => r.json())
      .then((d: { emails: string[] }) => setEmails(d.emails))
      .catch(() => {});
  }, []);

  // Poll status every 3 s
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleRunNow() {
    setRunBtnLabel('Starting...');
    try {
      const r = await fetch('/api/run', { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Failed to start scan' })) as { error?: string };
        alert(err.error ?? 'Failed to start scan');
        setRunBtnLabel('Run Now');
      }
    } catch {
      setRunBtnLabel('Run Now');
    }
  }

  async function addEmail() {
    const email = emailInput.trim();
    if (!email) return;
    const r = await fetch('/api/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await r.json() as { emails?: string[]; error?: string };
    if (!r.ok) { alert(data.error ?? 'Failed to add email'); return; }
    setEmailInput('');
    setEmails(data.emails ?? []);
  }

  async function removeEmail(email: string) {
    const r = await fetch('/api/emails/' + encodeURIComponent(email), { method: 'DELETE' });
    const data = await r.json() as { emails?: string[] };
    if (r.ok) setEmails(data.emails ?? []);
  }

  const isRunning = status?.isRunning ?? false;
  const whatsAppReady = status?.whatsAppReady ?? false;
  const progress = status?.progress ?? { current: 0, total: 0 };

  return (
    <div className="flex h-screen overflow-hidden bg-[#111827] text-[#f9fafb] font-sans">
      {/* ── Left panel ── */}
      <div className="w-[440px] min-w-[440px] h-full overflow-y-auto border-r border-[#374151] px-5 py-6 flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-bold">WhatsApp Group Monitor</h1>
          <p className="text-[#9ca3af] text-xs mt-0.5">Dashboard auto-refreshes every 90s</p>
        </div>

        {/* Status / Last run / Next scheduled */}
        <div className="grid grid-cols-3 gap-2.5">
          <StatCard label="Status">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
              isRunning
                ? 'text-[#f59e0b] bg-[#f59e0b1f] animate-pulse'
                : 'text-[#10b981] bg-[#10b9811f]'
            }`}>
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              {isRunning ? 'Running' : 'Idle'}
            </span>
          </StatCard>
          <StatCard label="Last Run">
            <span className="text-sm font-semibold">{fmtTime(status?.lastRunAt ?? null)}</span>
          </StatCard>
          <StatCard label="Next Scheduled">
            <span className="text-sm font-semibold">{fmtTime(status?.nextRunAt ?? null)}</span>
          </StatCard>
        </div>

        {/* Scan counts */}
        <div className="grid grid-cols-3 gap-2.5">
          <StatCard label="Pending 需跟進">
            <span className="text-[1.8rem] font-bold text-[#ef4444]">
              {status?.lastResult?.unresolved ?? '—'}
            </span>
          </StatCard>
          <StatCard label="Resolved 已完成">
            <span className="text-[1.8rem] font-bold text-[#10b981]">
              {status?.lastResult?.resolved ?? '—'}
            </span>
          </StatCard>
          <StatCard label="Skipped 略過">
            <span className="text-[1.8rem] font-bold text-[#9ca3af]">
              {status?.lastResult?.skipped ?? '—'}
            </span>
          </StatCard>
        </div>

        {/* Run Now button */}
        <button
          onClick={handleRunNow}
          disabled={isRunning || !whatsAppReady}
          className="w-full bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-[0.95rem] transition-colors"
        >
          {isRunning ? 'Running...' : !whatsAppReady ? 'Waiting for WhatsApp...' : runBtnLabel}
        </button>

        {/* Email recipients */}
        <div className="bg-[#1f2937] border border-[#374151] rounded-xl p-3.5">
          <p className="text-[0.65rem] uppercase tracking-wider text-[#9ca3af] mb-2">
            Report Recipients · 收件人
          </p>
          <div className="flex gap-1.5">
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addEmail(); }}
              placeholder="user@example.com"
              className="flex-1 bg-[#080d17] border border-[#374151] focus:border-[#3b82f6] rounded-md px-2.5 py-1.5 text-xs text-[#f9fafb] outline-none"
            />
            <button
              onClick={addEmail}
              className="bg-[#3b82f6] hover:bg-[#2563eb] text-white rounded-md px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors"
            >
              Add
            </button>
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {emails.map((e) => (
              <div
                key={e}
                className="flex items-center justify-between bg-[#080d17] border border-[#374151] rounded-md px-2.5 py-1.5"
              >
                <span className="text-xs">{e}</span>
                <button
                  onClick={() => removeEmail(e)}
                  className="text-[#9ca3af] hover:text-[#ef4444] text-base leading-none transition-colors px-0.5"
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Progress bar — visible only while scanning */}
        {isRunning && (
          <div>
            <p className="text-[0.65rem] uppercase tracking-wider text-[#9ca3af]">掃描進度 · Scan Progress</p>
            <div className="relative bg-[#1f2937] border border-[#374151] rounded-md overflow-hidden h-2 mt-1.5">
              {progress.total > 0 ? (
                <div
                  className="h-full bg-[#3b82f6] rounded-md transition-all duration-500"
                  style={{ width: Math.min(100, Math.round((progress.current / progress.total) * 100)) + '%' }}
                />
              ) : (
                <div className="absolute top-0 h-full w-[45%] bg-[#3b82f6] rounded-md animate-[slide_1.5s_ease-in-out_infinite]" />
              )}
            </div>
            <div className="flex justify-between text-[0.7rem] text-[#9ca3af] mt-1">
              <span>
                {progress.total > 0
                  ? progress.current + ' / ' + progress.total + ' 個群組'
                  : '連接 WhatsApp 中...'}
              </span>
              {progress.total > 0 && (
                <span>{Math.min(100, Math.round((progress.current / progress.total) * 100))}%</span>
              )}
            </div>
          </div>
        )}

        {/* Activity log */}
        <div>
          <p className="text-[0.65rem] uppercase tracking-wider text-[#9ca3af] mb-2">Activity Log</p>
          <div
            ref={logRef}
            className="bg-[#080d17] border border-[#374151] rounded-lg p-3 font-mono text-[0.72rem] leading-relaxed text-[#8fa8c8] h-64 overflow-y-auto whitespace-pre-wrap break-all"
          >
            {status?.logs?.length ? status.logs.join('\n') : <span className="text-[#9ca3af] italic">No activity yet...</span>}
          </div>
        </div>
      </div>

      {/* ── Right panel — report iframe ── */}
      <div className="flex-1 h-full flex flex-col overflow-hidden">
        <div className="px-4 py-2 bg-[#1f2937] border-b border-[#374151] flex items-center justify-between flex-shrink-0">
          <span className="text-[0.68rem] uppercase tracking-wider text-[#9ca3af]">
            報告預覽 · Last Report
          </span>
          {status?.lastRunAt && (
            <span className="text-[0.72rem] text-[#9ca3af] italic">
              Updated {fmtTime(status.lastRunAt)}
            </span>
          )}
        </div>
        <iframe
          ref={reportFrameRef}
          src="/api/report"
          className="flex-1 w-full border-none bg-white"
          title="Last scan report"
        />
      </div>

      <style>{`
        @keyframes slide {
          0%   { left: -45%; }
          100% { left: 110%; }
        }
      `}</style>
    </div>
  );
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#1f2937] border border-[#374151] rounded-xl p-3.5">
      <p className="text-[0.65rem] uppercase tracking-wider text-[#9ca3af] mb-2">{label}</p>
      {children}
    </div>
  );
}
