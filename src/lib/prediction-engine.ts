/**
 * AI予想エンジン v2
 *
 * 過去の成績データを12の観点から多角的に分析し、レースの予想を生成する。
 *
 * スコアリング要素と重み:
 *   1. 直近成績        (18%) - 直近5走の着順を重み付け評価
 *   2. コース適性      (10%) - 同競馬場での過去成績
 *   3. 距離適性        (12%) - 同距離帯での過去成績
 *   4. 馬場状態適性    (7%)  - 同馬場状態での成績
 *   5. 騎手能力        (8%)  - 騎手の勝率・複勝率
 *   6. スピード指数    (10%) - タイムベースの速度評価
 *   7. クラス実績      (5%)  - 重賞など上位クラスでの成績
 *   8. 脚質適性        (8%)  - 展開との相性（逃げ/先行/差し/追込）
 *   9. 枠順分析        (5%)  - コース形態に応じた枠の有利不利
 *  10. ローテーション  (5%)  - 前走からの間隔と叩き良化パターン
 *  11. 上がり3F        (8%)  - 末脚の切れ味評価
 *  12. 安定性          (4%)  - 着順のバラつきの少なさ
 */

import type {
  Prediction, PredictionPick, RaceAnalysis, RecommendedBet,
  RaceEntry, PastPerformance, TrackType, TrackCondition,
} from '@/types';

// 重み設定
const WEIGHTS = {
  recentForm: 0.18,
  courseAptitude: 0.10,
  distanceAptitude: 0.12,
  trackConditionAptitude: 0.07,
  jockeyAbility: 0.08,
  speedRating: 0.10,
  classPerformance: 0.05,
  runningStyle: 0.08,
  postPositionBias: 0.05,
  rotation: 0.05,
  lastThreeFurlongs: 0.08,
  consistency: 0.04,
};

// 脚質
type RunningStyle = '逃げ' | '先行' | '差し' | '追込' | '不明';

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
  runningStyle: RunningStyle;
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
  const cond = trackCondition || '良';

  // 各馬をスコアリング（脚質判定込み）
  const scoredHorses = horses.map(h =>
    scoreHorse(h, trackType, distance, cond, racecourseName, grade, horses.length)
  );

  // 展開予想から脚質ボーナスを付与
  applyPaceBonus(scoredHorses, distance);

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
  const analysis = analyzeRace(scoredHorses, trackType, distance, cond, racecourseName);

  // 信頼度算出
  const confidence = calculateConfidence(scoredHorses);

  // 推奨馬券
  const recommendedBets = generateBetRecommendations(scoredHorses, confidence);

  // サマリー生成
  const summary = generateSummary(topPicks, analysis, raceName, confidence);

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

// ==================== メインスコアリング ====================

