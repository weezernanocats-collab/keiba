'use client';
import { Suspense, useEffect, useState, useMemo, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import ConfidenceBadge from '@/components/ConfidenceBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import FavoriteProfilePopover from '@/components/FavoriteProfilePopover';
import { useFavorites } from '@/lib/use-favorites';
import { PredictionHistoryContent } from './history/page';

interface RaceRow {
  id: string;
  name: string;
  date: string;
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

interface BetTypeStat {
  type: string;
  total: number;
  hitRate: number;
  roi: number;
  avgOdds: number;
  hitCount: number;
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
  const [races, setRaces] = useState<RaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [predCache, setPredCache] = useState<Map<string, PredCache>>(new Map());
  const [loadingPred, setLoadingPred] = useState<string | null>(null);
  const [betTypeStats, setBetTypeStats] = useState<BetTypeStat[]>([]);
  const { isRaceFavoriteInProfile, toggleRaceForProfile } = useFavorites();

  useEffect(() => {
    async function fetchRaces() {
      try {
        const [racesRes, statsRes] = await Promise.all([
          fetch('/api/races?type=upcoming'),
          fetch('/api/accuracy-stats'),
        ]);
        const racesData = await racesRes.json();
        setRaces(racesData.races || []);
        const statsData = await statsRes.json();
        setBetTypeStats(statsData.betTypeStats || []);
      } catch (err) {
        console.error('Error:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchRaces();
  }, []);

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

  const grouped = useMemo(() => {
    const map = new Map<string, RaceRow[]>();
    for (const race of races) {
      const key = race.date;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(race);
    }
    return map;
  }, [races]);

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
      <p className="text-muted text-sm">
        過去の成績データを多角的に分析し、各レースの予想を提供します。タップで推奨馬券を表示します。
      </p>
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
                        <span className="text-xs text-muted shrink-0 hidden sm:inline">
                          {race.racecourseName} {race.trackType}{race.distance}m
                          {race.trackCondition ? ` / ${race.trackCondition}` : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-xs text-muted hidden sm:inline">{race.entryCount}頭</span>
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
                              <h3 className="text-sm font-bold text-muted mb-2">推奨馬券</h3>
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="border-b dark:border-gray-700 text-left text-xs text-muted">
                                      <th className="py-1 pr-2">券種</th>
                                      <th className="py-1 px-2">買い目</th>
                                      <th className="py-1 px-2 text-right">オッズ</th>
                                      <th className="py-1 px-2 text-right">期待値</th>
                                      <th className="py-1 px-2 text-right">的中率</th>
                                      <th className="py-1 px-2 text-right">Kelly</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {pred.recommendedBets.map((bet, idx) => {
                                      const stat = betTypeStatsMap.get(bet.type);
                                      const hitRate = stat?.hitRate || 0;
                                      const odds = bet.odds || 0;
                                      const evScore = odds > 0 && hitRate > 0 ? odds * hitRate : 0;
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
                                            {evScore > 0 ? (
                                              <span className={`font-bold ${evScore >= 100 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                                {Math.round(evScore)}
                                              </span>
                                            ) : bet.expectedValue > 0 ? (
                                              <span className="text-muted">{bet.expectedValue.toFixed(2)}</span>
                                            ) : '-'}
                                          </td>
                                          <td className="py-1.5 px-2 text-right">
                                            {hitRate > 0 ? (
                                              <span className="text-muted">
                                                {hitRate.toFixed(1)}%
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
