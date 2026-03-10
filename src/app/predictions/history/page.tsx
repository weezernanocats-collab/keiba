'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';

interface PickResult {
  rank: number;
  horseNumber: number;
  horseName: string;
  score: number;
  actualPosition: number | null;
  hit: boolean;
  placeHit: boolean;
}

interface BetResult {
  type: string;
  selections: number[];
  odds: number;
  hit: boolean;
  isEstimated: boolean;
  investment: number;
  payout: number;
  profit: number;
}

interface BetSummary {
  totalInvestment: number;
  totalPayout: number;
  totalProfit: number;
}

interface ActualTop3Entry {
  horseNumber: number;
  horseName: string;
}

interface HistoryItem {
  raceId: string;
  raceName: string;
  raceDate: string;
  racecourseName: string;
  raceNumber: number;
  grade: string | null;
  trackType: string;
  distance: number;
  trackCondition: string | null;
  confidence: number;
  summary: string;
  winHit: boolean;
  placeHit: boolean;
  top3PicksHit: number;
  roi: number;
  betReturn: number;
  pickResults: PickResult[];
  betResults: BetResult[];
  betSummary: BetSummary;
  actualTop3: number[];
  actualTop3Detailed?: ActualTop3Entry[];
}

interface Pagination {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
}

const RESULT_FILTERS = [
  { label: '全て', value: '' },
  { label: '単勝的中', value: 'win' },
  { label: '複勝的中', value: 'place' },
  { label: '不的中', value: 'miss' },
  { label: '馬連的中', value: 'umaren' },
  { label: 'ワイド的中', value: 'wide' },
  { label: '馬単的中', value: 'umatan' },
  { label: '三連複的中', value: 'sanrenpuku' },
  { label: '三連単的中', value: 'sanrentan' },
] as const;

const GRADE_FILTERS = [
  { label: '全て', value: '' },
  { label: 'G1', value: 'G1' },
  { label: 'G2', value: 'G2' },
  { label: 'G3', value: 'G3' },
  { label: 'オープン', value: 'オープン' },
  { label: '3勝', value: '3勝クラス' },
  { label: '2勝', value: '2勝クラス' },
  { label: '1勝', value: '1勝クラス' },
  { label: '未勝利', value: '未勝利' },
  { label: '新馬', value: '新馬' },
] as const;

const rankLabels = ['\u25CE', '\u25CB', '\u25B2', '\u25B3', '\u00D7', '\u2606'];

export { PredictionHistoryContent };

export default function PredictionHistoryPage() {
  return <PredictionHistoryContent embedded={false} />;
}

