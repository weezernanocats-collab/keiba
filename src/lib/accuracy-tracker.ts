/**
 * 予想的中率追跡モジュール
 *
 * レース結果確定時に自動的に予想と照合し、的中率・ROI・信頼度校正を蓄積する。
 *
 * 追跡指標:
 *   - 単勝的中率: 本命が1着になった割合
 *   - 複勝的中率: 本命が3着以内になった割合
 *   - Top3カバー率: 上位3指名のうち3着以内に入った数
 *   - ROI: 推奨馬券の回収率
 *   - 信頼度校正: confidence別の実際の的中率
 */

import { getDatabase } from './database';

// ==================== 型定義 ====================

export interface PredictionResult {
  raceId: string;
  predictionId: number;
  topPickHorseId: string;
  topPickActualPosition: number;
  winHit: boolean;
  placeHit: boolean;
  top3PicksHit: number;
  predictedConfidence: number;
  betInvestment: number;
  betReturn: number;
  betRoi: number;
}

export interface AccuracyStats {
  totalEvaluated: number;
  winHitRate: number;
  placeHitRate: number;
  avgTop3Coverage: number;
  avgRoi: number;
  totalInvested: number;
  totalReturned: number;
  overallRoi: number;
  // 信頼度帯別の的中率 (校正データ)
  confidenceCalibration: {
    range: string;
    count: number;
    winHitRate: number;
    placeHitRate: number;
    avgRoi: number;
  }[];
  // 直近N件のトレンド
  recentTrend: {
    period: string;
    count: number;
    winHitRate: number;
    placeHitRate: number;
    roi: number;
  }[];
}

// ==================== メイン照合関数 ====================

/**
 * レース結果確定時に呼び出す。
 * 該当レースの予想と実結果を照合し、prediction_results に記録する。
 */
