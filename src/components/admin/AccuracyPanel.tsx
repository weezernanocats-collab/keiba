'use client';

import { useState, useCallback } from 'react';

export interface AccuracyData {
  totalEvaluated: number;
  winHitRate: number;
  placeHitRate: number;
  avgTop3Coverage: number;
  overallRoi: number;
  totalInvested: number;
  totalReturned: number;
  confidenceCalibration: { range: string; count: number; winHitRate: number; placeHitRate: number; avgRoi: number }[];
  recentTrend: { period: string; count: number; winHitRate: number; placeHitRate: number; roi: number }[];
}

interface AIBetTypeStats {
  bets: number;
  hits: number;
  hitRate: number;
  investment: number;
  returnAmount: number;
  roi: number;
}

interface AIIndependentBetStats {
  totalRaces: number;
  totalBets: number;
  place: AIBetTypeStats;
  win: AIBetTypeStats;
}

interface CalibrationData {
  evaluatedRaces: number;
  factorContributions: { factor: string; weight: number; avgScoreWinners: number; avgScoreLosers: number; discriminationPower: number; suggestedWeight: number }[];
  suggestedWeights: Record<string, number>;
  currentWeights: Record<string, number>;
  expectedImprovement: string;
}

export interface AccuracyPanelProps {
  headers: () => Record<string, string>;
  triggerSync: (type: string, extra?: Record<string, string | boolean>) => Promise<void>;
}

function StatCard({ label, value, color }: { label: string; value: string; color?: 'green' | 'yellow' | 'red' | 'cyan' }) {
  const colorClass = color === 'green' ? 'text-green-300' : color === 'yellow' ? 'text-yellow-300' : color === 'red' ? 'text-red-300' : color === 'cyan' ? 'text-cyan-300' : 'text-white';
  return (
    <div className="bg-gray-800/50 rounded-lg p-3 text-center">
      <div className={`text-xl font-bold ${colorClass}`}>{value}</div>
      <div className="text-xs text-muted mt-0.5">{label}</div>
    </div>
  );
}