function PredictionHistoryContent({ embedded = false }: { embedded?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [resultFilter, setResultFilter] = useState('');
  const [gradeFilter, setGradeFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (resultFilter) params.set('result', resultFilter);
      if (gradeFilter) params.set('grade', gradeFilter);

      const res = await fetch(`/api/predictions/history?${params}`);
      const data = await res.json();
      setHistory(data.history || []);
      setPagination(data.pagination || null);
    } catch (err) {
      console.error('履歴取得エラー:', err);
    } finally {
      setLoading(false);
    }
  }, [page, resultFilter, gradeFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // フィルタ変更時はページ1に戻す
  const handleFilterChange = (type: 'result' | 'grade', value: string) => {
    if (type === 'result') setResultFilter(value);
    else setGradeFilter(value);
    setPage(1);
  };

  return (
    <div className={`space-y-6 ${embedded ? '' : 'animate-fadeIn'}`}>
      {!embedded && (
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">過去予想の結果</h1>
          <div className="flex gap-2">
            <Link href="/predictions" className="text-sm text-accent hover:underline">予想一覧</Link>
            <span className="text-muted">|</span>
            <Link href="/stats" className="text-sm text-accent hover:underline">統計</Link>
          </div>
        </div>
      )}

      {/* フィルタ */}
      <div className="flex flex-wrap gap-4">
        <div>
          <span className="text-xs text-muted mr-2">結果:</span>
          <div className="inline-flex flex-wrap gap-1">
            {RESULT_FILTERS.map(f => (
              <button
                key={f.value}
                onClick={() => handleFilterChange('result', f.value)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  resultFilter === f.value
                    ? 'bg-primary text-white'
                    : 'bg-card-bg border border-card-border hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="text-xs text-muted mr-2">グレード:</span>
          {GRADE_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => handleFilterChange('grade', f.value)}
              className={`px-3 py-1 rounded text-xs font-medium mr-1 transition-colors ${
                gradeFilter === f.value
                  ? 'bg-primary text-white'
                  : 'bg-card-bg border border-card-border hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <LoadingSpinner message="過去予想を読み込んでいます..." />
      ) : history.length === 0 ? (
        <div className="text-center py-12 text-muted">
          <p>該当する予想結果がありません</p>
        </div>
      ) : (
        <>
          {/* 件数表示 */}
          {pagination && (
            <div className="text-sm text-muted">
              {pagination.totalCount}件中 {(pagination.page - 1) * pagination.limit + 1}-
              {Math.min(pagination.page * pagination.limit, pagination.totalCount)}件を表示
            </div>
          )}

          {/* 予想結果リスト */}
          <div className="space-y-3">
            {history.map(item => (
              <div
                key={item.raceId}
                className="bg-card-bg border border-card-border rounded-xl overflow-hidden"
              >
                {/* ヘッダー部分（クリックで展開） */}
                <button
                  onClick={() => setExpandedId(expandedId === item.raceId ? null : item.raceId)}
                  className="w-full text-left p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-muted shrink-0">{item.raceDate}</span>
                      <GradeBadge grade={item.grade} size="sm" />
                      <span className="font-medium truncate">{item.raceName}</span>
                      <span className="text-xs text-muted shrink-0">
                        {item.racecourseName} {item.trackType}{item.distance}m
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      {item.betSummary.totalInvestment > 0 && (() => {
                        const roi = Math.round(item.betSummary.totalPayout / item.betSummary.totalInvestment * 100);
                        return (
                          <span className={`px-2 py-0.5 text-xs rounded font-bold ${
                            roi >= 100
                              ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
                              : 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300'
                          }`}>
                            ROI {roi}%
                          </span>
                        );
                      })()}
                      {item.winHit && (
                        <span className="text-xs text-green-600 dark:text-green-400 font-medium">単勝</span>
                      )}
                      {!item.winHit && item.placeHit && (
                        <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">複勝</span>
                      )}
                      <span className="text-muted text-sm">{expandedId === item.raceId ? '\u25B2' : '\u25BC'}</span>
                    </div>
                  </div>
                </button>

                {/* 展開時の詳細 */}
                {expandedId === item.raceId && (
                  <div className="border-t border-card-border p-4 space-y-4">
                    {/* 予想 vs 結果: 左右対比レイアウト */}
                    <ComparisonLayout pickResults={item.pickResults} actualTop3Detailed={item.actualTop3Detailed} />

                    {/* 推奨馬券の収支 */}
                    {item.betResults.length > 0 && (
                      <div>
                        <h3 className="text-sm font-bold text-muted mb-2">推奨馬券の収支</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b dark:border-gray-700 text-left text-xs text-muted">
                                <th className="py-1 pr-2">券種</th>
                                <th className="py-1 px-2">買い目</th>
                                <th className="py-1 px-2 text-right">オッズ</th>
                                <th className="py-1 px-2 text-center">結果</th>
                                <th className="py-1 px-2 text-right">ROI</th>
                              </tr>
                            </thead>
                            <tbody>
                              {item.betResults.map((bet, idx) => (
                                <tr key={idx} className="border-b dark:border-gray-800">
                                  <td className="py-1.5 pr-2 font-medium">{bet.type}</td>
                                  <td className="py-1.5 px-2 font-mono">{bet.selections.join('-')}</td>
                                  <td className="py-1.5 px-2 text-right font-mono">
                                    {bet.odds > 0 ? `${bet.odds.toFixed(1)}倍` : '-'}
                                    {bet.isEstimated && bet.odds > 0 && (
                                      <span className="text-xs text-muted ml-0.5">(推定)</span>
                                    )}
                                  </td>
                                  <td className="py-1.5 px-2 text-center">
                                    {bet.hit ? (
                                      <span className="px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 text-xs rounded font-bold">
                                        的中
                                      </span>
                                    ) : (
                                      <span className="text-xs text-gray-400">不的中</span>
                                    )}
                                  </td>
                                  <td className={`py-1.5 px-2 text-right font-bold font-mono ${
                                    bet.payout >= bet.investment ? 'text-green-600' : 'text-red-500'
                                  }`}>
                                    {bet.investment > 0 ? Math.round(bet.payout / bet.investment * 100) : 0}%
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr className="border-t-2 dark:border-gray-600 font-bold">
                                <td colSpan={2} className="py-2 pr-2">合計</td>
                                <td className="py-2 px-2 text-right text-xs text-muted">
                                  投資{item.betSummary.totalInvestment.toLocaleString()}円
                                </td>
                                <td className="py-2 px-2 text-center text-xs text-muted">
                                  回収{item.betSummary.totalPayout.toLocaleString()}円
                                </td>
                                <td className={`py-2 px-2 text-right font-mono ${
                                  item.betSummary.totalPayout >= item.betSummary.totalInvestment ? 'text-green-600' : 'text-red-500'
                                }`}>
                                  ROI {item.betSummary.totalInvestment > 0 ? Math.round(item.betSummary.totalPayout / item.betSummary.totalInvestment * 100) : 0}%
                                </td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* 詳細リンク */}
                    <div className="text-right">
                      <Link
                        href={`/predictions/${item.raceId}`}
                        className="text-sm text-accent hover:underline"
                      >
                        詳細を見る &rarr;
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ページネーション */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex justify-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-card-bg border border-card-border disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                前へ
              </button>
              <span className="px-4 py-2 text-sm text-muted">
                {pagination.page} / {pagination.totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                disabled={page >= pagination.totalPages}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-card-bg border border-card-border disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                次へ
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 左右対比レイアウト: AI予想順 vs 実着順 */
function ComparisonLayout({
  pickResults,
  actualTop3Detailed,
}: {
  pickResults: PickResult[];
  actualTop3Detailed?: ActualTop3Entry[];
}) {
  // 予想印から馬番→印のマップ作成
  const pickMarkMap = new Map<number, string>();
  pickResults.forEach((p, i) => {
    pickMarkMap.set(p.horseNumber, rankLabels[i] || '\u2606');
  });

  return (
    <div>
      <h3 className="text-sm font-bold text-muted mb-2">AI予想 vs 実着順</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 左: AI予想順 */}
        <div>
          <div className="text-xs text-muted font-medium mb-1 text-center">AI予想順</div>
          <div className="space-y-1">
            {pickResults.map((pick, idx) => {
              const mark = rankLabels[idx] || '\u2606';
              const posColor = pick.hit
                ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700'
                : pick.placeHit
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700'
                  : 'bg-gray-50 dark:bg-gray-800/30 border-gray-200 dark:border-gray-700';
              return (
                <div key={pick.horseNumber} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${posColor}`}>
                  <span className="font-bold text-sm w-5 text-center">{mark}</span>
                  <span className="font-mono text-xs w-6 text-center">{pick.horseNumber}</span>
                  <span className="text-sm flex-1 truncate">{pick.horseName}</span>
                  <span className="text-xs text-muted">
                    {pick.actualPosition ? (
                      <span className={`font-bold ${pick.hit ? 'text-green-600 dark:text-green-400' : pick.placeHit ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'}`}>
                        &rarr;{pick.actualPosition}着
                      </span>
                    ) : '-'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 右: 実着順 */}
        <div>
          <div className="text-xs text-muted font-medium mb-1 text-center">実着順</div>
          <div className="space-y-1">
            {(actualTop3Detailed && actualTop3Detailed.length > 0
              ? actualTop3Detailed
              : []
            ).map((entry, i) => {
              const mark = pickMarkMap.get(entry.horseNumber);
              const isPredicted = !!mark;
              const bgColor = i === 0
                ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700'
                : 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700';
              return (
                <div key={entry.horseNumber} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${bgColor}`}>
                  <span className="font-bold text-sm w-6 text-center text-amber-600 dark:text-amber-400">
                    {i + 1}着
                  </span>
                  <span className="font-mono text-xs w-6 text-center">{entry.horseNumber}</span>
                  <span className="text-sm flex-1 truncate">{entry.horseName}</span>
                  <span className="text-xs">
                    {isPredicted ? (
                      <span className="font-bold text-primary">&larr;{mark}</span>
                    ) : (
                      <span className="text-gray-400">圏外</span>
                    )}
                  </span>
                </div>
              );
            })}
            {(!actualTop3Detailed || actualTop3Detailed.length === 0) && (
              <div className="text-center py-4 text-muted text-xs">着順データなし</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
