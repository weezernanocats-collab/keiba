/**
 * APIルート共通ヘルパー
 * Cache-Controlヘッダーによるレスポンスキャッシュ
 */

type CachePreset = 'races' | 'prediction' | 'stats' | 'master' | 'no-cache';

const CACHE_PRESETS: Record<CachePreset, string> = {
  races: 'public, s-maxage=30, stale-while-revalidate=120',
  prediction: 'public, s-maxage=300, stale-while-revalidate=600',
  stats: 'public, s-maxage=1800, stale-while-revalidate=3600',
  master: 'public, s-maxage=600, stale-while-revalidate=1800',
  'no-cache': 'no-cache, no-store, must-revalidate',
};

export function getCacheHeaders(preset: CachePreset): Record<string, string> {
  return { 'Cache-Control': CACHE_PRESETS[preset] };
}

export function jsonWithCache<T>(data: T, preset: CachePreset, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCacheHeaders(preset),
    },
  });
}
