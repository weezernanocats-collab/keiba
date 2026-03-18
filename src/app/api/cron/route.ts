/**
 * Vercel Cron エンドポイント
 *
 * vercel.json の cron から呼び出される。
 * JST 時刻に基づいて朝ジョブ（bulk_chunked トリガー）または結果取得を実行。
 *
 * Hobby プラン対応:
 *   - 朝 (09:00 JST): /api/sync に bulk_chunked を POST してチェーン開始
 *   - 昼 (12:00 JST): 予想未生成レースの補完（朝のチェーンが途切れた場合の安全網）
 *   - 夕方 (17:00 JST): 結果スクレイプ + 予想照合 + 予想補完
 */
import { NextRequest, NextResponse } from 'next/server';
import { runCronJob, executeMissingPredictions, cleanupStaleRaces } from '@/lib/scheduler';
import { evaluateAllPendingRaces } from '@/lib/accuracy-tracker';
import { dbGet } from '@/lib/database';

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

    // 共通変数
    const jstTime = new Date(now.getTime() + jstOffset * 60_000);
    const todayStr = jstTime.toISOString().split('T')[0];

    // 非開催日の早期リターン: 今日・明日にレースがなければ全処理をスキップ
    const tomorrowStr = new Date(jstTime.getTime() + 86400000).toISOString().split('T')[0];
    const hasRaces = await dbGet<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM races WHERE date IN (?, ?)',
      [todayStr, tomorrowStr],
    );
    if (!hasRaces || hasRaces.cnt === 0) {
      return NextResponse.json({
        ok: true,
        timestamp: now.toISOString(),
        executed: [],
        skipped: ['非開催日: レースなし'],
      });
    }
    const baseUrl = request.nextUrl.origin;
    const syncKey = process.env.SYNC_KEY;

    // 朝 (08:30-09:30 JST) → bulk_chunked で非同期チェーン（全レース発売開始後）
    if (jstHour >= 8 && jstHour <= 9) {
      const executed: string[] = [];

      // bulk_chunked の初回リクエストを最優先で fire-and-forget 送信
      // スコープを今日+1日に削減（4日→2日: チェーン長を半減させ切断リスクを大幅低減）
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (syncKey) headers['x-sync-key'] = syncKey;
      const endDay = new Date(jstTime.getTime() + 1 * 86400000).toISOString().split('T')[0];

      fetch(`${baseUrl}/api/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'bulk_chunked',
          startDate: todayStr,
          endDate: endDay,
        }),
      }).then(res => {
        if (!res.ok) console.error(`[cron] morning bulk_chunked trigger HTTP ${res.status}`);
      }).catch(err => {
        console.error('[cron] morning bulk_chunked trigger failed:', err instanceof Error ? err.message : err);
      });

      executed.push(`morning: bulk_chunked triggered (${todayStr}〜${endDay})`);

      // 前日の未照合レースを評価（昨夕cronが失敗した場合の安全網）
      // bulk_chunked トリガー後に実行し、チェーン開始を遅延させない
      try {
        const evalResults = await evaluateAllPendingRaces();
        if (evalResults.length > 0) {
          const wins = evalResults.filter(r => r.winHit).length;
          executed.push(`morning: 前日照合 ${evalResults.length}件 (単勝${wins}的中)`);
        }
      } catch (e) {
        console.error('[cron] morning evaluate failed:', e);
      }

      // 過去の滞留レースをクリーンアップ（前日のcron失敗を回収）
      // bulk_chunked トリガー後に実行し、チェーン開始をブロックしない
      try {
        const { fixed, total } = await cleanupStaleRaces(15_000);
        if (total > 0) {
          executed.push(`morning: ステータス修復 ${fixed}/${total}件`);
        }
      } catch (e) {
        console.error('[cron] morning cleanup failed:', e);
      }

      return NextResponse.json({
        ok: true,
        timestamp: now.toISOString(),
        executed,
        skipped: [],
      });
    }

    // 午前〜午後 (10:00-14:00 JST) → チェーン再開 + 照合 + 予想補完
    if (jstHour >= 10 && jstHour <= 14) {
      const handlerStart = Date.now();
      const executed: string[] = [];

      // 1. 結果確定済みレースの予想照合（最優先・高速）
      try {
        const evalResults = await evaluateAllPendingRaces();
        if (evalResults.length > 0) {
          const wins = evalResults.filter(r => r.winHit).length;
          executed.push(`照合: ${evalResults.length}件 (単勝${wins}的中)`);
        }
      } catch (e) {
        console.error('[cron] midday evaluate failed:', e);
      }

      // 2. 予想未生成レースの補完（経過時間を考慮した動的タイムバジェット）
      // 60s maxDuration - 経過時間 - 10s安全マージン = 残りバジェット
      const elapsed = Date.now() - handlerStart;
      const predictionBudget = Math.max(5_000, 50_000 - elapsed);
      try {
        const { generated, total } = await executeMissingPredictions(todayStr, predictionBudget);
        executed.push(total > 0
          ? `予想補完: ${generated}/${total}件生成`
          : '全レース予想済み');
      } catch (e) {
        console.error('[cron] midday predictions failed:', e);
        executed.push(`予想補完失敗: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 3. bulk_chunked チェーンの再開（idempotentなので既処理項目はスキップされる）
      // 朝は今日+明日を処理するが、昼の再開は今日のみ（明日のデータは翌朝で十分）
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (syncKey) headers['x-sync-key'] = syncKey;
      fetch(`${baseUrl}/api/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'bulk_chunked',
          startDate: todayStr,
          endDate: todayStr,
        }),
      }).then(res => {
        if (!res.ok) console.error(`[cron] midday bulk_chunked resume HTTP ${res.status}`);
      }).catch(err => {
        console.error('[cron] midday bulk_chunked resume failed:', err instanceof Error ? err.message : err);
      });
      executed.push('bulk_chunked 再開トリガー');

      return NextResponse.json({
        ok: true,
        timestamp: now.toISOString(),
        executed: executed.map(e => `midday: ${e}`),
        skipped: [],
      });
    }

    // 夕方 (17:00 JST) 以降、または他の時間帯 → 従来のスケジューラーロジック
    // runCronJob の失敗が後続処理をブロックしないよう try-catch で囲む
    let result = { executed: [] as string[], skipped: [] as string[] };
    try {
      result = await runCronJob();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[cron] runCronJob failed:', msg);
      result.skipped.push(`runCronJob失敗: ${msg}`);
    }

    // 夕方cronでは結果照合と予想補完、ステータス修復を追加で実行
    if (jstHour >= 16 && jstHour <= 18) {
      // 当日の結果取得が一部失敗した場合や、過去の滞留レースを修復
      try {
        const { fixed, total } = await cleanupStaleRaces(15_000);
        if (fixed > 0) {
          result.executed.push(`evening: ステータス修復 ${fixed}/${total}件`);
        }
      } catch (e) {
        console.error('[cron] evening cleanup failed:', e);
      }
      // runCronJobが失敗した場合のみ、evaluateAllPendingRacesを追加実行
      // （成功時は executeResultFetch 内で既に呼ばれている）
      if (result.skipped.some(s => s.includes('runCronJob失敗'))) {
        try {
          const evalResults = await evaluateAllPendingRaces();
          if (evalResults.length > 0) {
            const wins = evalResults.filter(r => r.winHit).length;
            result.executed.push(`evening: 追加照合 ${evalResults.length}件 (単勝${wins}的中)`);
          }
        } catch (e) {
          console.error('[cron] evening evaluate failed:', e);
        }
      }

      // 予想未生成レースの補完（15秒のタイムバジェット）
      try {
        const { generated, total } = await executeMissingPredictions(todayStr, 15_000);
        if (generated > 0) {
          result.executed.push(`evening: 予想補完 ${generated}/${total}件生成`);
        }
      } catch (e) {
        console.error('[cron] evening predictions failed:', e);
      }
    }

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
