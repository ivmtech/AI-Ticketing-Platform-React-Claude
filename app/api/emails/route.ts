import { NextRequest, NextResponse } from 'next/server';
import state from '@/lib/state';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ emails: state.reportEmails });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { email?: string };
  const { email } = body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
  }
  if (state.reportEmails.includes(email)) {
    return NextResponse.json({ error: 'Email already in list' }, { status: 409 });
  }
  state.reportEmails.push(email);
  return NextResponse.json({ emails: state.reportEmails });
}
