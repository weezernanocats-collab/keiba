import { NextRequest, NextResponse } from 'next/server';
import { getJockeyById, getJockeyRecentResults } from '@/lib/queries';
import { seedAllData } from '@/lib/seed-data';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jockeyId: string }> }
) {
  try {
    seedAllData();
    const { jockeyId } = await params;
    const jockey = getJockeyById(jockeyId);

    if (!jockey) {
      return NextResponse.json({ error: '騎手が見つかりません' }, { status: 404 });
    }

    const recentResults = getJockeyRecentResults(jockeyId, 20);

    return NextResponse.json({ jockey, recentResults });
  } catch (error) {
    console.error('騎手詳細API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
