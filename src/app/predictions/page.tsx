'use client';
import { useEffect, useState } from 'react';
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
  status: string;
  entryCount: number;
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
        console.error('エラー:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchRaces();
  }, []);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-bold">🤖 AI予想</h1>
        <p className="text-muted text-sm mt-1">
          過去の成績データを多角的に分析し、各レースの予想を提供します。
          予想したいレースを選んでください。
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {races.map(race => (
          <Link
            key={race.id}
            href={`/predictions/${race.id}`}
            className="bg-card-bg border border-card-border rounded-xl p-5 hover:border-accent hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-2">
              <span className="text-sm text-muted">{race.date}</span>
              <GradeBadge grade={race.grade} size="sm" />
            </div>
            <h3 className="text-lg font-bold group-hover:text-accent transition-colors">{race.name}</h3>
            <div className="mt-2 flex flex-wrap gap-2 text-sm text-muted">
              <span>{race.racecourseName} {race.raceNumber}R</span>
              <span>|</span>
              <span>{race.trackType}{race.distance}m</span>
              <span>|</span>
              <span>{race.entryCount}頭</span>
            </div>
            <div className="mt-3 text-xs text-accent font-medium group-hover:underline">
              AI予想を見る →
            </div>
          </Link>
        ))}
      </div>

      {races.length === 0 && (
        <div className="text-center py-12 text-muted">
          <p className="text-lg">予想可能なレースがありません</p>
        </div>
      )}
    </div>
  );
}