function scoreHorse(
  input: HorseAnalysisInput,
  trackType: TrackType,
  distance: number,
  trackCondition: TrackCondition,
  racecourseName: string,
  grade: string | undefined,
  fieldSize: number,
): ScoredHorse {
  const { entry, pastPerformances: pp, jockeyWinRate, jockeyPlaceRate } = input;
  const reasons: string[] = [];
  const scores: Record<string, number> = {};

  // 脚質判定
  const runStyle = detectRunningStyle(pp);

  // 1. 直近成績 (0-100) - 直近5走を減衰加重
  scores.recentForm = calcRecentFormScore(pp);
  if (scores.recentForm >= 75) reasons.push(`直近成績が優秀（スコア${Math.round(scores.recentForm)}）`);
  else if (scores.recentForm >= 60) reasons.push('直近の調子は悪くない');
  else if (scores.recentForm <= 30) reasons.push('直近成績が低調');

  // 2. コース適性 (0-100)
  scores.courseAptitude = calcCourseAptitude(pp, racecourseName);
  if (scores.courseAptitude >= 75) reasons.push(`${racecourseName}コースで好成績`);
  else if (scores.courseAptitude <= 35) reasons.push(`${racecourseName}コースは未経験or苦手`);

  // 3. 距離適性 (0-100) - ベスト距離との差を非線形評価
  scores.distanceAptitude = calcDistanceAptitude(pp, distance);
  if (scores.distanceAptitude >= 75) reasons.push(`${distance}m前後がベスト距離`);
  else if (scores.distanceAptitude <= 35) reasons.push('距離適性に不安');

  // 4. 馬場状態適性 (0-100)
  scores.trackConditionAptitude = calcTrackConditionAptitude(pp, trackType, trackCondition);
  if (scores.trackConditionAptitude >= 75 && (trackCondition === '重' || trackCondition === '不良')) {
    reasons.push('道悪巧者、重馬場で成績上昇');
  }

  // 5. 騎手能力 (0-100)
  scores.jockeyAbility = calcJockeyScore(jockeyWinRate, jockeyPlaceRate);
  if (scores.jockeyAbility >= 75) reasons.push(`騎手${entry.jockeyName}は勝率トップクラス`);

  // 6. スピード指数 (0-100)
  scores.speedRating = calcSpeedRating(pp, trackType, distance);
  if (scores.speedRating >= 75) reasons.push('高水準のスピード指数を記録');

  // 7. クラス実績 (0-100)
  scores.classPerformance = calcClassPerformance(pp, grade);
  if (scores.classPerformance >= 75) reasons.push('重賞レベルで好走実績あり');

  // 8. 脚質適性 (0-100) - 展開ボーナスは後で付与
  scores.runningStyle = calcRunningStyleBase(runStyle, distance);
  if (runStyle === '逃げ' && distance <= 1400) reasons.push('逃げ馬で短距離向き');
  if (runStyle === '差し' && distance >= 1800) reasons.push('差し脚質で中長距離向き');
  if (runStyle === '追込' && distance >= 2000) reasons.push('追込で展開次第で一発あり');

  // 9. 枠順分析 (0-100)
  scores.postPositionBias = calcPostPositionBias(entry.postPosition, fieldSize, distance, trackType, racecourseName);
  if (scores.postPositionBias >= 75) reasons.push('枠順が有利');
  else if (scores.postPositionBias <= 30) reasons.push('外枠で不利');

  // 10. ローテーション (0-100) - 前走からの間隔
  scores.rotation = calcRotation(pp);
  if (scores.rotation >= 75) reasons.push('理想的なローテーション');
  else if (scores.rotation <= 30) reasons.push('間隔が空きすぎorタイトすぎ');

  // 11. 上がり3F (0-100)
  scores.lastThreeFurlongs = calcLastThreeFurlongs(pp, trackType);
  if (scores.lastThreeFurlongs >= 80) reasons.push('末脚が鋭く上がり最速級');
  else if (scores.lastThreeFurlongs >= 65) reasons.push('末脚はまずまず');

  // 12. 安定性 (0-100) - 着順のバラつき
  scores.consistency = calcConsistency(pp);
  if (scores.consistency >= 75) reasons.push('着順が安定しており堅実');
  else if (scores.consistency <= 30) reasons.push('ムラのある走りで計算しづらい');

  // 総合スコア
  let totalScore = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    totalScore += (scores[key] || 50) * weight;
  }

  if (reasons.length === 0) reasons.push('特筆すべき要素なし');

  return { entry, totalScore, scores, reasons, runningStyle: runStyle };
}

// ==================== 脚質判定 ====================

function detectRunningStyle(pp: PastPerformance[]): RunningStyle {
  if (pp.length === 0) return '不明';

  const recent = pp.slice(0, 8);
  let escapeCount = 0;
  let frontCount = 0;
  let stalkerCount = 0;
  let closerCount = 0;

  for (const perf of recent) {
    if (!perf.cornerPositions) continue;
    const corners = perf.cornerPositions.split('-').map(Number).filter(n => !isNaN(n));
    if (corners.length === 0) continue;

    const firstCorner = corners[0];
    const entries = perf.entries || 16;
    const ratio = firstCorner / entries;

    if (ratio <= 0.10) escapeCount++;
    else if (ratio <= 0.30) frontCount++;
    else if (ratio <= 0.60) stalkerCount++;
    else closerCount++;
  }

  const total = escapeCount + frontCount + stalkerCount + closerCount;
  if (total === 0) return '不明';

  if (escapeCount / total >= 0.4) return '逃げ';
  if (frontCount / total >= 0.4) return '先行';
  if ((escapeCount + frontCount) / total >= 0.6) return '先行';
  if (closerCount / total >= 0.4) return '追込';
  return '差し';
}

function calcRunningStyleBase(style: RunningStyle, distance: number): number {
  // 脚質×距離の基本スコア
  if (style === '不明') return 50;

  if (distance <= 1200) {
    if (style === '逃げ') return 75;
    if (style === '先行') return 70;
    if (style === '差し') return 50;
    return 35; // 追込
  }
  if (distance <= 1600) {
    if (style === '逃げ') return 65;
    if (style === '先行') return 70;
    if (style === '差し') return 65;
    return 45;
  }
  if (distance <= 2200) {
    if (style === '逃げ') return 55;
    if (style === '先行') return 65;
    if (style === '差し') return 70;
    return 55;
  }
  // 2400m以上
  if (style === '逃げ') return 50;
  if (style === '先行') return 60;
  if (style === '差し') return 70;
  return 65;
}

// ==================== 展開予想ボーナス ====================

