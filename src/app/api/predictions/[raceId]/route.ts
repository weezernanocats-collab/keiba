import { NextRequest, NextResponse } from 'next/server';
import { getPredictionByRaceId, getRaceById, savePrediction } from '@/lib/queries';
import { dbRun, dbAll, dbGet } from '@/lib/database';
import { buildAndPredict } from '@/lib/prediction-builder';
import { isBetHit } from '@/lib/bet-utils';
import { getCacheHeaders } from '@/lib/api-helpers';


export const maxDuration = 60;

/** 予想が壊れているか判定（horseId が全て欠落している場合） */
function isBrokenPrediction(topPicks: { horseId?: string; horseName?: string }[]): boolean {
  if (!topPicks || topPicks.length === 0) return true;
  return topPicks.every(pick => !pick.horseId && (!pick.horseName || pick.horseName.endsWith('番')));
}

/**
 * 馬場バイアス鮮度チェック: 予想生成後に同場の結果確定レースが増えたか判定
 *
 * 条件を全て満たす場合のみ再生成:
 *   1. 当日レースである
 *   2. 発走前（status = '出走確定'）
 *   3. 同場・同日の結果確定レースが3つ以上（バイアス算出可能）
 *   4. 予想生成時より結果確定レースが増えている（analysis.biasRaceCount と比較）
 */
