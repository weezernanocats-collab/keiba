import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';
import { isBetHit } from '@/lib/bet-utils';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/**
 * 馬券種別の収支サマリーAPI
 * GET /api/stats/bet-types
 *
 * 直近1000件の結果確定済みレースから馬券種別ごとの的中率・ROIを集計
 */

interface BetTypeSummary {
  type: string;
  total: number;
  hits: number;
  hitRate: number;
  totalInvestment: number;
  totalPayout: number;
  roi: number;
  profit: number;
}

interface Bet {
  type: string;
  selections: number[];
  odds?: number;
}

interface PredictionRow {
  race_id: string;
  bets_json: string | null;
}

interface EntryRow {
  race_id: string;
  horse_number: number;
  result_position: number;
}

const BET_TYPE_ORDER = ['単勝', '複勝', '馬連', 'ワイド', '馬単', '三連複', '三連単'];

export async function GET(request: NextRequest) {
  try {
    const daysParam = request.nextUrl.searchParams.get('days');
    const days = daysParam && daysParam !== 'all' ? parseInt(daysParam, 10) : 0;
    const dateFilter = days > 0
      ? `AND r.date >= date('now', '+9 hours', '-${days} days')`
      : '';

    // 1. prediction_results + predictions を JOIN して結果確定済みレースを取得
    const predictions = await dbAll<PredictionRow>(
      `SELECT p.race_id, p.bets_json
       FROM prediction_results pr
       JOIN predictions p ON pr.prediction_id = p.id
       JOIN races r ON pr.race_id = r.id
       WHERE r.status = '結果確定'
         AND p.bets_json IS NOT NULL
         AND p.bets_json != '[]'
         ${dateFilter}
       ORDER BY r.date DESC, r.race_number DESC
       LIMIT 1000`,
      [],
    );

    if (predictions.length === 0) {
      return NextResponse.json(
        { betTypes: [] },
        { headers: { 'Cache-Control': 'private, max-age=60' } },
      );
    }

    // 2. 対象レースIDを抽出し、race_entries から着順を一括取得
    const raceIds = [...new Set(predictions.map(p => p.race_id))];
    const entryResultMap = new Map<string, Map<number, number>>();

    // Turso のプレースホルダ数制限を考慮してバッチ処理
    const BATCH_SIZE = 200;
    for (let i = 0; i < raceIds.length; i += BATCH_SIZE) {
      const batch = raceIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const entries = await dbAll<EntryRow>(
        `SELECT race_id, horse_number, result_position
         FROM race_entries
         WHERE race_id IN (${placeholders}) AND result_position IS NOT NULL`,
        batch,
      );
      for (const e of entries) {
        if (!entryResultMap.has(e.race_id)) {
          entryResultMap.set(e.race_id, new Map());
        }
        entryResultMap.get(e.race_id)!.set(e.horse_number, e.result_position);
      }
    }

    // 3. bets_json をパースし、馬券種別ごとに集計
    const buckets = new Map<string, {
      total: number;
      hits: number;
      totalInvestment: number;
      totalPayout: number;
    }>();

    for (const row of predictions) {
      let bets: Bet[];
      try {
        bets = JSON.parse(row.bets_json || '[]');
      } catch {
        continue;
      }
      if (!Array.isArray(bets)) continue;

      const posMap = entryResultMap.get(row.race_id);
      if (!posMap) continue;

      // 着順からtop3を算出
      const top3 = [...posMap.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([num]) => num);

      for (const bet of bets) {
        const { type, selections, odds } = bet;
        if (!type || !Array.isArray(selections)) continue;

        if (!buckets.has(type)) {
          buckets.set(type, { total: 0, hits: 0, totalInvestment: 0, totalPayout: 0 });
        }
        const bucket = buckets.get(type)!;

        const investment = 100;
        bucket.total++;
        bucket.totalInvestment += investment;

        const isHit = isBetHit(type, selections, top3);
        if (isHit) {
          bucket.hits++;
          // 的中時: 100円 * オッズ
          const payout = odds && odds > 0 ? Math.round(investment * odds) : investment;
          bucket.totalPayout += payout;
        }
        // 不的中時: payout は 0（加算しない）
      }
    }

    // 4. レスポンス構築（馬券種別の定義順でソート）
    const betTypes: BetTypeSummary[] = [...buckets.entries()]
      .map(([type, val]) => ({
        type,
        total: val.total,
        hits: val.hits,
        hitRate: val.total > 0
          ? Math.round(val.hits / val.total * 1000) / 10
          : 0,
        totalInvestment: val.totalInvestment,
        totalPayout: val.totalPayout,
        roi: val.totalInvestment > 0
          ? Math.round(val.totalPayout / val.totalInvestment * 1000) / 10
          : 0,
        profit: val.totalPayout - val.totalInvestment,
      }))
      .sort((a, b) => {
        const ai = BET_TYPE_ORDER.indexOf(a.type);
        const bi = BET_TYPE_ORDER.indexOf(b.type);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

    return NextResponse.json(
      { betTypes },
      { headers: { 'Cache-Control': 'private, max-age=60' } },
    );
  } catch (error) {
    console.error('stats/bet-types エラー:', error);
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