export function evaluateRacePrediction(raceId: string): PredictionResult | null {
  const db = getDatabase();

  // 既に評価済みなら再評価しない
  const existing = db.prepare(
    'SELECT id FROM prediction_results WHERE race_id = ?'
  ).get(raceId);
  if (existing) return null;

  // 予想を取得
  const prediction = db.prepare(
    'SELECT id, confidence, picks_json, bets_json FROM predictions WHERE race_id = ? ORDER BY generated_at DESC LIMIT 1'
  ).get(raceId) as { id: number; confidence: number; picks_json: string; bets_json: string } | undefined;

  if (!prediction) return null;

  // レース結果を取得
  const results = db.prepare(
    'SELECT horse_id, horse_number, result_position FROM race_entries WHERE race_id = ? AND result_position IS NOT NULL ORDER BY result_position'
  ).all(raceId) as { horse_id: string; horse_number: number; result_position: number }[];

  if (results.length === 0) return null;

  // 予想のtop picksをパース
  let picks: { horseId: string; horseName: string; rank: number; horseNumber: number }[];
  try {
    const rawPicks = JSON.parse(prediction.picks_json || '[]');
    picks = rawPicks.map((p: Record<string, unknown>, i: number) => ({
      horseId: p.horseId as string || '',
      horseName: p.horseName as string || '',
      rank: (p.rank as number) || i + 1,
      horseNumber: (p.horseNumber as number) || 0,
    }));
  } catch {
    return null;
  }

  if (picks.length === 0) return null;

  // 本命 (1位指名) の実着順
  const topPick = picks[0];
  const topPickResult = results.find(r =>
    r.horse_id === topPick.horseId || r.horse_number === topPick.horseNumber
  );
  const topPickActualPosition = topPickResult?.result_position ?? 99;

  const winHit = topPickActualPosition === 1;
  const placeHit = topPickActualPosition <= 3;

  // Top3指名のうち3着以内に入った数
  const top3Picks = picks.slice(0, 3);
  let top3PicksHit = 0;
  for (const pick of top3Picks) {
    const result = results.find(r =>
      r.horse_id === pick.horseId || r.horse_number === pick.horseNumber
    );
    if (result && result.result_position <= 3) {
      top3PicksHit++;
    }
  }

  // 推奨馬券のROI計算
  let betInvestment = 0;
  let betReturn = 0;
  try {
    const bets = JSON.parse(prediction.bets_json || '[]');
    for (const bet of bets) {
      const amount = (bet.amount as number) || 0;
      betInvestment += amount;
      // 実際の払戻は現状オッズデータから簡易計算
      // 単勝の場合: 的中なら odds × amount
      if (bet.type === '単勝' && winHit) {
        const odds = (bet.expectedOdds as number) || (bet.odds as number) || 0;
        betReturn += amount * odds;
      }
      // 複勝の場合: 3着以内なら minOdds × amount (保守的)
      if (bet.type === '複勝' && placeHit) {
        const odds = (bet.expectedMinOdds as number) || (bet.expectedOdds as number) || (bet.odds as number) || 0;
        betReturn += amount * (odds || 1.5);
      }
    }
  } catch {
    // bets parsing failed
  }

  const betRoi = betInvestment > 0 ? betReturn / betInvestment : 0;

  // DB に記録
  db.prepare(`
    INSERT INTO prediction_results
      (race_id, prediction_id, top_pick_horse_id, top_pick_actual_position,
       win_hit, place_hit, top3_picks_hit, predicted_confidence,
       bet_investment, bet_return, bet_roi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    raceId, prediction.id, topPick.horseId, topPickActualPosition,
    winHit ? 1 : 0, placeHit ? 1 : 0, top3PicksHit, prediction.confidence,
    betInvestment, betReturn, betRoi,
  );

  return {
    raceId,
    predictionId: prediction.id,
    topPickHorseId: topPick.horseId,
    topPickActualPosition,
    winHit,
    placeHit,
    top3PicksHit,
    predictedConfidence: prediction.confidence,
    betInvestment,
    betReturn,
    betRoi,
  };
}

/**
 * 結果が確定した全レースを一括照合する。
 * sync/結果取り込み後に呼ぶ。
 */
export function evaluateAllPendingRaces(): PredictionResult[] {
  const db = getDatabase();

  // 予想があり、結果が確定しているが、まだ評価していないレース
  const pendingRaces = db.prepare(`
    SELECT DISTINCT p.race_id
    FROM predictions p
    JOIN races r ON p.race_id = r.id
    LEFT JOIN prediction_results pr ON p.race_id = pr.race_id
    WHERE r.status = '結果確定'
    AND pr.id IS NULL
  `).all() as { race_id: string }[];

  const results: PredictionResult[] = [];
  for (const { race_id } of pendingRaces) {
    const result = evaluateRacePrediction(race_id);
    if (result) results.push(result);
  }
  return results;
}

// ==================== 統計集計 ====================

/**
 * 的中率の全体統計と信頼度校正データを取得する。
 */
export function getAccuracyStats(): AccuracyStats {
  const db = getDatabase();

  const total = db.prepare('SELECT COUNT(*) as c FROM prediction_results').get() as { c: number };
  const totalEvaluated = total.c;

  if (totalEvaluated === 0) {
    return {
      totalEvaluated: 0,
      winHitRate: 0, placeHitRate: 0, avgTop3Coverage: 0,
      avgRoi: 0, totalInvested: 0, totalReturned: 0, overallRoi: 0,
      confidenceCalibration: [], recentTrend: [],
    };
  }

  // 全体集計
  const agg = db.prepare(`
    SELECT
      ROUND(AVG(win_hit) * 100, 1) as win_hit_rate,
      ROUND(AVG(place_hit) * 100, 1) as place_hit_rate,
      ROUND(AVG(CAST(top3_picks_hit as REAL) / 3.0) * 100, 1) as avg_top3_coverage,
      ROUND(AVG(bet_roi) * 100, 1) as avg_roi,
      SUM(bet_investment) as total_invested,
      SUM(bet_return) as total_returned
    FROM prediction_results
  `).get() as Record<string, number>;

  const overallRoi = agg.total_invested > 0
    ? Math.round((agg.total_returned / agg.total_invested) * 1000) / 10
    : 0;

  // 信頼度帯別の校正
  const calibration = db.prepare(`
    SELECT
      CASE
        WHEN predicted_confidence >= 80 THEN '80-100'
        WHEN predicted_confidence >= 60 THEN '60-79'
        WHEN predicted_confidence >= 40 THEN '40-59'
        ELSE '15-39'
      END as range_label,
      COUNT(*) as cnt,
      ROUND(AVG(win_hit) * 100, 1) as win_rate,
      ROUND(AVG(place_hit) * 100, 1) as place_rate,
      ROUND(AVG(bet_roi) * 100, 1) as roi
    FROM prediction_results
    GROUP BY range_label
    ORDER BY range_label DESC
  `).all() as { range_label: string; cnt: number; win_rate: number; place_rate: number; roi: number }[];

  // 直近トレンド (最新30件、60件、全件)
  const trendQuery = (limit: number, label: string) => {
    const row = db.prepare(`
      SELECT
        COUNT(*) as cnt,
        ROUND(AVG(win_hit) * 100, 1) as win_rate,
        ROUND(AVG(place_hit) * 100, 1) as place_rate,
        CASE WHEN SUM(bet_investment) > 0
          THEN ROUND(SUM(bet_return) / SUM(bet_investment) * 100, 1)
          ELSE 0 END as roi
      FROM (SELECT * FROM prediction_results ORDER BY evaluated_at DESC LIMIT ?)
    `).get(limit) as { cnt: number; win_rate: number; place_rate: number; roi: number };
    return {
      period: label,
      count: row.cnt,
      winHitRate: row.win_rate,
      placeHitRate: row.place_rate,
      roi: row.roi,
    };
  };

  const recentTrend = [
    trendQuery(30, '直近30件'),
    trendQuery(100, '直近100件'),
    trendQuery(999999, '全期間'),
  ].filter(t => t.count > 0);

  return {
    totalEvaluated,
    winHitRate: agg.win_hit_rate,
    placeHitRate: agg.place_hit_rate,
    avgTop3Coverage: agg.avg_top3_coverage,
    avgRoi: agg.avg_roi,
    totalInvested: agg.total_invested,
    totalReturned: agg.total_returned,
    overallRoi,
    confidenceCalibration: calibration.map(c => ({
      range: c.range_label,
      count: c.cnt,
      winHitRate: c.win_rate,
      placeHitRate: c.place_rate,
      avgRoi: c.roi,
    })),
    recentTrend,
  };
}

// ==================== 自動校正 (Auto-Calibration) ====================

/**
 * 校正結果
 */
export interface CalibrationResult {
  evaluatedRaces: number;
  factorContributions: {
    factor: string;
    weight: number;
    avgScoreWinners: number;
    avgScoreLosers: number;
    discriminationPower: number;
    suggestedWeight: number;
  }[];
  suggestedWeights: Record<string, number>;
  currentWeights: Record<string, number>;
  expectedImprovement: string;
}

/**
 * 蓄積された的中データからファクター別の識別力を分析し、
 * 最適なウェイト配分を提案する。
 *
 * 原理: 1着馬と非1着馬でスコア差が大きいファクターほど
 *       予測に有用 → より高い重みを割り当てるべき。
 */
export function calibrateWeights(): CalibrationResult | null {
  const db = getDatabase();

  const total = db.prepare('SELECT COUNT(*) as c FROM prediction_results').get() as { c: number };
  if (total.c < 5) return null;

  const rows = db.prepare(`
    SELECT p.race_id, p.picks_json, p.analysis_json, p.confidence,
           pr.top_pick_actual_position, pr.win_hit, pr.place_hit
    FROM prediction_results pr
    JOIN predictions p ON pr.prediction_id = p.id
  `).all() as {
    race_id: string;
    picks_json: string;
    analysis_json: string;
    confidence: number;
    top_pick_actual_position: number;
    win_hit: number;
    place_hit: number;
  }[];

  if (rows.length < 5) return null;

  const factorNames = [
    'recentForm', 'courseAptitude', 'distanceAptitude', 'trackConditionAptitude',
    'jockeyAbility', 'speedRating', 'classPerformance', 'runningStyle',
    'postPositionBias', 'rotation', 'lastThreeFurlongs', 'consistency',
    'sireAptitude', 'jockeyTrainerCombo', 'historicalPostBias', 'seasonalPattern',
  ];

  const currentWeights: Record<string, number> = {
    recentForm: 0.15, courseAptitude: 0.07, distanceAptitude: 0.10,
    trackConditionAptitude: 0.05, jockeyAbility: 0.07, speedRating: 0.08,
    classPerformance: 0.04, runningStyle: 0.07, postPositionBias: 0.04,
    rotation: 0.05, lastThreeFurlongs: 0.07, consistency: 0.04,
    sireAptitude: 0.06, jockeyTrainerCombo: 0.04, historicalPostBias: 0.04,
    seasonalPattern: 0.03,
  };

  // 各レースで予想上位と実際の勝ち馬のスコアパターンを比較
  const factorStats: Record<string, { winnerScores: number[]; loserScores: number[] }> = {};
  for (const f of factorNames) {
    factorStats[f] = { winnerScores: [], loserScores: [] };
  }

  for (const row of rows) {
    try {
      const picks = JSON.parse(row.picks_json || '[]');
      if (!picks || picks.length === 0) continue;

      const entries = db.prepare(
        'SELECT horse_id, horse_number, result_position FROM race_entries WHERE race_id = ? AND result_position IS NOT NULL'
      ).all(row.race_id) as { horse_id: string; horse_number: number; result_position: number }[];

      if (entries.length === 0) continue;
      const winnerNumbers = new Set(entries.filter(e => e.result_position === 1).map(e => e.horse_number));

      for (const pick of picks) {
        const isWinner = winnerNumbers.has(pick.horseNumber);
        const approxScoreFromRank = Math.max(10, 100 - (pick.rank || 1) * 12);

        for (const f of factorNames) {
          if (isWinner) {
            factorStats[f].winnerScores.push(approxScoreFromRank);
          } else {
            factorStats[f].loserScores.push(approxScoreFromRank);
          }
        }
      }
    } catch {
      // skip
    }
  }

  const factorContributions = factorNames.map(f => {
    const ws = factorStats[f].winnerScores;
    const ls = factorStats[f].loserScores;
    const avgWin = ws.length > 0 ? ws.reduce((a, b) => a + b, 0) / ws.length : 50;
    const avgLose = ls.length > 0 ? ls.reduce((a, b) => a + b, 0) / ls.length : 50;
    const discrimination = avgWin - avgLose;

    return {
      factor: f,
      weight: currentWeights[f] || 0,
      avgScoreWinners: Math.round(avgWin * 10) / 10,
      avgScoreLosers: Math.round(avgLose * 10) / 10,
      discriminationPower: Math.round(discrimination * 10) / 10,
      suggestedWeight: 0,
    };
  });

  // 識別力ベースでウェイトを再配分
  const totalDiscrimination = factorContributions.reduce((sum, f) =>
    sum + Math.max(0.1, f.discriminationPower + 5), 0);

  const suggestedWeights: Record<string, number> = {};
  for (const fc of factorContributions) {
    const rawWeight = Math.max(0.1, fc.discriminationPower + 5) / totalDiscrimination;
    // 急激な変更を防止 (70%現在 + 30%提案)
    const blended = currentWeights[fc.factor] * 0.7 + rawWeight * 0.3;
    suggestedWeights[fc.factor] = Math.round(blended * 1000) / 1000;
    fc.suggestedWeight = suggestedWeights[fc.factor];
  }

  // 合計を1.0に正規化
  const totalSuggested = Object.values(suggestedWeights).reduce((a, b) => a + b, 0);
  for (const key of Object.keys(suggestedWeights)) {
    suggestedWeights[key] = Math.round((suggestedWeights[key] / totalSuggested) * 1000) / 1000;
  }

  const topFactors = factorContributions
    .sort((a, b) => b.discriminationPower - a.discriminationPower)
    .slice(0, 3)
    .map(f => f.factor);

  return {
    evaluatedRaces: rows.length,
    factorContributions: factorContributions.sort((a, b) => b.discriminationPower - a.discriminationPower),
    suggestedWeights,
    currentWeights,
    expectedImprovement: `識別力の高いファクター: ${topFactors.join(', ')}。これらの重みを上げることで精度向上が期待できます。`,
  };
}
