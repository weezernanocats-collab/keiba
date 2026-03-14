import { NextRequest, NextResponse } from 'next/server';
import { getRacesByDate, getRacesByDateRange, getUpcomingRaces, getRecentResults } from '@/lib/queries';
import { getCacheHeaders } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const date = searchParams.get('date');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const type = searchParams.get('type'); // upcoming | results

    const headers = getCacheHeaders('races');

    if (type === 'upcoming') {
      if (date) {
        const allRaces = await getRacesByDate(date);
        const races = allRaces.filter(r => r.status === '予定' || r.status === '出走確定');
        return NextResponse.json({ races }, { headers });
      }
      const races = await getUpcomingRaces(50);
      return NextResponse.json({ races }, { headers });
    }

    if (type === 'results') {
      if (date) {
        const allRaces = await getRacesByDate(date);
        const races = allRaces.filter(r => r.status === '結果確定');
        return NextResponse.json({ races }, { headers });
      }
      const races = await getRecentResults(50);
      return NextResponse.json({ races }, { headers });
    }

    if (date) {
      const races = await getRacesByDate(date);
      return NextResponse.json({ races }, { headers });
    }

    if (startDate && endDate) {
      const races = await getRacesByDateRange(startDate, endDate);
      return NextResponse.json({ races }, { headers });
    }

    // デフォルト: 今後のレース
    const races = await getUpcomingRaces(50);
    return NextResponse.json({ races }, { headers });
  } catch (error) {
    console.error('レースAPI エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
