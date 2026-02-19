/**
 * AI予想エンジン
 *
 * 過去の成績データを多角的に分析し、レースの予想を生成する。
 * 各馬のスコアリングは以下の要素を重み付けして算出:
 *   - 直近成績 (25%)
 *   - コース適性 (15%)
 *   - 距離適性 (15%)
 *   - 馬場状態適性 (10%)
 *   - 騎手成績 (10%)
 *   - スピード指数 (15%)
 *   - クラス実績 (10%)
 */

import type {
  Prediction, PredictionPick, RaceAnalysis, RecommendedBet,
  RaceEntry, PastPerformance, TrackType, TrackCondition,
} from '@/types';

// 重み設定
const WEIGHTS = {
  recentForm: 0.25,
  courseAptitude: 0.15,
  distanceAptitude: 0.15,
  trackConditionAptitude: 0.10,
  jockeyAbility: 0.10,
  speedRating: 0.15,
  classPerformance: 0.10,
};

interface HorseAnalysisInput {
  entry: RaceEntry;
  pastPerformances: PastPerformance[];
  jockeyWinRate: number;
  jockeyPlaceRate: number;
}

interface ScoredHorse {
  entry: RaceEntry;
  totalScore: number;
  scores: Record<string, number>;
  reasons: string[];
}

export function generatePrediction(
  raceId: string,
  raceName: string,
  date: string,
  trackType: TrackType,
  distance: number,
  trackCondition: TrackCondition | undefined,
  racecourseName: string,
  grade: string | undefined,
  horses: HorseAnalysisInput[],
): Prediction {
  // 各馬をスコアリング
  const scoredHorses = horses.map(h =>
    scoreHorse(h, trackType, distance, trackCondition || '良', racecourseName, grade)
  );

  // スコア順にソート
  scoredHorses.sort((a, b) => b.totalScore - a.totalScore);

  // トップピック生成
  const topPicks: PredictionPick[] = scoredHorses.slice(0, 6).map((sh, idx) => ({
    rank: idx + 1,
    horseNumber: sh.entry.horseNumber,
    horseName: sh.entry.horseName,
    score: Math.round(sh.totalScore * 100) / 100,
    reasons: sh.reasons,
  }));

  // レース分析
  const analysis = analyzeRace(scoredHorses, trackType, distance, trackCondition || '良', racecourseName);

  // 信頼度算出
  const confidence = calculateConfidence(scoredHorses);

  // 推奨馬券
  const recommendedBets = generateBetRecommendations(scoredHorses);

  // サマリー生成
  const summary = generateSummary(topPicks, analysis, raceName);

  return {
    raceId,
    raceName,
    date,
    generatedAt: new Date().toISOString(),
    confidence,
    summary,
    topPicks,
    analysis,
    recommendedBets,
  };
}

