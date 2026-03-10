import { NextRequest, NextResponse } from 'next/server';
import { getOddsByRaceId, upsertOdds, upsertRaceEntryOdds } from '@/lib/queries';
import { getCacheHeaders } from '@/lib/api-helpers';
import { scrapeOdds, scrapeRaceResult } from '@/lib/scraper';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const raceId = searchParams.get('raceId');

    if (!raceId) {
      return NextResponse.json({ error: 'raceId が必要です' }, { status: 400 });
    }

    const odds = await getOddsByRaceId(raceId);
    return NextResponse.json({ odds }, { headers: getCacheHeaders('races') });
  } catch (error) {
    console.error('オッズAPI エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const raceId = body.raceId as string | undefined;

    if (!raceId) {
      return NextResponse.json({ error: 'raceId が必要です' }, { status: 400 });
    }

    let fetched = 0;

    // 1. netkeiba odds API を試行（発売中のレース向け）
    const oddsData = await scrapeOdds(raceId);
    if (oddsData.win.length > 0) {
      for (const w of oddsData.win) {
        await upsertOdds(raceId, '単勝', [w.horseNumber], w.odds);
        fetched++;
      }
      for (const p of oddsData.place) {
        await upsertOdds(raceId, '複勝', [p.horseNumber], p.minOdds, p.minOdds, p.maxOdds);
        fetched++;
      }
    } else {
      // 2. API が空 → result.html からオッズ取得（確定レース向け）
      try {
        const results = await scrapeRaceResult(raceId);
        for (const r of results) {
          if (r.odds > 0) {
            await upsertOdds(raceId, '単勝', [r.horseNumber], r.odds);
            await upsertRaceEntryOdds(raceId, r.horseNumber, r.odds, r.popularity);
            fetched++;
          }
        }
      } catch {
        // result.html も取得できない場合は無視
      }
    }

    // 保存後のオッズを返す
    const odds = await getOddsByRaceId(raceId);
    return NextResponse.json({ odds, fetched });
  } catch (error) {
    console.error('オッズ取得エラー:', error);
    return NextResponse.json({ error: 'オッズ取得に失敗しました' }, { status: 500 });
  }
}
