'use client';
import { Suspense, useState, useMemo, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import ConfidenceBadge from '@/components/ConfidenceBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import FavoriteProfilePopover from '@/components/FavoriteProfilePopover';
import { useFavorites } from '@/lib/use-favorites';
import { useApi, useDeferredApi, formatLastFetched } from '@/hooks/use-api';
import type { BetTypeStat } from '@/types';
import { PredictionHistoryContent } from './history/page';

interface RaceRow {
  id: string;
  name: string;
  date: string;
  time?: string;
  racecourseName: string;
  raceNumber: number;
  grade: string | null;
  trackType: string;
  distance: number;
  trackCondition: string | null;
  weather: string | null;
  status: string;
  entryCount: number;
  confidence: number | null;
  predictionGeneratedAt: string | null;
}

interface PredBet {
  type: string;
  selections: number[];
  reasoning: string;
  expectedValue: number;
  odds?: number;
  kellyFraction?: number;
  valueEdge?: number;
  recommendedStake?: number;
  hitProbability?: number;
}

interface PredPick {
  rank: number;
  horseNumber: number;
  horseName: string;
  score: number;
  runningStyle?: string;
}

interface PredCache {
  topPicks: PredPick[];
  recommendedBets: PredBet[];
  confidence: number;
}


const TABS = [
  { key: 'upcoming', label: 'AI予想' },
  { key: 'history', label: '過去予想' },
] as const;

type TabKey = typeof TABS[number]['key'];

export default function PredictionsPage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <PredictionsPageInner />
    </Suspense>
  );
}

function PredictionsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialTab = (searchParams.get('tab') === 'history' ? 'history' : 'upcoming') as TabKey;
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);

  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab);
    const url = tab === 'history' ? '/predictions?tab=history' : '/predictions';
    router.replace(url, { scroll: false });
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* ヘッダー + タブ */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold">AI予想</h1>
          <Link href="/stats" className="text-sm text-accent hover:underline">
            的中率分析
          </Link>
        </div>
        <div className="flex border-b border-card-border">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => handleTabChange(tab.key)}
              className={`px-5 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === tab.key
                  ? 'text-primary'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              {tab.label}
              {activeTab === tab.key && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* タブコンテンツ */}
      {activeTab === 'upcoming' ? (
        <UpcomingRaces />
      ) : (
        <PredictionHistoryContent embedded />
      )}
    </div>
  );
}

const rankLabels = ['\u25CE', '\u25CB', '\u25B2', '\u25B3', '\u00D7', '\u2606'];

function UpcomingRaces() {
  const { data: racesData, isValidating, lastFetched } = useApi<{ races: RaceRow[] }>('/api/races?type=upcoming');
  const { data: statsData } = useDeferredApi<{ betTypeStats: BetTypeStat[] }>('/api/accuracy-stats');

  const races = racesData?.races || [];
  const betTypeStats = statsData?.betTypeStats || [];
  const loading = !racesData;

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [predCache, setPredCache] = useState<Map<string, PredCache>>(new Map());
  const [loadingPred, setLoadingPred] = useState<string | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<string>('all');
  const { isRaceFavoriteInProfile, toggleRaceForProfile } = useFavorites();

  const betTypeStatsMap = useMemo(
    () => new Map(betTypeStats.map(s => [s.type, s])),
    [betTypeStats],
  );

  const handleExpand = useCallback(async (raceId: string) => {
    if (expandedId === raceId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(raceId);
    if (predCache.has(raceId)) return;

    setLoadingPred(raceId);
    try {
      const res = await fetch(`/api/predictions/${raceId}`);
      const data = await res.json();
      if (data.prediction) {
        setPredCache(prev => {
          const next = new Map(prev);
          next.set(raceId, {
            topPicks: data.prediction.topPicks || [],
            recommendedBets: data.prediction.recommendedBets || [],
            confidence: data.prediction.confidence || 0,
          });
          return next;
        });
      }
    } catch (err) {
      console.error('予想取得エラー:', err);
    } finally {
      setLoadingPred(null);
    }
  }, [expandedId, predCache]);

  const filteredRaces = useMemo(() => {
    if (confidenceFilter === 'all') return races;
    return races.filter(r => {
      if (confidenceFilter === 'high') return r.confidence != null && r.confidence >= 70;
      if (confidenceFilter === 'mid') return r.confidence != null && r.confidence >= 50 && r.confidence < 70;
      if (confidenceFilter === 'low') return r.confidence != null && r.confidence < 50;
      if (confidenceFilter === 'none') return r.confidence == null;
      return true;
    });
  }, [races, confidenceFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, RaceRow[]>();
    for (const race of filteredRaces) {
      const key = race.date;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(race);
    }
    return map;
  }, [filteredRaces]);

  if (loading) return <LoadingSpinner />;

  if (races.length === 0) {
    return (
      <div className="text-center py-12 text-muted">
        <p className="text-lg">予想可能なレースがありません</p>
        <p className="text-sm mt-2">次の開催日をお待ちください</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted text-sm">
          過去の成績データを多角的に分析し、各レースの予想を提供します。タップで推奨馬券を表示します。
        </p>
        <div className="flex items-center gap-2 ml-auto">
          {isValidating ? (
            <span className="text-xs text-muted animate-pulse">更新中...</span>
          ) : lastFetched ? (
            <span className="text-xs text-muted">最終取得: {formatLastFetched(lastFetched)}</span>
          ) : null}
          <select
            className="px-3 py-2 text-sm border border-card-border rounded-lg bg-card-bg"
            value={confidenceFilter}
            onChange={e => setConfidenceFilter(e.target.value)}
          >
            <option value="all">全信頼度</option>
            <option value="high">高 (70%+)</option>
            <option value="mid">中 (50-69%)</option>
            <option value="low">低 (&lt;50%)</option>
            <option value="none">未算出</option>
          </select>
          <span className="text-sm text-muted">{filteredRaces.length}件</span>
        </div>
      </div>
      {[...grouped.entries()].map(([date, dateRaces]) => (
        <div key={date}>
          <h2 className="text-lg font-bold mb-2 border-b border-card-border pb-1">{date}</h2>
          <div className="space-y-2">
            {dateRaces.map(race => {
              const isExpanded = expandedId === race.id;
              const pred = predCache.get(race.id);
              const isLoadingThis = loadingPred === race.id;

              return (
                <div
                  key={race.id}
                  className="bg-card-bg border border-card-border rounded-xl overflow-hidden"
                >
                  {/* ヘッダー部分（クリックで展開） */}
                  <button
                    onClick={() => handleExpand(race.id)}
                    className="w-full text-left p-3 md:p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-muted shrink-0">{race.raceNumber}R</span>
                        <GradeBadge grade={race.grade} size="sm" />
                        <span className="font-medium truncate">{race.name}</span>
                        {race.time && <span className="text-xs text-muted shrink-0">{race.time}</span>}
                        <span className="text-xs text-muted shrink-0 hidden sm:inline">
                          {race.racecourseName} {race.trackType}{race.distance}m
                          {race.trackCondition ? ` / ${race.trackCondition}` : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-xs text-muted hidden sm:inline">{race.entryCount}頭</span>
                        {race.predictionGeneratedAt && (
                          <span className="text-xs text-muted hidden sm:inline">
                            生成: {new Date(race.predictionGeneratedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                        <ConfidenceBadge value={race.confidence} />
                        <FavoriteProfilePopover
                          checkFavorite={(p) => isRaceFavoriteInProfile(race.id, p)}
                          onToggle={(p) => toggleRaceForProfile(race.id, p)}
                          size="sm"
                        />
                        <span className="text-muted text-sm">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                      </div>
                    </div>
                    {/* モバイル補助行 */}
                    <div className="sm:hidden text-xs text-muted mt-1">
                      {race.racecourseName} {race.trackType}{race.distance}m {race.entryCount}頭
                      {race.time && ` / ${race.time}`}
                      {race.predictionGeneratedAt && (
                        <span className="ml-2">
                          生成: {new Date(race.predictionGeneratedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </button>

                  {/* 展開時の詳細 */}
                  {isExpanded && (
                    <div className="border-t border-card-border p-4 space-y-4">
                      {isLoadingThis ? (
                        <div className="text-center py-4 text-muted text-sm">読み込み中...</div>
                      ) : pred ? (
                        <>
                          {/* 予想印サマリー */}
                          {pred.topPicks.length > 0 && (
                            <div>
                              <h3 className="text-sm font-bold text-muted mb-2">AI予想印</h3>
                              <div className="flex flex-wrap gap-2">
                                {pred.topPicks.slice(0, 6).map((pick, idx) => (
                                  <div
                                    key={pick.horseNumber}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-gray-50 dark:bg-gray-800/30 border-gray-200 dark:border-gray-700"
                                  >
                                    <span className="font-bold text-sm">{rankLabels[idx] || '\u2606'}</span>
                                    <span className="font-mono text-xs">{pick.horseNumber}</span>
                                    <span className="text-sm truncate max-w-[8rem]">{pick.horseName}</span>
                                    {pick.runningStyle && (
                                      <span className="text-xs text-muted">({pick.runningStyle})</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 推奨馬券 */}
                          {pred.recommendedBets.length > 0 && (
                            <div>
                              <h3 className="text-sm font-bold text-muted mb-1">推奨馬券</h3>
                              <p className="text-xs text-muted mb-2">
                                的中率算出要素: 過去成績・騎手適性・競馬場相性・脚質相性・安定性・買い方実績
                              </p>
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="border-b dark:border-gray-700 text-left text-xs text-muted">
                                      <th className="py-1 pr-2">券種</th>
                                      <th className="py-1 px-2">買い目</th>
                                      <th className="py-1 px-2 text-right">オッズ</th>
                                      <th className="py-1 px-2 text-right">予想ROI</th>
                                      <th className="py-1 px-2 text-right">期待値</th>
                                      <th className="py-1 px-2 text-right">的中率</th>
                                      <th className="py-1 px-2 text-right">Kelly</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {pred.recommendedBets.map((bet, idx) => {
                                      const stat = betTypeStatsMap.get(bet.type);
                                      // 馬券固有の的中率（モデル推定）を優先、なければ券種全体統計
                                      const hasModelProb = bet.hitProbability != null;
                                      const betHitProb = hasModelProb ? bet.hitProbability! * 100 : 0;
                                      const typeHitRate = stat?.hitRate || 0;
                                      const odds = bet.odds || 0;
                                      // モデル推定と買い方実績をブレンド（モデル70% + 実績30%）
                                      const blendedHitRate = hasModelProb && typeHitRate > 0
                                        ? betHitProb * 0.7 + typeHitRate * 0.3
                                        : hasModelProb ? betHitProb : typeHitRate;
                                      // 期待値 = ブレンド的中率 × オッズ（100が損益分岐点）
                                      const evScore = odds > 0 && blendedHitRate > 0 ? Math.round(odds * blendedHitRate) : 0;
                                      // 予想ROI = モデル推定勝率 × オッズ × 100
                                      const predRoi = bet.expectedValue > 0 ? Math.round(bet.expectedValue * 100) : 0;
                                      const isMain = bet.reasoning.startsWith('\u3010\u4E3B\u529B\u3011');
                                      const isValue = bet.reasoning.startsWith('\u3010\u30D0\u30EA\u30E5\u30FC\u3011');
                                      return (
                                        <tr key={idx} className="border-b dark:border-gray-800">
                                          <td className="py-1.5 pr-2">
                                            <span className="font-medium">{bet.type}</span>
                                            {isMain && (
                                              <span className="ml-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1 rounded">主力</span>
                                            )}
                                            {isValue && (
                                              <span className="ml-1 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 px-1 rounded">妙味</span>
                                            )}
                                          </td>
                                          <td className="py-1.5 px-2 font-mono font-bold">{bet.selections.join('-')}</td>
                                          <td className="py-1.5 px-2 text-right font-mono">
                                            {odds > 0 ? `${odds.toFixed(1)}倍` : '-'}
                                          </td>
                                          <td className="py-1.5 px-2 text-right">
                                            {predRoi > 0 ? (
                                              <span className={`font-bold ${predRoi >= 100 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                                {predRoi}%
                                              </span>
                                            ) : '-'}
                                          </td>
                                          <td className="py-1.5 px-2 text-right">
                                            {evScore > 0 ? (
                                              <span className={`font-bold ${evScore >= 100 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                                {evScore}
                                              </span>
                                            ) : '-'}
                                          </td>
                                          <td className="py-1.5 px-2 text-right">
                                            {hasModelProb ? (
                                              <span className="text-foreground font-bold">
                                                {blendedHitRate.toFixed(1)}%
                                              </span>
                                            ) : typeHitRate > 0 ? (
                                              <span className="text-muted">
                                                {typeHitRate.toFixed(1)}%
                                                <span className="text-xs ml-0.5">({stat?.total || 0})</span>
                                              </span>
                                            ) : '-'}
                                          </td>
                                          <td className="py-1.5 px-2 text-right">
                                            {bet.kellyFraction != null && bet.kellyFraction > 0 ? (
                                              <div>
                                                <span className="font-mono text-purple-600 dark:text-purple-400">
                                                  {(bet.kellyFraction * 100).toFixed(1)}%
                                                </span>
                                                {bet.valueEdge != null && bet.valueEdge > 0 && (
                                                  <div className="text-xs text-green-600 dark:text-green-400">
                                                    +{(bet.valueEdge * 100).toFixed(0)}%
                                                  </div>
                                                )}
                                              </div>
                                            ) : '-'}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}

                          {pred.recommendedBets.length === 0 && (
                            <div className="text-center py-2 text-muted text-sm">推奨馬券なし</div>
                          )}
                        </>
                      ) : (
                        <div className="text-center py-4 text-muted text-sm">予想データがありません</div>
                      )}

                      {/* 詳細リンク */}
                      <div className="text-right">
                        <Link
                          href={`/predictions/${race.id}`}
                          className="text-sm text-accent hover:underline"
                        >
                          詳細を見る &rarr;
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
