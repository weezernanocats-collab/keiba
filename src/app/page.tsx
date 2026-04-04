'use client';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import { useApi, formatLastFetched } from '@/hooks/use-api';
import type { BetResultDisplay as BetResult } from '@/types';

interface RaceRow {
  id: string;
  name: string;
  date: string;
  time: string | null;
  racecourseName: string;
  raceNumber: number;
  grade: string | null;
  trackType: string;
  distance: number;
  status: string;
  entryCount: number;
  topOdds: number | null;
}

interface HitRecord {
  raceId: string;
  raceName: string;
  raceDate: string;
  racecourseName: string;
  raceNumber: number;
  grade: string | null;
  winHit: boolean;
  placeHit: boolean;
  roi: number;
  betResults: BetResult[];
  betSummary: {
    totalInvestment: number;
    totalPayout: number;
    totalProfit: number;
  };
  aiPattern: string | null;
  aiConfidence: number | null;
  aiRankingBetResults: { type: string; selections: number[]; hit: boolean }[];
}

interface Stats {
  totalHorses: number;
  totalJockeys: number;
  totalRaces: number;
  upcomingRaces: number;
  totalPredictions: number;
}

function SkeletonRow() {
  return (
    <tr>
      <td colSpan={9} className="px-4 py-3">
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
      </td>
    </tr>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4 text-center">
      <div className="h-8 w-8 mx-auto mb-2 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
      <div className="h-6 w-16 mx-auto mb-1 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
      <div className="h-3 w-12 mx-auto bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
    </div>
  );
}

