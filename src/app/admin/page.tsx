'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { FixGradesPanel } from '@/components/admin/FixGradesPanel';
import { AdvancedPanel } from '@/components/admin/AdvancedPanel';
import { AccuracyPanel } from '@/components/admin/AccuracyPanel';

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
  const [loadingType, setLoadingType] = useState('');
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
    setLoadingType(type);
    setMessage('処理中...');
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
        // 同期処理の結果を詳細表示
        const parts: string[] = [];
        if (data.message) parts.push(data.message);
        if (data.details) parts.push(data.details);
        if (data.stats) {
          const s = data.stats;
          const statParts: string[] = [];
          if (s.predictionsGenerated > 0) statParts.push(`予想: ${s.predictionsGenerated}件`);
          if (s.racesScraped > 0) statParts.push(`レース: ${s.racesScraped}件`);
          if (s.oddsScraped > 0) statParts.push(`オッズ: ${s.oddsScraped}件`);
          if (s.horsesScraped > 0) statParts.push(`馬: ${s.horsesScraped}件`);
          if (statParts.length > 0) parts.push(`[${statParts.join(' / ')}]`);
        }
        if (data.errors?.length > 0) parts.push(`⚠ エラー${data.errors.length}件`);
        setMessage(parts.join(' | ') || `同期開始: ${data.syncId || ''}`);
        setTimeout(fetchStatus, 2000);
      } else {
        setMessage(data.error || 'エラーが発生しました');
      }
    } catch {
      setMessage('サーバーに接続できません');
    } finally {
      setLoading(false);
      setLoadingType('');
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
        <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
          message.includes('エラー') || message.includes('接続') || message.includes('失敗')
            ? 'bg-red-900/30 text-red-300 border border-red-700/30'
            : message === '処理中...'
              ? 'bg-yellow-900/30 text-yellow-300 border border-yellow-700/30'
              : 'bg-green-900/30 text-green-300 border border-green-700/30'
        }`}>
          {message === '処理中...' && (
            <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          )}
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
          {/* 結果取得 + バイアス再生成 */}
          <div className="bg-card-bg border border-card-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-bold">結果取得 + 予想再生成</h3>
            </div>
            <div className="flex items-center gap-2 mb-3">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-900/30 text-orange-300">レース当日に使う</span>
            </div>
            <p className="text-sm text-muted mb-3">
              レース結果を取得後、馬場バイアスを反映して予想を再生成します。
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
                onClick={() => triggerSync('results_bulk', { date: syncDate })}
                disabled={loading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {loading && loadingType === 'results_bulk' ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    取得中...
                  </span>
                ) : '結果取得'}
              </button>
              <button
                onClick={() => triggerSync('regenerate_predictions', { date: syncDate })}
                disabled={loading}
                className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-500 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {loading && loadingType === 'regenerate_predictions' ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    再生成中...
                  </span>
                ) : '再生成'}
              </button>
            </div>
            <p className="text-xs text-muted mt-2">
              手順: 先に「結果取得」→ 完了後に「再生成」を押してください。
            </p>
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
                className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-500 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {loading && loadingType === 'full' ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    実行中...
                  </span>
                ) : '実行'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ==================== 的中率ダッシュボード ==================== */}
      <AccuracyPanel headers={headers} triggerSync={triggerSync} />

      {/* ==================== グレード修正 ==================== */}
      <FixGradesPanel />

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

// ==================== グレード修正パネル ====================

