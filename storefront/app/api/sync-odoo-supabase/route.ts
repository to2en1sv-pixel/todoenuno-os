import { NextRequest, NextResponse } from 'next/server';
import { syncOdooToSupabase, llenarPostQueue } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await syncOdooToSupabase();
    await llenarPostQueue();
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
