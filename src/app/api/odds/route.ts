import { NextRequest, NextResponse } from 'next/server';
import { getOddsByRaceId } from '@/lib/queries';
import { seedAllData } from '@/lib/seed-data';

export async function GET(request: NextRequest) {
  try {
    await seedAllData();

    const { searchParams } = request.nextUrl;
    const raceId = searchParams.get('raceId');

    if (!raceId) {
      return NextResponse.json({ error: 'raceId が必要です' }, { status: 400 });
    }

    const odds = await getOddsByRaceId(raceId);
    return NextResponse.json({ odds });
  } catch (error) {
    console.error('オッズAPI エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