export function AccuracyPanel({ headers, triggerSync }: AccuracyPanelProps) {
  const [acc, setAcc] = useState<AccuracyData | null>(null);
  const [aiBetStats, setAiBetStats] = useState<AIIndependentBetStats | null>(null);
  const [cal, setCal] = useState<CalibrationData | null>(null);
  const [repairStatus, setRepairStatus] = useState<string | null>(null);

  const fetchAccuracy = useCallback(async () => {
    try {
      const res = await fetch('/api/sync', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ type: 'accuracy' }),
      });
      const data = await res.json();
      if (data.stats) setAcc(data.stats);
      if (data.aiIndependentBetStats) setAiBetStats(data.aiIndependentBetStats);
    } catch { /* ignore */ }
  }, [headers]);

  const runCalibration = useCallback(async () => {
    try {
      const res = await fetch('/api/sync', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ type: 'calibrate' }),
      });
      const data = await res.json();
      if (data.calibration) setCal(data.calibration);
    } catch { /* ignore */ }
  }, [headers]);

  const runRepairBetsOdds = useCallback(async () => {
    let offset = 0;
    let totalRepaired = 0;
    let totalReEvaluated = 0;

    setRepairStatus('修復中...');
    while (true) {
      try {
        const res = await fetch('/api/sync', {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ type: 'repair_bets_odds', offset }),
        });
        const data = await res.json();
        totalRepaired += data.repaired || 0;
        if (data.done) break;
        offset = data.nextOffset || offset + 10;
        setRepairStatus(`修復中... ${totalRepaired}件修復済`);
      } catch (e) {
        setRepairStatus(`修復エラー: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    setRepairStatus(`修復${totalRepaired}件完了。再評価中...`);
    while (true) {
      try {
        const res = await fetch('/api/sync', {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ type: 'reeval_repaired' }),
        });
        const data = await res.json();
        totalReEvaluated += data.reEvaluated || 0;
        if (data.done) break;
        setRepairStatus(`再評価中... ${totalReEvaluated}件完了`);
      } catch (e) {
        setRepairStatus(`再評価エラー: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    setRepairStatus(`完了: ${totalRepaired}件修復、${totalReEvaluated}件再評価`);
    fetchAccuracy();
  }, [headers, fetchAccuracy]);

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-purple-900/40 text-purple-300">分析</span>
          <h3 className="font-bold text-lg">予想的中率ダッシュボード</h3>
        </div>
      </div>
      <p className="text-sm text-muted mb-3">
        AIの予想精度を確認できます。結果照合はCronで自動実行されますが、手動でも実行できます。
      </p>
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="flex items-center gap-1">
          <button onClick={fetchAccuracy} className="px-3 py-1 text-xs bg-gray-600 text-white rounded hover:bg-gray-500 transition-colors">
            統計表示
          </button>
          <span className="text-[10px] text-muted">現在の統計を読み込む</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => triggerSync('evaluate_all')} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors">
            一括照合
          </button>
          <span className="text-[10px] text-muted">結果未照合の予想を一括で照合</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={runCalibration} className="px-3 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-500 transition-colors">
            ウェイト校正
          </button>
          <span className="text-[10px] text-muted">照合データから最適ウェイトを分析</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={runRepairBetsOdds} disabled={repairStatus !== null && !repairStatus.startsWith('完了') && !repairStatus.startsWith('エラー')} className="px-3 py-1 text-xs bg-orange-600 text-white rounded hover:bg-orange-500 transition-colors disabled:opacity-50">
            オッズ修復
          </button>
          <span className="text-[10px] text-muted">{repairStatus || 'bets_jsonにオッズを補完&再評価'}</span>
        </div>
      </div>

      {!acc ? (
        <p className="text-sm text-muted">「統計表示」をクリックして的中率統計を読み込みます</p>
      ) : acc.totalEvaluated === 0 ? (
        <p className="text-sm text-muted">照合済みレースがありません。結果が確定したレースがあれば「一括照合」を実行してください。</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="照合レース数" value={`${acc.totalEvaluated}`} />
            <StatCard label="単勝的中率" value={`${acc.winHitRate}%`} color={acc.winHitRate >= 15 ? 'green' : acc.winHitRate >= 8 ? 'yellow' : 'red'} />
            <StatCard label="複勝的中率" value={`${acc.placeHitRate}%`} color={acc.placeHitRate >= 40 ? 'green' : acc.placeHitRate >= 25 ? 'yellow' : 'red'} />
            <StatCard label="回収率" value={`${acc.overallRoi}%`} color={acc.overallRoi >= 100 ? 'green' : acc.overallRoi >= 75 ? 'yellow' : 'red'} />
          </div>

          {/* AI独自推奨（No-Oddsモデル）の成績 */}
          {aiBetStats && aiBetStats.totalBets > 0 && (
            <div className="border-t border-cyan-800/50 pt-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-cyan-900/40 text-cyan-300">市場非依存</span>
                <h4 className="text-sm font-medium">AI独自推奨の成績</h4>
                <span className="text-[10px] text-muted">No-Oddsモデルが1番人気と異なる馬を推奨したレース</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                <StatCard label="発動レース数" value={`${aiBetStats.totalRaces}`} color="cyan" />
                <StatCard label="複勝的中率" value={`${aiBetStats.place.hitRate}%`} color={aiBetStats.place.hitRate >= 50 ? 'green' : aiBetStats.place.hitRate >= 30 ? 'yellow' : 'red'} />
                <StatCard label="複勝ROI" value={`${aiBetStats.place.roi}%`} color={aiBetStats.place.roi >= 100 ? 'green' : aiBetStats.place.roi >= 75 ? 'yellow' : 'red'} />
                <StatCard
                  label="複勝収支"
                  value={`${aiBetStats.place.returnAmount - aiBetStats.place.investment >= 0 ? '+' : ''}${(aiBetStats.place.returnAmount - aiBetStats.place.investment).toLocaleString()}円`}
                  color={aiBetStats.place.returnAmount - aiBetStats.place.investment >= 0 ? 'green' : 'red'}
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-card-border text-muted">
                      <th className="py-1 text-left">券種</th>
                      <th className="py-1 text-right">ベット数</th>
                      <th className="py-1 text-right">的中</th>
                      <th className="py-1 text-right">的中率</th>
                      <th className="py-1 text-right">投資額</th>
                      <th className="py-1 text-right">回収額</th>
                      <th className="py-1 text-right">ROI</th>
                      <th className="py-1 text-right">損益</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: '複勝', stats: aiBetStats.place },
                      ...(aiBetStats.win.bets > 0 ? [{ label: '単勝', stats: aiBetStats.win }] : []),
                    ].map(row => {
                      const profit = row.stats.returnAmount - row.stats.investment;
                      return (
                        <tr key={row.label} className="border-b border-card-border/50">
                          <td className="py-1.5 font-medium">{row.label}</td>
                          <td className="py-1.5 text-right">{row.stats.bets}</td>
                          <td className="py-1.5 text-right">{row.stats.hits}</td>
                          <td className="py-1.5 text-right">{row.stats.hitRate}%</td>
                          <td className="py-1.5 text-right">{row.stats.investment.toLocaleString()}円</td>
                          <td className="py-1.5 text-right">{row.stats.returnAmount.toLocaleString()}円</td>
                          <td className={`py-1.5 text-right font-medium ${row.stats.roi >= 100 ? 'text-green-400' : 'text-red-400'}`}>
                            {row.stats.roi}%
                          </td>
                          <td className={`py-1.5 text-right ${profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {profit >= 0 ? '+' : ''}{profit.toLocaleString()}円
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted mt-2">
                100円均一ベット基準。AI独自推奨はオッズ情報を一切使わないNo-Oddsモデルの判断に基づく。
              </p>
            </div>
          )}

          {acc.confidenceCalibration.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">信頼度別 的中率（校正データ）</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-card-border text-muted">
                      <th className="py-1 text-left">信頼度帯</th>
                      <th className="py-1 text-right">件数</th>
                      <th className="py-1 text-right">単勝的中</th>
                      <th className="py-1 text-right">複勝的中</th>
                      <th className="py-1 text-right">ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acc.confidenceCalibration.map(c => (
                      <tr key={c.range} className="border-b border-card-border/50">
                        <td className="py-1.5 font-medium">{c.range}%</td>
                        <td className="py-1.5 text-right">{c.count}</td>
                        <td className="py-1.5 text-right">{c.winHitRate}%</td>
                        <td className="py-1.5 text-right">{c.placeHitRate}%</td>
                        <td className="py-1.5 text-right">{c.avgRoi}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {acc.recentTrend.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">的中率トレンド</h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {acc.recentTrend.map(t => (
                  <div key={t.period} className="bg-gray-800/50 rounded p-2 text-xs text-center">
                    <div className="font-medium mb-1">{t.period} ({t.count}件)</div>
                    <div>単{t.winHitRate}% / 複{t.placeHitRate}% / ROI {t.roi}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {cal && (
            <div className="border-t border-card-border pt-4">
              <h4 className="text-sm font-medium mb-2">ウェイト自動校正分析（{cal.evaluatedRaces}レース分析）</h4>
              <p className="text-xs text-muted mb-3">{cal.expectedImprovement}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-card-border text-muted">
                      <th className="py-1 text-left">ファクター</th>
                      <th className="py-1 text-right">現在</th>
                      <th className="py-1 text-right">推奨</th>
                      <th className="py-1 text-right">変更</th>
                      <th className="py-1 text-right">識別力</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cal.factorContributions.map(fc => {
                      const diff = fc.suggestedWeight - fc.weight;
                      const diffColor = diff > 0.005 ? 'text-green-400' : diff < -0.005 ? 'text-red-400' : 'text-gray-500';
                      return (
                        <tr key={fc.factor} className="border-b border-card-border/50">
                          <td className="py-1">{fc.factor}</td>
                          <td className="py-1 text-right">{(fc.weight * 100).toFixed(1)}%</td>
                          <td className="py-1 text-right font-medium">{(fc.suggestedWeight * 100).toFixed(1)}%</td>
                          <td className={`py-1 text-right ${diffColor}`}>
                            {diff > 0 ? '+' : ''}{(diff * 100).toFixed(1)}%
                          </td>
                          <td className="py-1 text-right">{fc.discriminationPower}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted mt-2">
                識別力 = 1着馬の平均スコア - 非1着馬の平均スコア。高いほど予測に有用。
                推奨値はデータ蓄積に応じて精度が向上します。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
