/**
 * お気に入りカスタムフック (localStorage ベース, プロフィール切替対応)
 */

'use client';

import { useState, useEffect, useCallback } from 'react';

const PROFILE_KEY = 'keiba-active-profile';
const LEGACY_STORAGE_KEY = 'keiba-favorites';

export const PROFILES = ['村越', '大日向', '倉前', '木村'] as const;
export type Profile = typeof PROFILES[number];

interface Favorites {
  races: string[];
  horses: string[];
}

function getStorageKey(profile: Profile): string {
  return `keiba-favorites-${profile}`;
}

function loadActiveProfile(): Profile {
  if (typeof window === 'undefined') return PROFILES[0];
  const saved = localStorage.getItem(PROFILE_KEY);
  if (saved && PROFILES.includes(saved as Profile)) return saved as Profile;
  return PROFILES[0];
}

function saveActiveProfile(profile: Profile): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(PROFILE_KEY, profile);
}

function loadFavorites(profile: Profile): Favorites {
  if (typeof window === 'undefined') return { races: [], horses: [] };
  try {
    const raw = localStorage.getItem(getStorageKey(profile));
    if (!raw) return { races: [], horses: [] };
    return JSON.parse(raw) as Favorites;
  } catch {
    return { races: [], horses: [] };
  }
}

function saveFavorites(profile: Profile, favs: Favorites): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(getStorageKey(profile), JSON.stringify(favs));
}

/** 旧keiba-favoritesをユーザー1に自動マイグレーション */
function migrateLegacy(): void {
  if (typeof window === 'undefined') return;
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return;

  const targetKey = getStorageKey(PROFILES[0]);
  // ユーザー1のデータがまだなければマイグレーション
  if (!localStorage.getItem(targetKey)) {
    localStorage.setItem(targetKey, legacy);
  }
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function useFavorites() {
  const [profile, setProfileState] = useState<Profile>(PROFILES[0]);
  const [favorites, setFavorites] = useState<Favorites>({ races: [], horses: [] });

  useEffect(() => {
    migrateLegacy();
    const active = loadActiveProfile();
    setProfileState(active);
    setFavorites(loadFavorites(active));
  }, []);

  const setProfile = useCallback((newProfile: Profile) => {
    saveActiveProfile(newProfile);
    setProfileState(newProfile);
    setFavorites(loadFavorites(newProfile));
  }, []);

  const toggleRace = useCallback((raceId: string) => {
    setFavorites(prev => {
      const races = prev.races.includes(raceId)
        ? prev.races.filter(id => id !== raceId)
        : [...prev.races, raceId];
      const next = { ...prev, races };
      saveFavorites(profile, next);
      return next;
    });
  }, [profile]);

  const toggleHorse = useCallback((horseId: string) => {
    setFavorites(prev => {
      const horses = prev.horses.includes(horseId)
        ? prev.horses.filter(id => id !== horseId)
        : [...prev.horses, horseId];
      const next = { ...prev, horses };
      saveFavorites(profile, next);
      return next;
    });
  }, [profile]);

  const isRaceFavorite = useCallback((raceId: string) => {
    return favorites.races.includes(raceId);
  }, [favorites.races]);

  const isHorseFavorite = useCallback((horseId: string) => {
    return favorites.horses.includes(horseId);
  }, [favorites.horses]);

  return {
    profile,
    setProfile,
    favorites,
    toggleRace,
    toggleHorse,
    isRaceFavorite,
    isHorseFavorite,
  };
}
