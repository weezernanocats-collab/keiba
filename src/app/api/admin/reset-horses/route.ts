import { NextRequest, NextResponse } from 'next/server';
import { dbAll, dbRun } from '@/lib/database';

/**
 * 取得失敗した馬をリセットし、次回バルクインポートで再取得させるエンドポイント
 *
 * GET: 取得失敗馬の一覧を表示
 * POST: 取得失敗馬をリセット（birth_dateをNULLに戻す）
 *
 * 認証: SYNC_KEY 必須
 */

function checkAuth(request: NextRequest): boolean {
  const syncKey = process.env.SYNC_KEY;
  if (!syncKey) return true;
  const authHeader = request.headers.get('authorization');
  const queryKey = request.nextUrl.searchParams.get('key');
  return authHeader === `Bearer ${syncKey}` || queryKey === syncKey;
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: '認証エラー' }, { status: 401 });
  }

  try {
    const failedHorses = await dbAll<Record<string, unknown>>(
      `SELECT h.id, h.name, h.birth_date,
              (SELECT COUNT(*) FROM race_entries re WHERE re.horse_id = h.id) as entry_count,
              (SELECT re.horse_name FROM race_entries re WHERE re.horse_id = h.id AND re.horse_name != '' LIMIT 1) as correct_name
       FROM horses h
       WHERE h.birth_date = 'FETCH_FAILED' OR h.name = '取得失敗'
       ORDER BY entry_count DESC`
    );

    const nameOverwritten = await dbAll<Record<string, unknown>>(
      `SELECT h.id, h.name,
              (SELECT re.horse_name FROM race_entries re WHERE re.horse_id = h.id AND re.horse_name != '' LIMIT 1) as correct_name
       FROM horses h
       WHERE h.name = '取得失敗'`
    );

    return NextResponse.json({
      failedCount: failedHorses.length,
      nameOverwrittenCount: nameOverwritten.length,
      failedHorses: failedHorses.slice(0, 50),
      nameOverwritten: nameOverwritten.slice(0, 50),
    });
  } catch (error) {
    console.error('リセット馬一覧エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: '認証エラー' }, { status: 401 });
  }

  try {
    // 1. name='取得失敗' の馬を race_entries の正しい名前に修正
    const nameFixed = await dbRun(
      `UPDATE horses SET name = (
        SELECT re.horse_name FROM race_entries re
        WHERE re.horse_id = horses.id AND re.horse_name != ''
        LIMIT 1
      ) WHERE name = '取得失敗' AND EXISTS (
        SELECT 1 FROM race_entries re
        WHERE re.horse_id = horses.id AND re.horse_name != ''
      )`
    );

    // 2. birth_date='FETCH_FAILED' をNULLにリセット（次回バルクで再取得）
    const birthReset = await dbRun(
      `UPDATE horses SET birth_date = NULL WHERE birth_date = 'FETCH_FAILED'`
    );

    // 3. name='取得失敗' のまま race_entries にも名前がない馬のbirth_dateもリセット
    const remainingReset = await dbRun(
      `UPDATE horses SET birth_date = NULL WHERE name = '取得失敗'`
    );

    return NextResponse.json({
      message: 'リセット完了',
      nameFixed: nameFixed.rowsAffected,
      birthReset: birthReset.rowsAffected,
      remainingReset: remainingReset.rowsAffected,
    });
  } catch (error) {
    console.error('リセット処理エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
