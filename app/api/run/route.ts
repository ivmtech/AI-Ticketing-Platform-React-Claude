import { NextResponse } from 'next/server';
import state from '@/lib/state';
import { runScan, isWhatsAppReady } from '@/lib/bootstrap';

export async function POST() {
  if (state.isRunning) {
    return NextResponse.json({ error: 'Scan is already running' }, { status: 409 });
  }
  if (!isWhatsAppReady()) {
    return NextResponse.json({ error: 'WhatsApp client is not ready yet. Please wait.' }, { status: 503 });
  }
  // Fire and forget — the scan runs in the background and updates state
  runScan();
  return NextResponse.json({ started: true });
}
