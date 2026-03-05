/**
 * ペース予測強化モジュール
 *
 * コンテキスト依存の動的ペースボーナスを計算する。
 * - 過去の前残り率データ
 * - ペーストラップ検出（逃げ1頭×スローペース）
 * - グレード/馬場状態によるペース補正
 */

// ---------- 型定義 ----------

export interface PacePerformanceRow {
  cornerPositions: string;  // "3-3-2-1" 形式
  position: number;         // 着順
  entries: number;          // 出走頭数
}

export interface HistoricalPaceProfile {
  sampleSize: number;
  frontRunnerWinRate: number;     // 4角3番手以内 → 勝利の割合
  closerWinRate: number;          // 4角後方半分 → 勝利の割合
  loneFrontRunnerWinRate: number; // 逃げ1頭時の勝率
}

/** prediction-engine.ts の ScoredHorse と互換のインターフェース */
export interface PaceScoredHorse {
  totalScore: number;
  scores: Record<string, number>;
  reasons: string[];
  runningStyle: string;
}

type PaceType = 'ハイ' | 'ミドル' | 'スロー';

// ---------- ペースプロファイル算出 ----------

/** 過去コーナー通過順データからペースプロファイルを算出する */
export function computePaceProfile(
  perfRows: PacePerformanceRow[],
): HistoricalPaceProfile | null {
  if (perfRows.length < 20) return null;

  const winners = perfRows.filter(r => r.position === 1);
  if (winners.length === 0) return null;

  let frontRunnerWins = 0;
  let closerWins = 0;

  for (const w of winners) {
    const corners = w.cornerPositions.split('-').map(Number);
    const lastCorner = corners[corners.length - 1];
    if (Number.isNaN(lastCorner)) continue;

    const frontThreshold = Math.ceil(w.entries * 0.25);
    const rearThreshold = Math.ceil(w.entries * 0.5);

    if (lastCorner <= frontThreshold) frontRunnerWins++;
    if (lastCorner > rearThreshold) closerWins++;
  }

  // 逃げ馬（1角1番手）の勝率
  const escaperRows = perfRows.filter(r => {
    const first = Number(r.cornerPositions.split('-')[0]);
    return first === 1;
  });
  const escaperWins = escaperRows.filter(r => r.position === 1).length;

  return {
    sampleSize: perfRows.length,
    frontRunnerWinRate: frontRunnerWins / winners.length,
    closerWinRate: closerWins / winners.length,
    loneFrontRunnerWinRate:
      escaperRows.length > 0 ? escaperWins / escaperRows.length : 0,
  };
}

// ---------- 強化ペースボーナス ----------

/** コンテキスト依存の動的ペースボーナスを各馬に適用する */
export function applyEnhancedPaceBonus(
  horses: PaceScoredHorse[],
  distance: number,
  grade: string | undefined,
  trackCondition: string,
  paceProfile: HistoricalPaceProfile | null,
): void {
  // 1. ペースタイプ判定
  const escapers = horses.filter(h => h.runningStyle === '逃げ').length;
  const frontRunners = horses.filter(h => h.runningStyle === '先行').length;
  const forwardTotal = escapers + frontRunners;

  let paceType: PaceType;
  if (forwardTotal >= Math.ceil(horses.length * 0.5)) {
    paceType = 'ハイ';
  } else if (forwardTotal <= Math.floor(horses.length * 0.25)) {
    paceType = 'スロー';
  } else {
    paceType = 'ミドル';
  }

  // 2. 脚質別ベースボーナス
  const bonus: Record<string, number> = {
    '逃げ': 0, '先行': 0, '差し': 0, '追込': 0, '不明': 0,
  };

  if (paceType === 'ハイ') {
    bonus['逃げ'] = -4;
    bonus['先行'] = -2;
    bonus['差し'] = 3;
    bonus['追込'] = 5;
  } else if (paceType === 'スロー') {
    bonus['逃げ'] = escapers <= 1 ? 6 : 3;
    bonus['先行'] = 3;
    bonus['差し'] = -2;
    bonus['追込'] = -5;
  }

  // 3. ペーストラップ検出: スロー×逃げ1頭 → 追加ボーナス
  if (paceType === 'スロー' && escapers === 1) {
    bonus['逃げ'] += 2;
  }

  // 4. グレード補正（G1はペースが上がりやすい）
  if (grade) {
    const gradeMultiplier = grade.includes('G1')
      ? 1.15
      : grade.includes('G2')
        ? 1.08
        : 1.0;
    for (const style of Object.keys(bonus)) {
      bonus[style] = bonus[style] * gradeMultiplier;
    }
  }

  // 5. 馬場状態補正（重・不良は前が止まりやすい）
  if (trackCondition === '重' || trackCondition === '不良') {
    bonus['逃げ'] -= 1;
    bonus['差し'] += 1;
    bonus['追込'] += 1;
  }

  // 6. 過去ペースプロファイル補正
  if (paceProfile) {
    if (paceProfile.frontRunnerWinRate > 0.55) {
      bonus['逃げ'] += 2;
      bonus['先行'] += 1;
    } else if (paceProfile.frontRunnerWinRate < 0.35) {
      bonus['差し'] += 1;
      bonus['追込'] += 1;
    }
    if (paceProfile.loneFrontRunnerWinRate > 0.40 && escapers === 1) {
      bonus['逃げ'] += 2;
    }
  }

  // 7. 距離ファクター
  const distFactor = distance <= 1400 ? 1.3 : distance <= 1800 ? 1.0 : 0.8;

  // 8. 適用
  for (const horse of horses) {
    const b = (bonus[horse.runningStyle] ?? 0) * distFactor;
    horse.totalScore += b;
    horse.scores['paceBonus'] = b;
    if (b >= 3) {
      horse.reasons.push(`展開利あり（${paceType}ペースで${horse.runningStyle}有利）`);
    } else if (b <= -3) {
      horse.reasons.push(`展開不利（${paceType}ペースで${horse.runningStyle}不利）`);
    }
  }
}

// ---------- ペース分析テキスト生成 ----------

/** ペースプロファイルの分析テキストを生成する */
export function generatePaceAnalysisText(
  horses: PaceScoredHorse[],
  paceProfile: HistoricalPaceProfile | null,
): string {
  if (!paceProfile) return '';

  const escaperCount = horses.filter(h => h.runningStyle === '逃げ').length;
  const frontPct = Math.round(paceProfile.frontRunnerWinRate * 100);
  const lonePct = Math.round(paceProfile.loneFrontRunnerWinRate * 100);

  let text = `過去データ(${paceProfile.sampleSize}R): 前残り率${frontPct}%。`;

  if (escaperCount === 1 && paceProfile.loneFrontRunnerWinRate > 0.30) {
    text += `逃げ馬1頭の場合の勝率は${lonePct}%と高い。`;
  } else if (paceProfile.closerWinRate > 0.40) {
    const closerPct = Math.round(paceProfile.closerWinRate * 100);
    text += `差し・追込の勝率${closerPct}%と後方有利の傾向。`;
  }

  return text;
}
