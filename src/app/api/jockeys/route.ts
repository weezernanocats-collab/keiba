import { NextRequest, NextResponse } from 'next/server';
import { getAllJockeys, searchJockeys } from '@/lib/queries';
import { seedAllData } from '@/lib/seed-data';

export async function GET(request: NextRequest) {
  try {
    await seedAllData();

    const { searchParams } = request.nextUrl;
    const query = searchParams.get('q');
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');

    if (query) {
      const jockeys = await searchJockeys(query, limit);
      return NextResponse.json({ jockeys });
    }

    const jockeys = await getAllJockeys(limit, offset);
    return NextResponse.json({ jockeys });
  } catch (error) {
    console.error('騎手API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
