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
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分

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

    // JST基準の日付フィルタ（Tursoのdate('now')はUTCなので+9時間補正）
    const dateFilter = days > 0
      ? `AND r.date >= date('now', '+9 hours', '-${days} days')`
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

    // ==================== 高信頼度フィルタ戦略 ====================
    // フィルタ条件: predicted_confidence >= 80 かつ bets_json内最大expectedValue > 1.0
    const hcOverall = { total: 0, win: 0, place: 0, invested: 0, returned: 0 };
    const hcByYear: Record<string, { total: number; win: number; place: number; invested: number; returned: number }> = {};
    const hcByMonth: Record<string, { total: number; win: number; place: number; invested: number; returned: number }> = {};

    for (const row of results) {
      const conf = row.predicted_confidence ?? 0;
      if (conf < 80) continue;

      // bets_jsonから最大expectedValueを取得
      let maxEv = 0;
      if (row.bets_json && row.bets_json !== '[]') {
        try {
          const bets: { expectedValue?: number }[] = JSON.parse(row.bets_json);
          if (Array.isArray(bets)) {
            for (const b of bets) {
              if (b.expectedValue != null && b.expectedValue > maxEv) {
                maxEv = b.expectedValue;
              }
            }
          }
        } catch { /* ignore parse errors */ }
      }
      if (maxEv <= 1.0) continue;

      const inv = row.bet_investment || 100;
      const ret = row.bet_return || 0;

      // overall
      hcOverall.total++;
      if (row.win_hit) hcOverall.win++;
      if (row.place_hit) hcOverall.place++;
      hcOverall.invested += inv;
      hcOverall.returned += ret;

      // byYear
      const yyyy = (row.race_date || '').slice(0, 4);
      if (yyyy) {
        if (!hcByYear[yyyy]) hcByYear[yyyy] = { total: 0, win: 0, place: 0, invested: 0, returned: 0 };
        hcByYear[yyyy].total++;
        if (row.win_hit) hcByYear[yyyy].win++;
        if (row.place_hit) hcByYear[yyyy].place++;
        hcByYear[yyyy].invested += inv;
        hcByYear[yyyy].returned += ret;
      }

      // byMonth
      const yyyymm = (row.race_date || '').slice(0, 7);
      if (yyyymm) {
        if (!hcByMonth[yyyymm]) hcByMonth[yyyymm] = { total: 0, win: 0, place: 0, invested: 0, returned: 0 };
        hcByMonth[yyyymm].total++;
        if (row.win_hit) hcByMonth[yyyymm].win++;
        if (row.place_hit) hcByMonth[yyyymm].place++;
        hcByMonth[yyyymm].invested += inv;
        hcByMonth[yyyymm].returned += ret;
      }
    }

    const formatHcBucket = (b: { total: number; win: number; place: number; invested: number; returned: number }) => ({
      total: b.total,
      winRate: b.total > 0 ? Math.round(b.win / b.total * 1000) / 10 : 0,
      placeRate: b.total > 0 ? Math.round(b.place / b.total * 1000) / 10 : 0,
      roi: b.invested > 0 ? Math.round(b.returned / b.invested * 1000) / 10 : 0,
      profit: Math.round(b.returned - b.invested),
    });

    // monthlyTrend: 月別に累計損益を追加
    const sortedMonths = Object.keys(hcByMonth).sort();
    let cumProfit = 0;
    const hcMonthlyTrend = sortedMonths.map(month => {
      const b = hcByMonth[month];
      const monthProfit = Math.round(b.returned - b.invested);
      cumProfit += monthProfit;
      return {
        month,
        ...formatHcBucket(b),
        cumProfit,
      };
    });

    // byYear整形
    const hcByYearFormatted: Record<string, ReturnType<typeof formatHcBucket>> = {};
    for (const [year, b] of Object.entries(hcByYear)) {
      hcByYearFormatted[year] = formatHcBucket(b);
    }

    const highConfEvStats = {
      overall: formatHcBucket(hcOverall),
      byYear: hcByYearFormatted,
      monthlyTrend: hcMonthlyTrend,
    };

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

    // ==================== AI独自推奨（No-Oddsモデル）統計 ====================
    const aiPredictions = await dbAll<{
      race_id: string;
      analysis_json: string;
      race_date: string;
    }>(`
      SELECT p.race_id, p.analysis_json, r.date as race_date
      FROM predictions p
      JOIN races r ON p.race_id = r.id
      WHERE r.status = '結果確定'
        AND p.analysis_json LIKE '%aiIndependentBets%'
        ${dateFilter}
      ORDER BY r.date ASC, r.race_number ASC
    `, []);

    const aiBetStats = { totalRaces: 0, totalBets: 0, place: { bets: 0, hits: 0, investment: 0, returnAmount: 0 }, win: { bets: 0, hits: 0, investment: 0, returnAmount: 0 } };
    const aiEntryMap = new Map<string, Map<number, { position: number; odds: number }>>();
    const aiPlaceOddsMap = new Map<string, Map<number, number>>();

    if (aiPredictions.length > 0) {
      // AI推奨対象レースの着順・オッズを一括取得
      const aiRaceIds = aiPredictions.map(p => p.race_id);

      const AI_BATCH = 200;
      for (let i = 0; i < aiRaceIds.length; i += AI_BATCH) {
        const batch = aiRaceIds.slice(i, i + AI_BATCH);
        const ph = batch.map(() => '?').join(',');
        const [entries, placeOdds] = await Promise.all([
          dbAll<{ race_id: string; horse_number: number; result_position: number; odds: number | null }>(
            `SELECT race_id, horse_number, result_position, odds FROM race_entries WHERE race_id IN (${ph}) AND result_position IS NOT NULL`, batch),
          dbAll<{ race_id: string; horse_number1: number; odds: number }>(
            `SELECT race_id, horse_number1, odds FROM odds WHERE race_id IN (${ph}) AND bet_type = '複勝'`, batch),
        ]);
        for (const e of entries) {
          if (!aiEntryMap.has(e.race_id)) aiEntryMap.set(e.race_id, new Map());
          aiEntryMap.get(e.race_id)!.set(e.horse_number, { position: e.result_position, odds: e.odds ?? 0 });
        }
        for (const o of placeOdds) {
          if (!aiPlaceOddsMap.has(o.race_id)) aiPlaceOddsMap.set(o.race_id, new Map());
          aiPlaceOddsMap.get(o.race_id)!.set(o.horse_number1, o.odds);
        }
      }

      aiBetStats.totalRaces = aiPredictions.length;
      for (const pred of aiPredictions) {
        let analysis: Record<string, unknown>;
        try { analysis = JSON.parse(pred.analysis_json); } catch { continue; }
        const bets = (analysis.aiIndependentBets || []) as Array<{ horseNumber: number; betTypes: string[] }>;

        for (const bet of bets) {
          const entry = aiEntryMap.get(pred.race_id)?.get(bet.horseNumber);
          if (!entry) continue;
          aiBetStats.totalBets++;

          if (bet.betTypes.includes('複勝')) {
            aiBetStats.place.bets++;
            aiBetStats.place.investment += 100;
            if (entry.position <= 3) {
              aiBetStats.place.hits++;
              const pOdds = aiPlaceOddsMap.get(pred.race_id)?.get(bet.horseNumber) ?? 0;
              aiBetStats.place.returnAmount += 100 * pOdds;
            }
          }
          if (bet.betTypes.includes('単勝')) {
            aiBetStats.win.bets++;
            aiBetStats.win.investment += 100;
            if (entry.position === 1) {
              aiBetStats.win.hits++;
              aiBetStats.win.returnAmount += 100 * entry.odds;
            }
          }
        }
      }
    }

    // 累積推移データ: 日付ごとの的中率・ROI・収支の推移
    interface AiCumPoint { date: string; bets: number; hits: number; hitRate: number; investment: number; returnAmount: number; roi: number; profit: number }
    const aiCumulativePlace: AiCumPoint[] = [];
    const aiCumulativeWin: AiCumPoint[] = [];
    {
      // 日付ごとに集計
      const dayMapPlace = new Map<string, { bets: number; hits: number; investment: number; returnAmount: number }>();
      const dayMapWin = new Map<string, { bets: number; hits: number; investment: number; returnAmount: number }>();

      for (const pred of aiPredictions) {
        let analysis: Record<string, unknown>;
        try { analysis = JSON.parse(pred.analysis_json); } catch { continue; }
        const bets = (analysis.aiIndependentBets || []) as Array<{ horseNumber: number; betTypes: string[] }>;
        const d = pred.race_date;

        for (const bet of bets) {
          const entry = aiEntryMap.get(pred.race_id)?.get(bet.horseNumber);
          if (!entry) continue;

          if (bet.betTypes.includes('複勝')) {
            const s = dayMapPlace.get(d) || { bets: 0, hits: 0, investment: 0, returnAmount: 0 };
            s.bets++; s.investment += 100;
            if (entry.position <= 3) {
              s.hits++;
              s.returnAmount += 100 * (aiPlaceOddsMap.get(pred.race_id)?.get(bet.horseNumber) ?? 0);
            }
            dayMapPlace.set(d, s);
          }
          if (bet.betTypes.includes('単勝')) {
            const s = dayMapWin.get(d) || { bets: 0, hits: 0, investment: 0, returnAmount: 0 };
            s.bets++; s.investment += 100;
            if (entry.position === 1) {
              s.hits++;
              s.returnAmount += 100 * entry.odds;
            }
            dayMapWin.set(d, s);
          }
        }
      }

      // 累積計算
      let cumBets = 0, cumHits = 0, cumInv = 0, cumRet = 0;
      for (const [date, s] of [...dayMapPlace.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        cumBets += s.bets; cumHits += s.hits; cumInv += s.investment; cumRet += s.returnAmount;
        aiCumulativePlace.push({
          date, bets: cumBets, hits: cumHits,
          hitRate: Math.round(cumHits / cumBets * 1000) / 10,
          investment: cumInv, returnAmount: Math.round(cumRet),
          roi: Math.round(cumRet / cumInv * 1000) / 10,
          profit: Math.round(cumRet - cumInv),
        });
      }
      cumBets = 0; cumHits = 0; cumInv = 0; cumRet = 0;
      for (const [date, s] of [...dayMapWin.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        cumBets += s.bets; cumHits += s.hits; cumInv += s.investment; cumRet += s.returnAmount;
        aiCumulativeWin.push({
          date, bets: cumBets, hits: cumHits,
          hitRate: Math.round(cumHits / cumBets * 1000) / 10,
          investment: cumInv, returnAmount: Math.round(cumRet),
          roi: Math.round(cumRet / cumInv * 1000) / 10,
          profit: Math.round(cumRet - cumInv),
        });
      }
    }

    const formatAiBetType = (s: typeof aiBetStats.place) => ({
      ...s,
      hitRate: s.bets > 0 ? Math.round(s.hits / s.bets * 1000) / 10 : 0,
      roi: s.investment > 0 ? Math.round(s.returnAmount / s.investment * 1000) / 10 : 0,
      returnAmount: Math.round(s.returnAmount),
    });

    const aiIndependentBetStats = {
      totalRaces: aiBetStats.totalRaces,
      totalBets: aiBetStats.totalBets,
      place: formatAiBetType(aiBetStats.place),
      win: formatAiBetType(aiBetStats.win),
      cumulativePlace: aiCumulativePlace,
      cumulativeWin: aiCumulativeWin.length > 0 ? aiCumulativeWin : undefined,
    };

    // ==================== AI推奨買い目（aiRankingBets: 馬連/ワイド）統計 ====================
    const aiRankingPredictions = await dbAll<{
      race_id: string;
      analysis_json: string;
      bets_json: string | null;
      race_date: string;
    }>(`
      SELECT p.race_id, p.analysis_json, p.bets_json, r.date as race_date
      FROM predictions p
      JOIN races r ON p.race_id = r.id
      WHERE r.status = '結果確定'
        AND p.analysis_json LIKE '%aiRankingBets%'
        ${dateFilter}
      ORDER BY r.date ASC, r.race_number ASC
    `, []);

    interface AiRankingBetStat { bets: number; hits: number; investment: number; returnAmount: number }
    const aiRankingStats: Record<string, AiRankingBetStat> = {};
    let aiRankingTotalRaces = 0;
    let aiRankingTotalBets = 0;

    // 累積推移用の日別データ
    const aiRankingDayMap = new Map<string, { bets: number; hits: number; investment: number; returnAmount: number }>();

    if (aiRankingPredictions.length > 0) {
      // 対象レースのtop3着順を取得
      const rkRaceIds = aiRankingPredictions.map(p => p.race_id);
      const rkTop3Map = new Map<string, number[]>(); // race_id -> [1着馬番, 2着馬番, 3着馬番]

      // 馬連/ワイドのオッズ + 単勝オッズ（推定用）を取得
      const rkOddsMap = new Map<string, Map<string, number>>(); // race_id -> "bet_type:h1-h2" -> odds
      const rkWinOddsMap = new Map<string, Map<number, number>>(); // race_id -> horse_number -> win_odds

      const RK_BATCH = 200;
      for (let i = 0; i < rkRaceIds.length; i += RK_BATCH) {
        const batch = rkRaceIds.slice(i, i + RK_BATCH);
        const ph = batch.map(() => '?').join(',');

        const [entries, betOdds] = await Promise.all([
          dbAll<{ race_id: string; horse_number: number; result_position: number; odds: number | null }>(
            `SELECT race_id, horse_number, result_position, odds FROM race_entries
             WHERE race_id IN (${ph}) AND result_position IS NOT NULL AND result_position <= 3
             ORDER BY result_position`, batch),
          dbAll<{ race_id: string; bet_type: string; horse_number1: number; horse_number2: number; odds: number; min_odds: number | null }>(
            `SELECT race_id, bet_type, horse_number1, horse_number2, odds, min_odds FROM odds
             WHERE race_id IN (${ph}) AND bet_type IN ('馬連', 'ワイド')`, batch),
        ]);

        for (const e of entries) {
          const arr = rkTop3Map.get(e.race_id) || [];
          if (arr.length < 3) arr.push(e.horse_number);
          rkTop3Map.set(e.race_id, arr);
          // 単勝オッズも保存（馬連/ワイドの推定用）
          if (e.odds && e.odds > 0) {
            if (!rkWinOddsMap.has(e.race_id)) rkWinOddsMap.set(e.race_id, new Map());
            rkWinOddsMap.get(e.race_id)!.set(e.horse_number, e.odds);
          }
        }
        for (const o of betOdds) {
          if (!rkOddsMap.has(o.race_id)) rkOddsMap.set(o.race_id, new Map());
          const h1 = Math.min(o.horse_number1, o.horse_number2 || 0);
          const h2 = Math.max(o.horse_number1, o.horse_number2 || 0);
          const key = `${o.bet_type}:${h1}-${h2}`;
          // ワイドはmin_oddsを使う（確実に払い戻される額）
          rkOddsMap.get(o.race_id)!.set(key, o.bet_type === 'ワイド' && o.min_odds ? o.min_odds : o.odds);
        }
      }

      // 全レースの単勝オッズも補完取得（top3以外のエントリも必要）
      for (let i = 0; i < rkRaceIds.length; i += RK_BATCH) {
        const batch = rkRaceIds.slice(i, i + RK_BATCH);
        const ph = batch.map(() => '?').join(',');
        const allEntries = await dbAll<{ race_id: string; horse_number: number; odds: number | null }>(
          `SELECT race_id, horse_number, odds FROM race_entries WHERE race_id IN (${ph}) AND odds IS NOT NULL AND odds > 0`, batch);
        for (const e of allEntries) {
          if (!rkWinOddsMap.has(e.race_id)) rkWinOddsMap.set(e.race_id, new Map());
          rkWinOddsMap.get(e.race_id)!.set(e.horse_number, e.odds!);
        }
      }

      for (const pred of aiRankingPredictions) {
        let analysis: Record<string, unknown>;
        try { analysis = JSON.parse(pred.analysis_json); } catch { continue; }
        const rkBetsData = analysis.aiRankingBets as { bets: Array<{ type: string; horses: Array<{ horseNumber: number }>; confidence: string }> } | undefined;
        if (!rkBetsData?.bets) continue;

        const top3 = rkTop3Map.get(pred.race_id);
        if (!top3 || top3.length < 2) continue;

        // bets_jsonから推定オッズのフォールバックマップを構築
        const betsOddsFallback = new Map<string, number>();
        if (pred.bets_json) {
          try {
            const bets = JSON.parse(pred.bets_json) as { type: string; selections: number[]; odds?: number }[];
            if (Array.isArray(bets)) {
              for (const b of bets) {
                if ((b.type === '馬連' || b.type === 'ワイド') && b.selections?.length >= 2 && b.odds && b.odds > 0) {
                  const h1 = Math.min(...b.selections);
                  const h2 = Math.max(...b.selections);
                  betsOddsFallback.set(`${b.type}:${h1}-${h2}`, b.odds);
                }
              }
            }
          } catch { /* skip */ }
        }

        let raceHasBet = false;
        for (const bet of rkBetsData.bets) {
          if (bet.type === '見送り') continue;
          const selections = bet.horses.map(h => h.horseNumber);
          if (selections.length < 2) continue;

          raceHasBet = true;
          const betType = bet.type; // 馬連 or ワイド

          if (!aiRankingStats[betType]) aiRankingStats[betType] = { bets: 0, hits: 0, investment: 0, returnAmount: 0 };
          const stat = aiRankingStats[betType];
          stat.bets++;
          stat.investment += 100;
          aiRankingTotalBets++;

          const hit = isBetHit(betType, selections, top3);
          if (hit) {
            stat.hits++;
            const h1 = Math.min(...selections);
            const h2 = Math.max(...selections);
            const oddsKey = `${betType}:${h1}-${h2}`;
            // 1. DBオッズ → 2. bets_json推定 → 3. 単勝オッズから合成推定
            let odds = rkOddsMap.get(pred.race_id)?.get(oddsKey)
              ?? betsOddsFallback.get(oddsKey)
              ?? 0;
            if (odds === 0) {
              // 単勝オッズから馬連/ワイドを推定: 馬連≈単勝1×単勝2×0.8/頭数補正, ワイド≈馬連×0.4
              const winOdds = rkWinOddsMap.get(pred.race_id);
              if (winOdds) {
                const o1 = winOdds.get(h1) ?? 0;
                const o2 = winOdds.get(h2) ?? 0;
                if (o1 > 0 && o2 > 0) {
                  const estimatedUmaren = Math.max(1.5, o1 * o2 * 0.08);
                  odds = betType === '馬連' ? estimatedUmaren : Math.max(1.1, estimatedUmaren * 0.4);
                }
              }
            }
            stat.returnAmount += 100 * odds;
          }

          // 日別集計
          const dayS = aiRankingDayMap.get(pred.race_date) || { bets: 0, hits: 0, investment: 0, returnAmount: 0 };
          dayS.bets++; dayS.investment += 100;
          if (hit) {
            dayS.hits++;
            const h1 = Math.min(...selections);
            const h2 = Math.max(...selections);
            const oddsKey = `${betType}:${h1}-${h2}`;
            let odds = rkOddsMap.get(pred.race_id)?.get(oddsKey)
              ?? betsOddsFallback.get(oddsKey)
              ?? 0;
            if (odds === 0) {
              const winOdds = rkWinOddsMap.get(pred.race_id);
              if (winOdds) {
                const o1 = winOdds.get(h1) ?? 0;
                const o2 = winOdds.get(h2) ?? 0;
                if (o1 > 0 && o2 > 0) {
                  const estimatedUmaren = Math.max(1.5, o1 * o2 * 0.08);
                  odds = betType === '馬連' ? estimatedUmaren : Math.max(1.1, estimatedUmaren * 0.4);
                }
              }
            }
            dayS.returnAmount += 100 * odds;
          }
          aiRankingDayMap.set(pred.race_date, dayS);
        }
        if (raceHasBet) aiRankingTotalRaces++;
      }
    }

    // 累積推移
    const aiRankingCumulative: AiCumPoint[] = [];
    {
      let cumBetsR = 0, cumHitsR = 0, cumInvR = 0, cumRetR = 0;
      for (const [date, s] of [...aiRankingDayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        cumBetsR += s.bets; cumHitsR += s.hits; cumInvR += s.investment; cumRetR += s.returnAmount;
        aiRankingCumulative.push({
          date, bets: cumBetsR, hits: cumHitsR,
          hitRate: Math.round(cumHitsR / cumBetsR * 1000) / 10,
          investment: cumInvR, returnAmount: Math.round(cumRetR),
          roi: cumInvR > 0 ? Math.round(cumRetR / cumInvR * 1000) / 10 : 0,
          profit: Math.round(cumRetR - cumInvR),
        });
      }
    }

    const aiRankingBetStats = {
      totalRaces: aiRankingTotalRaces,
      totalBets: aiRankingTotalBets,
      byType: Object.fromEntries(
        Object.entries(aiRankingStats).map(([type, s]) => [type, {
          ...s,
          hitRate: s.bets > 0 ? Math.round(s.hits / s.bets * 1000) / 10 : 0,
          roi: s.investment > 0 ? Math.round(s.returnAmount / s.investment * 1000) / 10 : 0,
          returnAmount: Math.round(s.returnAmount),
        }])
      ),
      cumulative: aiRankingCumulative.length > 0 ? aiRankingCumulative : undefined,
    };

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
      highConfEvStats,
      aiIndependentBetStats,
      aiRankingBetStats,
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
