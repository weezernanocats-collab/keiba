import { NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';
import { isBetHit } from '@/lib/bet-utils';
import { getCacheHeaders } from '@/lib/api-helpers';

/**
 * 信頼度×馬券種別クロスROI分析API
 * GET /api/stats/confidence-roi
 *
 * 信頼度帯（80+, 60-79, 40-59, 15-39）と馬券種別（単勝〜三連単）の
 * 的中率・ROIをクロス集計し、最適な馬券戦略を提示する。
 */

interface ConfBetBucket {
  total: number;
  hits: number;
  invested: number;
  returned: number;
  oddsSum: number;
  oddsCount: number;
}

interface PredRow {
  race_id: string;
  predicted_confidence: number;
  win_hit: number;
  place_hit: number;
  bet_investment: number;
  bet_return: number;
  bets_json: string | null;
}

const BET_TYPES = ['単勝', '複勝', '馬連', 'ワイド', '馬単', '三連複', '三連単'];

const CONF_BANDS = [
  { label: '80-100', min: 80, max: 100 },
  { label: '60-79', min: 60, max: 79 },
  { label: '40-59', min: 40, max: 59 },
  { label: '15-39', min: 15, max: 39 },
];

export async function GET() {
  try {
    const rows = await dbAll<PredRow>(
      `SELECT pr.race_id, pr.predicted_confidence, pr.win_hit, pr.place_hit,
              pr.bet_investment, pr.bet_return,
              p.bets_json
       FROM prediction_results pr
       JOIN predictions p ON pr.prediction_id = p.id
       JOIN races r ON pr.race_id = r.id
       WHERE r.status = '結果確定'
       ORDER BY r.date ASC`,
      [],
    );

    if (rows.length === 0) {
      return NextResponse.json(
        { matrix: [], summary: [], bestStrategies: [] },
        { headers: getCacheHeaders('stats') },
      );
    }

    // 着順マップ一括取得
    const raceIds = [...new Set(rows.map(r => r.race_id))];
    const entryResultMap = new Map<string, Map<number, number>>();
    const BATCH = 200;
    for (let i = 0; i < raceIds.length; i += BATCH) {
      const batch = raceIds.slice(i, i + BATCH);
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

    // クロス集計
    const matrix: Record<string, Record<string, ConfBetBucket>> = {};
    const confBasic: Record<string, { total: number; winHit: number; placeHit: number; winInvested: number; winReturned: number }> = {};

    for (const band of CONF_BANDS) {
      matrix[band.label] = {};
      for (const bt of BET_TYPES) {
        matrix[band.label][bt] = { total: 0, hits: 0, invested: 0, returned: 0, oddsSum: 0, oddsCount: 0 };
      }
      confBasic[band.label] = { total: 0, winHit: 0, placeHit: 0, winInvested: 0, winReturned: 0 };
    }

    for (const row of rows) {
      const conf = row.predicted_confidence ?? 50;
      const band = CONF_BANDS.find(b => conf >= b.min && conf <= b.max);
      if (!band) continue;

      confBasic[band.label].total++;
      if (row.win_hit) confBasic[band.label].winHit++;
      if (row.place_hit) confBasic[band.label].placeHit++;
      confBasic[band.label].winInvested += row.bet_investment || 100;
      confBasic[band.label].winReturned += row.bet_return || 0;

      if (!row.bets_json || row.bets_json === '[]') continue;

      let bets: { type: string; selections: number[]; odds?: number }[];
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
        if (!bet.type || !Array.isArray(bet.selections)) continue;
        if (!BET_TYPES.includes(bet.type)) continue;

        const bucket = matrix[band.label][bet.type];
        bucket.total++;
        bucket.invested += 100;
        if (bet.odds && bet.odds > 0) {
          bucket.oddsSum += bet.odds;
          bucket.oddsCount++;
        }
        if (isBetHit(bet.type, bet.selections, top3)) {
          bucket.hits++;
          bucket.returned += 100 * (bet.odds || 0);
        }
      }
    }

    // レスポンス構築
    const matrixResponse = CONF_BANDS.map(band => ({
      confidence: band.label,
      raceCount: confBasic[band.label].total,
      winRate: confBasic[band.label].total > 0
        ? Math.round(confBasic[band.label].winHit / confBasic[band.label].total * 1000) / 10 : 0,
      placeRate: confBasic[band.label].total > 0
        ? Math.round(confBasic[band.label].placeHit / confBasic[band.label].total * 1000) / 10 : 0,
      winRoi: confBasic[band.label].winInvested > 0
        ? Math.round(confBasic[band.label].winReturned / confBasic[band.label].winInvested * 1000) / 10 : 0,
      betTypes: BET_TYPES.map(bt => {
        const b = matrix[band.label][bt];
        return {
          type: bt,
          total: b.total,
          hits: b.hits,
          hitRate: b.total > 0 ? Math.round(b.hits / b.total * 1000) / 10 : 0,
          roi: b.invested > 0 ? Math.round(b.returned / b.invested * 1000) / 10 : 0,
          profit: Math.round(b.returned - b.invested),
          avgOdds: b.oddsCount > 0 ? Math.round(b.oddsSum / b.oddsCount * 10) / 10 : null,
        };
      }).filter(bt => bt.total > 0),
    })).filter(m => m.raceCount > 0);

    // 最適戦略（各信頼度帯でROI最高の馬券種別）
    const bestStrategies = matrixResponse.map(m => {
      const best = m.betTypes
        .filter(bt => bt.total >= 5)
        .sort((a, b) => b.roi - a.roi)[0];
      return best ? {
        confidence: m.confidence,
        bestBetType: best.type,
        roi: best.roi,
        hitRate: best.hitRate,
        sampleSize: best.total,
        profit: best.profit,
      } : null;
    }).filter(Boolean);

    // ROI 100%超えの組み合わせ
    const profitableCombos = matrixResponse.flatMap(m =>
      m.betTypes
        .filter(bt => bt.roi >= 100 && bt.total >= 5)
        .map(bt => ({
          confidence: m.confidence,
          betType: bt.type,
          roi: bt.roi,
          hitRate: bt.hitRate,
          sampleSize: bt.total,
          profit: bt.profit,
        }))
    ).sort((a, b) => b.roi - a.roi);

    return NextResponse.json(
      { matrix: matrixResponse, bestStrategies, profitableCombos, totalRaces: rows.length },
      { headers: getCacheHeaders('stats') },
    );
  } catch (error) {
    console.error('stats/confidence-roi エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
