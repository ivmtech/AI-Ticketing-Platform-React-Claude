import { NextResponse } from 'next/server';
import state from '@/lib/state';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    isRunning: state.isRunning,
    whatsAppReady: (globalThis as { __whatsappReady?: boolean }).__whatsappReady === true,
    lastRunAt: state.lastRunAt,
    nextRunAt: state.nextRunAt,
    lastResult: state.lastResult,
    progress: state.progress ?? { current: 0, total: 0 },
    logs: state.logs.slice(-100),
  });
}
