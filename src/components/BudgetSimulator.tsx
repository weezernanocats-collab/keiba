'use client';

import { useState } from 'react';

interface Bet {
  type: string;
  selections: number[];
  reasoning: string;
  expectedValue: number;
  odds?: number;
  kellyFraction?: number;
  valueEdge?: number;
  recommendedStake?: number;
}

interface BudgetSimulatorProps {
  bets: Bet[];
  riskLevel: 'low' | 'medium' | 'high';
}

export default function BudgetSimulator({ bets, riskLevel }: BudgetSimulatorProps) {
  const [budget, setBudget] = useState(1000);

  if (bets.length === 0) return null;

  // リスクレベルに基づく配分比率
  const allocations = getAllocations(bets, riskLevel, budget);

  // 回収シナリオ
  const allHitReturn = allocations.reduce((sum, a) => sum + (a.bet.odds ? a.amount * a.bet.odds : a.amount * a.bet.expectedValue), 0);
  const mainHits = allocations.filter(a => a.category === '主力');
  const mainHitReturn = mainHits.reduce((sum, a) => sum + (a.bet.odds ? a.amount * a.bet.odds : a.amount * a.bet.expectedValue), 0);

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-6">
      <h2 className="text-lg font-bold mb-2">💰 金額シミュレーション</h2>
      <p className="text-sm text-muted mb-4">
        上の「推奨馬券」を実際に購入する場合の配分例です。
        投資金額を入力すると、AIの戦略（リスク: {riskLevel === 'low' ? '低' : riskLevel === 'medium' ? '中' : '高'}）に基づいて
        主力・バリュー・押さえに自動配分します。
      </p>

      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm font-medium whitespace-nowrap">投資金額:</label>
        <input
          type="number"
          value={budget}
          onChange={(e) => setBudget(Math.max(100, Math.round(Number(e.target.value) / 100) * 100))}
          step={100}
          min={100}
          className="w-28 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-right bg-white dark:bg-gray-800"
        />
        <span className="text-sm">円</span>
        <div className="flex gap-1 ml-2">
          {[1000, 3000, 5000, 10000].map(v => (
            <button
              key={v}
              onClick={() => setBudget(v)}
              className={`px-2 py-1 text-xs rounded ${budget === v ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
            >
              {v >= 10000 ? `${v / 10000}万` : `${v}`}
            </button>
          ))}
        </div>
      </div>

      {/* 配分テーブル */}
      <div className="overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b dark:border-gray-700">
              <th className="text-left py-2">券種</th>
              <th className="text-left py-2">買い目</th>
              <th className="text-right py-2">金額</th>
              <th className="text-right py-2">オッズ</th>
              <th className="text-right py-2">的中時回収</th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((a, i) => (
              <tr key={i} className="border-b dark:border-gray-800">
                <td className="py-2">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    a.category === '主力' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300'
                    : a.category === 'バリュー' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                  }`}>
                    {a.category}
                  </span>
                  <span className="ml-1">{a.bet.type}</span>
                </td>
                <td className="py-2 font-mono">{a.bet.selections.join('-')}</td>
                <td className="py-2 text-right font-mono">{a.amount.toLocaleString()}円</td>
                <td className="py-2 text-right font-mono">
                  {a.bet.odds ? `${a.bet.odds.toFixed(1)}倍` : '-'}
                </td>
                <td className="py-2 text-right font-mono">
                  {a.bet.odds
                    ? `${Math.round(a.amount * a.bet.odds).toLocaleString()}円`
                    : '-'
                  }
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold">
              <td colSpan={2} className="py-2">合計</td>
              <td className="py-2 text-right">{allocations.reduce((s, a) => s + a.amount, 0).toLocaleString()}円</td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 回収シナリオ */}
      <h3 className="text-sm font-bold text-muted mb-2">回収シナリオ</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 rounded-lg p-3">
          <div className="text-xs text-green-600 dark:text-green-400 font-medium">全的中時</div>
          <div className="text-lg font-bold text-green-700 dark:text-green-300">
            {Math.round(allHitReturn).toLocaleString()}円
          </div>
          <div className="text-xs text-green-600 dark:text-green-400">
            回収率: {budget > 0 ? Math.round(allHitReturn / budget * 100) : 0}%
          </div>
        </div>
        {mainHits.length > 0 && (
          <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
            <div className="text-xs text-blue-600 dark:text-blue-400 font-medium">主力的中時</div>
            <div className="text-lg font-bold text-blue-700 dark:text-blue-300">
              {Math.round(mainHitReturn).toLocaleString()}円
            </div>
            <div className="text-xs text-blue-600 dark:text-blue-400">
              回収率: {budget > 0 ? Math.round(mainHitReturn / budget * 100) : 0}%
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface Allocation {
  bet: Bet;
  category: '主力' | 'バリュー' | '押さえ';
  amount: number;
}

function getAllocations(bets: Bet[], riskLevel: string, budget: number): Allocation[] {
  // カテゴリ分類
  const categorized = bets.map(bet => {
    let category: '主力' | 'バリュー' | '押さえ' = '押さえ';
    if (bet.reasoning.startsWith('【主力】')) category = '主力';
    else if (bet.reasoning.startsWith('【バリュー】')) category = 'バリュー';
    return { bet, category };
  });

  // Kelly Criterion ベース配分が可能か
  const hasKelly = categorized.some(c => c.bet.recommendedStake && c.bet.recommendedStake > 0);

  if (hasKelly) {
    // Kelly Criterion ベースの配分
    const riskMultiplier = riskLevel === 'low' ? 0.5 : riskLevel === 'medium' ? 0.75 : 1.0;
    const rawAllocations = categorized.map(({ bet, category }) => {
      const stake = (bet.recommendedStake || 0) * riskMultiplier;
      return { bet, category, stake };
    });

    // 正規化: 合計が100%を超えないようにスケール
    const totalStake = rawAllocations.reduce((s, a) => s + a.stake, 0);
    const scale = totalStake > 1 ? 1 / totalStake : 1;

    return rawAllocations.map(({ bet, category, stake }) => {
      const fraction = stake * scale;
      const rawAmount = budget * fraction;
      const amount = Math.max(100, Math.round(rawAmount / 100) * 100);
      return { bet, category, amount };
    });
  }

  // フォールバック: 従来のリスクレベルベース配分
  const ratios = riskLevel === 'low'
    ? { '主力': 0.6, 'バリュー': 0.25, '押さえ': 0.15 }
    : riskLevel === 'medium'
    ? { '主力': 0.5, 'バリュー': 0.3, '押さえ': 0.2 }
    : { '主力': 0.4, 'バリュー': 0.35, '押さえ': 0.25 };

  const counts = { '主力': 0, 'バリュー': 0, '押さえ': 0 };
  for (const c of categorized) counts[c.category]++;

  return categorized.map(({ bet, category }) => {
    const count = counts[category] || 1;
    const categoryBudget = budget * (ratios[category] || 0.2);
    const rawAmount = categoryBudget / count;
    const amount = Math.max(100, Math.round(rawAmount / 100) * 100);
    return { bet, category, amount };
  });
}
