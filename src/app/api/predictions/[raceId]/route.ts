import { NextRequest, NextResponse } from 'next/server';
import { getPredictionByRaceId, getRaceById } from '@/lib/queries';
import { seedAllData } from '@/lib/seed-data';

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

    const prediction = await getPredictionByRaceId(raceId);

    if (!prediction) {
      return NextResponse.json({ error: '予想がまだ生成されていません' }, { status: 404 });
    }

    // topPicks に horseName/horseNumber がない場合、race.entries から補完
    const entriesMap = new Map(
      race.entries.map(e => [e.horseNumber, e])
    );

    const augmentedPicks = prediction.topPicks.map(pick => {
      if (pick.horseName && pick.horseNumber) return pick;
      const entry = entriesMap.get(pick.horseNumber);
      return {
        ...pick,
        horseName: pick.horseName || entry?.horseName || `${pick.horseNumber}番`,
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
