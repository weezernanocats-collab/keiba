import { NextRequest, NextResponse } from 'next/server';
import { getPredictionByRaceId, getRaceById, getHorseById, getHorsePastPerformances, getJockeyStats, savePrediction } from '@/lib/queries';
import { dbRun, dbAll } from '@/lib/database';
import { generatePrediction } from '@/lib/prediction-engine';
import { isBetHit } from '@/lib/bet-utils';
import { seedAllData } from '@/lib/seed-data';
import type { RaceEntry } from '@/types';

/** 予想が壊れているか判定（horseId が全て欠落している場合） */
function isBrokenPrediction(topPicks: { horseId?: string; horseName?: string }[]): boolean {
  if (!topPicks || topPicks.length === 0) return true;
  return topPicks.every(pick => !pick.horseId && (!pick.horseName || pick.horseName.endsWith('番')));
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ raceId: string }> }
) {
  try {
    await seedAllData();
    const { raceId } = await params;

    const race = await getRaceById(raceId);
    if (!race) {
      return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 });
    }

    let prediction = await getPredictionByRaceId(raceId);

    // 壊れた予想を検出して再生成
    if (prediction && isBrokenPrediction(prediction.topPicks) && race.entries.length > 0) {
      try {
        // 既存の壊れた予想を削除
        await dbRun('DELETE FROM predictions WHERE race_id = ?', [raceId]);

        // 再生成
        const horseInputs = await Promise.all(
          race.entries.map(async (re: RaceEntry) => {
            const pastPerfs = await getHorsePastPerformances(re.horseId, race.date, 100);
            const horseData = await getHorseById(re.horseId) as { father_name?: string } | null;
            const jockeyStats = await getJockeyStats(re.jockeyId, race.date);
            return {
              entry: re,
              pastPerformances: pastPerfs,
              jockeyWinRate: jockeyStats.winRate,
              jockeyPlaceRate: jockeyStats.placeRate,
              fatherName: horseData?.father_name || '',
            };
          })
        );

        const newPrediction = await generatePrediction(
          raceId, race.name, race.date,
          race.trackType as '芝' | 'ダート' | '障害',
          race.distance,
          race.trackCondition as '良' | '稍重' | '重' | '不良' | undefined,
          race.racecourseName,
          race.grade,
          horseInputs,
        );
        await savePrediction(newPrediction);
        prediction = newPrediction;
      } catch (regenError) {
        console.error('予想再生成失敗:', regenError);
        // 再生成に失敗した場合はフォールバック
      }
    }

    if (!prediction) {
      return NextResponse.json({ error: '予想がまだ生成されていません' }, { status: 404 });
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

    const augmentedPrediction = {
      ...prediction,
      topPicks: augmentedPicks,
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

        // 実オッズ取得（単勝・複勝のみ）
        const oddsRows = await dbAll<{
          bet_type: string; horse_number1: number;
          odds: number; min_odds: number | null;
        }>(
          `SELECT bet_type, horse_number1, odds, min_odds
           FROM odds WHERE race_id = ? AND bet_type IN ('単勝', '複勝')`,
          [raceId],
        );
        const oddsMap = new Map<string, { odds: number; minOdds: number | null }>();
        for (const o of oddsRows) {
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

    return NextResponse.json({ prediction: augmentedPrediction, race, verification });
  } catch (error) {
    console.error('予想API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
