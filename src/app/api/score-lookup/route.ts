import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';
import { getCacheHeaders } from '@/lib/api-helpers';

export const maxDuration = 30;

// インメモリキャッシュ（重い集計を毎回実行しない）
let cachedResult: { data: unknown; expires: number } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30分（結果確定済みデータのみ使用、日中変動なし）

/**
 * スコア帯別の勝率を集計するAPI
 * predictions.picks_json のスコアを5点刻みバケットに分割し、
 * race_entries.result_position と照合して各バケットの単勝/複勝的中率を返す
 */
export async function GET(_request: NextRequest) {
  try {
    // キャッシュヒット時は即座に返す
    if (cachedResult && Date.now() < cachedResult.expires) {
      return NextResponse.json(cachedResult.data, { headers: getCacheHeaders('stats') });
    }

    // 1クエリでpredictions + race_entriesをJOINして取得
    const rows = await dbAll<{
      race_id: string;
      picks_json: string;
      horse_number: number;
      result_position: number;
    }>(
      `SELECT p.race_id, p.picks_json, re.horse_number, re.result_position
       FROM predictions p
       JOIN races r ON r.id = p.race_id
       JOIN race_entries re ON re.race_id = p.race_id
       WHERE r.status = '結果確定'
         AND re.result_position IS NOT NULL AND re.result_position > 0
         AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = p.race_id)
       ORDER BY r.date DESC`,
      [],
    );

    // レースごとの結果マップを構築
    const resultMap = new Map<string, Map<number, number>>();
    const racePicksMap = new Map<string, string>();
    for (const row of rows) {
      if (!resultMap.has(row.race_id)) {
        resultMap.set(row.race_id, new Map());
      }
      resultMap.get(row.race_id)!.set(row.horse_number, row.result_position);
      if (!racePicksMap.has(row.race_id)) {
        racePicksMap.set(row.race_id, row.picks_json);
      }
    }

    // スコアバケット集計（5点刻み）
    const buckets: Record<string, { total: number; win: number; place: number }> = {};

    for (const [raceId, picksJson] of racePicksMap) {
      const picks = JSON.parse(picksJson || '[]') as { horseNumber: number; score: number }[];
      const results = resultMap.get(raceId);
      if (!results) continue;

      for (const pick of picks) {
        const score = pick.score;
        const bucketKey = `${Math.floor(score / 5) * 5}`;

        if (!buckets[bucketKey]) {
          buckets[bucketKey] = { total: 0, win: 0, place: 0 };
        }

        const position = results.get(pick.horseNumber);
        buckets[bucketKey].total++;
        if (position === 1) buckets[bucketKey].win++;
        if (position !== undefined && position <= 3) buckets[bucketKey].place++;
      }
    }

    // バケットを配列に変換（ソート済み）
    const result = Object.entries(buckets)
      .map(([key, val]) => ({
        scoreRange: `${key}-${parseInt(key) + 5}`,
        scoreLow: parseInt(key),
        total: val.total,
        winRate: val.total > 0 ? Math.round((val.win / val.total) * 1000) / 10 : 0,
        placeRate: val.total > 0 ? Math.round((val.place / val.total) * 1000) / 10 : 0,
      }))
      .filter(b => b.total >= 5)
      .sort((a, b) => a.scoreLow - b.scoreLow);

    const responseData = { buckets: result };

    // キャッシュに保存
    cachedResult = { data: responseData, expires: Date.now() + CACHE_TTL_MS };

    return NextResponse.json(responseData, { headers: getCacheHeaders('stats') });
  } catch (error) {
    console.error('score-lookup エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
