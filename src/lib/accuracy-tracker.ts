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

import { dbAll, dbGet, dbRun } from './database';
import { isBetHit } from './bet-utils';
import { applyCalibrationWeights } from './prediction-engine';
import { saveCalibrationWeights, getActiveCalibrationWeights, saveCategoryCalibration, getActiveCategoryCalibrations } from './queries';
import { categorizeRace, applyCalibratedCategoryMultipliers, type RaceCategory } from './weight-profiles';

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
  brierScore: number | null;
  logLoss: number | null;
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
  // Proper Scoring Rules (Phase 0)
  scoringRules: {
    brierScore: number | null;        // 低いほど良い (0=完璧, 1=最悪)
    brierSkillScore: number | null;   // 対均等確率BSS (正値=モデルに価値あり)
    marketBSS: number | null;         // 対市場BSS (正値=市場を上回っている)
    logLoss: number | null;           // 対数損失 (低いほど良い)
    ece: number | null;               // Expected Calibration Error (低いほど良い)
    calibrationBins: CalibrationBin[] | null; // 10ビンのキャリブレーションデータ
    evaluatedWithProbs: number;       // 確率データ付きで評価されたレース数
  };
}

export interface CalibrationBin {
  binRange: string;       // 例: "10-20%"
  count: number;          // ビン内のサンプル数
  avgPredicted: number;   // 平均予測確率
  avgActual: number;      // 実際の勝率
  gap: number;            // |avgPredicted - avgActual|
}

// ==================== メイン照合関数 ====================

/**
 * レース結果確定時に呼び出す。
 * 該当レースの予想と実結果を照合し、prediction_results に記録する。
 */
