'use client';
import { useRef, useCallback } from 'react';
import useSWR, { type SWRConfiguration } from 'swr';

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `API error: ${res.status}`);
  }
  return res.json();
};

/** SWR共通設定: キャッシュ即表示 + 必ず再検証で鮮度保証 */
const defaultConfig: SWRConfiguration = {
  revalidateOnMount: true,
  revalidateOnFocus: true,
  revalidateIfStale: true,
  dedupingInterval: 10_000,
  focusThrottleInterval: 30_000,
  errorRetryCount: 2,
};

/** 汎用SWRフック（最終取得時刻付き） */
export function useApi<T>(url: string | null, config?: SWRConfiguration) {
  const lastFetchedRef = useRef<Date | null>(null);
  const onSuccess = useCallback(() => {
    lastFetchedRef.current = new Date();
  }, []);

  const result = useSWR<T>(url, fetcher, { ...defaultConfig, ...config, onSuccess });
  return { ...result, lastFetched: lastFetchedRef.current };
}

/** 遅延読み込み用 */
export function useDeferredApi<T>(url: string | null, config?: SWRConfiguration) {
  return useSWR<T>(url, fetcher, {
    ...defaultConfig,
    ...config,
    revalidateOnMount: true,
    suspense: false,
  });
}

/** 最終取得時刻をJST文字列で返す */
export function formatLastFetched(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
