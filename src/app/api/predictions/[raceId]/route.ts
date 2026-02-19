import { NextRequest, NextResponse } from 'next/server';
import { getPredictionByRaceId, getRaceById } from '@/lib/queries';
import { seedAllData } from '@/lib/seed-data';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ raceId: string }> }
) {
  try {
    seedAllData();
    const { raceId } = await params;

    const race = getRaceById(raceId);
    if (!race) {
      return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 });
    }

    const prediction = getPredictionByRaceId(raceId);

    if (!prediction) {
      return NextResponse.json({ error: '予想がまだ生成されていません' }, { status: 404 });
    }

    return NextResponse.json({ prediction, race });
  } catch (error) {
    console.error('予想API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
