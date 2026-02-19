'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';

interface RaceRow {
  id: string;
  name: string;
  date: string;
  racecourse_name: string;
  race_number: number;
  grade: string | null;
  track_type: string;
  distance: number;
  status: string;
  entry_count: number;
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
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [racesRes, resultsRes, statsRes] = await Promise.all([
          fetch('/api/races?type=upcoming'),
          fetch('/api/races?type=results'),
          fetch('/api/stats'),
        ]);
        const racesData = await racesRes.json();
        const resultsData = await resultsRes.json();
        const statsData = await statsRes.json();

        setUpcomingRaces(racesData.races || []);
        setRecentResults(resultsData.races || []);
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
                    <td className="px-4 py-3 font-medium">{race.racecourse_name}</td>
                    <td className="px-4 py-3">{race.race_number}R</td>
                    <td className="px-4 py-3">
                      <Link href={`/races/${race.id}`} className="text-accent hover:underline font-medium">
                        {race.name}
                      </Link>
                      {' '}
                      <GradeBadge grade={race.grade} size="sm" />
                    </td>
                    <td className="px-4 py-3 text-muted">{race.track_type}{race.distance}m</td>
                    <td className="px-4 py-3 text-center">{race.entry_count}頭</td>
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

      {/* 最近の結果 */}
      {recentResults.length > 0 && (
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
                      <td className="px-4 py-3 font-medium">{race.racecourse_name}</td>
                      <td className="px-4 py-3">
                        <Link href={`/races/${race.id}`} className="text-accent hover:underline">
                          {race.name}
                        </Link>
                        {' '}
                        <GradeBadge grade={race.grade} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-muted">{race.track_type}{race.distance}m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
