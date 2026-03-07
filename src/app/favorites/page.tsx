'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useFavorites } from '@/lib/use-favorites';
import LoadingSpinner from '@/components/LoadingSpinner';
import FavoriteButton from '@/components/FavoriteButton';

interface RaceInfo {
  id: string;
  name: string;
  date: string;
  racecourseName: string;
  raceNumber: number;
  trackType: string;
  distance: number;
  status: string;
}

interface HorseInfo {
  id: string;
  name: string;
  sex: string;
  age: number;
  trainerName: string;
}

export default function FavoritesPage() {
  const { favorites, toggleRace, toggleHorse, isRaceFavorite, isHorseFavorite } = useFavorites();
  const [races, setRaces] = useState<RaceInfo[]>([]);
  const [horses, setHorses] = useState<HorseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'races' | 'horses'>('races');

  useEffect(() => {
    async function fetchFavorites() {
      setLoading(true);
      try {
        // お気に入りレース
        if (favorites.races.length > 0) {
          const racePromises = favorites.races.map(async (id) => {
            try {
              const res = await fetch(`/api/races/${id}`);
              if (!res.ok) return null;
              const data = await res.json();
              return data.race as RaceInfo;
            } catch {
              return null;
            }
          });
          const raceResults = await Promise.all(racePromises);
          setRaces(raceResults.filter((r): r is RaceInfo => r !== null));
        } else {
          setRaces([]);
        }

        // お気に入り馬
        if (favorites.horses.length > 0) {
          const horsePromises = favorites.horses.map(async (id) => {
            try {
              const res = await fetch(`/api/horses/${id}`);
              if (!res.ok) return null;
              const data = await res.json();
              return data.horse as HorseInfo;
            } catch {
              return null;
            }
          });
          const horseResults = await Promise.all(horsePromises);
          setHorses(horseResults.filter((h): h is HorseInfo => h !== null));
        } else {
          setHorses([]);
        }
      } catch (err) {
        console.error('お気に入りデータ取得エラー:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchFavorites();
  }, [favorites.races, favorites.horses]);

  if (loading) return <LoadingSpinner message="お気に入りを読み込んでいます..." />;

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">お気に入り</h1>
        <Link href="/" className="text-sm text-accent hover:underline">← トップに戻る</Link>
      </div>

      {/* タブ */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
        <button
          onClick={() => setTab('races')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
            tab === 'races' ? 'bg-white dark:bg-gray-700 shadow' : 'hover:bg-white/50 dark:hover:bg-gray-700/50'
          }`}
        >
          レース ({favorites.races.length})
        </button>
        <button
          onClick={() => setTab('horses')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
            tab === 'horses' ? 'bg-white dark:bg-gray-700 shadow' : 'hover:bg-white/50 dark:hover:bg-gray-700/50'
          }`}
        >
          馬 ({favorites.horses.length})
        </button>
      </div>

      {tab === 'races' && (
        <div className="space-y-3">
          {races.length === 0 ? (
            <p className="text-center py-8 text-muted">お気に入りレースはありません</p>
          ) : (
            races.map(race => (
              <div key={race.id} className="bg-card-bg border border-card-border rounded-xl p-4 flex items-center justify-between">
                <Link href={`/predictions/${race.id}`} className="flex-1">
                  <div className="font-bold">{race.name}</div>
                  <div className="text-sm text-muted">
                    {race.date} | {race.racecourseName} {race.raceNumber}R | {race.trackType}{race.distance}m
                  </div>
                </Link>
                <FavoriteButton
                  isFavorite={isRaceFavorite(race.id)}
                  onToggle={() => toggleRace(race.id)}
                />
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'horses' && (
        <div className="space-y-3">
          {horses.length === 0 ? (
            <p className="text-center py-8 text-muted">お気に入り馬はありません</p>
          ) : (
            horses.map(horse => (
              <div key={horse.id} className="bg-card-bg border border-card-border rounded-xl p-4 flex items-center justify-between">
                <Link href={`/horses/${horse.id}`} className="flex-1">
                  <div className="font-bold">{horse.name}</div>
                  <div className="text-sm text-muted">
                    {horse.sex}{horse.age}歳 | {horse.trainerName}厩舎
                  </div>
                </Link>
                <FavoriteButton
                  isFavorite={isHorseFavorite(horse.id)}
                  onToggle={() => toggleHorse(horse.id)}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
