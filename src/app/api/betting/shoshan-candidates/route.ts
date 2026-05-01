import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const date = searchParams.get('date');

    if (!date) {
      return NextResponse.json({ error: 'date は必須です' }, { status: 400 });
    }

    const rows = await dbAll(
      `SELECT p.race_id, p.analysis_json, r.racecourse_name, r.race_number, r.name, r.time
       FROM predictions p
       JOIN races r ON p.race_id = r.id
       WHERE r.date = ?
         AND p.analysis_json LIKE '%shosanPrediction%'
       ORDER BY r.time, r.racecourse_name, r.race_number`,
      [date],
    );

    const results: {
      raceId: string;
      raceLabel: string;
      raceName: string;
      time: string | null;
      candidates: {
        horseNumber: number;
        horseName: string;
        theory: number;
        matchScore: number;
        jockeyName: string;
        reasons: string[];
      }[];
    }[] = [];

    for (const row of rows as Record<string, unknown>[]) {
      try {
        const analysis = JSON.parse(row.analysis_json as string);
        const shosan = analysis?.shosanPrediction;
        if (!shosan?.candidates?.length) continue;

        results.push({
          raceId: row.race_id as string,
          raceLabel: `${row.racecourse_name}${row.race_number}R`,
          raceName: row.name as string,
          time: row.time as string | null,
          candidates: shosan.candidates.map((c: Record<string, unknown>) => ({
            horseNumber: c.horseNumber,
            horseName: c.horseName,
            theory: c.theory,
            matchScore: c.matchScore,
            jockeyName: c.jockeyName,
            reasons: c.reasons || [],
          })),
        });
      } catch {
        // analysis_json parse failure — skip
      }
    }

    return NextResponse.json({ races: results });
  } catch (error) {
    console.error('しょーさん候補取得エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
