import { NextRequest, NextResponse } from 'next/server';
import { getAllHorses, searchHorses } from '@/lib/queries';
import { seedAllData } from '@/lib/seed-data';

export async function GET(request: NextRequest) {
  try {
    seedAllData();

    const { searchParams } = request.nextUrl;
    const query = searchParams.get('q');
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');

    if (query) {
      const horses = searchHorses(query, limit);
      return NextResponse.json({ horses });
    }

    const horses = getAllHorses(limit, offset);
    return NextResponse.json({ horses });
  } catch (error) {
    console.error('馬API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