async function shouldRegenerateForBias(
  race: { date: string; status: string; racecourseName: string },
  biasRaceCountAtGeneration: number,
): Promise<boolean> {
  // 当日レース & 発走前のみ
  const jstNow = new Date(Date.now() + 9 * 60 * 60_000);
  const todayStr = jstNow.toISOString().split('T')[0];
  if (race.date !== todayStr || race.status !== '出走確定') return false;

  // 同場・同日の結果確定レース数（軽量COUNT 1本）
  const result = await dbGet<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM races
     WHERE date = ? AND racecourse_name = ? AND status = '結果確定'`,
    [race.date, race.racecourseName],
  );
  const completedNow = result?.cnt ?? 0;

  // バイアス算出に3R必要 & 生成時より増えている
  return completedNow >= 3 && completedNow > biasRaceCountAtGeneration;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ raceId: string }> }
) {
  try {
    const apiStart = Date.now();
    const { raceId } = await params;

    const race = await getRaceById(raceId);
    if (!race) {
      return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 });
    }

    let prediction = await getPredictionByRaceId(raceId);

    // タイムガード: 残り時間が少なければ重い処理をスキップ（maxDuration=60s）
    const hasTimeForRegen = () => (Date.now() - apiStart) < 40_000; // 40秒以内

    // buildAndPredictを50秒タイムアウト付きで実行するヘルパー
    const buildWithTimeout = async (...args: Parameters<typeof buildAndPredict>) => {
      const timeoutMs = Math.max(5_000, 50_000 - (Date.now() - apiStart));
      const result = await Promise.race([
        buildAndPredict(...args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('予想生成タイムアウト')), timeoutMs)
        ),
      ]);
      return result;
    };

    let generationTimedOut = false;

    // 壊れた予想を検出して再生成
    if (prediction && isBrokenPrediction(prediction.topPicks) && race.entries.length > 0 && hasTimeForRegen()) {
      try {
        // 既存の壊れた予想を削除
        await dbRun('DELETE FROM predictions WHERE race_id = ?', [raceId]);

        // 再生成（タイムアウト付き）
        const newPrediction = await buildWithTimeout(
          raceId, race.name, race.date,
          race.trackType as '芝' | 'ダート' | '障害', race.distance,
          race.trackCondition as '良' | '稍重' | '重' | '不良' | undefined,
          race.racecourseName, race.grade, race.entries,
        );
        await savePrediction(newPrediction);
        prediction = newPrediction;
      } catch (regenError) {
        console.error('予想再生成失敗:', regenError);
        if (regenError instanceof Error && regenError.message.includes('タイムアウト')) {
          generationTimedOut = true;
        }
      }
    }

    // 予想が未生成の場合、オンデマンドで自動生成
    if (!prediction && race.entries.length >= 2 && hasTimeForRegen()) {
      try {
        const newPrediction = await buildWithTimeout(
          raceId, race.name, race.date,
          race.trackType as '芝' | 'ダート' | '障害', race.distance,
          race.trackCondition as '良' | '稍重' | '重' | '不良' | undefined,
          race.racecourseName, race.grade, race.entries,
          race.weather as string | undefined,
          { includeTrainerStats: true },
        );
        await savePrediction(newPrediction);
        prediction = newPrediction;
      } catch (genError) {
        console.error('オンデマンド予想生成失敗:', genError);
        if (genError instanceof Error && genError.message.includes('タイムアウト')) {
          generationTimedOut = true;
        }
      }
    }

    // オッズ未反映チェック: オッズなしで生成された予想を、オッズ取得後に再生成
    let regeneratedWithOdds = false;
    if (prediction && race.status === '出走確定' && race.entries.length >= 2 && hasTimeForRegen()) {
      const hasOddsInPrediction = prediction.analysis?.overround != null && prediction.analysis.overround > 0;
      if (!hasOddsInPrediction) {
        // DBにオッズが存在するか確認
        const oddsCount = await dbGet<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM race_entries WHERE race_id = ? AND odds > 0`,
          [raceId],
        );
        if (oddsCount && oddsCount.cnt >= 3) {
          // オッズがDBにあるのに予想に反映されていない → 再生成
          try {
            await dbRun('DELETE FROM predictions WHERE race_id = ?', [raceId]);
            const newPrediction = await buildWithTimeout(
              raceId, race.name, race.date,
              race.trackType as '芝' | 'ダート' | '障害', race.distance,
              race.trackCondition as '良' | '稍重' | '重' | '不良' | undefined,
              race.racecourseName, race.grade, race.entries,
              race.weather as string | undefined,
              { includeTrainerStats: true },
            );
            await savePrediction(newPrediction);
            prediction = newPrediction;
            regeneratedWithOdds = true;
          } catch (oddsRegenError) {
            console.error('オッズ反映再生成失敗:', oddsRegenError);
          }
        }
      }
    }

    // 馬場バイアス鮮度チェック: 当日レースで新しいバイアスデータがあれば通知
    // 初回表示はブロックせず、biasUpdateAvailableフラグで通知→ユーザーが「更新する」を押したら再リクエスト
    let regeneratedWithBias = false;
    let biasUpdateAvailable = false;
    const forceUpdate = _request.nextUrl.searchParams.get('biasUpdate') === '1';
    if (prediction && race.entries.length >= 2) {
      try {
        const biasCountAtGen = prediction.analysis?.biasRaceCount ?? 0;
        const needsRegen = await shouldRegenerateForBias(race, biasCountAtGen);
        if (needsRegen) {
          if (forceUpdate && hasTimeForRegen()) {
            // ユーザーが明示的に「更新する」を押した場合のみ再生成
            const newPrediction = await buildWithTimeout(
              raceId, race.name, race.date,
              race.trackType as '芝' | 'ダート' | '障害', race.distance,
              race.trackCondition as '良' | '稍重' | '重' | '不良' | undefined,
              race.racecourseName, race.grade, race.entries,
              race.weather as string | undefined,
              { includeTrainerStats: true },
            );
            await savePrediction(newPrediction);
            prediction = newPrediction;
            regeneratedWithBias = true;
          } else {
            // 初回アクセス: 既存予想を即返し、バイアス更新可能フラグで通知
            biasUpdateAvailable = true;
          }
        }
      } catch (biasError) {
        console.error('馬場バイアス再生成失敗:', biasError);
      }
    }

    if (!prediction) {
      const msg = generationTimedOut
        ? '予想生成がタイムアウトしました。再読み込みで再試行できます。'
        : '予想がまだ生成されていません';
      return NextResponse.json({ error: msg, generationTimedOut }, { status: 404 });
    }

    // topPicks に horseName/horseNumber がない場合、race.entries から補完
    const entriesMap = new Map(
      race.entries.map(e => [e.horseNumber, e])
    );

    const augmentedPicks = prediction.topPicks.map(pick => {
      if (pick.horseName && pick.horseNumber && !pick.horseName.endsWith('番')) return pick;
      const entry = entriesMap.get(pick.horseNumber);
      return {
        ...pick,
        horseName: (pick.horseName && !pick.horseName.endsWith('番')) ? pick.horseName : (entry?.horseName || `${pick.horseNumber}番`),
        horseNumber: pick.horseNumber || 0,
      };
    });

    // 推奨馬券のオッズをDBの最新値で補完（予想生成時にオッズ未取得の場合）
    const liveOddsRows = await dbAll<{
      bet_type: string; horse_number1: number;
      odds: number; min_odds: number | null;
    }>(
      `SELECT bet_type, horse_number1, odds, min_odds
       FROM odds WHERE race_id = ? AND bet_type IN ('単勝', '複勝')`,
      [raceId],
    );
    const liveOddsMap = new Map<string, number>();
    for (const o of liveOddsRows) {
      liveOddsMap.set(`${o.bet_type}-${o.horse_number1}`, o.odds);
    }
    // race_entries のオッズも取得（単勝オッズのフォールバック）
    const entryOddsMap = new Map<number, number>();
    for (const entry of race.entries) {
      if (entry.odds && entry.odds > 0) {
        entryOddsMap.set(entry.horseNumber, entry.odds);
      }
    }

    // モデル勝率を取得（EV再計算用）
    const winProbs: Record<number, number> = prediction.analysis?.winProbabilities || {};

    const augmentedBets = prediction.recommendedBets.map((bet) => {
      const sel0 = bet.selections?.[0];
      if (!sel0) return bet;

      // オッズ補完: DB最新値を使用（前売りオッズ含む）
      let odds = (bet.odds && bet.odds > 0) ? bet.odds : 0;
      if (odds <= 0) {
        if (bet.type === '単勝') {
          odds = liveOddsMap.get(`単勝-${sel0}`) || entryOddsMap.get(sel0) || 0;
        } else if (bet.type === '複勝') {
          odds = liveOddsMap.get(`複勝-${sel0}`) || 0;
        } else {
          odds = entryOddsMap.get(sel0) || liveOddsMap.get(`単勝-${sel0}`) || 0;
        }
      }

      // EV再計算: モデル推定勝率 × オッズ
      let expectedValue = bet.expectedValue;
      if (odds > 0 && sel0) {
        const prob = winProbs[sel0] || 0;
        if (prob > 0) {
          if (bet.type === '単勝') {
            expectedValue = Math.round(prob * odds * 100) / 100;
          } else if (bet.type === '複勝') {
            // 複勝確率 ≈ 勝率 × 3（簡易近似）
            const placeProb = Math.min(prob * 3, 0.95);
            expectedValue = Math.round(placeProb * odds * 100) / 100;
          } else {
            // 馬連・ワイド等: 組み合わせの推定確率 × オッズ
            const sel1 = bet.selections?.[1];
            const prob2 = sel1 ? (winProbs[sel1] || 0) : 0;
            const comboProb = prob + prob2 > 0 ? prob * prob2 * (bet.type === 'ワイド' ? 30 : 15) : 0;
            expectedValue = odds > 0 && comboProb > 0
              ? Math.round(Math.min(comboProb, 0.5) * odds * 100) / 100
              : bet.expectedValue;
          }
        }
      }

      return { ...bet, odds: odds > 0 ? odds : bet.odds, expectedValue };
    });

    // analysis_jsonからAI独自推奨・AI単独ランキングを復元
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const analysisAny = prediction.analysis as any;
    const aiIndependentBets = analysisAny?.aiIndependentBets || undefined;
    const aiOnlyRanking = analysisAny?.aiOnlyRanking || undefined;
    const aiRankingBets = analysisAny?.aiRankingBets || undefined;

    const augmentedPrediction = {
      ...prediction,
      topPicks: augmentedPicks,
      recommendedBets: augmentedBets,
      ...(aiIndependentBets ? { aiIndependentBets } : {}),
      ...(aiOnlyRanking ? { aiOnlyRanking } : {}),
      ...(aiRankingBets ? { aiRankingBets } : {}),
    };

    // 結果確定済みの場合は答え合わせデータを追加
    let verification = null;
    if (race.status === '結果確定') {
      try {
        const predResult = await dbAll<{
          win_hit: number;
          place_hit: number;
          top3_picks_hit: number;
          bet_roi: number;
        }>(
          'SELECT win_hit, place_hit, top3_picks_hit, bet_roi FROM prediction_results WHERE race_id = ?',
          [raceId],
        );

        // 出走馬の着順マップ
        const entryResults = new Map<number, number>();
        for (const entry of race.entries) {
          if (entry.result?.position) {
            entryResults.set(entry.horseNumber, entry.result.position);
          }
        }

        // 予想vs結果の対比
        const pickResults = augmentedPicks.map(pick => ({
          ...pick,
          actualPosition: entryResults.get(pick.horseNumber) ?? null,
          hit: entryResults.get(pick.horseNumber) === 1,
          placeHit: (entryResults.get(pick.horseNumber) ?? 99) <= 3,
        }));

        // 推奨馬券の的中判定
        const entryNameMap = new Map<number, string>();
        for (const entry of race.entries) {
          entryNameMap.set(entry.horseNumber, entry.horseName);
        }
        const actualTop3Detailed = [...entryResults.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, 3)
          .map(([num]) => ({ horseNumber: num, horseName: entryNameMap.get(num) || '' }));
        const actualTop3 = actualTop3Detailed.map(h => h.horseNumber);
        const actualWinner = actualTop3[0];

        // 実オッズ取得（liveOddsRowsを再利用、重複クエリ排除）
        const oddsMap = new Map<string, { odds: number; minOdds: number | null }>();
        for (const o of liveOddsRows) {
          oddsMap.set(`${o.bet_type}-${o.horse_number1}`, { odds: o.odds, minOdds: o.min_odds });
        }

        const betResults = augmentedPrediction.recommendedBets.map((bet: { type: string; selections: number[]; odds?: number }) => {
          const sels = bet.selections || [];
          const isHit = isBetHit(bet.type, sels, actualTop3);

          // 実オッズ検索
          let realOddsValue: number | null = null;
          let isEstimated = true;
          if (bet.type === '単勝' || bet.type === '複勝') {
            const found = oddsMap.get(`${bet.type}-${sels[0]}`);
            if (found) {
              realOddsValue = bet.type === '複勝' ? (found.minOdds ?? found.odds) : found.odds;
              isEstimated = false;
            }
          }
          const odds = realOddsValue ?? (bet.odds && bet.odds > 0 ? bet.odds : null);
          const investment = 100;
          const payout = isHit && odds != null ? Math.round(investment * odds) : (isHit ? investment : 0);
          const profit = payout - investment;

          return { ...bet, hit: isHit, odds: odds ?? 0, isEstimated, investment, payout, profit };
        });

        // 推奨馬券全体の収支
        const totalInvestment = betResults.reduce((s: number, b: { investment: number }) => s + b.investment, 0);
        const totalPayout = betResults.reduce((s: number, b: { payout: number }) => s + b.payout, 0);
        const totalProfit = totalPayout - totalInvestment;

        verification = {
          winHit: predResult[0]?.win_hit === 1,
          placeHit: predResult[0]?.place_hit === 1,
          top3InTop6: predResult[0]?.top3_picks_hit ?? 0,
          roi: Math.round((predResult[0]?.bet_roi ?? 0) * 100),
          pickResults,
          betResults,
          betSummary: { totalInvestment, totalPayout, totalProfit },
          actualTop3,
          actualTop3Detailed,
        };
      } catch (verErr) {
        console.error('答え合わせデータ取得エラー:', verErr);
      }
    }

    // 結果確定済みレースはデータ不変 → 長めにキャッシュ
    const cachePreset = race.status === '結果確定' ? 'stats' : 'prediction';
    return NextResponse.json({
      prediction: augmentedPrediction,
      race,
      verification,
      ...(regeneratedWithBias ? { regeneratedWithBias: true } : {}),
      ...(regeneratedWithOdds ? { regeneratedWithOdds: true } : {}),
      ...(biasUpdateAvailable ? { biasUpdateAvailable: true } : {}),
    }, { headers: getCacheHeaders(cachePreset) });
  } catch (error) {
    console.error('予想API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
