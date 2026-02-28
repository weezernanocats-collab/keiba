/**
 * Vercel Cron エンドポイント
 *
 * Vercel の Cron Jobs 機能から定期的に呼び出され、
 * 現在時刻（JST）に基づいて適切なスケジューラージョブを実行する。
 *
 * vercel.json での設定例:
 * {
 *   "crons": [
 *     { "path": "/api/cron", "schedule": "0 6,9,17,22 * * *" }
 *   ]
 * }
 *
 * CRON_SECRET 環境変数を設定すると、Vercel からのリクエストのみ許可する。
 */
import { NextRequest, NextResponse } from 'next/server';
import { runCronJob } from '@/lib/scheduler';

export const maxDuration = 300; // Vercel Pro: 最大300秒

export async function GET(request: NextRequest) {
  // Vercel Cron からのリクエスト認証
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { error: '認証エラー: 無効なCRON_SECRET' },
        { status: 401 }
      );
    }
  }

  try {
    const result = await runCronJob();

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
