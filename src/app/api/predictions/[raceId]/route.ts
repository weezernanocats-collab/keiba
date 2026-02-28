import { NextRequest, NextResponse } from 'next/server';
import { getPredictionByRaceId, getRaceById, getHorseById, getHorsePastPerformances, getJockeyStats, savePrediction } from '@/lib/queries';
import { dbRun } from '@/lib/database';
import { generatePrediction } from '@/lib/prediction-engine';
import { seedAllData } from '@/lib/seed-data';
import type { RaceEntry } from '@/types';

/** 予想が壊れているか判定（horseId が全て欠落している場合） */
function isBrokenPrediction(topPicks: { horseId?: string; horseName?: string }[]): boolean {
  if (!topPicks || topPicks.length === 0) return true;
  return topPicks.every(pick => !pick.horseId && (!pick.horseName || pick.horseName.endsWith('番')));
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ raceId: string }> }
) {
  try {
    await seedAllData();
    const { raceId } = await params;

    const race = await getRaceById(raceId);
    if (!race) {
      return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 });
    }

    let prediction = await getPredictionByRaceId(raceId);

    // 壊れた予想を検出して再生成
    if (prediction && isBrokenPrediction(prediction.topPicks) && race.entries.length > 0) {
      try {
        // 既存の壊れた予想を削除
        await dbRun('DELETE FROM predictions WHERE race_id = ?', [raceId]);

        // 再生成
        const horseInputs = await Promise.all(
          race.entries.map(async (re: RaceEntry) => {
            const pastPerfs = await getHorsePastPerformances(re.horseId, 100);
            const horseData = await getHorseById(re.horseId) as { father_name?: string } | null;
            const jockeyStats = await getJockeyStats(re.jockeyId);
            return {
              entry: re,
              pastPerformances: pastPerfs,
              jockeyWinRate: jockeyStats.winRate,
              jockeyPlaceRate: jockeyStats.placeRate,
              fatherName: horseData?.father_name || '',
            };
          })
        );

        const newPrediction = await generatePrediction(
          raceId, race.name, race.date,
          race.trackType as '芝' | 'ダート' | '障害',
          race.distance,
          race.trackCondition as '良' | '稍重' | '重' | '不良' | undefined,
          race.racecourseName,
          race.grade,
          horseInputs,
        );
        await savePrediction(newPrediction);
        prediction = newPrediction;
      } catch (regenError) {
        console.error('予想再生成失敗:', regenError);
        // 再生成に失敗した場合はフォールバック
      }
    }

    if (!prediction) {
      return NextResponse.json({ error: '予想がまだ生成されていません' }, { status: 404 });
    }

    // topPicks に horseName/horseNumber がない場合、race.entries から補完
    const entriesMap = new Map(
      race.entries.map(e => [e.horseNumber, e])
    );

    const augmentedPicks = prediction.topPicks.map(pick => {
      if (pick.horseName && pick.horseNumber && !pick.horseName.endsWith('番')) return pick;
      const entry = entriesMap.get(pick.horseNumber);
      return {
        ...pick,
        horseName: (pick.horseName && !pick.horseName.endsWith('番')) ? pick.horseName : (entry?.horseName || `${pick.horseNumber}番`),
        horseNumber: pick.horseNumber || 0,
      };
    });

    const augmentedPrediction = {
      ...prediction,
      topPicks: augmentedPicks,
    };

    return NextResponse.json({ prediction: augmentedPrediction, race });
  } catch (error) {
    console.error('予想API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
