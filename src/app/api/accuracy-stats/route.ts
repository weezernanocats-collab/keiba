import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';

/**
 * 的中率統計API
 * - rolling 50R ウィンドウで winRate/placeRate/ROI 推移
 * - 信頼度バケット別の的中率
 * - 競馬場別の的中率
 */
export async function GET(_request: NextRequest) {
  try {
    // 全 prediction_results を日付順に取得
    const results = await dbAll<{
      race_id: string;
      win_hit: number;
      place_hit: number;
      bet_roi: number;
      evaluated_at: string;
    }>(
      `SELECT pr.race_id, pr.win_hit, pr.place_hit, pr.bet_roi, pr.evaluated_at
       FROM prediction_results pr
       ORDER BY pr.evaluated_at ASC`,
      [],
    );

    // 信頼度・競馬場の追加情報
    const predRows = await dbAll<{
      race_id: string;
      confidence: number;
    }>(
      'SELECT race_id, confidence FROM predictions',
      [],
    );
    const confidenceMap = new Map(predRows.map(r => [r.race_id, r.confidence]));

    const raceRows = await dbAll<{
      id: string;
      racecourse_name: string;
      date: string;
    }>(
      "SELECT id, racecourse_name, date FROM races WHERE status = '結果確定'",
      [],
    );
    const raceInfoMap = new Map(raceRows.map(r => [r.id, { venue: r.racecourse_name, date: r.date }]));

    // Rolling 50R ウィンドウ
    const windowSize = 50;
    const rolling: { index: number; date: string; winRate: number; placeRate: number; roi: number }[] = [];
    for (let i = windowSize - 1; i < results.length; i++) {
      const window = results.slice(i - windowSize + 1, i + 1);
      const winRate = window.reduce((s, r) => s + r.win_hit, 0) / windowSize * 100;
      const placeRate = window.reduce((s, r) => s + r.place_hit, 0) / windowSize * 100;
      // bet_roi は倍率 (0=外れ, 2.5=250%回収)。パーセントに変換
      const avgRoi = window.reduce((s, r) => s + (r.bet_roi || 0), 0) / windowSize * 100;
      const raceInfo = raceInfoMap.get(results[i].race_id);

      rolling.push({
        index: i + 1,
        date: raceInfo?.date || results[i].evaluated_at.split('T')[0],
        winRate: Math.round(winRate * 10) / 10,
        placeRate: Math.round(placeRate * 10) / 10,
        roi: Math.round(avgRoi),
      });
    }

    // 信頼度バケット別 (10刻み: 0-30, 30-40, 40-50, ..., 80-100)
    const confBuckets: Record<string, { total: number; win: number; place: number }> = {};
    for (const r of results) {
      const conf = confidenceMap.get(r.race_id) ?? 50;
      const bucketKey = conf < 30 ? '0-30'
        : conf < 40 ? '30-40'
        : conf < 50 ? '40-50'
        : conf < 60 ? '50-60'
        : conf < 70 ? '60-70'
        : conf < 80 ? '70-80'
        : '80-100';

      if (!confBuckets[bucketKey]) confBuckets[bucketKey] = { total: 0, win: 0, place: 0 };
      confBuckets[bucketKey].total++;
      if (r.win_hit) confBuckets[bucketKey].win++;
      if (r.place_hit) confBuckets[bucketKey].place++;
    }

    const confidenceStats = Object.entries(confBuckets)
      .map(([range, val]) => ({
        range,
        total: val.total,
        winRate: val.total > 0 ? Math.round(val.win / val.total * 1000) / 10 : 0,
        placeRate: val.total > 0 ? Math.round(val.place / val.total * 1000) / 10 : 0,
      }))
      .sort((a, b) => a.range.localeCompare(b.range));

    // 競馬場別
    const venueBuckets: Record<string, { total: number; win: number; place: number }> = {};
    for (const r of results) {
      const info = raceInfoMap.get(r.race_id);
      const venue = info?.venue || '不明';
      if (!venueBuckets[venue]) venueBuckets[venue] = { total: 0, win: 0, place: 0 };
      venueBuckets[venue].total++;
      if (r.win_hit) venueBuckets[venue].win++;
      if (r.place_hit) venueBuckets[venue].place++;
    }

    const venueStats = Object.entries(venueBuckets)
      .map(([venue, val]) => ({
        venue,
        total: val.total,
        winRate: val.total > 0 ? Math.round(val.win / val.total * 1000) / 10 : 0,
        placeRate: val.total > 0 ? Math.round(val.place / val.total * 1000) / 10 : 0,
      }))
      .filter(v => v.total >= 3)
      .sort((a, b) => b.total - a.total);

    // 全体サマリ
    const totalWin = results.reduce((s, r) => s + r.win_hit, 0);
    const totalPlace = results.reduce((s, r) => s + r.place_hit, 0);
    const avgRoi = results.length > 0 ? results.reduce((s, r) => s + (r.bet_roi || 0), 0) / results.length * 100 : 0;

    return NextResponse.json({
      summary: {
        totalEvaluated: results.length,
        winRate: results.length > 0 ? Math.round(totalWin / results.length * 1000) / 10 : 0,
        placeRate: results.length > 0 ? Math.round(totalPlace / results.length * 1000) / 10 : 0,
        avgRoi: Math.round(avgRoi),
      },
      rolling,
      confidenceStats,
      venueStats,
    });
  } catch (error) {
    console.error('accuracy-stats エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
