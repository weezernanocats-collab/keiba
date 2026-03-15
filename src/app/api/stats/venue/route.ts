import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';

export const maxDuration = 15;
export const dynamic = 'force-dynamic';

/**
 * 競馬場別・トラック別の的中傾向API
 *
 * GET /api/stats/venue
 *
 * 返却データ:
 *   - venues: 競馬場別の的中率・ROI
 *   - tracks: トラック種別（芝/ダート/障害）の的中率・ROI
 */

interface VenueStat {
  name: string;
  total: number;
  win_rate: number;
  place_rate: number;
  roi: number;
}

interface TrackStat {
  type: string;
  total: number;
  win_rate: number;
  place_rate: number;
  roi: number;
}

export async function GET(request: NextRequest) {
  try {
    const daysParam = request.nextUrl.searchParams.get('days');
    const days = daysParam && daysParam !== 'all' ? parseInt(daysParam, 10) : 0;
    const dateFilter = days > 0
      ? `AND r.date >= date('now', '-${days} days')`
      : '';

    const [venues, tracks] = await Promise.all([
      dbAll<VenueStat>(
        `SELECT
          r.racecourse_name AS name,
          COUNT(*) AS total,
          ROUND(AVG(pr.win_hit) * 100, 1) AS win_rate,
          ROUND(AVG(pr.place_hit) * 100, 1) AS place_rate,
          ROUND(AVG(CASE WHEN pr.bet_investment > 0 THEN pr.bet_return / pr.bet_investment ELSE 0 END) * 100, 1) AS roi
        FROM prediction_results pr
        JOIN races r ON pr.race_id = r.id
        WHERE r.status = '結果確定' ${dateFilter}
        GROUP BY r.racecourse_name
        HAVING COUNT(*) >= 3
        ORDER BY total DESC`,
      ),
      dbAll<TrackStat>(
        `SELECT
          r.track_type AS type,
          COUNT(*) AS total,
          ROUND(AVG(pr.win_hit) * 100, 1) AS win_rate,
          ROUND(AVG(pr.place_hit) * 100, 1) AS place_rate,
          ROUND(AVG(CASE WHEN pr.bet_investment > 0 THEN pr.bet_return / pr.bet_investment ELSE 0 END) * 100, 1) AS roi
        FROM prediction_results pr
        JOIN races r ON pr.race_id = r.id
        WHERE r.status = '結果確定' ${dateFilter}
        GROUP BY r.track_type
        ORDER BY total DESC`,
      ),
    ]);

    const responseData = {
      venues: venues.map((v) => ({
        name: v.name,
        total: Number(v.total),
        winRate: Number(v.win_rate),
        placeRate: Number(v.place_rate),
        roi: Number(v.roi),
      })),
      tracks: tracks.map((t) => ({
        type: t.type,
        total: Number(t.total),
        winRate: Number(t.win_rate),
        placeRate: Number(t.place_rate),
        roi: Number(t.roi),
      })),
    };

    return NextResponse.json(responseData, {
      headers: { 'Cache-Control': 'private, max-age=60' },
    });
  } catch (error) {
    console.error('venue stats API エラー:', error);
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
