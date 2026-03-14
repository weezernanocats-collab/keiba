import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';
import { getCacheHeaders } from '@/lib/api-helpers';

export const maxDuration = 15;

/**
 * 的中率推移グラフ用API
 * クエリパラメータ: ?period=weekly | monthly (デフォルト: weekly)
 *
 * 返却データ:
 *   - trend: 期間ごとの単勝的中率・複勝的中率・ROI・レース数
 */

interface TrendRow {
  period: string;
  win_rate: number;
  place_rate: number;
  roi: number;
  total: number;
}

interface TrendItem {
  period: string;
  winRate: number;
  placeRate: number;
  roi: number;
  total: number;
}

const VALID_PERIODS = ['weekly', 'monthly'] as const;
type Period = typeof VALID_PERIODS[number];

function isValidPeriod(value: string): value is Period {
  return (VALID_PERIODS as readonly string[]).includes(value);
}

export async function GET(request: NextRequest) {
  try {
    const periodParam = request.nextUrl.searchParams.get('period') ?? 'weekly';
    const period: Period = isValidPeriod(periodParam) ? periodParam : 'weekly';

    const isWeekly = period === 'weekly';
    const periodExpr = isWeekly
      ? "strftime('%Y-W%W', r.date)"
      : "strftime('%Y-%m', r.date)";
    const limit = isWeekly ? 24 : 12;

    const rows = await dbAll<TrendRow>(
      `SELECT
        ${periodExpr} as period,
        ROUND(AVG(pr.win_hit) * 100, 1) as win_rate,
        ROUND(AVG(pr.place_hit) * 100, 1) as place_rate,
        ROUND(AVG(CASE WHEN pr.bet_investment > 0 THEN pr.bet_return / pr.bet_investment ELSE 0 END) * 100, 1) as roi,
        COUNT(*) as total
      FROM prediction_results pr
      JOIN races r ON pr.race_id = r.id
      WHERE r.status = '結果確定'
      GROUP BY period
      ORDER BY period DESC
      LIMIT ?`,
      [limit],
    );

    // DESC で取得して件数を制限した後、昇順に戻す（グラフ表示用）
    const trend: TrendItem[] = rows.reverse().map((row) => ({
      period: row.period,
      winRate: row.win_rate,
      placeRate: row.place_rate,
      roi: row.roi,
      total: row.total,
    }));

    return NextResponse.json({ trend }, {
      headers: getCacheHeaders('stats'),
    });
  } catch (error) {
    console.error('stats/trend エラー:', error);
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
