'use client';
import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import ConfidenceBadge from '@/components/ConfidenceBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import FavoriteProfilePopover from '@/components/FavoriteProfilePopover';
import { useFavorites } from '@/lib/use-favorites';

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
  confidence: number | null;
}

export default function RacesPage() {
  const [races, setRaces] = useState<RaceRow[]>([]);
  const [filter, setFilter] = useState<'upcoming' | 'results'>('upcoming');
  const [dateFilter, setDateFilter] = useState<string>('');
  const [courseFilter, setCourseFilter] = useState<string>('all');
  const [trackFilter, setTrackFilter] = useState<string>('all');
  const [gradeFilter, setGradeFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const { isRaceFavoriteInProfile, toggleRaceForProfile } = useFavorites();

  useEffect(() => {
    async function fetchRaces() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ type: filter });
        if (dateFilter) params.set('date', dateFilter);
        const res = await fetch(`/api/races?${params}`);
        const data = await res.json();
        setRaces(data.races || []);
      } catch (err) {
        console.error('レース取得エラー:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchRaces();
  }, [filter, dateFilter]);

  const courses = [...new Set(races.map(r => r.racecourseName))];

  const filteredRaces = useMemo(() => {
    return races.filter(r => {
      if (courseFilter !== 'all' && r.racecourseName !== courseFilter) return false;
      if (trackFilter !== 'all' && r.trackType !== trackFilter) return false;
      if (gradeFilter === 'grade' && !r.grade) return false;
      if (gradeFilter === 'G1' && r.grade !== 'G1') return false;
      if (gradeFilter === 'G2' && r.grade !== 'G2') return false;
      if (gradeFilter === 'G3' && r.grade !== 'G3') return false;
      return true;
    });
  }, [races, courseFilter, trackFilter, gradeFilter]);

  // 日付ごとにグループ化
  const groupedByDate: Record<string, RaceRow[]> = {};
  for (const race of filteredRaces) {
    if (!groupedByDate[race.date]) groupedByDate[race.date] = [];
    groupedByDate[race.date].push(race);
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold">レース一覧</h1>

      {/* フィルタ */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex rounded-lg overflow-hidden border border-card-border">
          <button
            className={`px-4 py-2 text-sm font-medium transition-colors ${filter === 'upcoming' ? 'bg-primary text-white' : 'bg-card-bg hover:bg-gray-700'}`}
            onClick={() => setFilter('upcoming')}
          >
            今後のレース
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium transition-colors ${filter === 'results' ? 'bg-primary text-white' : 'bg-card-bg hover:bg-gray-700'}`}
            onClick={() => setFilter('results')}
          >
            結果
          </button>
        </div>

        <input
          type="date"
          className="px-3 py-2 text-sm border border-card-border rounded-lg bg-card-bg"
          value={dateFilter}
          onChange={e => setDateFilter(e.target.value)}
        />

        <select
          className="px-3 py-2 text-sm border border-card-border rounded-lg bg-card-bg"
          value={courseFilter}
          onChange={e => setCourseFilter(e.target.value)}
        >
          <option value="all">全競馬場</option>
          {courses.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <select
          className="px-3 py-2 text-sm border border-card-border rounded-lg bg-card-bg"
          value={trackFilter}
          onChange={e => setTrackFilter(e.target.value)}
        >
          <option value="all">全トラック</option>
          <option value="芝">芝</option>
          <option value="ダート">ダート</option>
          <option value="障害">障害</option>
        </select>

        <select
          className="px-3 py-2 text-sm border border-card-border rounded-lg bg-card-bg"
          value={gradeFilter}
          onChange={e => setGradeFilter(e.target.value)}
        >
          <option value="all">全グレード</option>
          <option value="grade">重賞のみ</option>
          <option value="G1">G1</option>
          <option value="G2">G2</option>
          <option value="G3">G3</option>
        </select>

        {(dateFilter || courseFilter !== 'all' || trackFilter !== 'all' || gradeFilter !== 'all') && (
          <button
            className="px-3 py-2 text-xs text-red-400 hover:text-red-300 transition-colors"
            onClick={() => { setDateFilter(''); setCourseFilter('all'); setTrackFilter('all'); setGradeFilter('all'); }}
          >
            フィルタをリセット
          </button>
        )}

        <span className="text-sm text-muted ml-auto">
          {filteredRaces.length}件
        </span>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : (
        Object.entries(groupedByDate).map(([date, dateRaces]) => (
          <section key={date}>
            <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
              <span className="bg-primary text-white px-3 py-1 rounded-lg text-sm">{date}</span>
              <span className="text-muted text-sm">{dateRaces.length}レース</span>
            </h2>
            <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-800/50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">競馬場</th>
                      <th className="px-4 py-3 text-left font-medium">R</th>
                      <th className="px-4 py-3 text-left font-medium">レース名</th>
                      <th className="px-4 py-3 text-left font-medium">条件</th>
                      <th className="px-4 py-3 text-center font-medium">頭数</th>
                      <th className="px-4 py-3 text-center font-medium">状態</th>
                      <th className="px-4 py-3 text-center font-medium">信頼度</th>
                      <th className="px-4 py-3 text-center font-medium">詳細</th>
                      <th className="px-2 py-3 text-center font-medium w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border">
                    {dateRaces.map(race => (
                      <tr key={race.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
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
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            race.status === '出走確定' ? 'bg-green-100 text-green-800' :
                            race.status === '結果確定' ? 'bg-blue-100 text-blue-800' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {race.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {race.confidence != null && race.confidence >= 50 ? (
                            <ConfidenceBadge value={race.confidence} />
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Link
                            href={`/races/${race.id}`}
                            className="text-accent hover:underline text-xs"
                          >
                            出馬表
                          </Link>
                          {' / '}
                          <Link
                            href={`/predictions/${race.id}`}
                            className="text-accent hover:underline text-xs font-medium"
                          >
                            {race.status === '結果確定' ? '予想結果' : 'AI予想'}
                          </Link>
                        </td>
                        <td className="px-2 py-3 text-center">
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
            </div>
          </section>
        ))
      )}

      {!loading && filteredRaces.length === 0 && (
        <div className="text-center py-12 text-muted">
          <p className="text-lg">レースが見つかりません</p>
        </div>
      )}
    </div>
  );
}
