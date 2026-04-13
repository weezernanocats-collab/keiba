/**
 * 走破タイム標準化 + ペース特徴量 + L3F特徴量
 *
 * export-training-data.ts と prediction-engine.ts の両方から使う共通ロジック。
 * train/inference の特徴量一致を保証するため、計算は全てここに集約する。
 */

// ==================== タイムパーサー ====================

/** "1:34.8" → 94.8秒。パース不能なら 0 */
export function parseTimeToSeconds(timeStr: string | null | undefined): number {
  if (!timeStr || timeStr === '**' || timeStr === '') return 0;
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    const min = parseInt(parts[0], 10);
    const sec = parseFloat(parts[1]);
    if (!Number.isFinite(min) || !Number.isFinite(sec)) return 0;
    return min * 60 + sec;
  }
  const sec = parseFloat(timeStr);
  return Number.isFinite(sec) ? sec : 0;
}

/** "35.2" → 35.2秒。"34.1-34.7"（ハイフン付き=取消/2頭分）は 0 */
export function parseLastThreeFurlongs(l3fStr: string | null | undefined): number {
  if (!l3fStr || l3fStr === '' || l3fStr.includes('-')) return 0;
  const v = parseFloat(l3fStr);
  return Number.isFinite(v) && v > 20 && v < 50 ? v : 0;
}

// ==================== 基準タイムテーブル ====================

const STATIC_TIMES: Record<string, Record<number, number>> = {
  '芝': { 1000: 56.0, 1200: 69.0, 1400: 82.0, 1600: 95.0, 1800: 108.5, 2000: 121.0, 2200: 134.0, 2400: 147.0, 2500: 153.0, 3000: 183.0, 3200: 196.0, 3600: 222.0 },
  'ダート': { 1000: 59.0, 1200: 72.0, 1400: 84.0, 1600: 97.0, 1700: 104.0, 1800: 111.0, 2000: 125.0, 2100: 131.0 },
  'ダ': { 1000: 59.0, 1200: 72.0, 1400: 84.0, 1600: 97.0, 1700: 104.0, 1800: 111.0, 2000: 125.0, 2100: 131.0 },
};

function interpolateStdTime(table: Record<number, number>, distance: number): number {
  const distances = Object.keys(table).map(Number).sort((a, b) => a - b);
  if (distances.length === 0) return 0;
  if (table[distance] !== undefined) return table[distance];
  if (distance <= distances[0]) return table[distances[0]] * (distance / distances[0]);
  if (distance >= distances[distances.length - 1]) {
    const last = distances[distances.length - 1];
    return table[last] * (distance / last);
  }
  for (let i = 0; i < distances.length - 1; i++) {
    if (distance >= distances[i] && distance <= distances[i + 1]) {
      const denom = distances[i + 1] - distances[i];
      const ratio = denom > 0 ? (distance - distances[i]) / denom : 0;
      return table[distances[i]] + (table[distances[i + 1]] - table[distances[i]]) * ratio;
    }
  }
  return 0;
}

/** 馬場補正（良=0基準、重/不良ではタイムが遅くなる分を秒で返す） */
function conditionTimeAdj(condition: string, trackType: string, distance: number): number {
  const perFurlong = distance / 200;
  const isTurf = trackType === '芝';
  if (isTurf) {
    if (condition === '稍重' || condition === '稍') return perFurlong * 0.1;
    if (condition === '重') return perFurlong * 0.25;
    if (condition === '不良') return perFurlong * 0.4;
  } else {
    if (condition === '稍重' || condition === '稍') return perFurlong * -0.05;
    if (condition === '重') return perFurlong * -0.1;
    if (condition === '不良') return perFurlong * 0.05;
  }
  return 0;
}

/** 基準タイムを取得（秒）。馬場補正込み */
function getStandardTime(trackType: string, distance: number, condition: string): number {
  const table = STATIC_TIMES[trackType];
  if (!table) return 0;
  const base = interpolateStdTime(table, distance);
  if (base <= 0) return 0;
  return base + conditionTimeAdj(condition, trackType, distance);
}

// ==================== 走破タイム標準化 ====================

interface PastPerfForTime {
  time: string | null | undefined;
  trackType: string;
  distance: number;
  trackCondition: string | null | undefined;
  position: number;
}

/**
 * 1走分のタイム偏差を計算。
 * 正=基準より速い、負=基準より遅い。
 * 計算不能な場合は null。
 */