function applyPaceBonus(horses: ScoredHorse[], distance: number): void {
  // 逃げ馬・先行馬の数でペースを予想
  const escapers = horses.filter(h => h.runningStyle === '逃げ').length;
  const frontRunners = horses.filter(h => h.runningStyle === '先行').length;
  const forwardTotal = escapers + frontRunners;

  // ペース判定
  let paceType: 'ハイ' | 'ミドル' | 'スロー';
  if (forwardTotal >= Math.ceil(horses.length * 0.5)) {
    paceType = 'ハイ';
  } else if (forwardTotal <= Math.floor(horses.length * 0.25)) {
    paceType = 'スロー';
  } else {
    paceType = 'ミドル';
  }

  // ペースに応じた脚質ボーナス
  const bonus: Record<RunningStyle, number> = {
    '逃げ': 0, '先行': 0, '差し': 0, '追込': 0, '不明': 0,
  };

  if (paceType === 'ハイ') {
    bonus['逃げ'] = -4;
    bonus['先行'] = -2;
    bonus['差し'] = 3;
    bonus['追込'] = 5;
  } else if (paceType === 'スロー') {
    bonus['逃げ'] = escapers <= 1 ? 6 : 3;  // 逃げ1頭なら大有利
    bonus['先行'] = 3;
    bonus['差し'] = -2;
    bonus['追込'] = -5;
  }

  // 距離が短いほど前有利を強調
  const distFactor = distance <= 1400 ? 1.3 : distance <= 1800 ? 1.0 : 0.8;

  for (const horse of horses) {
    const b = (bonus[horse.runningStyle] || 0) * distFactor;
    horse.totalScore += b;
    if (b >= 3) {
      horse.reasons.push(`展開利あり（${paceType}ペースで${horse.runningStyle}有利）`);
    } else if (b <= -3) {
      horse.reasons.push(`展開不利（${paceType}ペースで${horse.runningStyle}不利）`);
    }
  }
}

// ==================== 個別スコア計算 ====================

function calcRecentFormScore(pp: PastPerformance[]): number {
  if (pp.length === 0) return 40;
  const recent = pp.slice(0, 5);
  let score = 0;
  const weights = [0.35, 0.25, 0.20, 0.12, 0.08];

  recent.forEach((perf, idx) => {
    const w = weights[idx] || 0.05;
    const posScore = positionToScore(perf.position, perf.entries || 16);
    score += posScore * w;
  });

  // 連勝ボーナス
  const winStreak = countWinStreak(pp);
  if (winStreak >= 3) score += 10;
  else if (winStreak >= 2) score += 5;

  // 前走大敗からの巻き返しパターン
  if (pp.length >= 2 && pp[0].position <= 3 && pp[1].position >= 8) {
    score += 3; // 立て直し成功
  }

  return Math.min(100, score);
}

function countWinStreak(pp: PastPerformance[]): number {
  let streak = 0;
  for (const perf of pp) {
    if (perf.position === 1) streak++;
    else break;
  }
  return streak;
}

function calcCourseAptitude(pp: PastPerformance[], racecourseName: string): number {
  const courseRaces = pp.filter(p => p.racecourseName === racecourseName);
  if (courseRaces.length === 0) return 50;

  const avgRatio = courseRaces.reduce((sum, p) => {
    return sum + p.position / (p.entries || 16);
  }, 0) / courseRaces.length;

  // 勝率ボーナス
  const wins = courseRaces.filter(p => p.position === 1).length;
  const winBonus = wins > 0 ? Math.min(15, wins * 5) : 0;

  return Math.min(100, ratioToScore(avgRatio) + winBonus);
}

function calcDistanceAptitude(pp: PastPerformance[], targetDistance: number): number {
  if (pp.length === 0) return 50;

  // 距離帯ごとに集計
  const exact = pp.filter(p => Math.abs(p.distance - targetDistance) <= 100);
  const near = pp.filter(p => Math.abs(p.distance - targetDistance) <= 200);
  const wide = pp.filter(p => Math.abs(p.distance - targetDistance) <= 400);

  if (wide.length === 0) return 35; // 完全に未経験距離

  // 近い距離帯ほど重視
  let score = 0;
  let totalWeight = 0;

  if (exact.length > 0) {
    const avgRatio = exact.reduce((s, p) => s + p.position / (p.entries || 16), 0) / exact.length;
    score += ratioToScore(avgRatio) * 3;
    totalWeight += 3;
  }
  if (near.length > 0) {
    const avgRatio = near.reduce((s, p) => s + p.position / (p.entries || 16), 0) / near.length;
    score += ratioToScore(avgRatio) * 2;
    totalWeight += 2;
  }
  if (wide.length > 0) {
    const avgRatio = wide.reduce((s, p) => s + p.position / (p.entries || 16), 0) / wide.length;
    score += ratioToScore(avgRatio) * 1;
    totalWeight += 1;
  }

  return totalWeight > 0 ? Math.min(100, score / totalWeight) : 50;
}

