import { NextResponse } from 'next/server';
import { getDashboardStats } from '@/lib/queries';
import { seedAllData } from '@/lib/seed-data';

export async function GET() {
  try {
    seedAllData();
    const stats = getDashboardStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error('統計API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