function calcSingleTimeDev(perf: PastPerfForTime): number | null {
  const seconds = parseTimeToSeconds(perf.time);
  if (seconds <= 0 || perf.distance <= 0) return null;
  if (perf.position >= 99) return null; // 取消・中止

  const stdTime = getStandardTime(perf.trackType, perf.distance, perf.trackCondition || '良');
  if (stdTime <= 0) return null;

  // (基準 - 実走) / 基準 * 100 → 正=速い
  return ((stdTime - seconds) / stdTime) * 100;
}

const TIME_WEIGHTS = [0.35, 0.25, 0.20, 0.12, 0.08];

export interface TimeFeatures {
  standardTimeDev: number;   // 直近5走の加重平均偏差
  bestTimeDev: number;       // 過去最高偏差
  timeConsistency: number;   // 偏差の標準偏差（安定性の逆数）
}

export function calcTimeFeatures(pastPerfs: PastPerfForTime[]): TimeFeatures {
  const devs: number[] = [];
  for (const p of pastPerfs) {
    if (devs.length >= 10) break; // 最大10走
    const d = calcSingleTimeDev(p);
    if (d !== null) devs.push(d);
  }

  if (devs.length === 0) {
    return { standardTimeDev: 0, bestTimeDev: 0, timeConsistency: 0 };
  }

  // 加重平均（直近5走）
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < Math.min(devs.length, TIME_WEIGHTS.length); i++) {
    weightedSum += devs[i] * TIME_WEIGHTS[i];
    weightTotal += TIME_WEIGHTS[i];
  }
  const standardTimeDev = weightTotal > 0 ? weightedSum / weightTotal : 0;

  // ベスト
  const bestTimeDev = Math.max(...devs);

  // 標準偏差（安定性）
  const mean = devs.reduce((s, v) => s + v, 0) / devs.length;
  const variance = devs.reduce((s, v) => s + (v - mean) ** 2, 0) / devs.length;
  const timeConsistency = Math.sqrt(variance);

  return { standardTimeDev, bestTimeDev, timeConsistency };
}

// ==================== ペース特徴量（corner_positionsベース） ====================

interface PastPerfForPace {
  cornerPositions: string | null | undefined;
  entries: number;
  position: number;
}

/**
 * corner_positionsをパースして数値配列を返す。
 * "3-3-2-1" → [3, 3, 2, 1]
 */
function parseCornerPositions(cp: string | null | undefined): number[] {
  if (!cp || cp === '') return [];
  return cp.split('-').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0);
}

export interface PaceFeatures {
  earlyPositionRatio: number;  // 第1コーナー相対位置 (0=先頭, 1=最後方)
  positionGainAvg: number;     // コーナー間の位置上昇量 (正=差してくる)
}

const PACE_WEIGHTS = [0.35, 0.25, 0.20, 0.12, 0.08];

export function calcPaceFeatures(pastPerfs: PastPerfForPace[]): PaceFeatures {
  const earlyRatios: number[] = [];
  const posGains: number[] = [];

  for (const p of pastPerfs) {
    if (earlyRatios.length >= 5) break;
    if (p.position >= 99) continue; // 取消
    const corners = parseCornerPositions(p.cornerPositions);
    if (corners.length === 0 || p.entries <= 0) continue;

    // 第1コーナーの相対位置
    earlyRatios.push((corners[0] - 1) / Math.max(p.entries - 1, 1));

    // 位置変化: 第1コーナー → 最終コーナー（正=差してくる）
    if (corners.length >= 2) {
      const gain = (corners[0] - corners[corners.length - 1]) / Math.max(p.entries - 1, 1);
      posGains.push(gain);
    }
  }

  // 加重平均
  let earlyPositionRatio = 0.5; // デフォルト=中間
  if (earlyRatios.length > 0) {
    let ws = 0, wt = 0;
    for (let i = 0; i < earlyRatios.length; i++) {
      const w = PACE_WEIGHTS[i] ?? 0.05;
      ws += earlyRatios[i] * w;
      wt += w;
    }
    earlyPositionRatio = wt > 0 ? ws / wt : 0.5;
  }

  let positionGainAvg = 0;
  if (posGains.length > 0) {
    let ws = 0, wt = 0;
    for (let i = 0; i < posGains.length; i++) {
      const w = PACE_WEIGHTS[i] ?? 0.05;
      ws += posGains[i] * w;
      wt += w;
    }
    positionGainAvg = wt > 0 ? ws / wt : 0;
  }

  return { earlyPositionRatio, positionGainAvg };
}