function calcTrackConditionAptitude(pp: PastPerformance[], trackType: TrackType, condition: TrackCondition): number {
  const relevantRaces = pp.filter(p => p.trackType === trackType);
  if (relevantRaces.length === 0) return 50;

  const sameCondition = relevantRaces.filter(p => p.trackCondition === condition);

  // 道悪系はグルーピング（重+不良、良+稍重）
  const isHeavy = condition === '重' || condition === '不良';
  const heavyRaces = relevantRaces.filter(p => p.trackCondition === '重' || p.trackCondition === '不良');

  const targetRaces = sameCondition.length >= 2 ? sameCondition : (isHeavy ? heavyRaces : relevantRaces.filter(p => p.trackCondition === '良' || p.trackCondition === '稍重'));

  if (targetRaces.length === 0) {
    return isHeavy ? 40 : 50;
  }

  const avgRatio = targetRaces.reduce((s, p) => s + p.position / (p.entries || 16), 0) / targetRaces.length;
  return ratioToScore(avgRatio);
}

function calcJockeyScore(winRate: number, placeRate: number): number {
  // 勝率を主軸、複勝率でベースアップ
  const score = (winRate * 100) * 2.5 + (placeRate * 100) * 1.2;
  return Math.min(100, Math.max(10, score));
}

function calcSpeedRating(pp: PastPerformance[], trackType: TrackType, distance: number): number {
  if (pp.length === 0) return 50;

  const relevantRaces = pp.filter(p =>
    p.trackType === trackType &&
    Math.abs(p.distance - distance) <= 200 &&
    p.time
  );

  if (relevantRaces.length === 0) return 50;

  // 標準タイム（秒）のテーブル
  const standardTimes: Record<string, Record<number, number>> = {
    '芝': { 1000: 56.0, 1200: 69.0, 1400: 82.0, 1600: 95.0, 1800: 108.5, 2000: 121.0, 2200: 134.0, 2400: 147.0, 2500: 153.0, 3000: 183.0, 3200: 196.0, 3600: 222.0 },
    'ダート': { 1000: 59.0, 1200: 72.0, 1400: 84.0, 1600: 97.0, 1700: 104.0, 1800: 111.0, 2000: 125.0, 2100: 131.0 },
    '障害': { 3000: 210.0, 3200: 225.0, 3300: 232.0, 3570: 252.0, 3930: 280.0, 4250: 305.0 },
  };

  // スピード指数を計算
  const ratings = relevantRaces.map(p => {
    const seconds = timeToSeconds(p.time);
    if (seconds <= 0) return 0;

    // 距離に応じた標準タイムを補間
    const stdTime = interpolateStandardTime(standardTimes[trackType] || {}, p.distance);
    if (stdTime <= 0) return 50;

    // 馬場差補正
    const condAdj = getConditionAdjustment(p.trackCondition, trackType);

    // スピード指数 = 基準値 + (標準タイム - 実タイム) × 距離補正 + 馬場差
    const timeDiff = stdTime - seconds;
    const rating = 50 + timeDiff * (1000 / p.distance) * 20 + condAdj;

    return Math.max(0, Math.min(100, rating));
  }).filter(r => r > 0);

  if (ratings.length === 0) return 50;

  // ベスト3の平均（安定した能力指標）
  ratings.sort((a, b) => b - a);
  const top3 = ratings.slice(0, 3);
  return top3.reduce((s, r) => s + r, 0) / top3.length;
}

function interpolateStandardTime(table: Record<number, number>, distance: number): number {
  const distances = Object.keys(table).map(Number).sort((a, b) => a - b);
  if (distances.length === 0) return 0;

  // 完全一致
  if (table[distance] !== undefined) return table[distance];

  // 範囲外
  if (distance <= distances[0]) return table[distances[0]] * (distance / distances[0]);
  if (distance >= distances[distances.length - 1]) {
    const last = distances[distances.length - 1];
    return table[last] * (distance / last);
  }

  // 線形補間
  for (let i = 0; i < distances.length - 1; i++) {
    if (distance >= distances[i] && distance <= distances[i + 1]) {
      const ratio = (distance - distances[i]) / (distances[i + 1] - distances[i]);
      return table[distances[i]] + (table[distances[i + 1]] - table[distances[i]]) * ratio;
    }
  }
  return 0;
}

function getConditionAdjustment(condition: TrackCondition | string, trackType: TrackType): number {
  if (trackType === '芝') {
    if (condition === '重') return 3;
    if (condition === '不良') return 5;
    if (condition === '稍重') return 1;
  } else {
    if (condition === '重') return 2;
    if (condition === '不良') return 4;
    if (condition === '稍重') return 1;
  }
  return 0;
}

