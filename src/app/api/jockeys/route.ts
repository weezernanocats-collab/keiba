import { NextRequest, NextResponse } from 'next/server';
import { getAllJockeys, searchJockeys } from '@/lib/queries';
import { getCacheHeaders } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const query = searchParams.get('q');
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');

    const headers = getCacheHeaders('master');

    if (query) {
      const jockeys = await searchJockeys(query, limit);
      return NextResponse.json({ jockeys }, { headers });
    }

    const jockeys = await getAllJockeys(limit, offset);
    return NextResponse.json({ jockeys }, { headers });
  } catch (error) {
    console.error('騎手API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
