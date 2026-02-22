'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

interface SyncLogEntry {
  id: string;
  type: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  details: string;
  errors: string[];
  stats: {
    racesScraped: number;
    entriesScraped: number;
    horsesScraped: number;
    oddsScraped: number;
    resultsScraped: number;
    predictionsGenerated: number;
  };
}

interface SyncStatus {
  currentSync: SyncLogEntry | null;
  history: SyncLogEntry[];
  isRunning: boolean;
}

interface BulkProgress {
  phase: string;
  current: number;
  total: number;
  detail: string;
  stats: {
    datesProcessed: number;
    racesScraped: number;
    entriesScraped: number;
    horsesScraped: number;
    pastPerformancesImported: number;
    oddsScraped: number;
    resultsScraped: number;
    predictionsGenerated: number;
  };
  errors: string[];
  isRunning: boolean;
  startedAt: string;
  completedAt?: string;
}

export default function AdminPage() {
  const [syncKey, setSyncKey] = useState('');
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [syncDate, setSyncDate] = useState(new Date().toISOString().split('T')[0]);
  const [syncRaceId, setSyncRaceId] = useState('');
  const [syncHorseId, setSyncHorseId] = useState('');
  // バルクインポート用
  const [bulkStartDate, setBulkStartDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [bulkEndDate, setBulkEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [bulkClearExisting, setBulkClearExisting] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const bulkPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const headers = useCallback(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (syncKey) h['x-sync-key'] = syncKey;
    return h;
  }, [syncKey]);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sync', { headers: headers() });
      const data = await res.json();
      if (res.ok) {
        setStatus(data);
        setMessage('');
      } else {
        setMessage(data.error || 'エラーが発生しました');
      }
    } catch {
      setMessage('サーバーに接続できません');
    } finally {
      setLoading(false);
    }
  }, [headers]);

  const triggerSync = useCallback(async (type: string, extraParams?: Record<string, string | boolean>) => {
    setLoading(true);
    setMessage('');
    try {
      const body: Record<string, string | boolean> = { type };
      if (extraParams) Object.assign(body, extraParams);

      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(data.message || `同期開始: ${data.syncId || ''}`);
        setTimeout(fetchStatus, 2000);
      } else {
        setMessage(data.error || 'エラーが発生しました');
      }
    } catch {
      setMessage('サーバーに接続できません');
    } finally {
      setLoading(false);
    }
  }, [headers, fetchStatus]);

  // バルクインポートの進捗ポーリング
  const pollBulkProgress = useCallback(async () => {
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'bulk_status' }),
      });
      const data = await res.json();
      if (data.progress) {
        setBulkProgress(data.progress);
        if (!data.progress.isRunning && bulkPollRef.current) {
          clearInterval(bulkPollRef.current);
          bulkPollRef.current = null;
        }
      }
    } catch {
      // ignore polling errors
    }
  }, [headers]);

  const startBulkImport = useCallback(async () => {
    await triggerSync('bulk', {
      startDate: bulkStartDate,
      endDate: bulkEndDate,
      clearExisting: bulkClearExisting,
    });
    // Start polling
    if (bulkPollRef.current) clearInterval(bulkPollRef.current);
    bulkPollRef.current = setInterval(pollBulkProgress, 3000);
    setTimeout(pollBulkProgress, 1000);
  }, [triggerSync, bulkStartDate, bulkEndDate, bulkClearExisting, pollBulkProgress]);

  const abortBulkImport = useCallback(async () => {
    await triggerSync('bulk_abort');
    setTimeout(pollBulkProgress, 2000);
  }, [triggerSync, pollBulkProgress]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (bulkPollRef.current) clearInterval(bulkPollRef.current);
    };
  }, []);

  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold">データ管理</h1>

      {/* Sync Key */}
      <div className="bg-card-bg border border-card-border rounded-xl p-4">
        <label className="block text-sm font-medium mb-2">同期キー（SYNC_KEY設定時のみ必要）</label>
        <div className="flex gap-2">
          <input
            type="password"
            value={syncKey}
            onChange={e => setSyncKey(e.target.value)}
            className="flex-1 px-3 py-2 text-sm border border-card-border rounded-lg bg-gray-800 text-white"
            placeholder="同期キーを入力..."
          />
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/80 disabled:opacity-50 transition-colors"
          >
            状態確認
          </button>
        </div>
      </div>

      {message && (
        <div className={`p-3 rounded-lg text-sm ${message.includes('エラー') || message.includes('接続') || message.includes('失敗') ? 'bg-red-900/30 text-red-300 border border-red-700/30' : 'bg-green-900/30 text-green-300 border border-green-700/30'}`}>
          {message}
        </div>
      )}

      {/* ==================== バルクインポート ==================== */}
      <div className="bg-card-bg border-2 border-primary/40 rounded-xl p-4">
        <h3 className="font-bold mb-2 text-lg">バルクインポート（実データ一括取り込み）</h3>
        <p className="text-sm text-muted mb-4">
          netkeiba.com から指定期間のレース・馬・過去成績を一括で取り込みます。
          数百〜数千頭の実データを投入し、種牡馬統計やコース統計を有効にします。
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-muted mb-1">開始日</label>
            <input
              type="date"
              value={bulkStartDate}
              onChange={e => setBulkStartDate(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-card-border rounded-lg bg-gray-800 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">終了日</label>
            <input
              type="date"
              value={bulkEndDate}
              onChange={e => setBulkEndDate(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-card-border rounded-lg bg-gray-800 text-white"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 mb-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={bulkClearExisting}
              onChange={e => setBulkClearExisting(e.target.checked)}
              className="rounded"
            />
            <span>既存データをクリアしてから取り込む</span>
          </label>
        </div>

        <div className="flex gap-2">
          <button
            onClick={startBulkImport}
            disabled={loading || (bulkProgress?.isRunning ?? false)}
            className="px-6 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/80 disabled:opacity-50 transition-colors font-medium"
          >
            バルクインポート開始
          </button>
          {bulkProgress?.isRunning && (
            <button
              onClick={abortBulkImport}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-500 transition-colors"
            >
              中断
            </button>
          )}
          <button
            onClick={pollBulkProgress}
            className="px-4 py-2 text-sm bg-gray-600 text-white rounded-lg hover:bg-gray-500 transition-colors"
          >
            進捗確認
          </button>
        </div>

        {/* バルクインポート進捗表示 */}
        {bulkProgress && (
          <div className="mt-4 space-y-3">
            <div className={`p-3 rounded-lg border ${
              bulkProgress.isRunning ? 'bg-blue-900/20 border-blue-700/30' :
              bulkProgress.errors.length > 0 ? 'bg-yellow-900/20 border-yellow-700/30' :
              'bg-green-900/20 border-green-700/30'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{bulkProgress.phase}</span>
                {bulkProgress.isRunning && bulkProgress.total > 0 && (
                  <span className="text-xs text-muted">{bulkProgress.current}/{bulkProgress.total}</span>
                )}
              </div>
              <p className="text-xs text-muted mb-2">{bulkProgress.detail}</p>

              {/* Progress bar */}
              {bulkProgress.isRunning && bulkProgress.total > 0 && (
                <div className="w-full bg-gray-700 rounded-full h-2 mb-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all duration-300"
                    style={{ width: `${Math.round((bulkProgress.current / bulkProgress.total) * 100)}%` }}
                  />
                </div>
              )}

              {/* Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {bulkProgress.stats.datesProcessed > 0 && (
                  <div className="bg-gray-800/50 rounded p-1.5 text-center">
                    <div className="font-medium">{bulkProgress.stats.datesProcessed}</div>
                    <div className="text-muted">日分</div>
                  </div>
                )}
                {bulkProgress.stats.racesScraped > 0 && (
                  <div className="bg-gray-800/50 rounded p-1.5 text-center">
                    <div className="font-medium">{bulkProgress.stats.racesScraped}</div>
                    <div className="text-muted">レース</div>
                  </div>
                )}
                {bulkProgress.stats.horsesScraped > 0 && (
                  <div className="bg-gray-800/50 rounded p-1.5 text-center">
                    <div className="font-medium">{bulkProgress.stats.horsesScraped}</div>
                    <div className="text-muted">馬</div>
                  </div>
                )}
                {bulkProgress.stats.pastPerformancesImported > 0 && (
                  <div className="bg-gray-800/50 rounded p-1.5 text-center">
                    <div className="font-medium">{bulkProgress.stats.pastPerformancesImported}</div>
                    <div className="text-muted">過去成績</div>
                  </div>
                )}
                {bulkProgress.stats.entriesScraped > 0 && (
                  <div className="bg-gray-800/50 rounded p-1.5 text-center">
                    <div className="font-medium">{bulkProgress.stats.entriesScraped}</div>
                    <div className="text-muted">出走馬</div>
                  </div>
                )}
                {bulkProgress.stats.resultsScraped > 0 && (
                  <div className="bg-gray-800/50 rounded p-1.5 text-center">
                    <div className="font-medium">{bulkProgress.stats.resultsScraped}</div>
                    <div className="text-muted">結果</div>
                  </div>
                )}
                {bulkProgress.stats.oddsScraped > 0 && (
                  <div className="bg-gray-800/50 rounded p-1.5 text-center">
                    <div className="font-medium">{bulkProgress.stats.oddsScraped}</div>
                    <div className="text-muted">オッズ</div>
                  </div>
                )}
                {bulkProgress.stats.predictionsGenerated > 0 && (
                  <div className="bg-gray-800/50 rounded p-1.5 text-center">
                    <div className="font-medium">{bulkProgress.stats.predictionsGenerated}</div>
                    <div className="text-muted">予想</div>
                  </div>
                )}
              </div>
            </div>

            {/* Errors */}
            {bulkProgress.errors.length > 0 && (
              <div className="p-3 rounded-lg bg-red-900/20 border border-red-700/30">
                <p className="text-xs font-medium text-red-300 mb-1">エラー ({bulkProgress.errors.length}件)</p>
                <div className="max-h-32 overflow-y-auto">
                  {bulkProgress.errors.slice(0, 10).map((err, i) => (
                    <p key={i} className="text-xs text-red-400">{err}</p>
                  ))}
                  {bulkProgress.errors.length > 10 && (
                    <p className="text-xs text-muted">他{bulkProgress.errors.length - 10}件</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ==================== 個別同期アクション ==================== */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Full Sync */}
        <div className="bg-card-bg border border-card-border rounded-xl p-4">
          <h3 className="font-bold mb-2">フル同期（1日分）</h3>
          <p className="text-sm text-muted mb-3">
            指定日のレース一覧、出馬表、オッズ、馬詳細、AI予想を一括取得します。
          </p>
          <div className="flex gap-2">
            <input
              type="date"
              value={syncDate}
              onChange={e => setSyncDate(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-card-border rounded-lg bg-gray-800 text-white"
            />
            <button
              onClick={() => triggerSync('full', { date: syncDate })}
              disabled={loading}
              className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-500 disabled:opacity-50 transition-colors"
            >
              実行
            </button>
          </div>
        </div>

        {/* Race List */}
        <div className="bg-card-bg border border-card-border rounded-xl p-4">
          <h3 className="font-bold mb-2">レース一覧取得</h3>
          <p className="text-sm text-muted mb-3">
            指定日のレース一覧のみを取得します。
          </p>
          <div className="flex gap-2">
            <input
              type="date"
              value={syncDate}
              onChange={e => setSyncDate(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-card-border rounded-lg bg-gray-800 text-white"
            />
            <button
              onClick={() => triggerSync('races', { date: syncDate })}
              disabled={loading}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              実行
            </button>
          </div>
        </div>

        {/* Race Detail */}
        <div className="bg-card-bg border border-card-border rounded-xl p-4">
          <h3 className="font-bold mb-2">出馬表取得</h3>
          <p className="text-sm text-muted mb-3">
            指定レースIDの出馬表を取得します。
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={syncRaceId}
              onChange={e => setSyncRaceId(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-card-border rounded-lg bg-gray-800 text-white"
              placeholder="レースID"
            />
            <button
              onClick={() => triggerSync('race_detail', { raceId: syncRaceId })}
              disabled={loading || !syncRaceId}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              実行
            </button>
          </div>
        </div>

        {/* Horse Detail */}
        <div className="bg-card-bg border border-card-border rounded-xl p-4">
          <h3 className="font-bold mb-2">馬詳細取得</h3>
          <p className="text-sm text-muted mb-3">
            指定馬IDの詳細と過去成績を取得します。
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={syncHorseId}
              onChange={e => setSyncHorseId(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-card-border rounded-lg bg-gray-800 text-white"
              placeholder="馬ID"
            />
            <button
              onClick={() => triggerSync('horse', { horseId: syncHorseId })}
              disabled={loading || !syncHorseId}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              実行
            </button>
          </div>
        </div>
      </div>

      {/* Sync Status */}
      {status && (
        <div className="space-y-4">
          {/* Current sync */}
          {status.currentSync && (
            <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4">
              <h3 className="font-bold text-yellow-300 mb-2">実行中の同期</h3>
              <p className="text-sm">{status.currentSync.details}</p>
              <p className="text-xs text-muted mt-1">ID: {status.currentSync.id}</p>
            </div>
          )}

          {/* History */}
          {status.history.length > 0 && (
            <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-card-border">
                <h3 className="font-bold text-sm">同期履歴</h3>
              </div>
              <div className="divide-y divide-card-border">
                {status.history.map(entry => (
                  <div key={entry.id} className="px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        entry.status === 'completed' ? 'bg-green-900/40 text-green-300' :
                        entry.status === 'failed' ? 'bg-red-900/40 text-red-300' :
                        'bg-yellow-900/40 text-yellow-300'
                      }`}>
                        {entry.status === 'completed' ? '完了' : entry.status === 'failed' ? '失敗' : '実行中'}
                      </span>
                      <span className="text-xs text-muted">{entry.type}</span>
                      <span className="text-xs text-muted ml-auto">{entry.startedAt}</span>
                    </div>
                    <p className="text-sm">{entry.details}</p>
                    {entry.errors.length > 0 && (
                      <div className="mt-1">
                        {entry.errors.slice(0, 3).map((err, i) => (
                          <p key={i} className="text-xs text-red-400">{err}</p>
                        ))}
                        {entry.errors.length > 3 && (
                          <p className="text-xs text-muted">他{entry.errors.length - 3}件のエラー</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