function calcClassPerformance(pp: PastPerformance[], _grade: string | undefined): number {
  if (pp.length === 0) return 50;

  const gradeRaces = pp.filter(p =>
    p.raceName.includes('G1') || p.raceName.includes('G2') || p.raceName.includes('G3') ||
    p.raceName.includes('ステークス') || p.raceName.includes('賞') || p.raceName.includes('カップ')
  );

  if (gradeRaces.length === 0) return 45;

  const topFinishes = gradeRaces.filter(p => p.position <= 3).length;
  const ratio = topFinishes / gradeRaces.length;

  if (ratio >= 0.5) return 90;
  if (ratio >= 0.3) return 75;
  if (ratio >= 0.15) return 60;
  return 40;
}

// ==================== 新要素 ====================

function calcPostPositionBias(post: number, fieldSize: number, distance: number, trackType: TrackType, racecourseName: string): number {
  if (fieldSize === 0) return 50;

  const posRatio = post / Math.ceil(fieldSize / 2); // 1-8枠中の位置

  // コースごとの枠有利・不利テーブル
  const biasMap: Record<string, Record<string, number>> = {
    '東京': { '芝_inner': 60, '芝_outer': 50, 'ダート_inner': 55, 'ダート_outer': 50 },
    '中山': { '芝_inner': 70, '芝_outer': 40, 'ダート_inner': 65, 'ダート_outer': 45 },
    '阪神': { '芝_inner': 55, '芝_outer': 55, 'ダート_inner': 60, 'ダート_outer': 50 },
    '京都': { '芝_inner': 60, '芝_outer': 50, 'ダート_inner': 55, 'ダート_outer': 50 },
    '小倉': { '芝_inner': 70, '芝_outer': 35, 'ダート_inner': 65, 'ダート_outer': 40 },
    '大井': { 'ダート_inner': 65, 'ダート_outer': 45 },
    '川崎': { 'ダート_inner': 70, 'ダート_outer': 35 },
    '船橋': { 'ダート_inner': 65, 'ダート_outer': 40 },
    '浦和': { 'ダート_inner': 70, 'ダート_outer': 35 },
  };

  const isInner = posRatio <= 1.0;
  const key = `${trackType}_${isInner ? 'inner' : 'outer'}`;
  const courseBias = biasMap[racecourseName]?.[key];

  if (courseBias !== undefined) {
    // 距離が短いほど枠の影響大
    const distFactor = distance <= 1400 ? 1.2 : distance >= 2400 ? 0.7 : 1.0;
    return Math.min(100, Math.max(10, courseBias * distFactor));
  }

  // データがないコースはデフォルト
  return isInner ? 55 : 48;
}

function calcRotation(pp: PastPerformance[]): number {
  if (pp.length === 0) return 50;

  const lastDate = pp[0].date;
  if (!lastDate) return 50;

  const lastRaceDate = new Date(lastDate);
  const today = new Date();
  const daysSinceLast = Math.floor((today.getTime() - lastRaceDate.getTime()) / (1000 * 60 * 60 * 24));

  // 理想的な間隔: 3-8週（21-56日）
  if (daysSinceLast < 10) return 25;  // 連闘は厳しい
  if (daysSinceLast < 14) return 45;  // 中1週
  if (daysSinceLast < 21) return 60;  // 中2週
  if (daysSinceLast <= 35) return 80;  // 中3-4週（理想）
  if (daysSinceLast <= 56) return 75;  // 中5-8週
  if (daysSinceLast <= 84) return 60;  // 中9-12週
  if (daysSinceLast <= 120) return 45; // 中13-17週
  if (daysSinceLast <= 180) return 35; // 半年ぶり
  return 20; // 長期休養明け

  // 叩き良化パターン: 前走が休み明けで凡走→今回は叩き2走目
  // (上記return文で既にreturnされるため、ここは到達しない)
}

function calcLastThreeFurlongs(pp: PastPerformance[], trackType: TrackType): number {
  if (pp.length === 0) return 50;

  const recent = pp.slice(0, 8);
  const times: number[] = [];

  for (const perf of recent) {
    const l3f = perf.lastThreeFurlongs;
    if (!l3f) continue;
    const t = parseFloat(l3f);
    if (t > 0 && t < 50) times.push(t);
  }

  if (times.length === 0) return 50;

  // ベスト上がりとここ3走の平均で評価
  const best = Math.min(...times);
  const recentAvg = times.slice(0, 3).reduce((s, t) => s + t, 0) / Math.min(3, times.length);

  // 基準タイム
  const baseline = trackType === '芝' ? 34.5 : 36.5;

  const bestDiff = baseline - best;
  const avgDiff = baseline - recentAvg;

  // ベスト50%、平均50%で評価
  const bestScore = 50 + bestDiff * 10;
  const avgScore = 50 + avgDiff * 8;

  return Math.min(100, Math.max(10, bestScore * 0.5 + avgScore * 0.5));
}