function scoreHorse(
  input: HorseAnalysisInput,
  trackType: TrackType,
  distance: number,
  trackCondition: TrackCondition,
  racecourseName: string,
  grade: string | undefined,
): ScoredHorse {
  const { entry, pastPerformances: pp, jockeyWinRate, jockeyPlaceRate } = input;
  const reasons: string[] = [];
  const scores: Record<string, number> = {};

  // 1. 直近成績スコア (0-100)
  const recentScore = calcRecentFormScore(pp);
  scores.recentForm = recentScore;
  if (recentScore >= 70) reasons.push(`直近成績が優秀（スコア${Math.round(recentScore)}）`);
  else if (recentScore <= 30) reasons.push(`直近成績が低調`);

  // 2. コース適性 (0-100)
  const courseScore = calcCourseAptitude(pp, racecourseName);
  scores.courseAptitude = courseScore;
  if (courseScore >= 70) reasons.push(`${racecourseName}コースでの実績あり`);

  // 3. 距離適性 (0-100)
  const distanceScore = calcDistanceAptitude(pp, distance);
  scores.distanceAptitude = distanceScore;
  if (distanceScore >= 70) reasons.push(`${distance}m前後の距離で好走歴`);
  else if (distanceScore <= 30) reasons.push(`距離適性に不安`);

  // 4. 馬場状態適性 (0-100)
  const conditionScore = calcTrackConditionAptitude(pp, trackType, trackCondition);
  scores.trackConditionAptitude = conditionScore;
  if (conditionScore >= 70) reasons.push(`${trackCondition}の${trackType}で実績あり`);

  // 5. 騎手能力 (0-100)
  const jockeyScore = calcJockeyScore(jockeyWinRate, jockeyPlaceRate);
  scores.jockeyAbility = jockeyScore;
  if (jockeyScore >= 70) reasons.push(`騎手${entry.jockeyName}の勝率が高い`);

  // 6. スピード指数 (0-100)
  const speedScore = calcSpeedRating(pp, trackType, distance);
  scores.speedRating = speedScore;
  if (speedScore >= 70) reasons.push(`高いスピード指数を記録`);

  // 7. クラス実績 (0-100)
  const classScore = calcClassPerformance(pp, grade);
  scores.classPerformance = classScore;
  if (classScore >= 70) reasons.push(`同クラス以上での好走実績`);

  // 総合スコア
  const totalScore =
    scores.recentForm * WEIGHTS.recentForm +
    scores.courseAptitude * WEIGHTS.courseAptitude +
    scores.distanceAptitude * WEIGHTS.distanceAptitude +
    scores.trackConditionAptitude * WEIGHTS.trackConditionAptitude +
    scores.jockeyAbility * WEIGHTS.jockeyAbility +
    scores.speedRating * WEIGHTS.speedRating +
    scores.classPerformance * WEIGHTS.classPerformance;

  if (reasons.length === 0) reasons.push('特筆すべき要素なし');

  return { entry, totalScore, scores, reasons };
}

// ==================== 個別スコア計算 ====================

function calcRecentFormScore(pp: PastPerformance[]): number {
  if (pp.length === 0) return 40; // データなしは中間値
  const recent = pp.slice(0, 5);
  let score = 0;
  const weights = [0.35, 0.25, 0.20, 0.12, 0.08];

  recent.forEach((perf, idx) => {
    const w = weights[idx] || 0.05;
    const posScore = positionToScore(perf.position, perf.entries || 16);
    score += posScore * w;
  });

  return Math.min(100, score);
}

function calcCourseAptitude(pp: PastPerformance[], racecourseName: string): number {
  const courseRaces = pp.filter(p => p.racecourseName === racecourseName);
  if (courseRaces.length === 0) return 50; // データなし

  const avgPosition = courseRaces.reduce((sum, p) => sum + p.position, 0) / courseRaces.length;
  const avgEntries = courseRaces.reduce((sum, p) => sum + (p.entries || 16), 0) / courseRaces.length;
  const ratio = avgPosition / avgEntries;

  if (ratio <= 0.15) return 95;
  if (ratio <= 0.25) return 80;
  if (ratio <= 0.35) return 65;
  if (ratio <= 0.50) return 50;
  return 30;
}

function calcDistanceAptitude(pp: PastPerformance[], targetDistance: number): number {
  if (pp.length === 0) return 50;

  // 距離±200mの範囲でフィルタ
  const nearDist = pp.filter(p => Math.abs(p.distance - targetDistance) <= 200);
  if (nearDist.length === 0) return 40;

  const avgPosition = nearDist.reduce((sum, p) => sum + p.position, 0) / nearDist.length;
  const avgEntries = nearDist.reduce((sum, p) => sum + (p.entries || 16), 0) / nearDist.length;
  const ratio = avgPosition / avgEntries;

  // 同距離±100m以内にベストがあればボーナス
  const bestAtDist = nearDist.filter(p => Math.abs(p.distance - targetDistance) <= 100)
    .reduce((best, p) => Math.min(best, p.position), 99);
  const distBonus = bestAtDist <= 3 ? 10 : 0;

  let score = 0;
  if (ratio <= 0.15) score = 95;
  else if (ratio <= 0.25) score = 80;
  else if (ratio <= 0.35) score = 65;
  else if (ratio <= 0.50) score = 50;
  else score = 30;

  return Math.min(100, score + distBonus);
}

