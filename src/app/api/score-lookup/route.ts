import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';

/**
 * スコア帯別の勝率を集計するAPI
 * predictions.picks_json のスコアを5点刻みバケットに分割し、
 * race_entries.result_position と照合して各バケットの単勝/複勝的中率を返す
 */
export async function GET(_request: NextRequest) {
  try {
    // 結果確定済みレースの予想と結果を取得
    const rows = await dbAll<{
      race_id: string;
      picks_json: string;
    }>(
      `SELECT p.race_id, p.picks_json
       FROM predictions p
       JOIN races r ON r.id = p.race_id
       WHERE r.status = '結果確定'
       ORDER BY r.date DESC
       LIMIT 2000`,
      [],
    );

    // 各レースの結果を取得
    const resultRows = await dbAll<{
      race_id: string;
      horse_number: number;
      result_position: number;
    }>(
      `SELECT re.race_id, re.horse_number, re.result_position
       FROM race_entries re
       JOIN races r ON r.id = re.race_id
       WHERE r.status = '結果確定' AND re.result_position IS NOT NULL AND re.result_position > 0`,
      [],
    );

    // レースごとの結果マップ
    const resultMap = new Map<string, Map<number, number>>();
    for (const row of resultRows) {
      if (!resultMap.has(row.race_id)) {
        resultMap.set(row.race_id, new Map());
      }
      resultMap.get(row.race_id)!.set(row.horse_number, row.result_position);
    }

    // スコアバケット集計（5点刻み: 30-35, 35-40, ..., 75-80, 80+）
    const buckets: Record<string, { total: number; win: number; place: number }> = {};

    for (const row of rows) {
      const picks = JSON.parse(row.picks_json || '[]') as { horseNumber: number; score: number }[];
      const results = resultMap.get(row.race_id);
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
      .filter(b => b.total >= 5)  // サンプル5件以上のみ
      .sort((a, b) => a.scoreLow - b.scoreLow);

    return NextResponse.json({ buckets: result });
  } catch (error) {
    console.error('score-lookup エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
