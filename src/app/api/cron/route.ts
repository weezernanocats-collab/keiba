/**
 * Vercel Cron エンドポイント
 *
 * vercel.json の cron から呼び出される。
 * JST 時刻に基づいて朝ジョブ（bulk_chunked トリガー）または結果取得を実行。
 *
 * Hobby プラン対応:
 *   - 朝 (06:00 JST): /api/sync に bulk_chunked を POST してチェーン開始（軽量）
 *   - 夕方 (17:00 JST): 結果スクレイプ + 予想照合（60秒以内で完了）
 */
import { NextRequest, NextResponse } from 'next/server';
import { runCronJob } from '@/lib/scheduler';

// Hobby: 60秒、Pro: 300秒 — Vercel が自動的にプランに応じて制限
export const maxDuration = 60;

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
    // JST 現在時刻を計算
    const now = new Date();
    const jstOffset = 9 * 60;
    const jstMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + jstOffset;
    const jstHour = Math.floor((jstMinutes % 1440) / 60);

    // 朝 (05:30-06:30 JST) → bulk_chunked で非同期チェーン
    if (jstHour >= 5 && jstHour <= 6) {
      const baseUrl = request.nextUrl.origin;
      const syncKey = process.env.SYNC_KEY;

      // bulk_chunked の初回リクエストを fire-and-forget で送信
      // これにより /api/sync 内でチャンク実行が自動チェーンされる
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (syncKey) headers['x-sync-key'] = syncKey;

      // JST日付を計算（今日 〜 3日後をカバー）
      const jstTime = new Date(now.getTime() + jstOffset * 60_000);
      const todayStr = jstTime.toISOString().split('T')[0];
      const endDay = new Date(jstTime.getTime() + 3 * 86400000).toISOString().split('T')[0];

      fetch(`${baseUrl}/api/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'bulk_chunked',
          startDate: todayStr,
          endDate: endDay,
        }),
      }).catch(() => {
        // fire-and-forget: エラーは無視（sync API 側でログに記録される）
      });

      return NextResponse.json({
        ok: true,
        timestamp: now.toISOString(),
        executed: ['morning: bulk_chunked triggered'],
        skipped: [],
      });
    }

    // 夕方 (17:00 JST) 以降、または他の時間帯 → 従来のスケジューラーロジック
    const result = await runCronJob();

    return NextResponse.json({
      ok: true,
      timestamp: now.toISOString(),
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
