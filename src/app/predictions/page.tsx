'use client';
import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';

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

function ConfidenceBadge({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-muted">---</span>;
  const color =
    value >= 70 ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' :
    value >= 50 ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400' :
    'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${color}`}>
      {value}%
    </span>
  );
}

export default function PredictionsPage() {
  const [races, setRaces] = useState<RaceRow[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-bold">AI予想</h1>
        <p className="text-muted text-sm mt-1">
          過去の成績データを多角的に分析し、各レースの予想を提供します。
        </p>
      </div>

      {races.length === 0 ? (
        <div className="text-center py-12 text-muted">
          <p className="text-lg">予想可能なレースがありません</p>
        </div>
      ) : (
        [...grouped.entries()].map(([date, dateRaces]) => (
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* モバイル: コンパクトリスト */}
            <div className="md:hidden space-y-1">
              {dateRaces.map(race => (
                <Link
                  key={race.id}
                  href={`/predictions/${race.id}`}
                  className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-card-bg/80 transition-colors border-b border-card-border/30"
                >
                  <div className="flex items-center gap-2 min-w-0">
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
                  </div>
                  <ConfidenceBadge value={race.confidence} />
                </Link>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
