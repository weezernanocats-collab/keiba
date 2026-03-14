import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';
import { isBetHit } from '@/lib/bet-utils';
import { getCacheHeaders } from '@/lib/api-helpers';

export const maxDuration = 30;

/**
 * 過去予想履歴API
 * 予想と結果を一緒に返す
 * クエリパラメータ:
 *   ?page=1 (ページ番号, デフォルト1)
 *   ?limit=20 (1ページあたり件数)
 *   ?grade=G1 (グレードフィルタ)
 *   ?result=win|place|miss|umaren|wide|umatan|sanrenpuku|sanrentan (結果フィルタ)
 */
export async function GET(request: NextRequest) {
  try {
    const page = Math.max(1, parseInt(request.nextUrl.searchParams.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(10, parseInt(request.nextUrl.searchParams.get('limit') || '20', 10)));
    const gradeFilter = request.nextUrl.searchParams.get('grade') || '';
    const resultFilter = request.nextUrl.searchParams.get('result') || '';
    const offset = (page - 1) * limit;

    // フィルタ条件を構築
    const conditions: string[] = ["r.status = '結果確定'"];
    const params: (string | number)[] = [];

    // グレードフィルタ: DB gradeカラム優先、フォールバックで名前ベース
    if (gradeFilter) {
      conditions.push(`(r.grade = ? OR (r.grade IS NULL AND ${
        gradeFilter === '新馬' ? "r.name LIKE '%新馬%'" :
        gradeFilter === '未勝利' ? "r.name LIKE '%未勝利%'" :
        gradeFilter === '1勝クラス' ? "(r.name LIKE '%1勝クラス%' OR r.name LIKE '%1勝%')" :
        gradeFilter === '2勝クラス' ? "(r.name LIKE '%2勝クラス%' OR r.name LIKE '%2勝%')" :
        gradeFilter === '3勝クラス' ? "(r.name LIKE '%3勝クラス%' OR r.name LIKE '%3勝%')" :
        gradeFilter === 'オープン' ? "(r.name LIKE '%オープン%' OR r.name LIKE '%ステークス%' OR r.name LIKE '%カップ%')" :
        '1=0'
      }))`);
      params.push(gradeFilter);
    }

    const BET_TYPE_MAP: Record<string, string> = {
      umaren: '馬連', wide: 'ワイド', umatan: '馬単',
      sanrenpuku: '三連複', sanrentan: '三連単',
    };

    if (resultFilter === 'win') {
      conditions.push('pr.win_hit = 1');
    } else if (resultFilter === 'place') {
      conditions.push('pr.place_hit = 1 AND pr.win_hit = 0');
    } else if (resultFilter === 'miss') {
      conditions.push('pr.place_hit = 0');
    } else if (BET_TYPE_MAP[resultFilter]) {
      conditions.push("pr.bet_hit_types LIKE ?");
      params.push(`%${BET_TYPE_MAP[resultFilter]}%`);
    }

    const whereClause = conditions.join(' AND ');

    // 1回のクエリで予想+結果+レース情報を取得
    const rows = await dbAll<{
      race_id: string;
      race_name: string;
      race_date: string;
      racecourse_name: string;
      race_number: number;
      grade: string | null;
      track_type: string;
      distance: number;
      track_condition: string | null;
      confidence: number;
      picks_json: string;
      bets_json: string;
      summary: string;
      win_hit: number;
      place_hit: number;
      top3_picks_hit: number;
      bet_roi: number;
      bet_return: number;
    }>(
      `SELECT r.id as race_id, r.name as race_name, r.date as race_date,
              r.racecourse_name, r.race_number, r.grade, r.track_type,
              r.distance, r.track_condition,
              p.confidence, p.picks_json, p.bets_json, p.summary,
              pr.win_hit, pr.place_hit, pr.top3_picks_hit,
              pr.bet_roi, pr.bet_return
       FROM prediction_results pr
       JOIN predictions p ON pr.prediction_id = p.id
       JOIN races r ON pr.race_id = r.id
       WHERE ${whereClause}
       ORDER BY r.date DESC, r.race_number DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    // 総件数（ページネーション用）
    const countRow = await dbAll<{ cnt: number }>(
      `SELECT COUNT(*) as cnt
       FROM prediction_results pr
       JOIN predictions p ON pr.prediction_id = p.id
       JOIN races r ON pr.race_id = r.id
       WHERE ${whereClause}`,
      params,
    );
    const totalCount = countRow[0]?.cnt ?? 0;

    // 各レースの実着順を一括取得（予想vs結果の対比用）
    const raceIds = rows.map(r => r.race_id);
    const entryResultMap = new Map<string, Map<number, { position: number; horseName: string }>>();
    // 実オッズマップ: race_id -> bet_type -> horse_numbers_key -> { odds, minOdds }
    const realOddsMap = new Map<string, Map<string, Map<string, { odds: number; minOdds: number | null }>>>();

    if (raceIds.length > 0) {
      const ph = raceIds.map(() => '?').join(',');
      const [entries, oddsRows] = await Promise.all([
        dbAll<{ race_id: string; horse_number: number; result_position: number; horse_name: string }>(
          `SELECT race_id, horse_number, result_position, horse_name FROM race_entries
           WHERE race_id IN (${ph}) AND result_position IS NOT NULL`,
          raceIds,
        ),
        dbAll<{
          race_id: string; bet_type: string;
          horse_number1: number; horse_number2: number | null; horse_number3: number | null;
          odds: number; min_odds: number | null;
        }>(
          `SELECT race_id, bet_type, horse_number1, horse_number2, horse_number3, odds, min_odds
           FROM odds WHERE race_id IN (${ph}) AND bet_type IN ('単勝', '複勝')`,
          raceIds,
        ),
      ]);
      for (const e of entries) {
        if (!entryResultMap.has(e.race_id)) entryResultMap.set(e.race_id, new Map());
        entryResultMap.get(e.race_id)!.set(e.horse_number, { position: e.result_position, horseName: e.horse_name });
      }
      for (const o of oddsRows) {
        if (!realOddsMap.has(o.race_id)) realOddsMap.set(o.race_id, new Map());
        const byType = realOddsMap.get(o.race_id)!;
        if (!byType.has(o.bet_type)) byType.set(o.bet_type, new Map());
        const nums = [o.horse_number1, o.horse_number2, o.horse_number3].filter((n): n is number => n != null);
        const key = nums.join('-');
        byType.get(o.bet_type)!.set(key, { odds: o.odds, minOdds: o.min_odds });
      }
    }

    // レスポンス構築
    const history = rows.map(row => {
      let picks: { rank: number; horseNumber: number; horseName: string; score: number }[] = [];
      try {
        picks = JSON.parse(row.picks_json || '[]');
      } catch { /* skip */ }

      let bets: { type: string; selections: number[]; odds?: number }[] = [];
      try {
        bets = JSON.parse(row.bets_json || '[]');
      } catch { /* skip */ }

      const posMap = entryResultMap.get(row.race_id) || new Map();
      const sortedEntries = [...posMap.entries()]
        .sort((a, b) => a[1].position - b[1].position);
      const top3 = sortedEntries.slice(0, 3).map(([num]) => num);
      const actualTop3Detailed = sortedEntries.slice(0, 3).map(([num, info]) => ({
        horseNumber: num,
        horseName: info.horseName,
      }));
      // 予想馬の実着順を付与
      const pickResults = picks.slice(0, 6).map(p => {
        const entry = posMap.get(p.horseNumber);
        return {
          ...p,
          actualPosition: entry?.position ?? null,
          hit: entry?.position === 1,
          placeHit: (entry?.position ?? 99) <= 3,
        };
      });

      // 馬券の的中判定 + 収支計算
      const raceOdds = realOddsMap.get(row.race_id);
      const betResults = bets.map(bet => {
        const sels = bet.selections || [];
        const isHit = isBetHit(bet.type, sels, top3);

        // 実オッズ検索（単勝/複勝のみ実オッズあり）
        let realOddsValue: number | null = null;
        let isEstimated = true;
        if (raceOdds) {
          const byType = raceOdds.get(bet.type);
          if (byType) {
            const key = sels.join('-');
            const found = byType.get(key);
            if (found) {
              realOddsValue = bet.type === '複勝' ? (found.minOdds ?? found.odds) : found.odds;
              isEstimated = false;
            }
          }
        }

        const odds = realOddsValue ?? (bet.odds && bet.odds > 0 ? bet.odds : null);
        const investment = 100;
        const payout = isHit && odds != null ? Math.round(investment * odds) : (isHit ? investment : 0);
        const profit = payout - investment;

        return {
          type: bet.type,
          selections: sels,
          hit: isHit,
          odds: odds ?? 0,
          isEstimated,
          investment,
          payout,
          profit,
        };
      });

      // レースごとの収支サマリ
      const totalInvestment = betResults.reduce((s, b) => s + b.investment, 0);
      const totalPayout = betResults.reduce((s, b) => s + b.payout, 0);
      const totalProfit = totalPayout - totalInvestment;

      return {
        raceId: row.race_id,
        raceName: row.race_name,
        raceDate: row.race_date,
        racecourseName: row.racecourse_name,
        raceNumber: row.race_number,
        grade: row.grade,
        trackType: row.track_type,
        distance: row.distance,
        trackCondition: row.track_condition,
        confidence: row.confidence,
        summary: row.summary,
        winHit: row.win_hit === 1,
        placeHit: row.place_hit === 1,
        top3PicksHit: row.top3_picks_hit,
        roi: Math.round((row.bet_roi || 0) * 100),
        betReturn: Math.round(row.bet_return || 0),
        pickResults,
        betResults,
        betSummary: { totalInvestment, totalPayout, totalProfit },
        actualTop3: top3,
        actualTop3Detailed,
      };
    });

    return NextResponse.json({
      history,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    }, { headers: getCacheHeaders('stats') });
  } catch (error) {
    console.error('predictions/history エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
