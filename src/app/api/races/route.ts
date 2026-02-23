import { NextRequest, NextResponse } from 'next/server';
import { getRacesByDate, getRacesByDateRange, getUpcomingRaces, getRecentResults } from '@/lib/queries';
import { seedAllData } from '@/lib/seed-data';

export async function GET(request: NextRequest) {
  try {
    await seedAllData();

    const { searchParams } = request.nextUrl;
    const date = searchParams.get('date');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const type = searchParams.get('type'); // upcoming | results

    if (type === 'upcoming') {
      const races = await getUpcomingRaces(50);
      return NextResponse.json({ races });
    }

    if (type === 'results') {
      const races = await getRecentResults(50);
      return NextResponse.json({ races });
    }

    if (date) {
      const races = await getRacesByDate(date);
      return NextResponse.json({ races });
    }

    if (startDate && endDate) {
      const races = await getRacesByDateRange(startDate, endDate);
      return NextResponse.json({ races });
    }

    // デフォルト: 今後のレース
    const races = await getUpcomingRaces(50);
    return NextResponse.json({ races });
  } catch (error) {
    console.error('レースAPI エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
