import { NextRequest, NextResponse } from 'next/server';
import { getHorseById, getHorsePastPerformances } from '@/lib/queries';
import { seedAllData } from '@/lib/seed-data';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ horseId: string }> }
) {
  try {
    await seedAllData();
    const { horseId } = await params;
    const horse = await getHorseById(horseId);

    if (!horse) {
      return NextResponse.json({ error: '馬が見つかりません' }, { status: 404 });
    }

    const pastPerformances = await getHorsePastPerformances(horseId, 20);

    return NextResponse.json({ horse, pastPerformances });
  } catch (error) {
    console.error('馬詳細API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
