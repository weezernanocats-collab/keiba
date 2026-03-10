'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface SyncInfo {
  isRunning: boolean;
  currentSync: {
    type: string;
    details: string;
    startedAt: string;
  } | null;
}

const TYPE_LABELS: Record<string, string> = {
  full: 'フル同期',
  races: 'レース取得',
  race_detail: '出馬表取得',
  odds: 'オッズ取得',
  results: '結果取得',
  horse: '馬詳細取得',
  regenerate_predictions: '予想再生成',
  bulk_chunked: 'バルクインポート',
  evaluate_all: '一括照合',
  calibrate: 'ウェイト校正',
};

export default function SyncStatusBanner() {
  const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null);
  const [completedMessage, setCompletedMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wasRunningRef = useRef(false);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const syncKey = typeof window !== 'undefined'
        ? localStorage.getItem('keiba-sync-key') || ''
        : '';
      const headers: Record<string, string> = {};
      if (syncKey) headers['x-sync-key'] = syncKey;

      const res = await fetch('/api/sync', { headers });
      if (!res.ok) return;
      const data: SyncInfo = await res.json();

      // 実行中 → 完了に変わったら完了メッセージを表示
      if (data.isRunning) {
        wasRunningRef.current = true;
        setCompletedMessage(null);
      } else if (wasRunningRef.current) {
        wasRunningRef.current = false;
        setCompletedMessage('同期処理が完了しました');
      }

      setSyncInfo(data);
    } catch {
      // ネットワークエラー時は無視
    }
  }, []);

  useEffect(() => {
    // 同期実行中は5秒、通常時は30秒でポーリング
    const interval = syncInfo?.isRunning ? 5000 : 30000;
    const id = setInterval(() => {
      fetchSyncStatus();
      setNow(Date.now());
    }, interval);
    // 初回取得
    const initId = setTimeout(() => {
      fetchSyncStatus();
    }, 0);
    return () => {
      clearInterval(id);
      clearTimeout(initId);
    };
  }, [fetchSyncStatus, syncInfo?.isRunning]);

  // 完了メッセージを8秒後に消す
  useEffect(() => {
    if (!completedMessage) return;
    const timer = setTimeout(() => setCompletedMessage(null), 8000);
    return () => clearTimeout(timer);
  }, [completedMessage]);

  // 実行中でも完了通知でもなければ何も表示しない
  if (!syncInfo?.isRunning && !completedMessage) return null;

  // 完了通知
  if (completedMessage) {
    return (
      <div className="bg-green-900/80 border-b border-green-700/50 text-green-200 text-sm">
        <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-2">
          <span className="text-green-400">&#10003;</span>
          <span>{completedMessage}</span>
        </div>
      </div>
    );
  }

  // 実行中バナー
  const current = syncInfo?.currentSync;
  const typeLabel = current ? (TYPE_LABELS[current.type] || current.type) : '同期処理';
  const elapsed = current
    ? Math.round((now - new Date(current.startedAt).getTime()) / 1000)
    : 0;
  const elapsedStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒`
    : `${elapsed}秒`;

  return (
    <div className="bg-yellow-900/80 border-b border-yellow-700/50 text-yellow-200 text-sm">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3">
        <span className="inline-block w-3 h-3 rounded-full bg-yellow-400 animate-pulse" />
        <span className="font-medium">{typeLabel}実行中</span>
        {current?.details && (
          <span className="text-yellow-300/80 truncate hidden sm:inline">
            {current.details}
          </span>
        )}
        <span className="text-yellow-400/60 text-xs ml-auto whitespace-nowrap">
          {elapsedStr}経過
        </span>
      </div>
    </div>
  );
}
