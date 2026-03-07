import { NextRequest, NextResponse } from 'next/server';
import { getPredictionByRaceId, getRaceById, getHorseById, getHorsePastPerformances, getJockeyStats, savePrediction } from '@/lib/queries';
import { dbRun, dbAll } from '@/lib/database';
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

    // 結果確定済みの場合は答え合わせデータを追加
    let verification = null;
    if (race.status === '結果確定') {
      try {
        const predResult = await dbAll<{
          win_hit: number;
          place_hit: number;
          top3_in_top6: number;
          roi: number;
        }>(
          'SELECT win_hit, place_hit, top3_in_top6, roi FROM prediction_results WHERE race_id = ?',
          [raceId],
        );

        // 出走馬の着順マップ
        const entryResults = new Map<number, number>();
        for (const entry of race.entries) {
          if (entry.result?.position) {
            entryResults.set(entry.horseNumber, entry.result.position);
          }
        }

        // 予想vs結果の対比
        const pickResults = augmentedPicks.map(pick => ({
          ...pick,
          actualPosition: entryResults.get(pick.horseNumber) ?? null,
          hit: entryResults.get(pick.horseNumber) === 1,
          placeHit: (entryResults.get(pick.horseNumber) ?? 99) <= 3,
        }));

        // 推奨馬券の的中判定
        const actualTop3 = [...entryResults.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, 3)
          .map(([num]) => num);
        const actualWinner = actualTop3[0];

        const betResults = augmentedPrediction.recommendedBets.map((bet: { type: string; selections: number[] }) => {
          let hitStatus = false;
          if (bet.type === '単勝') {
            hitStatus = bet.selections[0] === actualWinner;
          } else if (bet.type === '複勝') {
            hitStatus = actualTop3.includes(bet.selections[0]);
          } else if (bet.type === '馬連' || bet.type === 'ワイド') {
            hitStatus = bet.selections.every(s => actualTop3.includes(s));
          } else if (bet.type === '馬単') {
            hitStatus = bet.selections[0] === actualWinner && actualTop3.includes(bet.selections[1]);
          } else if (bet.type === '三連複') {
            hitStatus = bet.selections.every(s => actualTop3.includes(s));
          } else if (bet.type === '三連単') {
            hitStatus = bet.selections.length >= 3 &&
              bet.selections[0] === actualTop3[0] &&
              bet.selections[1] === actualTop3[1] &&
              bet.selections[2] === actualTop3[2];
          }
          return { ...bet, hit: hitStatus };
        });

        verification = {
          winHit: predResult[0]?.win_hit === 1,
          placeHit: predResult[0]?.place_hit === 1,
          top3InTop6: predResult[0]?.top3_in_top6 ?? 0,
          roi: predResult[0]?.roi ?? 0,
          pickResults,
          betResults,
          actualTop3,
        };
      } catch (verErr) {
        console.error('答え合わせデータ取得エラー:', verErr);
      }
    }

    return NextResponse.json({ prediction: augmentedPrediction, race, verification });
  } catch (error) {
    console.error('予想API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
