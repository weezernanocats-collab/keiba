import { NextResponse } from 'next/server';
import { getDashboardStats } from '@/lib/queries';
import { getCacheHeaders } from '@/lib/api-helpers';

export async function GET() {
  try {
    const stats = await getDashboardStats();
    return NextResponse.json(stats, { headers: getCacheHeaders('stats') });
  } catch (error) {
    console.error('統計API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
