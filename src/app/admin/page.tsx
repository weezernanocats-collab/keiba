'use client';

import { useState, useCallback } from 'react';

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

export default function AdminPage() {
  const [syncKey, setSyncKey] = useState('');
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [syncDate, setSyncDate] = useState(new Date().toISOString().split('T')[0]);
  const [syncRaceId, setSyncRaceId] = useState('');
  const [syncHorseId, setSyncHorseId] = useState('');

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

  const triggerSync = useCallback(async (type: string, extraParams?: Record<string, string>) => {
    setLoading(true);
    setMessage('');
    try {
      const body: Record<string, string> = { type };
      if (extraParams) Object.assign(body, extraParams);

      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(`同期開始: ${data.syncId}`);
        // Poll status after a bit
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
        <div className={`p-3 rounded-lg text-sm ${message.includes('エラー') || message.includes('接続') ? 'bg-red-900/30 text-red-300 border border-red-700/30' : 'bg-green-900/30 text-green-300 border border-green-700/30'}`}>
          {message}
        </div>
      )}

      {/* Sync Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Full Sync */}
        <div className="bg-card-bg border border-card-border rounded-xl p-4">
          <h3 className="font-bold mb-2">フル同期</h3>
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