// ==================== 上がり3F相対特徴量 ====================

interface PastPerfForL3f {
  lastThreeFurlongs: string | null | undefined;
  distance: number;
  trackType: string;
  position: number;
}

// 距離帯別の基準L3F（秒）: 良馬場での概算中央値
const BASE_L3F: Record<string, Record<string, number>> = {
  '芝': { short: 34.5, mile: 35.0, long: 35.5 },
  'ダート': { short: 37.0, mile: 37.5, long: 38.0 },
  'ダ': { short: 37.0, mile: 37.5, long: 38.0 },
};

function getBaseL3f(trackType: string, distance: number): number {
  const t = BASE_L3F[trackType];
  if (!t) return 36.0;
  if (distance <= 1400) return t.short;
  if (distance <= 1800) return t.mile;
  return t.long;
}

export function calcL3fRelative(pastPerfs: PastPerfForL3f[]): number {
  const diffs: number[] = [];
  for (const p of pastPerfs) {
    if (diffs.length >= 5) break;
    if (p.position >= 99) continue;
    const l3f = parseLastThreeFurlongs(p.lastThreeFurlongs);
    if (l3f <= 0) continue;

    const base = getBaseL3f(p.trackType, p.distance);
    // 正=基準より速い切れ味
    diffs.push(base - l3f);
  }

  if (diffs.length === 0) return 0;

  // 加重平均
  let ws = 0, wt = 0;
  for (let i = 0; i < diffs.length; i++) {
    const w = PACE_WEIGHTS[i] ?? 0.05;
    ws += diffs[i] * w;
    wt += w;
  }
  return wt > 0 ? ws / wt : 0;
}

// ==================== テン3F推定（前半ペース） ====================

/**
 * 前半タイム推定: 走破タイム − 上がり3F
 * 距離で正規化して200mあたりのペースを返す（秒/200m）
 *
 * 1200m: 前半 = テン3F そのもの（600m区間）
 * 1400m+: 前半 = スタート〜残り600m地点の区間タイム
 */
interface PastPerfForEarlySpeed {
  time: string | null | undefined;
  lastThreeFurlongs: string | null | undefined;
  distance: number;
  cornerPositions: string | null | undefined;
  entries: number;
  position: number;
}

export interface EarlySpeedProfile {
  /** 前半ペース（秒/200m）- 小さいほど速い */
  earlyPacePer200m: number;
  /** 同距離帯平均との差（秒/200m）- 負=平均より速い */
  earlyPaceRelative: number;
  /** サンプル数 */
  sampleCount: number;
}

// 距離帯別の前半ペース基準値（秒/200m）: 実データ75,473走から算出
// 前半タイム = 走破タイム - L3F。前半距離 = distance - 600m。ペース = 前半タイム / (前半距離/200)
const EARLY_PACE_BASELINES: Record<string, Record<number, number>> = {
  '芝': {
    1200: 11.55,
    1400: 11.80,  // 1200と1600の中間推定
    1600: 12.00,
    1800: 12.21,
    2000: 12.28,
    2200: 12.35,
    2400: 12.40,
  },
  'ダート': {
    1200: 11.79,
    1400: 12.29,
    1600: 12.45,  // 1400と1800の中間推定
    1700: 12.55,
    1800: 12.65,
    2000: 12.70,
  },
};

function getEarlyPaceBaseline(trackType: string, distance: number): number {
  const table = EARLY_PACE_BASELINES[trackType] || EARLY_PACE_BASELINES['ダート'];
  if (!table) return 12.2;
  const dists = Object.keys(table).map(Number).sort((a, b) => a - b);
  // 最も近い距離の基準値を返す
  let closest = dists[0];
  let minDiff = Math.abs(distance - closest);
  for (const d of dists) {
    const diff = Math.abs(distance - d);
    if (diff < minDiff) { closest = d; minDiff = diff; }
  }
  return table[closest];
}

