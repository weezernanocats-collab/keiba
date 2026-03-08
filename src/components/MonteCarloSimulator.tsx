'use client';

import { useState, useCallback } from 'react';

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

interface MonteCarloSimulatorProps {
  bets: Bet[];
  winProbabilities?: Record<number, number>;
}

interface SimResult {
  totalProfit: number;
  roi: number;
  hitCount: number;
}

const NUM_SIMULATIONS = 10000;

export default function MonteCarloSimulator({ bets, winProbabilities }: MonteCarloSimulatorProps) {
  const [results, setResults] = useState<{
    avgRoi: number;
    medianRoi: number;
    profitProb: number;
    percentile5: number;
    percentile95: number;
    distribution: number[];
  } | null>(null);
  const [running, setRunning] = useState(false);

  const runSimulation = useCallback(() => {
    if (!winProbabilities || bets.length === 0) return;
    setRunning(true);

    // 非同期で実行してUIブロックを回避
    setTimeout(() => {
      const simResults: SimResult[] = [];

      for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
        let totalInvest = 0;
        let totalReturn = 0;
        let hits = 0;

        // シミュレーション: ランダムに勝馬を決定（確率ベース）
        // 勝馬をwinProbabilitiesに基づいて決定
        const horses = Object.entries(winProbabilities).map(([num, prob]) => ({
          number: parseInt(num),
          prob,
        }));
        horses.sort((a, b) => b.prob - a.prob);

        const totalProb = horses.reduce((s, h) => s + h.prob, 0);
        const rand = Math.random() * totalProb;
        let cumProb = 0;
        let winner = horses[0].number;
        for (const h of horses) {
          cumProb += h.prob;
          if (rand <= cumProb) {
            winner = h.number;
            break;
          }
        }

        // 2着・3着もシミュレート（残りの馬から確率的に選択）
        const remaining = horses.filter(h => h.number !== winner);
        const rem1Prob = remaining.reduce((s, h) => s + h.prob, 0);
        const rand2 = Math.random() * rem1Prob;
        let cum2 = 0;
        let second = remaining[0]?.number ?? 0;
        for (const h of remaining) {
          cum2 += h.prob;
          if (rand2 <= cum2) {
            second = h.number;
            break;
          }
        }

        const remaining2 = remaining.filter(h => h.number !== second);
        const rem2Prob = remaining2.reduce((s, h) => s + h.prob, 0);
        const rand3 = Math.random() * rem2Prob;
        let cum3 = 0;
        let third = remaining2[0]?.number ?? 0;
        for (const h of remaining2) {
          cum3 += h.prob;
          if (rand3 <= cum3) {
            third = h.number;
            break;
          }
        }

        const top3 = new Set([winner, second, third]);

        for (const bet of bets) {
          const stake = 100;
          totalInvest += stake;
          const odds = bet.odds || bet.expectedValue;

          let hit = false;
          if (bet.type === '単勝') {
            hit = bet.selections[0] === winner;
          } else if (bet.type === '複勝') {
            hit = top3.has(bet.selections[0]);
          } else if (bet.type === '馬連') {
            hit = top3.has(bet.selections[0]) && top3.has(bet.selections[1])
              && (bet.selections.includes(winner) || bet.selections.includes(second));
          } else if (bet.type === 'ワイド') {
            hit = top3.has(bet.selections[0]) && top3.has(bet.selections[1]);
          } else if (bet.type === '馬単') {
            hit = bet.selections[0] === winner && bet.selections[1] === second;
          } else if (bet.type === '三連複') {
            hit = bet.selections.every(s => top3.has(s));
          } else if (bet.type === '三連単') {
            hit = bet.selections[0] === winner
              && bet.selections[1] === second
              && bet.selections[2] === third;
          }

          if (hit) {
            totalReturn += stake * odds;
            hits++;
          }
        }

        simResults.push({
          totalProfit: totalReturn - totalInvest,
          roi: totalInvest > 0 ? totalReturn / totalInvest : 0,
          hitCount: hits,
        });
      }

      // 統計計算
      const rois = simResults.map(r => r.roi).sort((a, b) => a - b);
      const avgRoi = rois.reduce((s, v) => s + v, 0) / rois.length;
      const medianRoi = rois[Math.floor(rois.length / 2)];
      const profitProb = rois.filter(r => r >= 1.0).length / rois.length;
      const percentile5 = rois[Math.floor(rois.length * 0.05)];
      const percentile95 = rois[Math.floor(rois.length * 0.95)];

      // ROI分布のヒストグラム (10ビン)
      const binCount = 10;
      const minRoi = Math.max(0, rois[0]);
      const maxRoi = Math.min(rois[rois.length - 1], avgRoi * 3);
      const binWidth = (maxRoi - minRoi) / binCount;
      const distribution = new Array(binCount).fill(0);
      for (const r of rois) {
        const binIdx = Math.min(binCount - 1, Math.max(0, Math.floor((r - minRoi) / binWidth)));
        distribution[binIdx]++;
      }

      setResults({
        avgRoi: Math.round(avgRoi * 1000) / 10,
        medianRoi: Math.round(medianRoi * 1000) / 10,
        profitProb: Math.round(profitProb * 1000) / 10,
        percentile5: Math.round(percentile5 * 1000) / 10,
        percentile95: Math.round(percentile95 * 1000) / 10,
        distribution,
      });
      setRunning(false);
    }, 50);
  }, [bets, winProbabilities]);

  if (!winProbabilities || Object.keys(winProbabilities).length === 0) return null;

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-6">
      <h2 className="text-lg font-bold mb-2">Monte Carlo Simulation</h2>
      <p className="text-sm text-muted mb-4">
        推奨馬券を{NUM_SIMULATIONS.toLocaleString()}回シミュレートし、収益分布を推定します。
      </p>

      <button
        onClick={runSimulation}
        disabled={running}
        className="bg-primary text-white px-4 py-2 rounded-lg font-medium hover:bg-primary-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {running ? 'シミュレーション中...' : 'シミュレーション実行'}
      </button>

      {results && (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="bg-gray-50 dark:bg-gray-800/30 rounded-lg p-3 text-center">
              <div className="text-xs text-muted">平均ROI</div>
              <div className={`text-lg font-bold ${results.avgRoi >= 100 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {results.avgRoi.toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/30 rounded-lg p-3 text-center">
              <div className="text-xs text-muted">中央値ROI</div>
              <div className={`text-lg font-bold ${results.medianRoi >= 100 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {results.medianRoi.toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/30 rounded-lg p-3 text-center">
              <div className="text-xs text-muted">利益確率</div>
              <div className={`text-lg font-bold ${results.profitProb >= 50 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {results.profitProb.toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/30 rounded-lg p-3 text-center">
              <div className="text-xs text-muted">5%ile</div>
              <div className="text-sm font-mono">{results.percentile5.toFixed(1)}%</div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/30 rounded-lg p-3 text-center">
              <div className="text-xs text-muted">95%ile</div>
              <div className="text-sm font-mono">{results.percentile95.toFixed(1)}%</div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/30 rounded-lg p-3 text-center">
              <div className="text-xs text-muted">試行回数</div>
              <div className="text-sm font-mono">{NUM_SIMULATIONS.toLocaleString()}</div>
            </div>
          </div>

          {/* 簡易ヒストグラム */}
          <div>
            <h3 className="text-sm font-bold text-muted mb-2">ROI分布</h3>
            <div className="flex items-end gap-1 h-20">
              {results.distribution.map((count, i) => {
                const maxCount = Math.max(...results.distribution);
                const height = maxCount > 0 ? (count / maxCount) * 100 : 0;
                return (
                  <div
                    key={i}
                    className="flex-1 bg-primary/60 rounded-t"
                    style={{ height: `${height}%` }}
                    title={`${count}回`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between text-xs text-muted mt-1">
              <span>低</span>
              <span>ROI</span>
              <span>高</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
