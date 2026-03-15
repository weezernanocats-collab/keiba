import { NextRequest, NextResponse } from 'next/server';
import { getOddsByRaceId, upsertOdds, upsertRaceEntryOdds } from '@/lib/queries';
import { getCacheHeaders } from '@/lib/api-helpers';
import { scrapeOdds, scrapeRaceResult } from '@/lib/scraper';
import { dbAll, dbRun } from '@/lib/database';

export const maxDuration = 60;

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
    const raceIds = body.raceIds as string[] | undefined;

    // 複数レース一括更新（フロントからのチャンク）
    if (raceIds && raceIds.length > 0) {
      return await handleBatchOddsRefresh(raceIds);
    }

    if (!raceId) {
      return NextResponse.json({ error: 'raceId または raceIds が必要です' }, { status: 400 });
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

// ==================== 一括オッズ更新（チャンク対応） ====================

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function processOneRace(raceId: string) {
  const odds = await scrapeOdds(raceId);
  let win = 0;
  let place = 0;
  if (odds.win.length > 0) {
    for (const w of odds.win) {
      await upsertOdds(raceId, '単勝', [w.horseNumber], w.odds);
      await dbRun(
        'UPDATE race_entries SET odds = ? WHERE race_id = ? AND horse_number = ?',
        [w.odds, raceId, w.horseNumber]
      );
      win++;
    }
    for (const p of odds.place) {
      await upsertOdds(raceId, '複勝', [p.horseNumber], p.minOdds, p.minOdds, p.maxOdds);
      place++;
    }
  }
  return { win, place };
}

// フロントから渡されたraceIds（最大8件）を3並列で処理
async function handleBatchOddsRefresh(raceIds: string[]) {
  try {
    let totalWin = 0;
    let totalPlace = 0;
    let failCount = 0;

    for (let i = 0; i < raceIds.length; i += 3) {
      const batch = raceIds.slice(i, i + 3);
      const results = await Promise.allSettled(
        batch.map(id => processOneRace(id))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          totalWin += r.value.win;
          totalPlace += r.value.place;
        } else {
          failCount++;
        }
      }
      if (i + 3 < raceIds.length) await sleep(300);
    }

    return NextResponse.json({
      status: 'ok',
      races: raceIds.length,
      totalWin,
      totalPlace,
      failCount,
    });
  } catch (error) {
    console.error('一括オッズ更新エラー:', error);
    return NextResponse.json({ error: '一括オッズ更新に失敗しました' }, { status: 500 });
  }
}
