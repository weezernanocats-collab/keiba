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
  odds?: number;
  hit: boolean;
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
  actualTop3: number[];
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
] as const;

const GRADE_FILTERS = [
  { label: '全て', value: '' },
  { label: 'G1', value: 'G1' },
  { label: 'G2', value: 'G2' },
  { label: 'G3', value: 'G3' },
  { label: 'オープン', value: 'オープン' },
] as const;

const rankLabels = ['\u25CE', '\u25CB', '\u25B2', '\u25B3', '\u00D7', '\u2606'];

export default function PredictionHistoryPage() {
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
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">過去予想の結果</h1>
        <div className="flex gap-2">
          <Link href="/predictions" className="text-sm text-accent hover:underline">予想一覧</Link>
          <span className="text-muted">|</span>
          <Link href="/stats" className="text-sm text-accent hover:underline">統計</Link>
        </div>
      </div>

      {/* フィルタ */}
      <div className="flex flex-wrap gap-4">
        <div>
          <span className="text-xs text-muted mr-2">結果:</span>
          {RESULT_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => handleFilterChange('result', f.value)}
              className={`px-3 py-1 rounded text-xs font-medium mr-1 transition-colors ${
                resultFilter === f.value
                  ? 'bg-primary text-white'
                  : 'bg-card-bg border border-card-border hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {f.label}
            </button>
          ))}
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
                      {item.winHit && (
                        <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 text-xs rounded font-bold">
                          単勝的中
                        </span>
                      )}
                      {!item.winHit && item.placeHit && (
                        <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-xs rounded font-bold">
                          複勝的中
                        </span>
                      )}
                      {!item.winHit && !item.placeHit && (
                        <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 text-xs rounded">
                          不的中
                        </span>
                      )}
                      <span className={`text-sm font-bold ${item.roi > 0 ? 'text-green-600' : 'text-red-500'}`}>
                        {item.roi > 0 ? '+' : ''}{item.roi}%
                      </span>
                      <span className="text-muted text-sm">{expandedId === item.raceId ? '\u25B2' : '\u25BC'}</span>
                    </div>
                  </div>
                </button>

                {/* 展開時の詳細 */}
                {expandedId === item.raceId && (
                  <div className="border-t border-card-border p-4 space-y-4">
                    {/* 予想 vs 結果テーブル */}
                    <div>
                      <h3 className="text-sm font-bold text-muted mb-2">予想印 vs 実着順</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b dark:border-gray-700 text-left text-xs text-muted">
                              <th className="py-1 pr-2">印</th>
                              <th className="py-1 px-2">馬番</th>
                              <th className="py-1 px-2">馬名</th>
                              <th className="py-1 px-2 text-right">スコア</th>
                              <th className="py-1 px-2 text-center">着順</th>
                              <th className="py-1 px-2 text-center">判定</th>
                            </tr>
                          </thead>
                          <tbody>
                            {item.pickResults.map((pick, idx) => (
                              <tr key={pick.horseNumber} className="border-b dark:border-gray-800">
                                <td className="py-1.5 pr-2 font-bold">{rankLabels[idx] || '\u2606'}</td>
                                <td className="py-1.5 px-2 font-mono">{pick.horseNumber}</td>
                                <td className="py-1.5 px-2">{pick.horseName}</td>
                                <td className="py-1.5 px-2 text-right font-mono">{pick.score}</td>
                                <td className="py-1.5 px-2 text-center font-bold">
                                  {pick.actualPosition ? `${pick.actualPosition}着` : '-'}
                                </td>
                                <td className="py-1.5 px-2 text-center">
                                  {pick.hit && (
                                    <span className="px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 text-xs rounded font-bold">
                                      1着
                                    </span>
                                  )}
                                  {!pick.hit && pick.placeHit && (
                                    <span className="px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-xs rounded font-bold">
                                      複勝圏
                                    </span>
                                  )}
                                  {!pick.hit && !pick.placeHit && pick.actualPosition && (
                                    <span className="text-xs text-gray-400">-</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* 推奨馬券の結果 */}
                    {item.betResults.length > 0 && (
                      <div>
                        <h3 className="text-sm font-bold text-muted mb-2">推奨馬券の結果</h3>
                        <div className="flex flex-wrap gap-2">
                          {item.betResults.map((bet, idx) => (
                            <span key={idx} className={`px-2 py-1 rounded text-xs font-medium ${
                              bet.hit
                                ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 border border-green-300'
                                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 border border-gray-300 dark:border-gray-600'
                            }`}>
                              {bet.type} {bet.selections.join('-')}
                              {bet.odds ? ` (${bet.odds.toFixed(1)}倍)` : ''}
                              {bet.hit ? ' 的中' : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 実際のTop3 */}
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <span>実際の上位3頭:</span>
                      {item.actualTop3.map((num, i) => (
                        <span key={num} className="px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 rounded font-bold">
                          {i + 1}着: {num}番
                        </span>
                      ))}
                    </div>

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