export function calcEarlySpeedProfile(
  pastPerfs: PastPerfForEarlySpeed[],
  trackType: string = '芝',
): EarlySpeedProfile {
  const paces: number[] = [];

  for (const p of pastPerfs) {
    if (paces.length >= 5) break;
    if (p.position >= 99) continue;
    if (!p.distance || p.distance < 1000) continue;

    const totalSec = parseTimeToSeconds(p.time);
    const l3fSec = parseLastThreeFurlongs(p.lastThreeFurlongs);
    if (totalSec <= 0 || l3fSec <= 0) continue;

    const firstPartSec = totalSec - l3fSec;
    const firstPartDist = p.distance - 600;
    if (firstPartDist <= 0) continue;

    const pacePer200m = firstPartSec / (firstPartDist / 200);
    if (pacePer200m < 8 || pacePer200m > 18) continue; // 異常値除外

    paces.push(pacePer200m);
  }

  if (paces.length === 0) {
    return { earlyPacePer200m: 0, earlyPaceRelative: 0, sampleCount: 0 };
  }

  // 加重平均（直近重視）
  let ws = 0, wt = 0;
  for (let i = 0; i < paces.length; i++) {
    const w = PACE_WEIGHTS[i] ?? 0.05;
    ws += paces[i] * w;
    wt += w;
  }
  const earlyPacePer200m = wt > 0 ? ws / wt : paces[0];

  // 基準値との差
  const baseline = getEarlyPaceBaseline(trackType, pastPerfs[0]?.distance || 1600);
  const earlyPaceRelative = earlyPacePer200m - baseline;

  return { earlyPacePer200m, earlyPaceRelative, sampleCount: paces.length };
}

// ==================== 1角2番手確保スコア ====================

export interface FirstCornerScore {
  /** 1角2番手以内の確保スコア (0-100)。高いほど確保しやすい */
  score: number;
  /** 判定理由 */
  factors: string[];
}

/**
 * レースコンテキストを考慮した1角2番手確保スコア
 *
 * 考慮要素:
 * 1. 自馬のテン（前半ペース）の速さ
 * 2. 同レース内の逃げ馬の数
 * 3. 自馬より内枠にいる逃げ馬の数
 * 4. 自馬の過去の先行成功率
 */
export function calcFirstCornerScore(
  horse: {
    earlySpeed: EarlySpeedProfile;
    postPosition: number;
    frontCount: number;     // 過去10走の1角1-2番手回数
    totalRaces: number;     // 過去10走のJRA出走数
  },
  rivals: {
    earlySpeed: EarlySpeedProfile;
    postPosition: number;
    frontCount: number;
  }[],
): FirstCornerScore {
  const factors: string[] = [];
  let score = 50; // 基本スコア

  // 1. 自馬の前半ペース（速いほど+）
  if (horse.earlySpeed.sampleCount > 0) {
    const rel = horse.earlySpeed.earlyPaceRelative;
    if (rel <= -0.3) { score += 15; factors.push(`テン速い(${rel.toFixed(2)}s/200m)`); }
    else if (rel <= -0.1) { score += 8; factors.push(`テンやや速い`); }
    else if (rel >= 0.3) { score -= 10; factors.push(`テン遅い`); }
  }

  // 2. 自馬の先行成功率
  if (horse.totalRaces > 0) {
    const rate = horse.frontCount / horse.totalRaces;
    if (rate >= 0.5) { score += 15; factors.push(`先行率${(rate * 100).toFixed(0)}%`); }
    else if (rate >= 0.3) { score += 8; factors.push(`先行率${(rate * 100).toFixed(0)}%`); }
    else { score -= 5; }
  }

  // 3. 同レース内の逃げ馬数（テンが速い馬 = earlyPaceRelative < -0.1 & frontCount >= 2）
  const fastRivals = rivals.filter(r =>
    r.earlySpeed.sampleCount > 0 && r.earlySpeed.earlyPaceRelative < -0.1 && r.frontCount >= 2
  );
  if (fastRivals.length === 0) {
    score += 15;
    factors.push('同型なし');
  } else if (fastRivals.length === 1) {
    score += 5;
    factors.push(`同型1頭`);
  } else {
    score -= 10 * (fastRivals.length - 1);
    factors.push(`同型${fastRivals.length}頭(競合)`);
  }

  // 4. 内枠の速い馬の存在（自分より内にテンが速い逃げ馬 → 不利）
  const innerFast = fastRivals.filter(r => r.postPosition < horse.postPosition);
  if (innerFast.length >= 2) {
    score -= 15;
    factors.push(`内枠に速い馬${innerFast.length}頭`);
  } else if (innerFast.length === 1) {
    score -= 5;
    factors.push('内枠に速い馬1頭');
  }

  return { score: Math.max(0, Math.min(100, score)), factors };
}
