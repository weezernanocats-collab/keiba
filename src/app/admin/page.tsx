'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

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
  const [syncKey, setSyncKey] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('keiba-sync-key') || '';
    }
    return '';
  });
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
  const [isImporting, setIsImporting] = useState(false);
  const abortChunkedRef = useRef(false);

  // syncKeyをlocalStorageに永続化（SyncStatusBannerで利用）
  useEffect(() => {
    localStorage.setItem('keiba-sync-key', syncKey);
  }, [syncKey]);

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

  // チャンク方式バルクインポート（Vercel対応）
  const startBulkImport = useCallback(async () => {
    if (isImporting) return;
    setIsImporting(true);
    abortChunkedRef.current = false;
    setMessage('バルクインポートを開始しました');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let state: any = null;
    let retries = 0;

    while (true) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = { type: 'bulk_chunked' };
        if (state) {
          body.state = state;
        } else {
          body.startDate = bulkStartDate;
          body.endDate = bulkEndDate;
          body.clearExisting = bulkClearExisting;
        }

        const res = await fetch('/api/sync', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const data = await res.json();
          setMessage(data.error || 'エラーが発生しました');
          break;
        }

        const data = await res.json();
        state = data.state;
        retries = 0;

        // フェーズに応じた進捗計算
        let progressCurrent = 0;
        let progressTotal = 0;
        switch (state.phase) {
          case 'dates':
            progressCurrent = state.stats.datesProcessed;
            progressTotal = state.totalDates;
            break;
          case 'race_details':
            progressCurrent = state.stats.racesScraped;
            progressTotal = state.stats.racesScraped + state.phaseRemaining;
            break;
          case 'horses':
            progressCurrent = state.stats.horsesScraped;
            progressTotal = state.stats.horsesScraped + state.phaseRemaining;
            break;
          case 'results':
            progressCurrent = state.stats.resultsScraped;
            progressTotal = state.stats.resultsScraped + state.phaseRemaining;
            break;
          case 'predictions':
            progressCurrent = state.stats.predictionsGenerated;
            progressTotal = state.stats.predictionsGenerated + state.phaseRemaining;
            break;
        }

        setBulkProgress({
          phase: state.phaseLabel,
          current: progressCurrent,
          total: progressTotal,
          detail: state.phaseRemaining > 0
            ? `${state.phaseLabel} (残り${state.phaseRemaining}件)`
            : state.phaseLabel,
          stats: state.stats,
          errors: state.errors,
          isRunning: state.phase !== 'done',
          startedAt: state.startedAt,
          completedAt: state.completedAt,
        });

        if (state.phase === 'done') {
          setMessage('バルクインポートが完了しました');
          break;
        }

        if (abortChunkedRef.current) {
          setMessage('バルクインポートを中断しました');
          setBulkProgress(prev => prev ? { ...prev, isRunning: false, phase: '中断' } : null);
          break;
        }
      } catch {
        retries++;
        if (retries >= 5) {
          setMessage('サーバーに接続できません。処理を中断しました。');
          setBulkProgress(prev => prev ? { ...prev, isRunning: false, phase: 'エラー' } : null);
          break;
        }
        setMessage(`接続エラー。リトライ中... (${retries}/5)`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    setIsImporting(false);
  }, [bulkStartDate, bulkEndDate, bulkClearExisting, headers, isImporting]);

  const abortBulkImport = useCallback(() => {
    abortChunkedRef.current = true;
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
        <div className="flex items-center gap-2 mb-1">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-900/40 text-yellow-300">初回 / リセット時</span>
          <h3 className="font-bold text-lg">バルクインポート（実データ一括取り込み）</h3>
        </div>
        <p className="text-sm text-muted mb-4">
          netkeiba.com から指定期間のレース・馬・過去成績を一括で取り込みます。
          <span className="text-yellow-300">初回セットアップ時</span>や、DBをリセットした後に実行してください。
          日常運用ではCronが毎日自動取得するため不要です。
        </p>

        {/* 期間プリセット */}
        <div className="flex flex-wrap gap-2 mb-3">
          {[
            { label: '直近1ヶ月', days: 30 },
            { label: '直近3ヶ月', days: 90 },
            { label: '直近6ヶ月', days: 180 },
            { label: '直近1年 (推奨)', days: 365 },
            { label: '直近2年', days: 730 },
          ].map(preset => (
            <button
              key={preset.days}
              onClick={() => {
                const d = new Date();
                d.setDate(d.getDate() - preset.days);
                setBulkStartDate(d.toISOString().split('T')[0]);
                setBulkEndDate(new Date().toISOString().split('T')[0]);
              }}
              className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                preset.days === 365
                  ? 'border-primary text-primary hover:bg-primary/20 font-medium'
                  : 'border-card-border text-muted hover:bg-gray-700'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>

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
            disabled={loading || isImporting}
            className="px-6 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/80 disabled:opacity-50 transition-colors font-medium"
          >
            {isImporting ? 'インポート中...' : 'バルクインポート開始'}
          </button>
          {isImporting && (
            <button
              onClick={abortBulkImport}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-500 transition-colors"
            >
              中断
            </button>
          )}
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

      {/* ==================== 自動化ステータス ==================== */}
      <div className="bg-card-bg border border-green-700/40 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-900/40 text-green-300">自動</span>
          <h3 className="font-bold text-lg">自動データ更新</h3>
        </div>
        <p className="text-sm text-muted mb-4">
          以下の処理はVercel CronとGitHub Actionsで自動実行されます。操作不要です。
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-green-400 text-sm">&#x2713;</span>
              <span className="text-sm font-medium">毎朝 09:00 (JST)</span>
            </div>
            <p className="text-xs text-muted">レース一覧 / 出馬表 / 馬情報 / オッズ / AI予想を自動取得</p>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-green-400 text-sm">&#x2713;</span>
              <span className="text-sm font-medium">毎夕 17:00 (JST)</span>
            </div>
            <p className="text-xs text-muted">レース結果を自動取得 / 的中率を自動照合</p>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-green-400 text-sm">&#x2713;</span>
              <span className="text-sm font-medium">毎週月曜 12:00 (JST)</span>
            </div>
            <p className="text-xs text-muted">XGBoost MLモデルを自動再学習 (GitHub Actions)</p>
          </div>
        </div>
      </div>

      {/* ==================== 必要に応じて実行 ==================== */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-orange-900/40 text-orange-300">手動</span>
          <h3 className="font-bold text-lg">必要に応じて実行</h3>
        </div>
        <p className="text-sm text-muted mb-4">
          特定の状況で手動実行が必要な操作です。各項目の説明を確認してください。
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Regenerate Predictions */}
          <div className="bg-card-bg border border-card-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-bold">予想再生成（バイアス反映）</h3>
            </div>
            <div className="flex items-center gap-2 mb-3">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-900/30 text-orange-300">レース当日に使う</span>
            </div>
            <p className="text-sm text-muted mb-3">
              午前のレース結果を取得し、馬場バイアスを分析して午後のレース予想を再生成します。
              <span className="text-orange-300"> レース当日の13時頃</span>に実行すると効果的です。
            </p>
            <div className="flex gap-2">
              <input
                type="date"
                value={syncDate}
                onChange={e => setSyncDate(e.target.value)}
                className="flex-1 px-3 py-2 text-sm border border-card-border rounded-lg bg-gray-800 text-white"
              />
              <button
                onClick={() => triggerSync('regenerate_predictions', { date: syncDate })}
                disabled={loading}
                className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-500 disabled:opacity-50 transition-colors"
              >
                再生成
              </button>
            </div>
          </div>

          {/* Full Sync */}
          <div className="bg-card-bg border border-card-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-bold">フル同期（1日分）</h3>
            </div>
            <div className="flex items-center gap-2 mb-3">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-900/30 text-blue-300">Cronが動かなかった時に</span>
            </div>
            <p className="text-sm text-muted mb-3">
              指定日のレース一覧、出馬表、オッズ、馬詳細、AI予想を一括取得します。
              通常はCronが自動実行するため、<span className="text-blue-300">Cronが失敗した場合や過去日のデータが欲しい時</span>に使います。
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
        </div>
      </div>

      {/* ==================== 的中率ダッシュボード ==================== */}
      <AccuracyPanel headers={headers} triggerSync={triggerSync} />

      {/* ==================== 上級者向け：個別操作 ==================== */}
      <AdvancedPanel
        syncDate={syncDate}
        setSyncDate={setSyncDate}
        syncRaceId={syncRaceId}
        setSyncRaceId={setSyncRaceId}
        syncHorseId={syncHorseId}
        setSyncHorseId={setSyncHorseId}
        triggerSync={triggerSync}
        loading={loading}
        headers={headers}
      />

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

// ==================== 上級者向けパネル ====================

function AdvancedPanel({
  syncDate, setSyncDate, syncRaceId, setSyncRaceId, syncHorseId, setSyncHorseId,
  triggerSync, loading, headers,
}: {
  syncDate: string;
  setSyncDate: (v: string) => void;
  syncRaceId: string;
  setSyncRaceId: (v: string) => void;
  syncHorseId: string;
  setSyncHorseId: (v: string) => void;
  triggerSync: (type: string, extra?: Record<string, string | boolean>) => Promise<void>;
  loading: boolean;
  headers: () => Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);

  const schedAction = useCallback(async (action: string, extra?: Record<string, unknown>) => {
    try {
      await fetch('/api/scheduler', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ action, ...extra }),
      });
    } catch { /* ignore */ }
  }, [headers]);

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center justify-between w-full"
      >
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-700 text-gray-400">上級者向け</span>
          <h3 className="font-bold text-lg">個別操作・デバッグ</h3>
        </div>
        <span className="text-muted text-sm">{expanded ? '▲ 閉じる' : '▼ 開く'}</span>
      </button>
      <p className="text-sm text-muted mt-1">
        通常は使う必要のない個別データ取得操作です。デバッグやデータ修復時に使います。
      </p>

      {expanded && (
        <div className="mt-4 space-y-4">
          {/* 手動ジョブ実行 */}
          <div className="bg-gray-800/30 rounded-lg p-3">
            <h4 className="text-sm font-medium mb-2">Cronジョブを手動実行</h4>
            <p className="text-xs text-muted mb-3">Cronが失敗した場合や、今すぐ実行したい場合に個別のジョブを手動で実行できます。</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => schedAction('run_job', { job: 'morning' })} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors">
                朝取得（レース+出馬表+予想）
              </button>
              <button onClick={() => schedAction('run_job', { job: 'odds' })} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors">
                オッズ取得
              </button>
              <button onClick={() => schedAction('run_job', { job: 'results' })} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors">
                結果取得
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Race List */}
            <div className="bg-gray-800/30 rounded-lg p-3">
              <h4 className="text-sm font-medium mb-1">レース一覧取得</h4>
              <p className="text-xs text-muted mb-2">指定日のレース一覧のみを取得します。</p>
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
            <div className="bg-gray-800/30 rounded-lg p-3">
              <h4 className="text-sm font-medium mb-1">出馬表取得</h4>
              <p className="text-xs text-muted mb-2">指定レースIDの出馬表を取得します。</p>
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
            <div className="bg-gray-800/30 rounded-lg p-3">
              <h4 className="text-sm font-medium mb-1">馬詳細取得</h4>
              <p className="text-xs text-muted mb-2">指定馬IDの詳細と過去成績を取得します。</p>
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
        </div>
      )}
    </div>
  );
}