function calcTrackConditionAptitude(pp: PastPerformance[], trackType: TrackType, condition: TrackCondition): number {
  const relevantRaces = pp.filter(p => p.trackType === trackType);
  if (relevantRaces.length === 0) return 50;

  // 同馬場状態での成績
  const sameCondition = relevantRaces.filter(p => p.trackCondition === condition);
  if (sameCondition.length === 0) {
    // 重・不良での経験がない馬は道悪適性が不明
    if (condition === '重' || condition === '不良') return 40;
    return 50;
  }

  const avgPosition = sameCondition.reduce((sum, p) => sum + p.position, 0) / sameCondition.length;
  const avgEntries = sameCondition.reduce((sum, p) => sum + (p.entries || 16), 0) / sameCondition.length;
  const ratio = avgPosition / avgEntries;

  if (ratio <= 0.15) return 95;
  if (ratio <= 0.25) return 80;
  if (ratio <= 0.35) return 65;
  if (ratio <= 0.50) return 50;
  return 30;
}

function calcJockeyScore(winRate: number, placeRate: number): number {
  // 勝率と複勝率を組み合わせ
  const score = (winRate * 100) * 3 + (placeRate * 100) * 1.5;
  return Math.min(100, Math.max(0, score));
}

function calcSpeedRating(pp: PastPerformance[], trackType: TrackType, distance: number): number {
  if (pp.length === 0) return 50;

  const relevantRaces = pp.filter(p =>
    p.trackType === trackType &&
    Math.abs(p.distance - distance) <= 200 &&
    p.time
  );

  if (relevantRaces.length === 0) return 50;

  // タイムからスピード指数を算出（簡易版）
  const speeds = relevantRaces.map(p => {
    const seconds = timeToSeconds(p.time);
    if (seconds <= 0) return 0;
    // 距離/秒 で基本速度を算出し、馬場差を考慮
    const baseSpeed = p.distance / seconds;
    const condAdj = p.trackCondition === '重' || p.trackCondition === '不良' ? 0.02 : 0;
    return baseSpeed + condAdj;
  }).filter(s => s > 0);

  if (speeds.length === 0) return 50;

  const bestSpeed = Math.max(...speeds);
  // 基準速度（ダート1200m = 15.6m/s、芝1600m = 16.0m/s 程度）
  const referenceSpeed = trackType === '芝' ? 16.0 : 15.5;
  const diff = (bestSpeed - referenceSpeed) / referenceSpeed;

  return Math.min(100, Math.max(0, 50 + diff * 500));
}

function calcClassPerformance(pp: PastPerformance[], _grade: string | undefined): number {
  if (pp.length === 0) return 50;

  // 重賞（G1,G2,G3）での着順を評価
  const gradeRaces = pp.filter(p =>
    p.raceName.includes('G1') || p.raceName.includes('G2') || p.raceName.includes('G3') ||
    p.raceName.includes('ステークス') || p.raceName.includes('賞') || p.raceName.includes('カップ')
  );

  if (gradeRaces.length === 0) return 45;

  // 上位入線率
  const topFinishes = gradeRaces.filter(p => p.position <= 3).length;
  const ratio = topFinishes / gradeRaces.length;

  if (ratio >= 0.5) return 90;
  if (ratio >= 0.3) return 75;
  if (ratio >= 0.15) return 60;
  return 40;
}

// ==================== レース分析 ====================

