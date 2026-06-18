import { NextResponse } from 'next/server';
import state from '@/lib/state';

export async function POST() {
  if (state.isRunning) {
    return NextResponse.json({ error: 'Scan is already running' }, { status: 409 });
  }
  if (!(globalThis as { __whatsappReady?: boolean }).__whatsappReady) {
    return NextResponse.json({ error: 'WhatsApp client is not ready yet. Please wait.' }, { status: 503 });
  }
  // Dynamic import so changes to scan logic hot-reload without server restart
  const { runScan } = await import('@/lib/scan');
  // Fire and forget — the scan runs in the background and updates state
  runScan();
  return NextResponse.json({ started: true });
}
