'use client';
import { Suspense, useState, useMemo, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import ConfidenceBadge from '@/components/ConfidenceBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import FavoriteProfilePopover from '@/components/FavoriteProfilePopover';
import { useFavorites } from '@/lib/use-favorites';
import { useApi, formatLastFetched } from '@/hooks/use-api';
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
  aiPattern: string | null;
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

interface AIRankingBetHorse {
  horseNumber: number;
  horseName: string;
  aiRank: number;
  aiProb: number;
}

interface AIRankingBetItem {
  type: string;
  horses: AIRankingBetHorse[];
  reasoning: string;
  confidence: 'high' | 'medium' | 'low';
}

interface AIRankingBetsData {
  bets: AIRankingBetItem[];
  pattern: string;
  summary: string;
}

interface PredCache {
  topPicks: PredPick[];
  recommendedBets: PredBet[];
  confidence: number;
  aiRankingBets?: AIRankingBetsData;
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

function BetVerdictBadge({ pattern, confidence }: { pattern: string | null; confidence: number | null }) {
  if (!pattern || confidence == null) return null;
  let label: string;
  let className: string;
  if ((pattern === '一強' || pattern === '二強') && confidence >= 60) {
    label = '買い';
    className = 'bg-green-500 text-white';
  } else if ((pattern === '一強' || pattern === '二強' || pattern === '三つ巴') && confidence >= 45) {
    label = '検討';
    className = 'bg-blue-500 text-white';
  } else if (pattern === '混戦' || confidence < 30) {
    label = '見送り';
    className = 'bg-gray-400 text-white';
  } else {
    label = '様子見';
    className = 'bg-amber-500 text-white';
  }
  return (
    <span className={`${className} px-2 py-0.5 rounded text-xs font-bold shrink-0`}>
      {label}
    </span>
  );
}

function UpcomingRaces() {
  const { data: racesData, isValidating, lastFetched, mutate } = useApi<{ races: RaceRow[] }>('/api/races?type=upcoming');
  const races = racesData?.races || [];
  const loading = !racesData;

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [predCache, setPredCache] = useState<Map<string, PredCache>>(new Map());
  const [loadingPred, setLoadingPred] = useState<string | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<string>('all');
  const { isRaceFavoriteInProfile, toggleRaceForProfile } = useFavorites();

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
            aiRankingBets: data.prediction.aiRankingBets || undefined,
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
      if (confidenceFilter === 'buy') {
        const p = r.aiPattern;
        return (p === '一強' || p === '二強') && r.confidence != null && r.confidence >= 60;
      }
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
          <button
            onClick={() => { setPredCache(new Map()); mutate(); }}
            disabled={isValidating}
            className="px-3 py-1.5 text-xs border border-card-border rounded-lg bg-card-bg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {isValidating ? '更新中...' : '最新に更新'}
          </button>
          {!isValidating && lastFetched && (
            <span className="text-xs text-muted hidden sm:inline">{formatLastFetched(lastFetched)}</span>
          )}
          <select
            className="px-3 py-2 text-sm border border-card-border rounded-lg bg-card-bg"
            value={confidenceFilter}
            onChange={e => setConfidenceFilter(e.target.value)}
          >
            <option value="all">全レース</option>
            <option value="buy">買い推奨のみ</option>
            <option value="high">信頼度 高 (70%+)</option>
            <option value="mid">信頼度 中 (50-69%)</option>
            <option value="low">信頼度 低 (&lt;50%)</option>
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
                        <BetVerdictBadge pattern={race.aiPattern} confidence={race.confidence} />
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
                          {/* 予想印サマリー（コンパクト） */}
                          {pred.topPicks.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {pred.topPicks.slice(0, 6).map((pick, idx) => (
                                <div
                                  key={pick.horseNumber}
                                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border bg-gray-50 dark:bg-gray-800/30 border-gray-200 dark:border-gray-700"
                                >
                                  <span className="font-bold text-sm">{rankLabels[idx] || '\u2606'}</span>
                                  <span className="font-mono text-xs">{pick.horseNumber}</span>
                                  <span className="text-sm truncate max-w-[7rem]">{pick.horseName}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* AI推奨買い目（コンパクト） */}
                          {pred.aiRankingBets && pred.aiRankingBets.bets.length > 0 && (
                            <div className="border border-emerald-300 dark:border-emerald-700 rounded-lg p-3 bg-emerald-50/50 dark:bg-emerald-900/20">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-sm font-bold">AI買い目</span>
                                <span className="text-xs bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200 px-1.5 py-0.5 rounded">
                                  {pred.aiRankingBets.pattern}
                                </span>
                              </div>
                              <div className="space-y-1.5">
                                {pred.aiRankingBets.bets.map((bet, idx) => (
                                  <div key={idx} className="flex items-center gap-2 text-sm">
                                    <span className={`px-2 py-0.5 rounded text-xs font-bold text-white ${
                                      bet.confidence === 'high' ? 'bg-emerald-600' : bet.confidence === 'medium' ? 'bg-blue-600' : 'bg-gray-500'
                                    }`}>
                                      {bet.type}
                                    </span>
                                    <span className="font-bold">
                                      {bet.horses.map(h => `${h.horseNumber} ${h.horseName}`).join(' - ')}
                                    </span>
                                    <span className="text-xs text-muted">
                                      {bet.confidence === 'high' ? '本線' : bet.confidence === 'medium' ? '押さえ' : ''}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
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
