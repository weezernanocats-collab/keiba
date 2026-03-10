import { NextRequest, NextResponse } from 'next/server';
import { getAllHorses, searchHorses } from '@/lib/queries';
import { getCacheHeaders } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const query = searchParams.get('q');
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');

    const headers = getCacheHeaders('master');

    if (query) {
      const horses = await searchHorses(query, limit);
      return NextResponse.json({ horses }, { headers });
    }

    const horses = await getAllHorses(limit, offset);
    return NextResponse.json({ horses }, { headers });
  } catch (error) {
    console.error('馬API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
