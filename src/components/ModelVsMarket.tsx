'use client';

import type { MarketAnalysisEntry as MarketEntry } from '@/types';

interface Props {
  marketAnalysis: Record<number, MarketEntry>;
  valueHorses: number[];
  overround: number;
  /** 馬番→馬名のマップ（topPicksから構築） */
  horseNames: Record<number, string>;
}

export default function ModelVsMarket({ marketAnalysis, valueHorses, overround, horseNames }: Props) {
  const entries = Object.entries(marketAnalysis)
    .map(([hn, data]) => ({ horseNumber: Number(hn), ...data }))
    .sort((a, b) => b.disagreement - a.disagreement);

  if (entries.length === 0) return null;

  const maxProb = Math.max(...entries.map(e => Math.max(e.modelProb, e.marketProb)));

  const getLabel = (disagreement: number): { text: string; color: string } => {
    if (disagreement >= 0.05) return { text: '妙味大', color: 'text-amber-600 dark:text-amber-400' };
    if (disagreement >= 0.03) return { text: '妙味あり', color: 'text-amber-600 dark:text-amber-400' };
    if (disagreement <= -0.05) return { text: '過大評価', color: 'text-red-500 dark:text-red-400' };
    if (disagreement <= -0.03) return { text: 'やや過大', color: 'text-red-400 dark:text-red-300' };
    return { text: '適正', color: 'text-gray-500 dark:text-gray-400' };
  };

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">📊 モデル vs 市場オッズ</h2>
        <span className="text-xs text-muted">
          オーバーラウンド: {((overround - 1) * 100).toFixed(1)}%
        </span>
      </div>

      {/* 凡例 */}
      <div className="flex gap-4 mb-4 text-xs text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-blue-500" /> モデル確率
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-orange-400" /> 市場確率
        </span>
      </div>

      {/* 妙味馬ハイライト */}
      {valueHorses.length > 0 && (
        <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <p className="text-sm font-bold text-amber-700 dark:text-amber-300 mb-1">
            妙味馬（モデルが市場より高評価）
          </p>
          <div className="flex flex-wrap gap-2">
            {valueHorses.map(hn => {
              const data = marketAnalysis[hn];
              const name = horseNames[hn] || `${hn}番`;
              return (
                <span key={hn} className="text-xs bg-amber-100 dark:bg-amber-800/40 text-amber-800 dark:text-amber-200 px-2 py-1 rounded">
                  {hn}番 {name} (+{(data.disagreement * 100).toFixed(1)}%)
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* 比較テーブル */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted border-b border-card-border">
              <th className="py-2 pr-2 w-16">馬番</th>
              <th className="py-2 pr-2">馬名</th>
              <th className="py-2 pr-2 w-24 text-right">モデル</th>
              <th className="py-2 pr-2 w-24 text-right">市場</th>
              <th className="py-2 px-2">比較</th>
              <th className="py-2 pr-2 w-20 text-right">差分</th>
              <th className="py-2 w-20 text-center">評価</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => {
              const label = getLabel(e.disagreement);
              const modelWidth = maxProb > 0 ? (e.modelProb / maxProb) * 100 : 0;
              const marketWidth = maxProb > 0 ? (e.marketProb / maxProb) * 100 : 0;
              const name = horseNames[e.horseNumber] || '';
              return (
                <tr
                  key={e.horseNumber}
                  className={`border-b border-card-border/50 ${e.isValue ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}`}
                >
                  <td className="py-2 pr-2 font-bold">{e.horseNumber}</td>
                  <td className="py-2 pr-2 truncate max-w-[120px]">{name}</td>
                  <td className="py-2 pr-2 text-right font-mono">{(e.modelProb * 100).toFixed(1)}%</td>
                  <td className="py-2 pr-2 text-right font-mono">{(e.marketProb * 100).toFixed(1)}%</td>
                  <td className="py-2 px-2">
                    <div className="space-y-1">
                      <div className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full"
                          style={{ width: `${modelWidth}%` }}
                        />
                      </div>
                      <div className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-orange-400 rounded-full"
                          style={{ width: `${marketWidth}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className={`py-2 pr-2 text-right font-mono ${e.disagreement >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-500 dark:text-red-400'}`}>
                    {e.disagreement >= 0 ? '+' : ''}{(e.disagreement * 100).toFixed(1)}%
                  </td>
                  <td className={`py-2 text-center text-xs font-bold ${label.color}`}>
                    {label.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted">
        ※ 差分 = モデル確率 - 市場確率。正の値はモデルが市場より高く評価している馬。
      </p>
    </div>
  );
}