function calcConsistency(pp: PastPerformance[]): number {
  if (pp.length < 3) return 50;

  const recent = pp.slice(0, 10);
  const ratios = recent.map(p => p.position / (p.entries || 16));

  // 着順比率の標準偏差
  const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const variance = ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / ratios.length;
  const stdDev = Math.sqrt(variance);

  // 標準偏差が小さい＝安定
  if (stdDev <= 0.10) return 90;
  if (stdDev <= 0.15) return 75;
  if (stdDev <= 0.20) return 60;
  if (stdDev <= 0.30) return 45;
  return 30;
}

// ==================== レース分析 ====================

function analyzeRace(scoredHorses: ScoredHorse[], trackType: TrackType, distance: number, condition: TrackCondition, racecourseName: string): RaceAnalysis {
  // 馬場バイアス
  let trackBias = `${racecourseName}${trackType}${distance}m`;

  // コース形態に基づく詳細分析
  const courseInfo = getCourseCharacteristics(racecourseName, trackType, distance);
  if (condition === '重' || condition === '不良') {
    trackBias += `（${condition}馬場）- ${courseInfo}。道悪で内枠有利の傾向が強まる可能性あり。パワー型の馬に注目。`;
  } else if (condition === '稍重') {
    trackBias += `（${condition}馬場）- ${courseInfo}。やや時計がかかる馬場。`;
  } else {
    trackBias += `（${condition}馬場）- ${courseInfo}。`;
  }

  // ペース分析（詳細版）
  const escapers = scoredHorses.filter(h => h.runningStyle === '逃げ');
  const frontRunners = scoredHorses.filter(h => h.runningStyle === '先行');
  const stalkers = scoredHorses.filter(h => h.runningStyle === '差し');
  const closers = scoredHorses.filter(h => h.runningStyle === '追込');
  const forwardTotal = escapers.length + frontRunners.length;

  let paceAnalysis: string;
  if (forwardTotal >= Math.ceil(scoredHorses.length * 0.5)) {
    paceAnalysis = `ハイペース予想。逃げ${escapers.length}頭・先行${frontRunners.length}頭と前に行く馬が多い。前が厳しい展開で、差し・追込馬（${stalkers.length + closers.length}頭）に展開利。後方から一気の末脚を使える馬が有利。`;
  } else if (forwardTotal <= Math.floor(scoredHorses.length * 0.25)) {
    paceAnalysis = `スローペース予想。逃げ${escapers.length}頭・先行${frontRunners.length}頭と先行勢が少ない。${escapers.length <= 1 ? '逃げ馬が楽にハナを切れそうで、前残りに警戒。' : ''}上がり勝負になりやすく、瞬発力のある馬が有利。`;
  } else {
    paceAnalysis = `ミドルペース予想。脚質分布は逃げ${escapers.length}/先行${frontRunners.length}/差し${stalkers.length}/追込${closers.length}とバランスが取れている。実力通りの決着が見込まれる。`;
  }

  // キーファクター
  const keyFactors: string[] = [];
  if (distance >= 2400) keyFactors.push('長距離戦。スタミナと折り合いが鍵。父母の血統的な裏付けも重要');
  else if (distance >= 1800) keyFactors.push('中距離戦。総合力が問われる距離帯');
  else if (distance <= 1200) keyFactors.push('スプリント戦。ゲートの出と前半3Fのスピードが勝敗を左右');
  else if (distance <= 1400) keyFactors.push('短距離戦。先行力とスピードの持続力がカギ');

  if (condition === '重' || condition === '不良') keyFactors.push('道悪適性が勝敗を分ける。パワー型が台頭しやすい');

  // 上がり3F上位馬に注目
  const fastFinishers = scoredHorses.filter(h => h.scores.lastThreeFurlongs >= 70);
  if (fastFinishers.length > 0) {
    keyFactors.push(`上がり3F上位: ${fastFinishers.slice(0, 3).map(h => h.entry.horseName).join('、')}`);
  }

  if (scoredHorses.length >= 2) {
    const gap = scoredHorses[0].totalScore - scoredHorses[1].totalScore;
    keyFactors.push(`1位と2位のスコア差: ${Math.round(gap * 10) / 10}pt`);
  }

  // リスク要因
  const riskFactors: string[] = [];
  if (scoredHorses.length >= 2 && scoredHorses[0].totalScore - scoredHorses[1].totalScore < 3) {
    riskFactors.push('上位馬の差が極めて小さく、波乱含み');
  } else if (scoredHorses.length >= 2 && scoredHorses[0].totalScore - scoredHorses[1].totalScore < 5) {
    riskFactors.push('上位馬の差が小さく、波乱の可能性あり');
  }

  if (scoredHorses.some(sh => sh.entry.odds && sh.entry.odds <= 1.5)) {
    riskFactors.push('断然の1番人気がいるが、過信は禁物');
  }

  const longAbsence = scoredHorses.filter(h => h.scores.rotation <= 35);
  if (longAbsence.length > 0) {
    riskFactors.push(`休養明けの馬あり: ${longAbsence.map(h => h.entry.horseName).join('、')} - 仕上がり次第`);
  }

  const inconsistent = scoredHorses.slice(0, 3).filter(h => h.scores.consistency <= 40);
  if (inconsistent.length > 0) {
    riskFactors.push(`上位予想馬にムラ馬あり: ${inconsistent.map(h => h.entry.horseName).join('、')}`);
  }

  return { trackBias, paceAnalysis, keyFactors, riskFactors };
}

