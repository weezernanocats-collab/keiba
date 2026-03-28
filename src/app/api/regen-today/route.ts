import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';
import { getRaceById, savePrediction } from '@/lib/queries';
import { buildAndPredict } from '@/lib/prediction-builder';
import { ensureCalibrationLoaded } from '@/lib/accuracy-tracker';
import type { TrackType, TrackCondition, RaceEntry } from '@/types';

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const deadline = startTime + 50_000; // 50秒バジェット

  // 認証チェック
  const syncKey = process.env.SYNC_KEY;
  if (syncKey) {
    const provided = request.nextUrl.searchParams.get('key');
    if (provided !== syncKey) {
      return NextResponse.json({ error: '認証エラー' }, { status: 401 });
    }
  }

  // デバッグ: DB接続状態を確認
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  if (!tursoUrl) {
    return NextResponse.json({
      error: 'TURSO_DATABASE_URL が未設定です',
      envKeys: Object.keys(process.env).filter(k => k.includes('TURSO') || k.includes('DATABASE')),
    }, { status: 500 });
  }

  try {
    // JST今日の日付
    const jstNow = new Date(Date.now() + 9 * 60 * 60_000);
    const today = jstNow.toISOString().split('T')[0];
    const dateParam = request.nextUrl.searchParams.get('date') || today;

    // 予想がないレースを取得
    const missing = await dbAll<{
      id: string; name: string; track_type: string; distance: number;
      track_condition: string; racecourse_name: string; grade: string; weather: string;
    }>(
      `SELECT r.id, r.name, r.track_type, r.distance, r.track_condition,
              r.racecourse_name, r.grade, r.weather
       FROM races r
       LEFT JOIN predictions p ON r.id = p.race_id
       WHERE p.id IS NULL AND r.date = ?
         AND r.status IN ('出走確定', '結果確定')
         AND (SELECT COUNT(*) FROM race_entries re WHERE re.race_id = r.id) >= 2
       ORDER BY r.race_number`,
      [dateParam]
    );

    if (missing.length === 0) {
      return NextResponse.json({
        ok: true,
        date: dateParam,
        message: '予想未生成レースなし（全レース予想済み）',
        generated: 0,
        total: 0,
      });
    }

    await ensureCalibrationLoaded();

    let generated = 0;
    const errors: string[] = [];

    for (const race of missing) {
      if (Date.now() >= deadline) {
        errors.push(`タイムバジェット到達: ${generated}/${missing.length}件で中断`);
        break;
      }

      try {
        const raceData = await getRaceById(race.id);
        if (!raceData?.entries?.length || raceData.entries.length < 2) continue;

        const prediction = await buildAndPredict(
          race.id, race.name, dateParam,
          race.track_type as TrackType, race.distance,
          race.track_condition as TrackCondition | undefined,
          race.racecourse_name, race.grade,
          raceData.entries as RaceEntry[],
          race.weather as string | undefined,
          { includeTrainerStats: true },
        );
        await savePrediction(prediction);
        generated++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${race.id} ${race.name}: ${msg}`);
      }
    }

    return NextResponse.json({
      ok: true,
      date: dateParam,
      generated,
      total: missing.length,
      remaining: missing.length - generated,
      elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
