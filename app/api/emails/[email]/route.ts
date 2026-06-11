import { NextResponse } from 'next/server';
import state from '@/lib/state';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ email: string }> }
) {
  const { email } = await params;
  const decoded = decodeURIComponent(email);
  const idx = state.reportEmails.indexOf(decoded);
  if (idx === -1) {
    return NextResponse.json({ error: 'Email not found' }, { status: 404 });
  }
  state.reportEmails.splice(idx, 1);
  return NextResponse.json({ emails: state.reportEmails });
}
