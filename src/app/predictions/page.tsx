'use client';
import { Suspense, useEffect, useState, useMemo } from 'react';
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

function UpcomingRaces() {
  const [races, setRaces] = useState<RaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { isRaceFavoriteInProfile, toggleRaceForProfile } = useFavorites();

  useEffect(() => {
    async function fetchRaces() {
      try {
        const res = await fetch('/api/races?type=upcoming');
        const data = await res.json();
        setRaces(data.races || []);
      } catch (err) {
        console.error('Error:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchRaces();
  }, []);

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
        過去の成績データを多角的に分析し、各レースの予想を提供します。
      </p>
      {[...grouped.entries()].map(([date, dateRaces]) => (
        <div key={date}>
          <h2 className="text-lg font-bold mb-2 border-b border-card-border pb-1">{date}</h2>
          {/* デスクトップ: テーブル */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted border-b border-card-border">
                  <th className="py-2 px-2 font-medium">R</th>
                  <th className="py-2 px-2 font-medium">レース名</th>
                  <th className="py-2 px-2 font-medium">場所</th>
                  <th className="py-2 px-2 font-medium">条件</th>
                  <th className="py-2 px-2 font-medium text-center">頭数</th>
                  <th className="py-2 px-2 font-medium text-center">信頼度</th>
                  <th className="py-2 px-1 font-medium w-10"></th>
                </tr>
              </thead>
              <tbody>
                {dateRaces.map(race => (
                  <tr key={race.id} className="border-b border-card-border/50 hover:bg-card-bg/80 transition-colors">
                    <td className="py-2 px-2 text-muted">{race.raceNumber}</td>
                    <td className="py-2 px-2">
                      <Link
                        href={`/predictions/${race.id}`}
                        className="font-medium hover:text-accent transition-colors inline-flex items-center gap-2"
                      >
                        {race.name}
                        <GradeBadge grade={race.grade} size="sm" />
                      </Link>
                    </td>
                    <td className="py-2 px-2 text-muted">{race.racecourseName}</td>
                    <td className="py-2 px-2 text-muted">
                      {race.trackType}{race.distance}m
                      {race.trackCondition ? ` / ${race.trackCondition}` : ''}
                    </td>
                    <td className="py-2 px-2 text-center">{race.entryCount}</td>
                    <td className="py-2 px-2 text-center">
                      <ConfidenceBadge value={race.confidence} />
                    </td>
                    <td className="py-2 px-1 text-center">
                      <FavoriteProfilePopover
                        checkFavorite={(p) => isRaceFavoriteInProfile(race.id, p)}
                        onToggle={(p) => toggleRaceForProfile(race.id, p)}
                        size="sm"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* モバイル: コンパクトリスト */}
          <div className="md:hidden space-y-1">
            {dateRaces.map(race => (
              <div
                key={race.id}
                className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-card-bg/80 transition-colors border-b border-card-border/30"
              >
                <Link
                  href={`/predictions/${race.id}`}
                  className="flex items-center gap-2 min-w-0 flex-1"
                >
                  <span className="text-xs text-muted w-6 shrink-0">{race.raceNumber}R</span>
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate flex items-center gap-1">
                      {race.name}
                      <GradeBadge grade={race.grade} size="sm" />
                    </div>
                    <div className="text-xs text-muted">
                      {race.racecourseName} {race.trackType}{race.distance}m {race.entryCount}頭
                    </div>
                  </div>
                </Link>
                <div className="flex items-center gap-2 shrink-0">
                  <ConfidenceBadge value={race.confidence} />
                  <FavoriteProfilePopover
                    checkFavorite={(p) => isRaceFavoriteInProfile(race.id, p)}
                    onToggle={(p) => toggleRaceForProfile(race.id, p)}
                    size="sm"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
