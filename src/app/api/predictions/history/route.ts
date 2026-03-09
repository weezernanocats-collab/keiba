import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';

/**
 * 過去予想履歴API
 * 予想と結果を一緒に返す
 * クエリパラメータ:
 *   ?page=1 (ページ番号, デフォルト1)
 *   ?limit=20 (1ページあたり件数)
 *   ?grade=G1 (グレードフィルタ)
 *   ?result=win|place|miss (結果フィルタ)
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

    // グレードフィルタ: G1/G2/G3はgradeカラム、他は名前ベースでSQL LIKE
    if (gradeFilter) {
      if (['G1', 'G2', 'G3'].includes(gradeFilter)) {
        conditions.push('r.grade = ?');
        params.push(gradeFilter);
      } else if (gradeFilter === '新馬') {
        conditions.push("r.name LIKE '%新馬%'");
      } else if (gradeFilter === '未勝利') {
        conditions.push("r.name LIKE '%未勝利%'");
      } else if (gradeFilter === '1勝クラス') {
        conditions.push("(r.name LIKE '%1勝クラス%' OR r.name LIKE '%1勝%')");
      } else if (gradeFilter === '2勝クラス') {
        conditions.push("(r.name LIKE '%2勝クラス%' OR r.name LIKE '%2勝%')");
      } else if (gradeFilter === '3勝クラス') {
        conditions.push("(r.name LIKE '%3勝クラス%' OR r.name LIKE '%3勝%')");
      } else if (gradeFilter === 'オープン') {
        conditions.push("(r.name LIKE '%オープン%' OR r.name LIKE '%ステークス%' OR r.name LIKE '%カップ%')");
      }
    }

    if (resultFilter === 'win') {
      conditions.push('pr.win_hit = 1');
    } else if (resultFilter === 'place') {
      conditions.push('pr.place_hit = 1 AND pr.win_hit = 0');
    } else if (resultFilter === 'miss') {
      conditions.push('pr.place_hit = 0');
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
    const entryResultMap = new Map<string, Map<number, number>>();

    if (raceIds.length > 0) {
      const ph = raceIds.map(() => '?').join(',');
      const entries = await dbAll<{ race_id: string; horse_number: number; result_position: number }>(
        `SELECT race_id, horse_number, result_position FROM race_entries
         WHERE race_id IN (${ph}) AND result_position IS NOT NULL`,
        raceIds,
      );
      for (const e of entries) {
        if (!entryResultMap.has(e.race_id)) entryResultMap.set(e.race_id, new Map());
        entryResultMap.get(e.race_id)!.set(e.horse_number, e.result_position);
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
      const top3 = [...posMap.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([num]) => num);
      const winner = top3[0];

      // 予想馬の実着順を付与
      const pickResults = picks.slice(0, 6).map(p => ({
        ...p,
        actualPosition: posMap.get(p.horseNumber) ?? null,
        hit: posMap.get(p.horseNumber) === 1,
        placeHit: (posMap.get(p.horseNumber) ?? 99) <= 3,
      }));

      // 馬券の的中判定
      const betResults = bets.map(bet => {
        let isHit = false;
        const sels = bet.selections || [];
        if (bet.type === '単勝') isHit = sels[0] === winner;
        else if (bet.type === '複勝') isHit = top3.includes(sels[0]);
        else if (bet.type === '馬連' || bet.type === 'ワイド') isHit = sels.every(s => top3.includes(s));
        else if (bet.type === '馬単') isHit = sels[0] === winner && sels.length >= 2 && top3.includes(sels[1]);
        else if (bet.type === '三連複') isHit = sels.length >= 3 && sels.every(s => top3.includes(s));
        else if (bet.type === '三連単') isHit = sels.length >= 3 && sels[0] === top3[0] && sels[1] === top3[1] && sels[2] === top3[2];
        return { ...bet, hit: isHit };
      });

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
        actualTop3: top3,
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
    });
  } catch (error) {
    console.error('predictions/history エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
