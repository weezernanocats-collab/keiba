/**
 * お気に入りカスタムフック (localStorage ベース)
 */

'use client';

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'keiba-favorites';

interface Favorites {
  races: string[];
  horses: string[];
}

function loadFavorites(): Favorites {
  if (typeof window === 'undefined') return { races: [], horses: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { races: [], horses: [] };
    return JSON.parse(raw) as Favorites;
  } catch {
    return { races: [], horses: [] };
  }
}

function saveFavorites(favs: Favorites): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favs));
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<Favorites>({ races: [], horses: [] });

  useEffect(() => {
    setFavorites(loadFavorites());
  }, []);

  const toggleRace = useCallback((raceId: string) => {
    setFavorites(prev => {
      const races = prev.races.includes(raceId)
        ? prev.races.filter(id => id !== raceId)
        : [...prev.races, raceId];
      const next = { ...prev, races };
      saveFavorites(next);
      return next;
    });
  }, []);

  const toggleHorse = useCallback((horseId: string) => {
    setFavorites(prev => {
      const horses = prev.horses.includes(horseId)
        ? prev.horses.filter(id => id !== horseId)
        : [...prev.horses, horseId];
      const next = { ...prev, horses };
      saveFavorites(next);
      return next;
    });
  }, []);

  const isRaceFavorite = useCallback((raceId: string) => {
    return favorites.races.includes(raceId);
  }, [favorites.races]);

  const isHorseFavorite = useCallback((horseId: string) => {
    return favorites.horses.includes(horseId);
  }, [favorites.horses]);

  return { favorites, toggleRace, toggleHorse, isRaceFavorite, isHorseFavorite };
}
