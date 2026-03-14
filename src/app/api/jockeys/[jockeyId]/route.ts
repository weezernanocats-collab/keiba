import { NextRequest, NextResponse } from 'next/server';
import { getJockeyById, getJockeyRecentResults } from '@/lib/queries';
import { dbGet } from '@/lib/database';
import { getCacheHeaders } from '@/lib/api-helpers';

export const maxDuration = 15;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JockeyData = Record<string, any>;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jockeyId: string }> }
) {
  try {
    const { jockeyId } = await params;
    let jockey: JockeyData | null = (await getJockeyById(jockeyId)) ?? null;

    // jockeys テーブルにない場合、race_entries から騎手情報を構築
    if (!jockey) {
      const stats = await dbGet<Record<string, unknown>>(
        `SELECT
          e.jockey_id as id,
          e.jockey_name as name,
          COUNT(*) as total_races,
          SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN e.result_position <= 2 THEN 1 ELSE 0 END) as top2,
          SUM(CASE WHEN e.result_position <= 3 THEN 1 ELSE 0 END) as top3,
          SUM(CASE WHEN e.result_position IS NOT NULL THEN 1 ELSE 0 END) as finished
        FROM race_entries e
        WHERE e.jockey_id = ? AND e.jockey_name != ''
        GROUP BY e.jockey_id`,
        [jockeyId]
      );

      if (!stats || !stats.name) {
        return NextResponse.json({ error: '騎手が見つかりません' }, { status: 404 });
      }

      const totalRaces = (stats.total_races as number) || 0;
      const wins = (stats.wins as number) || 0;
      const finished = (stats.finished as number) || 1;
      const top2 = (stats.top2 as number) || 0;
      const top3 = (stats.top3 as number) || 0;

      jockey = {
        id: stats.id as string,
        name: stats.name as string,
        name_en: null,
        age: 0,
        region: '中央',
        belongs_to: '',
        total_races: totalRaces,
        wins,
        win_rate: finished > 0 ? wins / finished : 0,
        place_rate: finished > 0 ? top2 / finished : 0,
        show_rate: finished > 0 ? top3 / finished : 0,
        total_earnings: 0,
        _partial: true,
      };
    }

    const recentResults = await getJockeyRecentResults(jockeyId, 20);

    return NextResponse.json({ jockey, recentResults }, { headers: getCacheHeaders('master') });
  } catch (error) {
    console.error('騎手詳細API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