export default function HomePage() {
  const { data: racesData, isValidating: racesValidating, lastFetched } = useApi<{ races: RaceRow[] }>('/api/races?type=upcoming');
  const { data: resultsData } = useApi<{ races: RaceRow[] }>('/api/races?type=results');
  const { data: hitsData } = useApi<{ history: HitRecord[] }>('/api/predictions/history?limit=10');
  const { data: stats } = useApi<Stats>('/api/stats');

  const upcomingRaces = racesData?.races || [];
  const recentResults = resultsData?.races || [];
  const recentHits = hitsData?.history || [];

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* ヒーローセクション */}
      <section className="bg-gradient-to-r from-primary to-primary-light rounded-2xl p-8 text-white">
        <h1 className="text-3xl md:text-4xl font-bold mb-3">
          KEIBA MASTER
        </h1>
        <p className="text-lg text-white/80 mb-6">
          AIが分析する高精度競馬予想。中央競馬・地方競馬の全レース対応。
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/predictions"
            className="bg-accent hover:bg-accent-light px-6 py-3 rounded-lg font-bold transition-colors"
          >
            AI予想を見る
          </Link>
          <Link
            href="/races"
            className="bg-white/20 hover:bg-white/30 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            レース一覧
          </Link>
          <Link
            href="/stats"
            className="bg-white/20 hover:bg-white/30 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            的中率分析
          </Link>
          <Link
            href="/calendar"
            className="bg-white/20 hover:bg-white/30 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            カレンダー
          </Link>
        </div>
      </section>

      {/* 統計 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats ? (
          [
            { label: '登録馬', value: stats.totalHorses, icon: '🐴' },
            { label: '登録騎手', value: stats.totalJockeys, icon: '🏆' },
            { label: '今後のレース', value: stats.upcomingRaces, icon: '📅' },
            { label: 'AI予想数', value: stats.totalPredictions, icon: '🤖' },
          ].map((s) => (
            <div key={s.label} className="bg-card-bg border border-card-border rounded-xl p-4 text-center">
              <div className="text-2xl mb-1">{s.icon}</div>
              <div className="text-2xl font-bold">{s.value}</div>
              <div className="text-sm text-muted">{s.label}</div>
            </div>
          ))
        ) : (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        )}
      </section>

      {/* 今後のレース */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">📅 今後のレース</h2>
          <div className="flex items-center gap-3">
            {racesValidating ? (
              <span className="text-xs text-muted animate-pulse">更新中...</span>
            ) : lastFetched ? (
              <span className="text-xs text-muted">最終取得: {formatLastFetched(lastFetched)}</span>
            ) : null}
            <Link href="/races" className="text-sm text-accent hover:underline">すべて見る →</Link>
          </div>
        </div>
        <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">日付</th>
                  <th className="px-4 py-3 text-left font-medium">競馬場</th>
                  <th className="px-4 py-3 text-left font-medium">R</th>
                  <th className="px-4 py-3 text-left font-medium">発走</th>
                  <th className="px-4 py-3 text-left font-medium">レース名</th>
                  <th className="px-4 py-3 text-left font-medium">条件</th>
                  <th className="px-4 py-3 text-center font-medium">頭数</th>
                  <th className="px-4 py-3 text-center font-medium">1人気</th>
                  <th className="px-4 py-3 text-center font-medium">予想</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-card-border">
                {upcomingRaces.length > 0 ? (
                  upcomingRaces.slice(0, 10).map((race) => (
                    <tr key={race.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap">{race.date}</td>
                      <td className="px-4 py-3 font-medium">{race.racecourseName}</td>
                      <td className="px-4 py-3">{race.raceNumber}R</td>
                      <td className="px-4 py-3 text-muted whitespace-nowrap">{race.time || '-'}</td>
                      <td className="px-4 py-3">
                        <Link href={`/races/${race.id}`} className="text-accent hover:underline font-medium">
                          {race.name}
                        </Link>
                        {' '}
                        <GradeBadge grade={race.grade} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-muted">{race.trackType}{race.distance}m</td>
                      <td className="px-4 py-3 text-center">{race.entryCount}頭</td>
                      <td className="px-4 py-3 text-center text-muted">
                        {race.topOdds != null ? `${race.topOdds.toFixed(1)}倍` : '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Link
                          href={`/predictions/${race.id}`}
                          className="inline-block bg-accent/10 text-accent px-3 py-1 rounded-full text-xs font-medium hover:bg-accent/20 transition-colors"
                        >
                          予想
                        </Link>
                      </td>
                    </tr>
                  ))
                ) : !racesData ? (
                  Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
                ) : (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-muted">今後のレースはありません</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* AI推奨買い目の直近結果 */}
      {recentHits.length > 0 ? (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold">AI推奨買い目 直近の結果</h2>
            <Link href="/predictions/history" className="text-sm text-accent hover:underline">すべて見る →</Link>
          </div>
          <div className="space-y-3">
            {recentHits.slice(0, 8).map((hit) => {
              // 買い判定バッジ
              const pattern = hit.aiPattern;
              const confidence = hit.aiConfidence ?? 0;
              const hasAiBets = hit.aiRankingBetResults.length > 0;
              let verdictLabel: string;
              let verdictClass: string;
              if ((pattern === '一強' || pattern === '二強') && hasAiBets && confidence >= 60) {
                verdictLabel = '強く推奨'; verdictClass = 'bg-green-500 text-white';
              } else if (hasAiBets && confidence >= 45 && (pattern === '一強' || pattern === '二強' || pattern === '三つ巴')) {
                verdictLabel = '推奨'; verdictClass = 'bg-blue-500 text-white';
              } else if (pattern === '混戦' || !hasAiBets || confidence < 30) {
                verdictLabel = '見送り'; verdictClass = 'bg-gray-400 text-white';
              } else {
                verdictLabel = '様子見'; verdictClass = 'bg-yellow-500 text-white';
              }

              const aiHits = hit.aiRankingBetResults.filter(b => b.hit);
              const aiMisses = hit.aiRankingBetResults.filter(b => !b.hit);

              return (
                <Link
                  key={hit.raceId}
                  href={`/predictions/${hit.raceId}`}
                  className="block bg-card-bg border border-card-border rounded-xl p-4 hover:border-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`${verdictClass} px-2 py-0.5 rounded text-xs font-bold shrink-0`}>{verdictLabel}</span>
                    <span className="text-sm text-muted">{hit.raceDate}</span>
                    <span className="text-sm font-medium">{hit.racecourseName} {hit.raceNumber}R</span>
                    <span className="text-sm font-medium truncate">{hit.raceName}</span>
                    <GradeBadge grade={hit.grade} size="sm" />
                  </div>
                  {hit.aiRankingBetResults.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {aiHits.map((b, i) => (
                        <span key={`hit-${i}`} className="inline-flex items-center gap-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-xs font-bold px-2 py-0.5 rounded-full">
                          {b.type} {b.selections.join('-')} 的中!
                        </span>
                      ))}
                      {aiMisses.map((b, i) => (
                        <span key={`miss-${i}`} className="inline-flex items-center gap-1 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs px-2 py-0.5 rounded-full">
                          {b.type} {b.selections.join('-')} 不的中
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-muted">AI推奨買い目なし</span>
                  )}
                </Link>
              );
            })}
          </div>
        </section>
      ) : recentResults.length > 0 ? (
        <section>
          <h2 className="text-xl font-bold mb-4">最近の結果</h2>
          <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">日付</th>
                    <th className="px-4 py-3 text-left font-medium">競馬場</th>
                    <th className="px-4 py-3 text-left font-medium">レース名</th>
                    <th className="px-4 py-3 text-left font-medium">条件</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-card-border">
                  {recentResults.slice(0, 5).map((race) => (
                    <tr key={race.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap">{race.date}</td>
                      <td className="px-4 py-3 font-medium">{race.racecourseName}</td>
                      <td className="px-4 py-3">
                        <Link href={`/races/${race.id}`} className="text-accent hover:underline">
                          {race.name}
                        </Link>
                        {' '}
                        <GradeBadge grade={race.grade} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-muted">{race.trackType}{race.distance}m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
