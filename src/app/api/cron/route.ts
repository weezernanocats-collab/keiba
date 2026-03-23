/**
 * Vercel Cron エンドポイント
 *
 * vercel.json の cron から呼び出される。
 * JST 時刻に基づいて適切なジョブを実行する。
 *
 * 重要な設計方針:
 *   - evaluate + cleanup は「全てのcron実行」で必ず実行（非開催日でも）
 *   - 非開催日チェックはインポート/予想生成のみをゲート
 *   - 結果取得はタイムバジェット付きで直接呼び出し（runCronJob経由しない）
 *   - 夜cron (22:00 JST) で当日結果の安全網を提供
 */
import { NextRequest, NextResponse } from 'next/server';
import { runCronJob, executeMissingPredictions, cleanupStaleRaces, executeResultFetch, fetchUpcomingOdds, collectOddsSnapshots } from '@/lib/scheduler';
import { evaluateAllPendingRaces } from '@/lib/accuracy-tracker';
import { dbGet } from '@/lib/database';

// Hobby: 60秒、Pro: 300秒 — Vercel が自動的にプランに応じて制限
export const maxDuration = 60;
// netkeiba.com へのスクレイピングを日本リージョンから実行
export const preferredRegion = 'hnd1';

export async function GET(request: NextRequest) {
  // Vercel Cron からのリクエスト認証
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: '認証エラー: CRON_SECRET未設定' },
      { status: 401 }
    );
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: '認証エラー: 無効なCRON_SECRET' },
      { status: 401 }
    );
  }

  try {
    const handlerStart = Date.now();
    // JST 現在時刻を計算
    const now = new Date();
    const jstOffset = 9 * 60;
    const jstMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + jstOffset;
    const jstHour = Math.floor((jstMinutes % 1440) / 60);

    // 共通変数
    const jstTime = new Date(now.getTime() + jstOffset * 60_000);
    const todayStr = jstTime.toISOString().split('T')[0];
    const baseUrl = request.nextUrl.origin;
    const syncKey = process.env.SYNC_KEY;

    // ============================================================
    // Phase 1: 常に実行 — evaluate + cleanup（非開催日でも実行）
    // ============================================================
    const alwaysExecuted: string[] = [];

    // 1a. 結果確定済みレースの予想照合
    try {
      const evalResults = await evaluateAllPendingRaces();
      if (evalResults.length > 0) {
        const wins = evalResults.filter(r => r.winHit).length;
        alwaysExecuted.push(`照合: ${evalResults.length}件 (単勝${wins}的中)`);
      }
    } catch (e) {
      console.error('[cron] evaluate failed:', e);
    }

    // 1b. 過去の滞留レースをクリーンアップ
    try {
      const elapsed1 = Date.now() - handlerStart;
      const cleanupBudget = Math.max(5_000, 15_000 - elapsed1);
      const { fixed, total } = await cleanupStaleRaces(cleanupBudget);
      if (total > 0) {
        alwaysExecuted.push(`ステータス修復: ${fixed}/${total}件`);
      }
    } catch (e) {
      console.error('[cron] cleanup failed:', e);
    }

    // ============================================================
    // Phase 2: 非開催日チェック（インポート/結果取得のゲートのみ）
    // ============================================================
    const tomorrowStr = new Date(jstTime.getTime() + 86400000).toISOString().split('T')[0];
    const yesterdayStr = new Date(jstTime.getTime() - 86400000).toISOString().split('T')[0];
    // 昨日・今日・明日にレースがあるかチェック（昨日の結果取得を確実に行うため）
    const hasRaces = await dbGet<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM races WHERE date IN (?, ?, ?)',
      [yesterdayStr, todayStr, tomorrowStr],
    );
    const isRacingPeriod = (hasRaces?.cnt ?? 0) > 0;

    if (!isRacingPeriod) {
      return NextResponse.json({
        ok: true,
        timestamp: now.toISOString(),
        executed: alwaysExecuted,
        skipped: ['非開催日: 昨日〜明日にレースなし'],
      });
    }

    // ============================================================
    // Phase 3: 時間帯別処理
    // ============================================================

    // 朝 (08:30-09:30 JST) → bulk_chunked で非同期チェーン
    if (jstHour >= 8 && jstHour <= 9) {
      const executed = [...alwaysExecuted];

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

      // 当日レースのオッズスナップショット収集（時系列データ蓄積）
      try {
        const { collected, total } = await collectOddsSnapshots(todayStr, 15_000);
        if (collected > 0) {
          executed.push(`morning: オッズスナップショット ${collected}/${total}レース`);
        }
      } catch (e) {
        console.error('[cron] morning odds snapshot failed:', e);
      }

      return NextResponse.json({
        ok: true,
        timestamp: now.toISOString(),
        executed,
        skipped: [],
      });
    }

    // 午前〜午後 (10:00-14:00 JST) → チェーン再開 + 予想補完
    if (jstHour >= 10 && jstHour <= 14) {
      const executed = [...alwaysExecuted];

      // 予想未生成レースの補完
      const elapsed = Date.now() - handlerStart;
      const predictionBudget = Math.max(5_000, 50_000 - elapsed);
      try {
        const { generated, total } = await executeMissingPredictions(todayStr, predictionBudget);
        executed.push(total > 0
          ? `midday: 予想補完 ${generated}/${total}件生成`
          : 'midday: 全レース予想済み');
      } catch (e) {
        console.error('[cron] midday predictions failed:', e);
        executed.push(`midday: 予想補完失敗: ${e instanceof Error ? e.message : String(e)}`);
      }

      // bulk_chunked チェーンの再開
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
      executed.push('midday: bulk_chunked 再開トリガー');

      // 当日レースのオッズスナップショット収集（時系列データ蓄積）
      const snapshotBudget = Math.max(5_000, 45_000 - (Date.now() - handlerStart));
      try {
        const { collected, total } = await collectOddsSnapshots(todayStr, snapshotBudget);
        if (collected > 0) {
          executed.push(`midday: オッズスナップショット ${collected}/${total}レース`);
        }
      } catch (e) {
        console.error('[cron] midday odds snapshot failed:', e);
      }

      return NextResponse.json({
        ok: true,
        timestamp: now.toISOString(),
        executed,
        skipped: [],
      });
    }

    // 夕方 (16:00-18:00 JST) → 結果取得（直接呼び出し） + 予想補完
    if (jstHour >= 16 && jstHour <= 18) {
      const executed = [...alwaysExecuted];

      // 1. 当日の結果取得（タイムバジェット35秒）
      try {
        const elapsed = Date.now() - handlerStart;
        const resultBudget = Math.max(10_000, 37_000 - elapsed);
        const { resultCount, totalRaces } = await executeResultFetch(todayStr, resultBudget);
        if (totalRaces > 0) {
          executed.push(`evening: 結果取得 ${resultCount}/${totalRaces}レース確定`);
        } else {
          executed.push('evening: 結果取得対象なし');
        }
      } catch (e) {
        console.error('[cron] evening result fetch failed:', e);
        executed.push(`evening: 結果取得失敗: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 2. 照合（結果取得後に再実行）
      try {
        const evalResults = await evaluateAllPendingRaces();
        if (evalResults.length > 0) {
          const wins = evalResults.filter(r => r.winHit).length;
          executed.push(`evening: 追加照合 ${evalResults.length}件 (単勝${wins}的中)`);
        }
      } catch (e) {
        console.error('[cron] evening evaluate failed:', e);
      }

      // 3. 予想未生成レースの補完（残り時間）
      const elapsedFinal = Date.now() - handlerStart;
      const predBudget = Math.max(3_000, 52_000 - elapsedFinal);
      try {
        const { generated, total } = await executeMissingPredictions(todayStr, predBudget);
        if (generated > 0) {
          executed.push(`evening: 予想補完 ${generated}/${total}件生成`);
        }
      } catch (e) {
        console.error('[cron] evening predictions failed:', e);
      }

      // 4. 翌日・翌々日のオッズ事前取得 + 予想再生成
      try {
        const { fetched, predicted } = await fetchUpcomingOdds(todayStr);
        if (fetched > 0) {
          executed.push(`evening: 前日オッズ ${fetched}件取得, 予想${predicted}件再生成`);
        }
      } catch (e) {
        console.error('[cron] evening upcoming odds failed:', e);
      }

      return NextResponse.json({
        ok: true,
        timestamp: now.toISOString(),
        executed,
        skipped: [],
      });
    }

    // 夜 (21:00-23:00 JST) → 当日結果の安全網 + 翌日レース取得
    if (jstHour >= 21 && jstHour <= 23) {
      const executed = [...alwaysExecuted];

      // 1. 当日の未取得結果を回収（夕方cronが部分完了の場合の安全網）
      // includeToday=true で当日レースも対象
      try {
        const elapsed = Date.now() - handlerStart;
        const resultBudget = Math.max(10_000, 25_000 - elapsed);
        const { resultCount, totalRaces } = await executeResultFetch(todayStr, resultBudget);
        if (totalRaces > 0) {
          executed.push(`night: 結果安全網 ${resultCount}/${totalRaces}レース`);
        }
      } catch (e) {
        console.error('[cron] night result safety-net failed:', e);
      }

      // 2. 照合
      try {
        const evalResults = await evaluateAllPendingRaces();
        if (evalResults.length > 0) {
          const wins = evalResults.filter(r => r.winHit).length;
          executed.push(`night: 照合 ${evalResults.length}件 (単勝${wins}的中)`);
        }
      } catch (e) {
        console.error('[cron] night evaluate failed:', e);
      }

      // 3. 翌日レース取得（runCronJob経由: nightFetchTime=22:00のisNearで実行）
      try {
        const result = await runCronJob();
        executed.push(...result.executed.map(e => `night: ${e}`));
      } catch (e) {
        console.error('[cron] night runCronJob failed:', e);
      }

      // 4. 翌日オッズ事前取得
      try {
        const { fetched, predicted } = await fetchUpcomingOdds(todayStr);
        if (fetched > 0) {
          executed.push(`night: 前日オッズ ${fetched}件取得, 予想${predicted}件再生成`);
        }
      } catch (e) {
        console.error('[cron] night upcoming odds failed:', e);
      }

      return NextResponse.json({
        ok: true,
        timestamp: now.toISOString(),
        executed,
        skipped: [],
      });
    }

    // その他の時間帯 → 従来のスケジューラーロジック
    let result = { executed: [] as string[], skipped: [] as string[] };
    try {
      result = await runCronJob();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[cron] runCronJob failed:', msg);
      result.skipped.push(`runCronJob失敗: ${msg}`);
    }

    return NextResponse.json({
      ok: true,
      timestamp: now.toISOString(),
      executed: [...alwaysExecuted, ...result.executed],
      skipped: result.skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