function getCourseCharacteristics(course: string, trackType: TrackType, distance: number): string {
  const info: Record<string, Record<string, string>> = {
    '東京': {
      '芝': '直線が長く（525m）、末脚が活きるコース。瞬発力勝負になりやすい',
      'ダート': '直線が長くスピードの持続力が問われる。差し馬も届きやすい',
    },
    '中山': {
      '芝': '直線が短く（310m）小回り急坂。先行力と坂を上るパワーが重要',
      'ダート': '小回りで先行有利。内枠の逃げ・先行馬に注意',
    },
    '阪神': {
      '芝': `${distance >= 1800 ? '外回り' : '内回り'}。急坂があり、パワーとスタミナの両立が求められる`,
      'ダート': 'コーナーがきつめで、器用さが求められる。先行有利の傾向',
    },
    '京都': {
      '芝': `${distance >= 1800 ? '外回り' : '内回り'}。平坦でスピードが活きる。瞬発力のある差し馬に注意`,
      'ダート': '平坦コースでスピード持続力が問われる',
    },
    '大井': { 'ダート': '大箱コースでスピード持続力が問われる。外回りは差しも決まる' },
    '川崎': { 'ダート': '小回りで先行有利。内枠の逃げ馬が残りやすい' },
    '船橋': { 'ダート': '直線が短く小回り。先行力が重要' },
    '浦和': { 'ダート': '最も小回りのコース。圧倒的に先行有利' },
  };

  return info[course]?.[trackType] || '標準的なコース形態';
}

// ==================== 信頼度 ====================

function calculateConfidence(scoredHorses: ScoredHorse[]): number {
  if (scoredHorses.length < 3) return 25;

  const gap1_2 = scoredHorses[0].totalScore - scoredHorses[1].totalScore;
  const gap1_3 = scoredHorses[0].totalScore - scoredHorses[2].totalScore;

  let confidence = 35;

  // スコア差
  if (gap1_2 > 10) confidence += 20;
  else if (gap1_2 > 7) confidence += 15;
  else if (gap1_2 > 4) confidence += 8;
  else confidence -= 5;

  if (gap1_3 > 15) confidence += 15;
  else if (gap1_3 > 10) confidence += 10;
  else if (gap1_3 > 6) confidence += 5;

  // データの充実度
  const avgNon50 = scoredHorses.reduce((sum, sh) =>
    sum + Object.values(sh.scores).filter(s => s !== 50).length, 0
  ) / scoredHorses.length;
  if (avgNon50 >= 8) confidence += 10;
  else if (avgNon50 >= 5) confidence += 5;

  // 本命馬の安定性ボーナス
  if (scoredHorses[0].scores.consistency >= 70) confidence += 5;

  return Math.min(92, Math.max(15, confidence));
}

// ==================== 推奨馬券 ====================

