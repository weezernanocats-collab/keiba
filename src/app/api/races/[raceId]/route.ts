import { NextRequest, NextResponse } from 'next/server';
import { getRaceById } from '@/lib/queries';
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

    return NextResponse.json({ race });
  } catch (error) {
    console.error('レース詳細API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
