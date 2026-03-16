'use client';

import { useState, useCallback } from 'react';

export interface AdvancedPanelProps {
  syncDate: string;
  setSyncDate: (v: string) => void;
  syncRaceId: string;
  setSyncRaceId: (v: string) => void;
  syncHorseId: string;
  setSyncHorseId: (v: string) => void;
  triggerSync: (type: string, extra?: Record<string, string | boolean>) => Promise<void>;
  loading: boolean;
  headers: () => Record<string, string>;
}

export function AdvancedPanel({
  syncDate, setSyncDate, syncRaceId, setSyncRaceId, syncHorseId, setSyncHorseId,
  triggerSync, loading, headers,
}: AdvancedPanelProps) {
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
