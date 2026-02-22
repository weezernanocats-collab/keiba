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

      {/* ==================== 自動スケジューラー ==================== */}
      <SchedulerPanel headers={headers} />

      {/* ==================== 的中率ダッシュボード ==================== */}
      <AccuracyPanel headers={headers} triggerSync={triggerSync} />

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

// ==================== スケジューラーパネル ====================

interface SchedulerStatus {
  isRunning: boolean;
  config: { morningFetchTime: string; oddsFetchTime: string; resultFetchTime: string; nightFetchTime: string };
  lastRun: string | null;
  nextScheduled: string | null;
  recentLogs: { timestamp: string; action: string; detail: string; success: boolean }[];
}

function SchedulerPanel({ headers }: { headers: () => Record<string, string> }) {
  const [sched, setSched] = useState<SchedulerStatus | null>(null);

  const fetchScheduler = useCallback(async () => {
    try {
      const res = await fetch('/api/scheduler', { headers: headers() });
      if (res.ok) setSched(await res.json());
    } catch { /* ignore */ }
  }, [headers]);

  const schedAction = useCallback(async (action: string, extra?: Record<string, unknown>) => {
    try {
      await fetch('/api/scheduler', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ action, ...extra }),
      });
      setTimeout(fetchScheduler, 1000);
    } catch { /* ignore */ }
  }, [headers, fetchScheduler]);

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-lg">自動データ更新スケジューラー</h3>
        <button onClick={fetchScheduler} className="px-3 py-1 text-xs bg-gray-600 text-white rounded hover:bg-gray-500 transition-colors">
          状態取得
        </button>
      </div>

      {!sched ? (
        <p className="text-sm text-muted">「状態取得」をクリックしてスケジューラーの状態を確認</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className={`px-2 py-1 rounded text-xs font-medium ${sched.isRunning ? 'bg-green-900/40 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
              {sched.isRunning ? '稼働中' : '停止中'}
            </span>
            {sched.nextScheduled && (
              <span className="text-xs text-muted">次回: {sched.nextScheduled}</span>
            )}
            {sched.lastRun && (
              <span className="text-xs text-muted">最終: {sched.lastRun}</span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {!sched.isRunning ? (
              <button onClick={() => schedAction('start')} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-500 transition-colors">
                スケジューラー開始
              </button>
            ) : (
              <button onClick={() => schedAction('stop')} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-500 transition-colors">
                停止
              </button>
            )}
            <button onClick={() => schedAction('run_job', { job: 'morning' })} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors">
              今すぐ朝取得
            </button>
            <button onClick={() => schedAction('run_job', { job: 'odds' })} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors">
              今すぐオッズ
            </button>
            <button onClick={() => schedAction('run_job', { job: 'results' })} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors">
              今すぐ結果
            </button>
          </div>

          <p className="text-xs text-muted">
            スケジュール: 朝{sched.config.morningFetchTime} / オッズ{sched.config.oddsFetchTime} / 結果{sched.config.resultFetchTime} / 翌日分{sched.config.nightFetchTime}
          </p>

          {sched.recentLogs.length > 0 && (
            <div className="max-h-40 overflow-y-auto space-y-1">
              {sched.recentLogs.slice(0, 10).map((log, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className={log.success ? 'text-green-400' : 'text-red-400'}>
                    {log.success ? '[OK]' : '[NG]'}
                  </span>
                  <span className="text-muted">{log.timestamp.slice(11, 19)}</span>
                  <span className="font-medium">{log.action}</span>
                  <span className="text-muted truncate">{log.detail}</span>
                </div>
              ))}
            </div>
          )}
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

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-lg">予想的中率ダッシュボード</h3>
        <div className="flex gap-2">
          <button onClick={() => triggerSync('evaluate_all')} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors">
            一括照合
          </button>
          <button onClick={runCalibration} className="px-3 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-500 transition-colors">
            ウェイト校正
          </button>
          <button onClick={fetchAccuracy} className="px-3 py-1 text-xs bg-gray-600 text-white rounded hover:bg-gray-500 transition-colors">
            統計更新
          </button>
        </div>
      </div>

      {!acc ? (
        <p className="text-sm text-muted">「統計更新」をクリックして的中率統計を取得</p>
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