// ==================== 的中率パネル ====================

interface AccuracyData {
  totalEvaluated: number;
  winHitRate: number;
  placeHitRate: number;
  avgTop3Coverage: number;
  overallRoi: number;
  totalInvested: number;
  totalReturned: number;
  confidenceCalibration: { range: string; count: number; winHitRate: number; placeHitRate: number; avgRoi: number }[];
  recentTrend: { period: string; count: number; winHitRate: number; placeHitRate: number; roi: number }[];
}

interface CalibrationData {
  evaluatedRaces: number;
  factorContributions: { factor: string; weight: number; avgScoreWinners: number; avgScoreLosers: number; discriminationPower: number; suggestedWeight: number }[];
  suggestedWeights: Record<string, number>;
  currentWeights: Record<string, number>;
  expectedImprovement: string;
}

function AccuracyPanel({ headers, triggerSync }: {
  headers: () => Record<string, string>;
  triggerSync: (type: string, extra?: Record<string, string | boolean>) => Promise<void>;
}) {
  const [acc, setAcc] = useState<AccuracyData | null>(null);
  const [cal, setCal] = useState<CalibrationData | null>(null);
  const [repairStatus, setRepairStatus] = useState<string | null>(null);

  const fetchAccuracy = useCallback(async () => {
    try {
      const res = await fetch('/api/sync', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ type: 'accuracy' }),
      });
      const data = await res.json();
      if (data.stats) setAcc(data.stats);
    } catch { /* ignore */ }
  }, [headers]);

  const runCalibration = useCallback(async () => {
    try {
      const res = await fetch('/api/sync', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ type: 'calibrate' }),
      });
      const data = await res.json();
      if (data.calibration) setCal(data.calibration);
    } catch { /* ignore */ }
  }, [headers]);

  const runRepairBetsOdds = useCallback(async () => {
    let offset = 0;
    let totalRepaired = 0;
    let totalReEvaluated = 0;

    // Phase 1: オッズ修復（10件ずつ）
    setRepairStatus('修復中...');
    while (true) {
      try {
        const res = await fetch('/api/sync', {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ type: 'repair_bets_odds', offset }),
        });
        const data = await res.json();
        totalRepaired += data.repaired || 0;
        if (data.done) break;
        offset = data.nextOffset || offset + 10;
        setRepairStatus(`修復中... ${totalRepaired}件修復済`);
      } catch (e) {
        setRepairStatus(`修復エラー: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    // Phase 2: 再評価（5件ずつ）
    setRepairStatus(`修復${totalRepaired}件完了。再評価中...`);
    while (true) {
      try {
        const res = await fetch('/api/sync', {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ type: 'reeval_repaired' }),
        });
        const data = await res.json();
        totalReEvaluated += data.reEvaluated || 0;
        if (data.done) break;
        setRepairStatus(`再評価中... ${totalReEvaluated}件完了`);
      } catch (e) {
        setRepairStatus(`再評価エラー: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    setRepairStatus(`完了: ${totalRepaired}件修復、${totalReEvaluated}件再評価`);
    fetchAccuracy();
  }, [headers, fetchAccuracy]);

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-purple-900/40 text-purple-300">分析</span>
          <h3 className="font-bold text-lg">予想的中率ダッシュボード</h3>
        </div>
      </div>
      <p className="text-sm text-muted mb-3">
        AIの予想精度を確認できます。結果照合はCronで自動実行されますが、手動でも実行できます。
      </p>
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="flex items-center gap-1">
          <button onClick={fetchAccuracy} className="px-3 py-1 text-xs bg-gray-600 text-white rounded hover:bg-gray-500 transition-colors">
            統計表示
          </button>
          <span className="text-[10px] text-muted">現在の統計を読み込む</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => triggerSync('evaluate_all')} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors">
            一括照合
          </button>
          <span className="text-[10px] text-muted">結果未照合の予想を一括で照合</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={runCalibration} className="px-3 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-500 transition-colors">
            ウェイト校正
          </button>
          <span className="text-[10px] text-muted">照合データから最適ウェイトを分析</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={runRepairBetsOdds} disabled={repairStatus !== null && !repairStatus.startsWith('完了') && !repairStatus.startsWith('エラー')} className="px-3 py-1 text-xs bg-orange-600 text-white rounded hover:bg-orange-500 transition-colors disabled:opacity-50">
            オッズ修復
          </button>
          <span className="text-[10px] text-muted">{repairStatus || 'bets_jsonにオッズを補完&再評価'}</span>
        </div>
      </div>

      {!acc ? (
        <p className="text-sm text-muted">「統計表示」をクリックして的中率統計を読み込みます</p>
      ) : acc.totalEvaluated === 0 ? (
        <p className="text-sm text-muted">照合済みレースがありません。結果が確定したレースがあれば「一括照合」を実行してください。</p>
      ) : (
        <div className="space-y-4">
          {/* 全体統計 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="照合レース数" value={`${acc.totalEvaluated}`} />
            <StatCard label="単勝的中率" value={`${acc.winHitRate}%`} color={acc.winHitRate >= 15 ? 'green' : acc.winHitRate >= 8 ? 'yellow' : 'red'} />
            <StatCard label="複勝的中率" value={`${acc.placeHitRate}%`} color={acc.placeHitRate >= 40 ? 'green' : acc.placeHitRate >= 25 ? 'yellow' : 'red'} />
            <StatCard label="回収率" value={`${acc.overallRoi}%`} color={acc.overallRoi >= 100 ? 'green' : acc.overallRoi >= 75 ? 'yellow' : 'red'} />
          </div>

          {/* 信頼度校正 */}
          {acc.confidenceCalibration.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">信頼度別 的中率（校正データ）</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-card-border text-muted">
                      <th className="py-1 text-left">信頼度帯</th>
                      <th className="py-1 text-right">件数</th>
                      <th className="py-1 text-right">単勝的中</th>
                      <th className="py-1 text-right">複勝的中</th>
                      <th className="py-1 text-right">ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acc.confidenceCalibration.map(c => (
                      <tr key={c.range} className="border-b border-card-border/50">
                        <td className="py-1.5 font-medium">{c.range}%</td>
                        <td className="py-1.5 text-right">{c.count}</td>
                        <td className="py-1.5 text-right">{c.winHitRate}%</td>
                        <td className="py-1.5 text-right">{c.placeHitRate}%</td>
                        <td className="py-1.5 text-right">{c.avgRoi}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* トレンド */}
          {acc.recentTrend.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">的中率トレンド</h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {acc.recentTrend.map(t => (
                  <div key={t.period} className="bg-gray-800/50 rounded p-2 text-xs text-center">
                    <div className="font-medium mb-1">{t.period} ({t.count}件)</div>
                    <div>単{t.winHitRate}% / 複{t.placeHitRate}% / ROI {t.roi}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ウェイト自動校正結果 */}
          {cal && (
            <div className="border-t border-card-border pt-4">
              <h4 className="text-sm font-medium mb-2">ウェイト自動校正分析（{cal.evaluatedRaces}レース分析）</h4>
              <p className="text-xs text-muted mb-3">{cal.expectedImprovement}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-card-border text-muted">
                      <th className="py-1 text-left">ファクター</th>
                      <th className="py-1 text-right">現在</th>
                      <th className="py-1 text-right">推奨</th>
                      <th className="py-1 text-right">変更</th>
                      <th className="py-1 text-right">識別力</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cal.factorContributions.map(fc => {
                      const diff = fc.suggestedWeight - fc.weight;
                      const diffColor = diff > 0.005 ? 'text-green-400' : diff < -0.005 ? 'text-red-400' : 'text-gray-500';
                      return (
                        <tr key={fc.factor} className="border-b border-card-border/50">
                          <td className="py-1">{fc.factor}</td>
                          <td className="py-1 text-right">{(fc.weight * 100).toFixed(1)}%</td>
                          <td className="py-1 text-right font-medium">{(fc.suggestedWeight * 100).toFixed(1)}%</td>
                          <td className={`py-1 text-right ${diffColor}`}>
                            {diff > 0 ? '+' : ''}{(diff * 100).toFixed(1)}%
                          </td>
                          <td className="py-1 text-right">{fc.discriminationPower}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted mt-2">
                識別力 = 1着馬の平均スコア - 非1着馬の平均スコア。高いほど予測に有用。
                推奨値はデータ蓄積に応じて精度が向上します。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: 'green' | 'yellow' | 'red' }) {
  const colorClass = color === 'green' ? 'text-green-300' : color === 'yellow' ? 'text-yellow-300' : color === 'red' ? 'text-red-300' : 'text-white';
  return (
    <div className="bg-gray-800/50 rounded-lg p-3 text-center">
      <div className={`text-xl font-bold ${colorClass}`}>{value}</div>
      <div className="text-xs text-muted mt-0.5">{label}</div>
    </div>
  );
}