function analyzeRace(scoredHorses: ScoredHorse[], trackType: TrackType, distance: number, condition: TrackCondition, racecourseName: string): RaceAnalysis {
  // 馬場バイアス分析
  let trackBias = `${racecourseName}${trackType}${distance}m`;
  if (condition === '重' || condition === '不良') {
    trackBias += `（${condition}馬場）- 道悪巧者に注意。内枠有利の傾向が強まる可能性あり。`;
  } else {
    trackBias += `（${condition}馬場）- 標準的な馬場状態。`;
  }

  // ペース分析
  const frontRunners = scoredHorses.filter(sh => isFrontRunner(sh));
  let paceAnalysis: string;
  if (frontRunners.length >= 3) {
    paceAnalysis = 'ハイペース予想。逃げ・先行馬が多く、前が厳しい展開に。差し・追込馬に展開利あり。';
  } else if (frontRunners.length <= 1) {
    paceAnalysis = 'スローペース予想。逃げ馬が少なく、前残りの可能性。逃げ・先行馬に注目。';
  } else {
    paceAnalysis = 'ミドルペース予想。平均的な流れで、実力通りの決着が見込まれる。';
  }

  // キーファクター
  const keyFactors: string[] = [];
  if (distance >= 2400) keyFactors.push('長距離戦のため、スタミナと折り合いが鍵');
  if (distance <= 1200) keyFactors.push('スプリント戦、ゲートの出と前半のスピードが重要');
  if (condition === '重' || condition === '不良') keyFactors.push('道悪適性が勝敗を分ける');
  keyFactors.push(`上位馬のスコア差: ${scoredHorses.length >= 2 ? Math.round((scoredHorses[0].totalScore - scoredHorses[1].totalScore) * 10) / 10 : '不明'}`);

  // リスク要因
  const riskFactors: string[] = [];
  if (scoredHorses.length > 0 && scoredHorses[0].totalScore - (scoredHorses[1]?.totalScore || 0) < 5) {
    riskFactors.push('上位馬の差が小さく、波乱の可能性あり');
  }
  if (scoredHorses.some(sh => sh.entry.odds && sh.entry.odds <= 2.0)) {
    riskFactors.push('断然人気馬がいるが、過信は禁物');
  }

  return { trackBias, paceAnalysis, keyFactors, riskFactors };
}

function isFrontRunner(sh: ScoredHorse): boolean {
  // 通過順が早い馬を逃げ・先行馬と判定（簡易版）
  return sh.scores.speedRating > 65;
}

// ==================== 信頼度 ====================

function calculateConfidence(scoredHorses: ScoredHorse[]): number {
  if (scoredHorses.length < 3) return 30;

  // 上位馬のスコア差が大きいほど信頼度が高い
  const gap1_2 = scoredHorses[0].totalScore - scoredHorses[1].totalScore;
  const gap1_3 = scoredHorses[0].totalScore - scoredHorses[2].totalScore;

  let confidence = 40;
  if (gap1_2 > 10) confidence += 20;
  else if (gap1_2 > 5) confidence += 10;
  if (gap1_3 > 15) confidence += 15;
  else if (gap1_3 > 8) confidence += 8;

  // データ量によるボーナス
  const avgDataPoints = scoredHorses.reduce((sum, sh) =>
    sum + Object.values(sh.scores).filter(s => s !== 50).length, 0
  ) / scoredHorses.length;
  if (avgDataPoints >= 5) confidence += 10;

  return Math.min(90, Math.max(20, confidence));
}

// ==================== 推奨馬券 ====================

