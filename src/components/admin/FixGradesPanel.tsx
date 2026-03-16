'use client';

import { useState } from 'react';

interface FixGradesResult {
  g1Before: number;
  g1After: number;
  g1Fixed: number;
  nullGradeFixed: number;
  distribution: { grade: string | null; cnt: number }[];
}

export function FixGradesPanel() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FixGradesResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFix = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/fix-grades', { method: 'POST' });
      if (!res.ok) {
        const text = await res.text();
        setError(`API エラー (${res.status}): ${text.slice(0, 200)}`);
        return;
      }
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(`通信エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4">
      <h3 className="font-bold text-lg mb-2">レースグレード修正</h3>
      <p className="text-sm text-muted mb-3">
        旧スクレイパーのバグにより、オープン/勝クラス/未勝利/新馬がG1に誤分類されている問題を修正します。
        レース名をもとに正しいクラスに再分類します。
      </p>
      <button
        onClick={handleFix}
        disabled={loading}
        className="px-4 py-2 text-sm bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:opacity-50 transition-colors"
      >
        {loading ? '修正中...' : 'グレード再分類を実行'}
      </button>

      {error && (
        <div className="mt-3 p-3 rounded-lg text-sm bg-red-900/30 text-red-300 border border-red-700/30">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 space-y-2">
          <div className="p-3 rounded-lg text-sm bg-green-900/30 text-green-300 border border-green-700/30">
            G1: {result.g1Before}件 → {result.g1After}件（{result.g1Fixed}件修正）
            {result.nullGradeFixed > 0 && ` / NULL→クラス設定: ${result.nullGradeFixed}件`}
          </div>
          {result.distribution.length > 0 && (
            <div className="text-sm">
              <div className="text-muted mb-1">修正後のグレード分布:</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                {result.distribution.map(d => (
                  <div key={d.grade ?? 'null'} className="text-xs py-1 px-2 bg-gray-800 rounded flex justify-between">
                    <span>{d.grade || '未分類'}</span>
                    <span className="font-mono">{d.cnt}件</span>
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