function generateBetRecommendations(scoredHorses: ScoredHorse[], confidence: number): RecommendedBet[] {
  const bets: RecommendedBet[] = [];
  if (scoredHorses.length < 3) return bets;

  const top = scoredHorses[0];
  const second = scoredHorses[1];
  const third = scoredHorses[2];
  const fourth = scoredHorses[3];
  const gap12 = top.totalScore - second.totalScore;

  // 単勝（本命が抜けている場合）
  if (gap12 > 5 && confidence >= 50) {
    bets.push({
      type: '単勝',
      selections: [top.entry.horseNumber],
      reasoning: `${top.entry.horseName}が総合力で群を抜いている。${top.reasons[0] || ''}。信頼度${confidence}%。`,
      expectedValue: calcExpectedValue(top, scoredHorses),
    });
  }

  // 複勝（安定重視）
  bets.push({
    type: '複勝',
    selections: [top.entry.horseNumber],
    reasoning: `${top.entry.horseName}の3着以内は堅い。安定感重視の馬券。${top.scores.consistency >= 70 ? '着順も安定しており信頼できる。' : ''}`,
    expectedValue: calcExpectedValue(top, scoredHorses) * 0.7,
  });

  // 馬連
  bets.push({
    type: '馬連',
    selections: [top.entry.horseNumber, second.entry.horseNumber],
    reasoning: `${top.entry.horseName}と${second.entry.horseName}の上位2頭。${second.reasons[0] || ''}`,
    expectedValue: (calcExpectedValue(top, scoredHorses) + calcExpectedValue(second, scoredHorses)) / 2,
  });

  // ワイド（本命と穴馬の組み合わせ）
  if (third.totalScore > 40) {
    bets.push({
      type: 'ワイド',
      selections: [top.entry.horseNumber, third.entry.horseNumber],
      reasoning: `${top.entry.horseName}軸で${third.entry.horseName}へ。${third.reasons[0] || '好走条件が揃っている'}`,
      expectedValue: (calcExpectedValue(top, scoredHorses) + calcExpectedValue(third, scoredHorses)) / 2,
    });
  }

  // 三連複
  if (fourth && third.totalScore - fourth.totalScore > 2) {
    bets.push({
      type: '三連複',
      selections: [top.entry.horseNumber, second.entry.horseNumber, third.entry.horseNumber],
      reasoning: `上位3頭で堅く決まる想定。${confidence >= 60 ? '信頼度高め。' : '波乱の余地あり、抑え程度に。'}`,
      expectedValue: (calcExpectedValue(top, scoredHorses) + calcExpectedValue(second, scoredHorses) + calcExpectedValue(third, scoredHorses)) / 3,
    });
  }

  // 馬単（軸が明確な場合）
  if (gap12 > 7 && confidence >= 55) {
    bets.push({
      type: '馬単',
      selections: [top.entry.horseNumber, second.entry.horseNumber],
      reasoning: `${top.entry.horseName}が頭鉄板。2着に${second.entry.horseName}。${gap12 > 10 ? '1着は堅い。' : ''}`,
      expectedValue: calcExpectedValue(top, scoredHorses) * 1.5,
    });
  }

  // 三連単（高信頼度の場合のみ）
  if (gap12 > 8 && confidence >= 65 && fourth && third.totalScore - fourth.totalScore > 3) {
    bets.push({
      type: '三連単',
      selections: [top.entry.horseNumber, second.entry.horseNumber, third.entry.horseNumber],
      reasoning: `高配当狙い。着順まで予想。${top.entry.horseName}→${second.entry.horseName}→${third.entry.horseName}の順。`,
      expectedValue: (calcExpectedValue(top, scoredHorses) + calcExpectedValue(second, scoredHorses) + calcExpectedValue(third, scoredHorses)) / 3 * 2,
    });
  }

  return bets;
}

function calcExpectedValue(horse: ScoredHorse, all: ScoredHorse[]): number {
  const totalScores = all.reduce((sum, h) => sum + h.totalScore, 0);
  if (totalScores === 0) return 1;
  const probability = horse.totalScore / totalScores;
  const odds = horse.entry.odds || (1 / probability);
  return Math.round(probability * odds * 100) / 100;
}

// ==================== サマリー生成 ====================

function generateSummary(topPicks: PredictionPick[], analysis: RaceAnalysis, raceName: string, confidence: number): string {
  const parts: string[] = [];
  parts.push(`【${raceName}の予想】`);
  parts.push('');

  if (topPicks.length > 0) {
    parts.push(`◎本命: ${topPicks[0].horseName}（スコア${topPicks[0].score}）`);
    parts.push(`  → ${topPicks[0].reasons.slice(0, 2).join('。')}`);
  }
  if (topPicks.length > 1) {
    parts.push(`○対抗: ${topPicks[1].horseName}（スコア${topPicks[1].score}）`);
    parts.push(`  → ${topPicks[1].reasons.slice(0, 2).join('。')}`);
  }
  if (topPicks.length > 2) {
    parts.push(`▲単穴: ${topPicks[2].horseName}（スコア${topPicks[2].score}）`);
  }

  parts.push('');
  parts.push(`【展開予想】${analysis.paceAnalysis}`);

  if (analysis.riskFactors.length > 0) {
    parts.push('');
    parts.push(`【注意点】${analysis.riskFactors.join(' / ')}`);
  }

  parts.push('');
  parts.push(`AI信頼度: ${confidence}%`);

  return parts.join('\n');
}

// ==================== ユーティリティ ====================

function positionToScore(position: number, entries: number): number {
  if (entries <= 0) return 50;
  const ratio = position / entries;
  if (ratio <= 0.05) return 100;
  if (position === 1) return 95;
  if (position === 2) return 85;
  if (position === 3) return 75;
  if (ratio <= 0.25) return 65;
  if (ratio <= 0.40) return 50;
  if (ratio <= 0.55) return 38;
  if (ratio <= 0.75) return 22;
  return 8;
}

function ratioToScore(ratio: number): number {
  if (ratio <= 0.10) return 95;
  if (ratio <= 0.15) return 85;
  if (ratio <= 0.20) return 78;
  if (ratio <= 0.25) return 72;
  if (ratio <= 0.30) return 65;
  if (ratio <= 0.40) return 55;
  if (ratio <= 0.50) return 45;
  if (ratio <= 0.65) return 32;
  return 20;
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

// エクスポート
export { scoreHorse as _scoreHorse };
export type { HorseAnalysisInput };
