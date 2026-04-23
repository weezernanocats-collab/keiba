/**
 * 馬券配分計算エンジン
 *
 * - 合成オッズ計算
 * - 均等払い戻し配分（どの組み合わせが当たっても同額になるよう配分）
 * - 均等金額配分（全組み合わせに同額ずつ）
 */

export interface BetCombination {
  /** 組み合わせラベル（例: "1-2", "3"） */
  label: string;
  /** 現在のオッズ */
  odds: number;
}

export interface BetAllocation {
  /** 組み合わせラベル */
  label: string;
  /** オッズ */
  odds: number;
  /** 配分金額（100円単位） */
  amount: number;
  /** この組み合わせが的中した場合の払い戻し */
  payout: number;
}

export interface BetCalculationResult {
  /** 合成オッズ */
  syntheticOdds: number;
  /** 条件クリアしたか */
  conditionMet: boolean;
  /** 各組み合わせの配分 */
  allocations: BetAllocation[];
  /** 実際の合計投資額（丸め後） */
  totalInvestment: number;
  /** 的中時の期待払い戻し（最小値） */
  minPayout: number;
  /** 実質回収率 */
  actualROI: number;
}

/**
 * 合成オッズを計算する
 * 合成オッズ = 1 / Σ(1/odds_i)
 */
export function calculateSyntheticOdds(combinations: BetCombination[]): number {
  const sumInverseOdds = combinations.reduce((sum, c) => sum + 1 / c.odds, 0);
  return 1 / sumInverseOdds;
}

/**
 * 均等払い戻し配分を計算する
 * どの組み合わせが的中しても同じ金額が戻るように配分
 *
 * bet_i = budget * (1/odds_i) / Σ(1/odds_j)
 * → 100円単位に丸め
 */
export function calculateEqualPayoutDistribution(
  combinations: BetCombination[],
  budget: number,
  minSyntheticOdds: number,
): BetCalculationResult {
  const syntheticOdds = calculateSyntheticOdds(combinations);
  const conditionMet = syntheticOdds >= minSyntheticOdds;

  const sumInverseOdds = combinations.reduce((sum, c) => sum + 1 / c.odds, 0);

  const allocations: BetAllocation[] = combinations.map(c => {
    // 理論値
    const rawAmount = budget * (1 / c.odds) / sumInverseOdds;
    // 100円単位に丸め（切り上げ: 賭け金が足りないと損するため）
    const amount = Math.max(100, Math.ceil(rawAmount / 100) * 100);
    return {
      label: c.label,
      odds: c.odds,
      amount,
      payout: Math.floor(amount * c.odds),
    };
  });

  const totalInvestment = allocations.reduce((sum, a) => sum + a.amount, 0);
  const minPayout = Math.min(...allocations.map(a => a.payout));
  const actualROI = totalInvestment > 0 ? minPayout / totalInvestment : 0;

  return {
    syntheticOdds: Math.round(syntheticOdds * 100) / 100,
    conditionMet,
    allocations,
    totalInvestment,
    minPayout,
    actualROI: Math.round(actualROI * 1000) / 1000,
  };
}

/**
 * 均等金額配分を計算する
 * 全組み合わせに同額ずつ賭ける
 */
export function calculateEqualAmountDistribution(
  combinations: BetCombination[],
  budget: number,
  minSyntheticOdds: number,
): BetCalculationResult {
  const syntheticOdds = calculateSyntheticOdds(combinations);
  const conditionMet = syntheticOdds >= minSyntheticOdds;

  const amountPerBet = Math.max(100, Math.floor(budget / combinations.length / 100) * 100);

  const allocations: BetAllocation[] = combinations.map(c => ({
    label: c.label,
    odds: c.odds,
    amount: amountPerBet,
    payout: Math.floor(amountPerBet * c.odds),
  }));

  const totalInvestment = allocations.reduce((sum, a) => sum + a.amount, 0);
  const minPayout = Math.min(...allocations.map(a => a.payout));
  const actualROI = totalInvestment > 0 ? minPayout / totalInvestment : 0;

  return {
    syntheticOdds: Math.round(syntheticOdds * 100) / 100,
    conditionMet,
    allocations,
    totalInvestment,
    minPayout,
    actualROI: Math.round(actualROI * 1000) / 1000,
  };
}

/**
 * 通知用テキストを生成
 */
export function formatBetNotification(
  raceLabel: string,
  betType: string,
  result: BetCalculationResult,
): string {
  const lines: string[] = [];

  if (result.conditionMet) {
    lines.push(`${raceLabel} ${betType} 条件クリア!`);
  } else {
    lines.push(`${raceLabel} ${betType} 条件未達`);
  }

  lines.push(`合成オッズ: ${result.syntheticOdds}倍`);
  lines.push('');

  for (const a of result.allocations) {
    lines.push(`${a.label} ${a.odds}倍 → ${a.amount.toLocaleString()}円 (的中時${a.payout.toLocaleString()}円)`);
  }

  lines.push('');
  lines.push(`合計: ${result.totalInvestment.toLocaleString()}円`);
  lines.push(`最低払戻: ${result.minPayout.toLocaleString()}円`);
  lines.push(`実質回収率: ${Math.round(result.actualROI * 100)}%`);

  return lines.join('\n');
}
