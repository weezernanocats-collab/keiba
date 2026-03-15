import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';
import { isBetHit } from '@/lib/bet-utils';
import { getCacheHeaders } from '@/lib/api-helpers';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/**
 * 的中率統計API
 * クエリパラメータ: ?days=30 | 60 | 180 | all (デフォルト: all)
 *
 * 返却データ:
 *   - summary: 全体サマリ（単勝/複勝/ROI）
 *   - rolling: ローリングウィンドウ推移
 *   - confidenceStats: 信頼度バケット別
 *   - venueStats: 競馬場別
 *   - gradeStats: グレード別（G1/G2/G3等）
 *   - roiBreakdown: 単勝ROI / 複勝ROI
 *   - betTypeStats: 推奨馬券種別の的中率・ROI
 */

// インメモリキャッシュ（Turso Read量を削減）
const cache = new Map<string, { data: unknown; expires: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30分（結果確定済みデータのみ使用、日中変動なし）

export async function GET(request: NextRequest) {
  try {
    const daysParam = request.nextUrl.searchParams.get('days');
    const days = daysParam && daysParam !== 'all' ? parseInt(daysParam, 10) : 0;
    const cacheKey = `stats_${days}`;

    // キャッシュヒット時は即座に返す
    const cached = cache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
      return NextResponse.json(cached.data, {
        headers: { 'Cache-Control': 'private, max-age=60' },
      });
    }

    const dateFilter = days > 0
      ? `AND r.date >= date('now', '-${days} days')`
      : '';

    // メインクエリ: prediction_results + races + race_entries(オッズ) + odds(複勝実オッズ) + predictions(bets_json) を1回で取得
    const results = await dbAll<{
      race_id: string;
      win_hit: number;
      place_hit: number;
      bet_roi: number;
      bet_investment: number;
      bet_return: number;
      evaluated_at: string;
      race_date: string;
      racecourse_name: string;
      race_name: string;
      grade: string | null;
      top_pick_horse_id: string | null;
      predicted_confidence: number;
      top_pick_odds: number | null;
      top_pick_horse_number: number | null;
      place_min_odds: number | null;
      bets_json: string | null;
    }>(
      `SELECT pr.race_id, pr.win_hit, pr.place_hit, pr.bet_roi,
              pr.bet_investment, pr.bet_return, pr.evaluated_at,
              pr.predicted_confidence, pr.top_pick_horse_id,
              r.date as race_date, r.racecourse_name, r.name as race_name, r.grade,
              re.odds as top_pick_odds, re.horse_number as top_pick_horse_number,
              o.min_odds as place_min_odds,
              p.bets_json
       FROM prediction_results pr
       JOIN races r ON r.id = pr.race_id
       LEFT JOIN race_entries re ON re.race_id = pr.race_id AND re.horse_id = pr.top_pick_horse_id
       LEFT JOIN odds o ON o.race_id = pr.race_id AND o.bet_type = '複勝' AND o.horse_number1 = re.horse_number
       LEFT JOIN predictions p ON p.race_id = pr.race_id
       WHERE r.status = '結果確定' ${dateFilter}
       ORDER BY r.date ASC, pr.evaluated_at ASC`,
      [],
    );

    // 馬券判定用の着順マップを一括取得
    const raceIdsWithBets = [...new Set(
      results.filter(r => r.bets_json && r.bets_json !== '[]').map(r => r.race_id)
    )];
    const entryResultMap = new Map<string, Map<number, number>>();

    if (raceIdsWithBets.length > 0) {
      const BATCH = 200;
      for (let i = 0; i < raceIdsWithBets.length; i += BATCH) {
        const batch = raceIdsWithBets.slice(i, i + BATCH);
        const ph = batch.map(() => '?').join(',');
        const entries = await dbAll<{ race_id: string; horse_number: number; result_position: number }>(
          `SELECT race_id, horse_number, result_position FROM race_entries
           WHERE race_id IN (${ph}) AND result_position IS NOT NULL`,
          batch,
        );
        for (const e of entries) {
          if (!entryResultMap.has(e.race_id)) entryResultMap.set(e.race_id, new Map());
          entryResultMap.get(e.race_id)!.set(e.horse_number, e.result_position);
        }
      }
    }

    // Rolling ウィンドウ
    const windowSize = Math.min(50, Math.max(10, Math.floor(results.length / 3)));
    const rolling: { index: number; date: string; winRate: number; placeRate: number; roi: number }[] = [];
    if (results.length >= windowSize) {
      // ポイント数を最大100に間引き（大量データ時のJSON/描画コスト削減）
      const totalPoints = results.length - windowSize + 1;
      const step = Math.max(1, Math.floor(totalPoints / 100));
      for (let i = windowSize - 1; i < results.length; i += step) {
        const window = results.slice(i - windowSize + 1, i + 1);
        const winRate = window.reduce((s, r) => s + r.win_hit, 0) / windowSize * 100;
        const placeRate = window.reduce((s, r) => s + r.place_hit, 0) / windowSize * 100;
        const avgRoi = window.reduce((s, r) => s + (r.bet_roi || 0), 0) / windowSize * 100;

        rolling.push({
          index: i + 1,
          date: results[i].race_date,
          winRate: Math.round(winRate * 10) / 10,
          placeRate: Math.round(placeRate * 10) / 10,
          roi: Math.round(avgRoi),
        });
      }
    }

    // 信頼度バケット別
    const confBuckets: Record<string, { total: number; win: number; place: number; invested: number; returned: number }> = {};
    for (const r of results) {
      const conf = r.predicted_confidence ?? 50;
      const bucketKey = conf < 30 ? '0-30'
        : conf < 40 ? '30-40'
        : conf < 50 ? '40-50'
        : conf < 60 ? '50-60'
        : conf < 70 ? '60-70'
        : conf < 80 ? '70-80'
        : '80-100';

      if (!confBuckets[bucketKey]) confBuckets[bucketKey] = { total: 0, win: 0, place: 0, invested: 0, returned: 0 };
      confBuckets[bucketKey].total++;
      if (r.win_hit) confBuckets[bucketKey].win++;
      if (r.place_hit) confBuckets[bucketKey].place++;
      confBuckets[bucketKey].invested += r.bet_investment || 100;
      confBuckets[bucketKey].returned += r.bet_return || 0;
    }

    const confidenceStats = Object.entries(confBuckets)
      .map(([range, val]) => ({
        range,
        total: val.total,
        winRate: val.total > 0 ? Math.round(val.win / val.total * 1000) / 10 : 0,
        placeRate: val.total > 0 ? Math.round(val.place / val.total * 1000) / 10 : 0,
        roi: val.invested > 0 ? Math.round(val.returned / val.invested * 1000) / 10 : 0,
      }))
      .sort((a, b) => a.range.localeCompare(b.range));

    // 競馬場別
    const venueBuckets: Record<string, { total: number; win: number; place: number }> = {};
    for (const r of results) {
      const venue = r.racecourse_name || '不明';
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

    // ==================== グレード/条件クラス別統計 ====================
    const gradeBuckets: Record<string, { total: number; win: number; place: number; invested: number; returned: number }> = {};
    for (const r of results) {
      const grade = classifyRace(r.grade, r.race_name);
      if (!gradeBuckets[grade]) gradeBuckets[grade] = { total: 0, win: 0, place: 0, invested: 0, returned: 0 };
      gradeBuckets[grade].total++;
      if (r.win_hit) gradeBuckets[grade].win++;
      if (r.place_hit) gradeBuckets[grade].place++;
      gradeBuckets[grade].invested += r.bet_investment || 100;
      gradeBuckets[grade].returned += r.bet_return || 0;
    }

    // グレード表示順
    const gradeOrder = ['G1', 'G2', 'G3', 'リステッド', 'オープン', '3勝クラス', '2勝クラス', '1勝クラス', '未勝利', '新馬', 'その他'];
    const gradeStats = Object.entries(gradeBuckets)
      .map(([grade, val]) => ({
        grade,
        total: val.total,
        winRate: val.total > 0 ? Math.round(val.win / val.total * 1000) / 10 : 0,
        placeRate: val.total > 0 ? Math.round(val.place / val.total * 1000) / 10 : 0,
        roi: val.invested > 0 ? Math.round(val.returned / val.invested * 1000) / 10 : 0,
      }))
      .sort((a, b) => {
        const ai = gradeOrder.indexOf(a.grade);
        const bi = gradeOrder.indexOf(b.grade);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

    // ==================== 単勝/複勝別ROI ====================
    let totalWinInvested = 0;
    let totalWinReturned = 0;
    let totalPlaceInvested = 0;
    let totalPlaceReturned = 0;

    for (const r of results) {
      const inv = r.bet_investment || 100;
      // 単勝ROI
      totalWinInvested += inv;
      totalWinReturned += r.bet_return || 0;

      // 複勝ROI: oddsテーブルの実min_oddsを優先、なければ単勝オッズ×0.35で近似
      totalPlaceInvested += inv;
      if (r.place_hit) {
        const placeOdds = r.place_min_odds
          ? r.place_min_odds
          : (r.top_pick_odds ? Math.max(1.1, r.top_pick_odds * 0.35) : 0);
        totalPlaceReturned += inv * placeOdds;
      }
    }

    const roiBreakdown = {
      winRoi: totalWinInvested > 0
        ? Math.round(totalWinReturned / totalWinInvested * 1000) / 10 : 0,
      placeRoi: totalPlaceInvested > 0
        ? Math.round(totalPlaceReturned / totalPlaceInvested * 1000) / 10 : 0,
      winInvested: totalWinInvested,
      winReturned: Math.round(totalWinReturned),
      placeInvested: totalPlaceInvested,
      placeReturned: Math.round(totalPlaceReturned),
    };

    // ==================== 推奨馬券種別統計 ====================
    const betTypeBuckets: Record<string, {
      total: number;
      hit: number;
      invested: number;
      returned: number;
      oddsSum: number;
      oddsCount: number;
    }> = {};

    for (const row of results) {
      if (!row.bets_json || row.bets_json === '[]') continue;

      let bets: { type: string; selections: number[]; odds?: number; expectedValue?: number }[];
      try {
        bets = JSON.parse(row.bets_json);
      } catch { continue; }
      if (!Array.isArray(bets)) continue;

      const posMap = entryResultMap.get(row.race_id);
      if (!posMap) continue;

      const top3 = [...posMap.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([num]) => num);

      for (const bet of bets) {
        const type = bet.type;
        if (!betTypeBuckets[type]) {
          betTypeBuckets[type] = { total: 0, hit: 0, invested: 0, returned: 0, oddsSum: 0, oddsCount: 0 };
        }
        const bucket = betTypeBuckets[type];
        bucket.total++;
        bucket.invested += 100;

        if (bet.odds && bet.odds > 0) {
          bucket.oddsSum += bet.odds;
          bucket.oddsCount++;
        }

        // 的中判定
        const sels = bet.selections || [];
        const isHit = isBetHit(type, sels, top3);

        if (isHit) {
          bucket.hit++;
          bucket.returned += 100 * (bet.odds || 0);
        }
      }
    }

    const betTypeOrder = ['単勝', '複勝', '馬連', 'ワイド', '馬単', '三連複', '三連単'];
    const betTypeStats = Object.entries(betTypeBuckets)
      .map(([type, val]) => ({
        type,
        total: val.total,
        hitRate: val.total > 0 ? Math.round(val.hit / val.total * 1000) / 10 : 0,
        roi: val.invested > 0 ? Math.round(val.returned / val.invested * 1000) / 10 : 0,
        avgOdds: val.oddsCount > 0 ? Math.round(val.oddsSum / val.oddsCount * 10) / 10 : 0,
        hitCount: val.hit,
      }))
      .sort((a, b) => {
        const ai = betTypeOrder.indexOf(a.type);
        const bi = betTypeOrder.indexOf(b.type);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

    // 全体サマリ
    const totalWin = results.reduce((s, r) => s + r.win_hit, 0);
    const totalPlace = results.reduce((s, r) => s + r.place_hit, 0);
    const avgRoi = results.length > 0 ? results.reduce((s, r) => s + (r.bet_roi || 0), 0) / results.length * 100 : 0;

    const responseData = {
      summary: {
        totalEvaluated: results.length,
        winRate: results.length > 0 ? Math.round(totalWin / results.length * 1000) / 10 : 0,
        placeRate: results.length > 0 ? Math.round(totalPlace / results.length * 1000) / 10 : 0,
        avgRoi: Math.round(avgRoi),
      },
      rolling,
      rollingWindowSize: windowSize,
      confidenceStats,
      venueStats,
      gradeStats,
      roiBreakdown,
      betTypeStats,
      period: days > 0 ? `${days}日` : '全期間',
    };

    // キャッシュに保存
    cache.set(cacheKey, { data: responseData, expires: Date.now() + CACHE_TTL_MS });

    return NextResponse.json(responseData, {
      headers: { 'Cache-Control': 'private, max-age=60' },
    });
  } catch (error) {
    console.error('accuracy-stats エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}

/** レースのグレード + レース名から条件クラスを判定（DB grade優先） */
function classifyRace(grade: string | null, raceName: string): string {
  if (grade && ['G1', 'G2', 'G3', 'リステッド', 'オープン', '3勝クラス', '2勝クラス', '1勝クラス', '未勝利', '新馬'].includes(grade)) {
    return grade;
  }
  // フォールバック: レース名から推定
  if (raceName.includes('新馬')) return '新馬';
  if (raceName.includes('未勝利')) return '未勝利';
  if (raceName.includes('1勝クラス') || raceName.includes('1勝')) return '1勝クラス';
  if (raceName.includes('2勝クラス') || raceName.includes('2勝')) return '2勝クラス';
  if (raceName.includes('3勝クラス') || raceName.includes('3勝')) return '3勝クラス';
  if (raceName.includes('リステッド') || raceName.includes('Listed')) return 'リステッド';
  if (raceName.includes('オープン')) return 'オープン';
  if (raceName.includes('ステークス') || raceName.includes('カップ') || raceName.includes('賞')) return 'オープン';
  return 'その他';
}
