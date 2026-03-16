'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import type { BetResultDisplay as BetResult } from '@/types';

interface RaceRow {
  id: string;
  name: string;
  date: string;
  racecourseName: string;
  raceNumber: number;
  grade: string | null;
  trackType: string;
  distance: number;
  status: string;
  entryCount: number;
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
}

interface Stats {
  totalHorses: number;
  totalJockeys: number;
  totalRaces: number;
  upcomingRaces: number;
  totalPredictions: number;
}

export default function HomePage() {
  const [upcomingRaces, setUpcomingRaces] = useState<RaceRow[]>([]);
  const [recentResults, setRecentResults] = useState<RaceRow[]>([]);
  const [recentHits, setRecentHits] = useState<HitRecord[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [racesRes, resultsRes, statsRes, hitsRes] = await Promise.all([
          fetch('/api/races?type=upcoming'),
          fetch('/api/races?type=results'),
          fetch('/api/stats'),
          fetch('/api/predictions/history?result=win&limit=10'),
        ]);
        const racesData = await racesRes.json();
        const resultsData = await resultsRes.json();
        const statsData = await statsRes.json();
        const hitsData = await hitsRes.json();

        setUpcomingRaces(racesData.races || []);
        setRecentResults(resultsData.races || []);
        setRecentHits(hitsData.history || []);
        setStats(statsData);
      } catch (err) {
        console.error('データ取得エラー:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) return <LoadingSpinner message="データを読み込んでいます..." />;

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* ヒーローセクション */}
      <section className="bg-gradient-to-r from-primary to-primary-light rounded-2xl p-8 text-white">
        <h1 className="text-3xl md:text-4xl font-bold mb-3">
          🏇 KEIBA MASTER
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
      {stats && (
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
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
          ))}
        </section>
      )}

      {/* 今後のレース */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">📅 今後のレース</h2>
          <Link href="/races" className="text-sm text-accent hover:underline">すべて見る →</Link>
        </div>
        <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">日付</th>
                  <th className="px-4 py-3 text-left font-medium">競馬場</th>
                  <th className="px-4 py-3 text-left font-medium">R</th>
                  <th className="px-4 py-3 text-left font-medium">レース名</th>
                  <th className="px-4 py-3 text-left font-medium">条件</th>
                  <th className="px-4 py-3 text-center font-medium">頭数</th>
                  <th className="px-4 py-3 text-center font-medium">予想</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-card-border">
                {upcomingRaces.slice(0, 10).map((race) => (
                  <tr key={race.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">{race.date}</td>
                    <td className="px-4 py-3 font-medium">{race.racecourseName}</td>
                    <td className="px-4 py-3">{race.raceNumber}R</td>
                    <td className="px-4 py-3">
                      <Link href={`/races/${race.id}`} className="text-accent hover:underline font-medium">
                        {race.name}
                      </Link>
                      {' '}
                      <GradeBadge grade={race.grade} size="sm" />
                    </td>
                    <td className="px-4 py-3 text-muted">{race.trackType}{race.distance}m</td>
                    <td className="px-4 py-3 text-center">{race.entryCount}頭</td>
                    <td className="px-4 py-3 text-center">
                      <Link
                        href={`/predictions/${race.id}`}
                        className="inline-block bg-accent/10 text-accent px-3 py-1 rounded-full text-xs font-medium hover:bg-accent/20 transition-colors"
                      >
                        予想
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 直近の的中 / 最近の結果 */}
      {recentHits.length > 0 ? (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold">🎯 直近の的中</h2>
            <Link href="/predictions/history?result=win" className="text-sm text-accent hover:underline">すべて見る →</Link>
          </div>
          <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">日付</th>
                    <th className="px-4 py-3 text-left font-medium">競馬場</th>
                    <th className="px-4 py-3 text-left font-medium">レース名</th>
                    <th className="px-4 py-3 text-left font-medium">的中</th>
                    <th className="px-4 py-3 text-right font-medium">ROI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-card-border">
                  {recentHits.slice(0, 5).map((hit) => {
                    const hitBets = hit.betResults.filter(b => b.hit);
                    const roi = hit.betSummary.totalInvestment > 0
                      ? Math.round((hit.betSummary.totalPayout / hit.betSummary.totalInvestment) * 100)
                      : 0;

                    return (
                      <tr key={hit.raceId} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-3 whitespace-nowrap">{hit.raceDate}</td>
                        <td className="px-4 py-3 font-medium">{hit.racecourseName}</td>
                        <td className="px-4 py-3">
                          <Link href={`/predictions/${hit.raceId}`} className="text-accent hover:underline font-medium">
                            {hit.raceNumber}R {hit.raceName}
                          </Link>
                          {' '}
                          <GradeBadge grade={hit.grade} size="sm" />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {hit.winHit && (
                              <span className="inline-block bg-green-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                                単勝的中!
                              </span>
                            )}
                            {hit.placeHit && !hit.winHit && (
                              <span className="inline-block bg-emerald-400 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                                複勝的中!
                              </span>
                            )}
                            {hitBets
                              .filter(b => b.type !== '単勝' && b.type !== '複勝')
                              .map((b) => (
                                <span
                                  key={b.type}
                                  className="inline-block bg-teal-500 text-white text-xs font-bold px-2 py-0.5 rounded-full"
                                >
                                  {b.type}的中!
                                </span>
                              ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className={`font-bold ${roi >= 100 ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                            {roi}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : recentResults.length > 0 ? (
        <section>
          <h2 className="text-xl font-bold mb-4">🏁 最近の結果</h2>
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
