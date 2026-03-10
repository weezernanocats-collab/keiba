import { NextRequest, NextResponse } from 'next/server';
import { getRaceById } from '@/lib/queries';
import { getCacheHeaders } from '@/lib/api-helpers';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ raceId: string }> }
) {
  try {
    const { raceId } = await params;
    const race = await getRaceById(raceId);

    if (!race) {
      return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 });
    }

    return NextResponse.json({ race }, { headers: getCacheHeaders('races') });
  } catch (error) {
    console.error('レース詳細API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