export async function evaluateRacePrediction(raceId: string): Promise<PredictionResult | null> {
  // 既に評価済みなら再評価しない
  const existing = await dbGet<{ id: number }>(
    'SELECT id FROM prediction_results WHERE race_id = ?',
    [raceId]
  );
  if (existing) return null;

  // 予想を取得（analysis_json も取得 → winProbabilities を抽出）
  const prediction = await dbGet<{ id: number; confidence: number; picks_json: string; bets_json: string; analysis_json: string }>(
    'SELECT id, confidence, picks_json, bets_json, analysis_json FROM predictions WHERE race_id = ? ORDER BY generated_at DESC LIMIT 1',
    [raceId]
  );

  if (!prediction) return null;

  // レース結果を取得（オッズ含む）
  const results = await dbAll<{ horse_id: string; horse_number: number; result_position: number; odds: number | null }>(
    'SELECT horse_id, horse_number, result_position, odds FROM race_entries WHERE race_id = ? AND result_position IS NOT NULL ORDER BY result_position',
    [raceId]
  );

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

  // ROI計算: 本命馬に単勝100円を仮定し、実オッズで計算
  const BET_AMOUNT = 100;
  const betInvestment = BET_AMOUNT;
  let betReturn = 0;
  if (winHit) {
    let topPickOdds = topPickResult?.odds ?? 0;
    // race_entries.odds が null の場合、odds テーブルからフォールバック取得
    if (topPickOdds === 0 && topPickResult) {
      const oddsRow = await dbGet<{ odds: number }>(
        "SELECT odds FROM odds WHERE race_id = ? AND bet_type = '単勝' AND horse_number1 = ?",
        [raceId, topPickResult.horse_number]
      );
      if (oddsRow) topPickOdds = oddsRow.odds;
    }
    betReturn = BET_AMOUNT * topPickOdds;
  }
  const betRoi = betReturn / betInvestment;

  // Brier Score & Log Loss 算出（analysis_json に winProbabilities があれば）
  const { brierScore, logLoss } = computeScoringRules(prediction.analysis_json, results);

  // 馬券的中タイプ算出（単勝・複勝以外の券種で的中したもの）
  const top3Numbers = results.slice(0, 3).map(r => r.horse_number);
  let betsForHitCheck: { type: string; selections: number[] }[] = [];
  try {
    betsForHitCheck = JSON.parse(prediction.bets_json || '[]');
  } catch { /* skip */ }
  const betHitTypes = betsForHitCheck
    .filter(bet => !['単勝', '複勝'].includes(bet.type) && isBetHit(bet.type, bet.selections, top3Numbers))
    .map(bet => bet.type);
  const betHitTypesStr = betHitTypes.length > 0 ? betHitTypes.join(',') : '';

  // DB に記録
  await dbRun(`
    INSERT INTO prediction_results
      (race_id, prediction_id, top_pick_horse_id, top_pick_actual_position,
       win_hit, place_hit, top3_picks_hit, predicted_confidence,
       bet_investment, bet_return, bet_roi, brier_score, log_loss, bet_hit_types)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    raceId, prediction.id, topPick.horseId, topPickActualPosition,
    winHit ? 1 : 0, placeHit ? 1 : 0, top3PicksHit, prediction.confidence,
    betInvestment, betReturn, betRoi, brierScore, logLoss, betHitTypesStr,
  ]);

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
    brierScore,
    logLoss,
  };
}

// ==================== Proper Scoring Rules ====================

/**
 * analysis_json から winProbabilities を抽出し、
 * 各馬の予測確率 vs 実結果(1/0) から Brier Score と Log Loss を算出する。
 *
 * Brier Score = (1/N) × Σ(p_i - y_i)²  (低いほど良い、0=完璧)
 * Log Loss = -(1/N) × Σ[y_i×log(p_i) + (1-y_i)×log(1-p_i)]  (低いほど良い)
 */
function computeScoringRules(
  analysisJson: string | null,
  results: { horse_number: number; result_position: number }[],
): { brierScore: number | null; logLoss: number | null } {
  if (!analysisJson) return { brierScore: null, logLoss: null };

  let winProbabilities: Record<string, number> | null = null;
  try {
    const analysis = JSON.parse(analysisJson);
    winProbabilities = analysis.winProbabilities || null;
  } catch {
    return { brierScore: null, logLoss: null };
  }

  if (!winProbabilities || Object.keys(winProbabilities).length === 0) {
    return { brierScore: null, logLoss: null };
  }

  const EPS = 1e-15; // log(0) 防止用
  let brierSum = 0;
  let logLossSum = 0;
  let count = 0;

  for (const result of results) {
    const prob = winProbabilities[String(result.horse_number)];
    if (prob === undefined) continue;

    const actual = result.result_position === 1 ? 1 : 0;
    const clampedProb = Math.max(EPS, Math.min(1 - EPS, prob));

    // Brier Score: (p - y)²
    brierSum += (clampedProb - actual) ** 2;

    // Log Loss: -[y×log(p) + (1-y)×log(1-p)]
    logLossSum += -(actual * Math.log(clampedProb) + (1 - actual) * Math.log(1 - clampedProb));

    count++;
  }

  if (count === 0) return { brierScore: null, logLoss: null };

  return {
    brierScore: Math.round((brierSum / count) * 100000) / 100000,
    logLoss: Math.round((logLossSum / count) * 100000) / 100000,
  };
}

/**
 * 結果が確定した全レースを一括照合する。
 * sync/結果取り込み後に呼ぶ。
 */
export async function evaluateAllPendingRaces(): Promise<PredictionResult[]> {
  // 予想があり、結果が確定しているが、まだ評価していないレース
  const pendingRaces = await dbAll<{ race_id: string }>(`
    SELECT DISTINCT p.race_id
    FROM predictions p
    JOIN races r ON p.race_id = r.id
    LEFT JOIN prediction_results pr ON p.race_id = pr.race_id
    WHERE r.status = '結果確定'
    AND pr.id IS NULL
  `);

  const results: PredictionResult[] = [];
  for (const { race_id } of pendingRaces) {
    const result = await evaluateRacePrediction(race_id);
    if (result) results.push(result);
  }
  return results;
}

// ==================== 統計集計 ====================

/**
 * 的中率の全体統計と信頼度校正データを取得する。
 */
export async function getAccuracyStats(): Promise<AccuracyStats> {
  const total = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM prediction_results');
  const totalEvaluated = total?.c ?? 0;

  const emptyScoringRules = {
    brierScore: null, brierSkillScore: null, marketBSS: null,
    logLoss: null, ece: null, calibrationBins: null, evaluatedWithProbs: 0,
  };

  if (totalEvaluated === 0) {
    return {
      totalEvaluated: 0,
      winHitRate: 0, placeHitRate: 0, avgTop3Coverage: 0,
      avgRoi: 0, totalInvested: 0, totalReturned: 0, overallRoi: 0,
      confidenceCalibration: [], recentTrend: [],
      scoringRules: emptyScoringRules,
    };
  }

  // 全体集計
  const agg = await dbGet<Record<string, number>>(`
    SELECT
      ROUND(AVG(win_hit) * 100, 1) as win_hit_rate,
      ROUND(AVG(place_hit) * 100, 1) as place_hit_rate,
      ROUND(AVG(CAST(top3_picks_hit as REAL) / 3.0) * 100, 1) as avg_top3_coverage,
      ROUND(AVG(bet_roi) * 100, 1) as avg_roi,
      SUM(bet_investment) as total_invested,
      SUM(bet_return) as total_returned
    FROM prediction_results
  `);

  if (!agg) {
    return {
      totalEvaluated: 0,
      winHitRate: 0, placeHitRate: 0, avgTop3Coverage: 0,
      avgRoi: 0, totalInvested: 0, totalReturned: 0, overallRoi: 0,
      confidenceCalibration: [], recentTrend: [],
      scoringRules: emptyScoringRules,
    };
  }

  const overallRoi = agg.total_invested > 0
    ? Math.round((agg.total_returned / agg.total_invested) * 1000) / 10
    : 0;

  // 信頼度帯別の校正
  const calibration = await dbAll<{ range_label: string; cnt: number; win_rate: number; place_rate: number; roi: number }>(`
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
  `);

  // 直近トレンド (最新30件、60件、全件)
  const trendQuery = async (limit: number, label: string) => {
    const row = await dbGet<{ cnt: number; win_rate: number; place_rate: number; roi: number }>(`
      SELECT
        COUNT(*) as cnt,
        ROUND(AVG(win_hit) * 100, 1) as win_rate,
        ROUND(AVG(place_hit) * 100, 1) as place_rate,
        CASE WHEN SUM(bet_investment) > 0
          THEN ROUND(SUM(bet_return) / SUM(bet_investment) * 100, 1)
          ELSE 0 END as roi
      FROM (SELECT * FROM prediction_results ORDER BY evaluated_at DESC LIMIT ?)
    `, [limit]);
    return {
      period: label,
      count: row?.cnt ?? 0,
      winHitRate: row?.win_rate ?? 0,
      placeHitRate: row?.place_rate ?? 0,
      roi: row?.roi ?? 0,
    };
  };

  const recentTrend = (await Promise.all([
    trendQuery(30, '直近30件'),
    trendQuery(100, '直近100件'),
    trendQuery(999999, '全期間'),
  ])).filter(t => t.count > 0);

  // Proper Scoring Rules 集計
  const scoringRules = await computeAggregateScoringRules();

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
    scoringRules,
  };
}

// ==================== Scoring Rules 集計（軽量版: DBに記録済みの値の平均のみ） ====================

/**
 * prediction_results に保存済みの brier_score / log_loss の集計のみ行う（軽量版）。
 * BSS / ECE はper-horseデータが必要でTurso負荷が大きいため、
 * scripts/check-scoring-rules.ts でローカル実行する設計。
 */
async function computeAggregateScoringRules(): Promise<AccuracyStats['scoringRules']> {
  const agg = await dbGet<{
    cnt: number; avg_brier: number; avg_ll: number;
  }>(`
    SELECT
      COUNT(*) as cnt,
      AVG(brier_score) as avg_brier,
      AVG(log_loss) as avg_ll
    FROM prediction_results
    WHERE brier_score IS NOT NULL
  `);

  if (!agg || agg.cnt === 0) {
    return {
      brierScore: null, brierSkillScore: null, marketBSS: null,
      logLoss: null, ece: null, calibrationBins: null, evaluatedWithProbs: 0,
    };
  }

  return {
    brierScore: Math.round(agg.avg_brier * 100000) / 100000,
    brierSkillScore: null,  // スクリプトで算出
    marketBSS: null,        // スクリプトで算出
    logLoss: Math.round(agg.avg_ll * 100000) / 100000,
    ece: null,              // スクリプトで算出
    calibrationBins: null,  // スクリプトで算出
    evaluatedWithProbs: agg.cnt,
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
export async function calibrateWeights(): Promise<CalibrationResult | null> {
  const total = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM prediction_results');
  if (!total || total.c < 5) return null;

  const rows = await dbAll<{
    race_id: string;
    picks_json: string;
    analysis_json: string;
    confidence: number;
    top_pick_actual_position: number;
    win_hit: number;
    place_hit: number;
  }>(`
    SELECT p.race_id, p.picks_json, p.analysis_json, p.confidence,
           pr.top_pick_actual_position, pr.win_hit, pr.place_hit
    FROM prediction_results pr
    JOIN predictions p ON pr.prediction_id = p.id
  `);

  if (rows.length < 5) return null;

  const factorNames = [
    'recentForm', 'courseAptitude', 'distanceAptitude', 'trackConditionAptitude',
    'jockeyAbility', 'speedRating', 'classPerformance', 'runningStyle',
    'postPositionBias', 'rotation', 'lastThreeFurlongs', 'consistency',
    'sireAptitude', 'trainerAbility', 'jockeyTrainerCombo',
    'seasonalPattern', 'handicapAdvantage', 'marketOdds',
    'marginCompetitiveness', 'weatherAptitude',
  ];

  const currentWeights: Record<string, number> = {
    recentForm: 0.15, courseAptitude: 0.06, distanceAptitude: 0.10,
    trackConditionAptitude: 0.04, jockeyAbility: 0.07, speedRating: 0.10,
    classPerformance: 0.04, runningStyle: 0.05, postPositionBias: 0.04,
    rotation: 0.04, lastThreeFurlongs: 0.07, consistency: 0.04,
    sireAptitude: 0.05, trainerAbility: 0.04, jockeyTrainerCombo: 0.02,
    seasonalPattern: 0.02, handicapAdvantage: 0.01,
    marketOdds: 0.03, marginCompetitiveness: 0.01, weatherAptitude: 0.02,
  };

  // 全対象レースの race_entries を一括取得（N+1クエリ回避）
  const allRaceIds = [...new Set(rows.map(r => r.race_id))];
  const entriesByRace = new Map<string, { horse_id: string; horse_number: number; result_position: number }[]>();

  // JOINで一括取得（WHERE INだと800+でTursoタイムアウトするのでバッチ分割）
  const BATCH_SIZE = 200;
  for (let i = 0; i < allRaceIds.length; i += BATCH_SIZE) {
    const batch = allRaceIds.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    const batchEntries = await dbAll<{ race_id: string; horse_id: string; horse_number: number; result_position: number }>(
      `SELECT race_id, horse_id, horse_number, result_position FROM race_entries WHERE race_id IN (${placeholders}) AND result_position IS NOT NULL`,
      batch
    );
    for (const e of batchEntries) {
      const arr = entriesByRace.get(e.race_id) || [];
      arr.push(e);
      entriesByRace.set(e.race_id, arr);
    }
  }

  // 各レースで予想上位と実際の勝ち馬のスコアパターンを比較
  const factorStats: Record<string, { winnerScores: number[]; loserScores: number[] }> = {};
  for (const f of factorNames) {
    factorStats[f] = { winnerScores: [], loserScores: [] };
  }

  for (const row of rows) {
    try {
      const picks = JSON.parse(row.picks_json || '[]');
      if (!picks || picks.length === 0) continue;

      const entries = entriesByRace.get(row.race_id) || [];

      if (entries.length === 0) continue;
      const winnerNumbers = new Set(entries.filter(e => e.result_position === 1).map(e => e.horse_number));

      // analysis_json にファクタースコア付きの horseScores がある場合はそれを使用
      let horseScoresMap: Map<number, Record<string, number>> | null = null;
      try {
        const analysis = JSON.parse(row.analysis_json || '{}');
        if (analysis.horseScores && typeof analysis.horseScores === 'object') {
          horseScoresMap = new Map();
          for (const [numStr, scores] of Object.entries(analysis.horseScores)) {
            horseScoresMap.set(Number(numStr), scores as Record<string, number>);
          }
        }
      } catch {
        // analysis parsing failed, use fallback
      }

      for (const pick of picks) {
        const isWinner = winnerNumbers.has(pick.horseNumber);

        if (horseScoresMap && horseScoresMap.has(pick.horseNumber)) {
          // 実際のファクタースコアを使用（高精度）
          const factorScores = horseScoresMap.get(pick.horseNumber)!;
          for (const f of factorNames) {
            const score = factorScores[f];
            if (score !== undefined) {
              if (isWinner) {
                factorStats[f].winnerScores.push(score);
              } else {
                factorStats[f].loserScores.push(score);
              }
            }
          }
        } else {
          // フォールバック: ランクベースの近似スコア
          const approxScoreFromRank = Math.max(10, 100 - (pick.rank || 1) * 12);
          for (const f of factorNames) {
            if (isWinner) {
              factorStats[f].winnerScores.push(approxScoreFromRank);
            } else {
              factorStats[f].loserScores.push(approxScoreFromRank);
            }
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

// ==================== 自動キャリブレーション適用 ====================

/** 最低レース数を満たしていれば自動校正を実行し、重みを適用する */
const MIN_RACES_FOR_AUTO_CALIBRATION = 100;

export async function autoCalibrate(): Promise<{ applied: boolean; message: string }> {
  const total = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM prediction_results');
  if (!total || total.c < MIN_RACES_FOR_AUTO_CALIBRATION) {
    return { applied: false, message: `自動校正にはあと${MIN_RACES_FOR_AUTO_CALIBRATION - (total?.c ?? 0)}件の照合済みレースが必要です` };
  }

  const result = await calibrateWeights();
  if (!result) {
    return { applied: false, message: '校正データの生成に失敗しました' };
  }

  // 重みをDBに保存して適用
  await saveCalibrationWeights(result.suggestedWeights, result.evaluatedRaces, true, '自動校正');
  applyCalibrationWeights(result.suggestedWeights);

  // カテゴリ別校正も実行
  const categoryResult = await calibrateCategoryWeights();
  const categoryMsg = categoryResult
    ? `カテゴリ別校正: ${categoryResult.categories.length}カテゴリ適用`
    : '';

  return {
    applied: true,
    message: `${result.evaluatedRaces}レースの実績から重みを校正しました。${result.expectedImprovement}${categoryMsg ? ' ' + categoryMsg : ''}`,
  };
}

// ==================== カテゴリ別自動校正 ====================

interface CategoryCalibrationResult {
  categories: { category: string; evaluatedRaces: number; multipliers: Record<string, number> }[];
}

const MIN_CATEGORY_RACES = 20;

/**
 * カテゴリ別（芝短/マイル/長/ダ短/ダ長）にファクター識別力を分析し、
 * カテゴリ固有の乗数を算出する。
 */
export async function calibrateCategoryWeights(): Promise<CategoryCalibrationResult | null> {
  const rows = await dbAll<{
    race_id: string;
    analysis_json: string;
    track_type: string;
    distance: number;
  }>(`
    SELECT p.race_id, p.analysis_json, r.track_type, r.distance
    FROM prediction_results pr
    JOIN predictions p ON pr.prediction_id = p.id
    JOIN races r ON pr.race_id = r.id
  `);

  if (rows.length < MIN_CATEGORY_RACES) return null;

  // レースエントリを一括取得
  const allRaceIds = [...new Set(rows.map(r => r.race_id))];
  const entriesByRace = new Map<string, { horse_number: number; result_position: number }[]>();
  const BATCH_SIZE = 200;
  for (let i = 0; i < allRaceIds.length; i += BATCH_SIZE) {
    const batch = allRaceIds.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    const batchEntries = await dbAll<{ race_id: string; horse_number: number; result_position: number }>(
      `SELECT race_id, horse_number, result_position FROM race_entries WHERE race_id IN (${placeholders}) AND result_position IS NOT NULL`,
      batch
    );
    for (const e of batchEntries) {
      const arr = entriesByRace.get(e.race_id) || [];
      arr.push(e);
      entriesByRace.set(e.race_id, arr);
    }
  }

  const factorNames = [
    'recentForm', 'courseAptitude', 'distanceAptitude', 'trackConditionAptitude',
    'jockeyAbility', 'speedRating', 'classPerformance', 'runningStyle',
    'postPositionBias', 'rotation', 'lastThreeFurlongs', 'consistency',
    'sireAptitude', 'trainerAbility', 'jockeyTrainerCombo',
    'seasonalPattern', 'handicapAdvantage', 'marketOdds',
    'marginCompetitiveness', 'weatherAptitude',
  ];

  // カテゴリ別にファクタースコアを収集
  const categoryData = new Map<RaceCategory, { winnerScores: Record<string, number[]>; loserScores: Record<string, number[]>; count: number }>();

  for (const row of rows) {
    const category = categorizeRace(row.track_type, row.distance);
    if (!categoryData.has(category)) {
      const init = { winnerScores: {} as Record<string, number[]>, loserScores: {} as Record<string, number[]>, count: 0 };
      for (const f of factorNames) {
        init.winnerScores[f] = [];
        init.loserScores[f] = [];
      }
      categoryData.set(category, init);
    }
    const catData = categoryData.get(category)!;
    catData.count++;

    let horseScoresMap: Record<string, Record<string, number>> | null = null;
    try {
      const analysis = JSON.parse(row.analysis_json || '{}');
      horseScoresMap = analysis.horseScores || null;
    } catch { continue; }

    if (!horseScoresMap) continue;

    const entries = entriesByRace.get(row.race_id) || [];
    const winnerNumbers = new Set(entries.filter(e => e.result_position === 1).map(e => e.horse_number));

    for (const [numStr, scores] of Object.entries(horseScoresMap)) {
      const horseNum = Number(numStr);
      const isWinner = winnerNumbers.has(horseNum);
      for (const f of factorNames) {
        const val = scores[f];
        if (val === undefined) continue;
        if (isWinner) catData.winnerScores[f].push(val);
        else catData.loserScores[f].push(val);
      }
    }
  }

  // グローバル平均識別力
  const globalDiscrim: Record<string, number> = {};
  for (const f of factorNames) {
    let wSum = 0, wCount = 0, lSum = 0, lCount = 0;
    for (const catData of categoryData.values()) {
      wSum += catData.winnerScores[f].reduce((a, b) => a + b, 0);
      wCount += catData.winnerScores[f].length;
      lSum += catData.loserScores[f].reduce((a, b) => a + b, 0);
      lCount += catData.loserScores[f].length;
    }
    const avgWin = wCount > 0 ? wSum / wCount : 50;
    const avgLose = lCount > 0 ? lSum / lCount : 50;
    globalDiscrim[f] = avgWin - avgLose;
  }

  // カテゴリ別乗数を算出
  const results: CategoryCalibrationResult['categories'] = [];

  for (const [category, catData] of categoryData.entries()) {
    if (catData.count < MIN_CATEGORY_RACES) continue;

    const multipliers: Record<string, number> = {};
    for (const f of factorNames) {
      const ws = catData.winnerScores[f];
      const ls = catData.loserScores[f];
      if (ws.length < 5 || ls.length < 5) continue;

      const avgWin = ws.reduce((a, b) => a + b, 0) / ws.length;
      const avgLose = ls.reduce((a, b) => a + b, 0) / ls.length;
      const catDiscrim = avgWin - avgLose;
      const globalD = globalDiscrim[f] || 0.1;

      // カテゴリの識別力 / グローバル識別力 → 相対強度
      const ratio = globalD !== 0 ? catDiscrim / globalD : 1.0;
      // 保守的ブレンド: 70%現在 + 30%算出値
      const computed = Math.max(0.5, Math.min(2.0, ratio));
      multipliers[f] = Math.round((0.7 * 1.0 + 0.3 * computed) * 1000) / 1000;
    }

    await saveCategoryCalibration(category, multipliers, catData.count, true, `自動校正: ${catData.count}レース`);
    results.push({ category, evaluatedRaces: catData.count, multipliers });
  }

  // メモリに適用
  if (results.length > 0) {
    const calibMap = new Map(results.map(r => [r.category, r.multipliers]));
    applyCalibratedCategoryMultipliers(calibMap);
  }

  return { categories: results };
}

// ==================== bets_json オッズ修復 ====================

export interface RepairBetsOddsResult {
  repaired: number;
  reEvaluated: number;
  done: boolean;
  phase: 'repair' | 'reeval';
}

/**
 * 既存 predictions の bets_json にオッズが埋め込まれていないものを
 * odds テーブルから補完する（修復フェーズのみ、再評価は別途）。
 * チャンク方式: 1回の呼び出しで最大 CHUNK_SIZE 件を処理し、残件を返す。
 */
const REPAIR_CHUNK_SIZE = 10;

export async function repairBetsOdds(offset = 0): Promise<RepairBetsOddsResult> {
  // オッズ未埋め込みの predictions を取得（LIMIT+OFFSETでチャンク化）
  const predictions = await dbAll<{ id: number; race_id: string; bets_json: string }>(
    `SELECT id, race_id, bets_json FROM predictions WHERE bets_json IS NOT NULL AND bets_json != '[]' ORDER BY id LIMIT ? OFFSET ?`,
    [REPAIR_CHUNK_SIZE, offset]
  );

  let repaired = 0;

  for (const pred of predictions) {
    let bets: { type: string; selections: number[]; reasoning: string; expectedValue: number; odds?: number }[];
    try {
      bets = JSON.parse(pred.bets_json);
    } catch { continue; }
    if (!Array.isArray(bets) || bets.length === 0) continue;

    const needsRepair = bets.some(b => !b.odds || b.odds <= 0);
    if (!needsRepair) continue;

    const winOdds = await dbAll<{ horse_number1: number; odds: number }>(
      `SELECT horse_number1, odds FROM odds WHERE race_id = ? AND bet_type = '単勝'`,
      [pred.race_id]
    );
    if (winOdds.length === 0) continue;

    const oddsMap = new Map(winOdds.map(o => [o.horse_number1, o.odds]));

    let changed = false;
    for (const bet of bets) {
      if (bet.odds && bet.odds > 0) continue;
      const sels = bet.selections || [];
      if (sels.length === 0) continue;

      if (bet.type === '単勝') {
        const o = oddsMap.get(sels[0]);
        if (o) { bet.odds = o; changed = true; }
      } else if (bet.type === '複勝') {
        const o = oddsMap.get(sels[0]);
        if (o) { bet.odds = Math.max(1.1, o * 0.35); changed = true; }
      } else if (bet.type === '馬連' && sels.length >= 2) {
        const o1 = oddsMap.get(sels[0]);
        const o2 = oddsMap.get(sels[1]);
        if (o1 && o2) { bet.odds = o1 * o2 * 0.5; changed = true; }
      } else if (bet.type === 'ワイド' && sels.length >= 2) {
        const o1 = oddsMap.get(sels[0]);
        const o2 = oddsMap.get(sels[1]);
        if (o1 && o2) { bet.odds = o1 * o2 * 0.25; changed = true; }
      } else if (bet.type === '馬単' && sels.length >= 2) {
        const o1 = oddsMap.get(sels[0]);
        const o2 = oddsMap.get(sels[1]);
        if (o1 && o2) { bet.odds = o1 * o2 * 0.9; changed = true; }
      } else if (bet.type === '三連複' && sels.length >= 3) {
        const o1 = oddsMap.get(sels[0]);
        const o2 = oddsMap.get(sels[1]);
        const o3 = oddsMap.get(sels[2]);
        if (o1 && o2 && o3) { bet.odds = o1 * o2 * o3 * 0.3; changed = true; }
      } else if (bet.type === '三連単' && sels.length >= 3) {
        const o1 = oddsMap.get(sels[0]);
        const o2 = oddsMap.get(sels[1]);
        const o3 = oddsMap.get(sels[2]);
        if (o1 && o2 && o3) { bet.odds = o1 * o2 * o3 * 0.6; changed = true; }
      }
    }

    if (changed) {
      await dbRun(
        `UPDATE predictions SET bets_json = ? WHERE id = ?`,
        [JSON.stringify(bets), pred.id]
      );
      repaired++;
    }
  }

  return { repaired, reEvaluated: 0, done: predictions.length < REPAIR_CHUNK_SIZE, phase: 'repair' };
}

/**
 * 修復済みpredictionの再評価をチャンクで行う。
 * prediction_results が存在しない prediction を対象にする。
 */
const REEVAL_CHUNK_SIZE = 5;

export async function reEvaluateRepairedChunk(): Promise<RepairBetsOddsResult> {
  // prediction_results が存在しない prediction の race_id を取得
  const pending = await dbAll<{ race_id: string }>(
    `SELECT DISTINCT p.race_id FROM predictions p
     LEFT JOIN prediction_results pr ON p.race_id = pr.race_id
     WHERE p.bets_json IS NOT NULL AND p.bets_json != '[]' AND pr.id IS NULL
     LIMIT ?`,
    [REEVAL_CHUNK_SIZE]
  );

  let reEvaluated = 0;
  for (const row of pending) {
    const result = await evaluateRacePrediction(row.race_id);
    if (result) reEvaluated++;
  }

  return { repaired: 0, reEvaluated, done: pending.length < REEVAL_CHUNK_SIZE, phase: 'reeval' };
}

/**
 * 起動時にDBからキャリブレーション済み重みがあれば読み込んで適用する。
 * 各エンドポイントの初回呼び出し時に一度だけ実行する。
 */
let calibrationLoaded = false;

export async function ensureCalibrationLoaded(): Promise<void> {
  if (calibrationLoaded) return;
  calibrationLoaded = true;

  const weights = await getActiveCalibrationWeights();
  if (weights) {
    applyCalibrationWeights(weights);
  }

  // カテゴリ別校正も読み込み
  const categoryCalibrations = await getActiveCategoryCalibrations();
  if (categoryCalibrations) {
    applyCalibratedCategoryMultipliers(categoryCalibrations);
  }
}