function generateBetRecommendations(scoredHorses: ScoredHorse[]): RecommendedBet[] {
  const bets: RecommendedBet[] = [];
  if (scoredHorses.length < 3) return bets;

  const top = scoredHorses[0];
  const second = scoredHorses[1];
  const third = scoredHorses[2];

  // 単勝
  if (top.totalScore > 65 && top.totalScore - second.totalScore > 5) {
    bets.push({
      type: '単勝',
      selections: [top.entry.horseNumber],
      reasoning: `${top.entry.horseName}が総合力で群を抜いている。${top.reasons[0] || ''}`,
      expectedValue: calcExpectedValue(top, scoredHorses),
    });
  }

  // 複勝
  bets.push({
    type: '複勝',
    selections: [top.entry.horseNumber],
    reasoning: `${top.entry.horseName}の3着以内は堅い。安定感重視の馬券。`,
    expectedValue: calcExpectedValue(top, scoredHorses) * 0.7,
  });

  // 馬連
  bets.push({
    type: '馬連',
    selections: [top.entry.horseNumber, second.entry.horseNumber],
    reasoning: `${top.entry.horseName}と${second.entry.horseName}の上位2頭で決まる可能性が高い。`,
    expectedValue: (calcExpectedValue(top, scoredHorses) + calcExpectedValue(second, scoredHorses)) / 2,
  });

  // ワイド
  bets.push({
    type: 'ワイド',
    selections: [top.entry.horseNumber, third.entry.horseNumber],
    reasoning: `${top.entry.horseName}と${third.entry.horseName}のワイド。${third.entry.horseName}は穴候補。`,
    expectedValue: (calcExpectedValue(top, scoredHorses) + calcExpectedValue(third, scoredHorses)) / 2,
  });

  // 三連複（上位3頭が明確な場合）
  if (scoredHorses.length >= 4 && third.totalScore - scoredHorses[3].totalScore > 3) {
    bets.push({
      type: '三連複',
      selections: [top.entry.horseNumber, second.entry.horseNumber, third.entry.horseNumber],
      reasoning: `上位3頭が抜けており、堅い三連複。`,
      expectedValue: (calcExpectedValue(top, scoredHorses) + calcExpectedValue(second, scoredHorses) + calcExpectedValue(third, scoredHorses)) / 3,
    });
  }

  return bets;
}

function calcExpectedValue(horse: ScoredHorse, all: ScoredHorse[]): number {
  const totalScores = all.reduce((sum, h) => sum + h.totalScore, 0);
  if (totalScores === 0) return 1;
  const probability = horse.totalScore / totalScores;
  const odds = horse.entry.odds || (1 / probability);
  return probability * odds;
}

// ==================== サマリー生成 ====================

function generateSummary(topPicks: PredictionPick[], analysis: RaceAnalysis, raceName: string): string {
  const parts: string[] = [];
  parts.push(`【${raceName}の予想】`);

  if (topPicks.length > 0) {
    parts.push(`本命は${topPicks[0].horseName}。${topPicks[0].reasons[0] || '総合力で最上位評価'}`);
  }
  if (topPicks.length > 1) {
    parts.push(`対抗は${topPicks[1].horseName}。`);
  }

  parts.push(analysis.paceAnalysis);

  if (analysis.riskFactors.length > 0) {
    parts.push(`注意点: ${analysis.riskFactors[0]}`);
  }

  return parts.join('\n');
}

// ==================== ユーティリティ ====================

function positionToScore(position: number, entries: number): number {
  if (entries <= 0) return 50;
  const ratio = position / entries;
  if (ratio <= 0.05) return 100; // 1着 / 大人数
  if (position === 1) return 95;
  if (position === 2) return 85;
  if (position === 3) return 75;
  if (ratio <= 0.25) return 65;
  if (ratio <= 0.50) return 45;
  if (ratio <= 0.75) return 25;
  return 10;
}

function timeToSeconds(timeStr: string): number {
  if (!timeStr) return 0;
  const match = timeStr.match(/(?:(\d+):)?(\d+)\.(\d+)/);
  if (!match) return 0;
  const min = parseInt(match[1] || '0');
  const sec = parseInt(match[2]);
  const msec = parseInt(match[3]);
  return min * 60 + sec + msec / 10;
}

// エクスポート（テスト用）
export { scoreHorse as _scoreHorse };
export type { HorseAnalysisInput };
