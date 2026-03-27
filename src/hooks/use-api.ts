'use client';
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

/** 汎用SWRフック */
export function useApi<T>(url: string | null, config?: SWRConfiguration) {
  return useSWR<T>(url, fetcher, { ...defaultConfig, ...config });
}

/** 遅延読み込み用: マウント後に少し遅れてフェッチ開始 */
export function useDeferredApi<T>(url: string | null, config?: SWRConfiguration) {
  return useSWR<T>(url, fetcher, {
    ...defaultConfig,
    ...config,
    revalidateOnMount: true,
    // 初回はサスペンドしない（メイン描画をブロックしない）
    suspense: false,
  });
}
