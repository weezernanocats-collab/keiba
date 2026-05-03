'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, Suspense } from 'react';

const BET_TYPE_LABELS: Record<string, string> = {
  tansho: '単勝',
  umaren: '馬連',
  wide: 'ワイド',
  umatan: '馬単',
  sanrenpuku: '三連複',
  sanrentan: '三連単',
};

const STRATEGY_LABELS: Record<string, string> = {
  shoshan: 'しょーさん予想',
  ai: 'AI予想',
  shoshan_ai: 'しょーさん×AI掛け合わせ',
};

const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  shoshan: '先行力×休養×アゲ騎手理論に基づく予想',
  ai: 'XGBoost+CatBoostによるAI予想',
  shoshan_ai: 'しょーさん予想とAI予想の一致馬を狙う',
};

interface BetConfig {
  userId: string;
  dailyBudget: number;
  betTypes: Record<string, boolean>;
  strategies: Record<string, boolean>;
  strategyWeights: Record<string, number>;
  minOdds: number | null;
  maxOdds: number | null;
  active: boolean;
}

function ConfigForm() {
  const searchParams = useSearchParams();
  const userId = searchParams.get('user');

  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading');
  const [displayName, setDisplayName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isDefault, setIsDefault] = useState(true);

  const [config, setConfig] = useState<BetConfig>({
    userId: '',
    dailyBudget: 3000,
    betTypes: { tansho: true, umaren: false, wide: false, umatan: false, sanrenpuku: false, sanrentan: false },
    strategies: { shoshan: true, ai: true, shoshan_ai: false },
    strategyWeights: { shoshan: 50, ai: 50 },
    minOdds: null,
    maxOdds: null,
    active: true,
  });

  useEffect(() => {
    if (!userId) {
      setStatus('error');
      setErrorMsg('URLにユーザーIDが必要です（例: /betting-config?user=murakoshi）');
      return;
    }
    fetch(`/api/betting-config?userId=${userId}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setStatus('error');
          setErrorMsg(data.error);
        } else {
          setDisplayName(data.displayName);
          setConfig(data.config);
          setIsDefault(data.isDefault);
          setStatus('ready');
        }
      })
      .catch(() => {
        setStatus('error');
        setErrorMsg('通信エラー');
      });
  }, [userId]);

  // 有効な戦略の合計が100%になるようウェイト正規化
  const activeStrategies = Object.entries(config.strategies).filter(([, v]) => v).map(([k]) => k);

  const handleBetTypeToggle = (key: string) => {
    setConfig(prev => ({
      ...prev,
      betTypes: { ...prev.betTypes, [key]: !prev.betTypes[key] },
    }));
  };

  const handleStrategyToggle = (key: string) => {
    setConfig(prev => {
      const newStrategies = { ...prev.strategies, [key]: !prev.strategies[key] };
      // ウェイト再計算：新しく有効になった戦略を均等配分
      const active = Object.entries(newStrategies).filter(([, v]) => v).map(([k]) => k);
      const equalWeight = active.length > 0 ? Math.floor(100 / active.length) : 0;
      const newWeights: Record<string, number> = {};
      active.forEach((k, i) => {
        newWeights[k] = i === active.length - 1 ? 100 - equalWeight * (active.length - 1) : equalWeight;
      });
      return { ...prev, strategies: newStrategies, strategyWeights: newWeights };
    });
  };

  const handleWeightChange = (key: string, value: number) => {
    setConfig(prev => {
      const newWeights = { ...prev.strategyWeights, [key]: value };
      // 他の戦略のウェイトを残りで按分
      const others = activeStrategies.filter(k => k !== key);
      const remaining = Math.max(0, 100 - value);
      const currentOthersTotal = others.reduce((s, k) => s + (prev.strategyWeights[k] || 0), 0);
      others.forEach(k => {
        if (currentOthersTotal > 0) {
          newWeights[k] = Math.round((prev.strategyWeights[k] || 0) / currentOthersTotal * remaining);
        } else {
          newWeights[k] = Math.round(remaining / others.length);
        }
      });
      return { ...prev, strategyWeights: newWeights };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // バリデーション
    if (!Object.values(config.betTypes).some(v => v)) {
      setErrorMsg('少なくとも1つの券種を選んでください');
      return;
    }
    if (!Object.values(config.strategies).some(v => v)) {
      setErrorMsg('少なくとも1つの戦略を選んでください');
      return;
    }
    if (config.dailyBudget < 100) {
      setErrorMsg('予算は100円以上にしてください');
      return;
    }

    setStatus('saving');
    setErrorMsg('');

    try {
      const res = await fetch('/api/betting-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.success) {
        setStatus('saved');
        setIsDefault(false);
        setTimeout(() => setStatus('ready'), 2000);
      } else {
        setStatus('ready');
        setErrorMsg(data.error || '保存に失敗しました');
      }
    } catch {
      setStatus('ready');
      setErrorMsg('通信エラー');
    }
  };

  if (status === 'loading') {
    return <div className="text-center py-20 text-gray-500">読み込み中...</div>;
  }
  if (status === 'error') {
    return (
      <div className="max-w-lg mx-auto mt-16 p-6 bg-red-50 border border-red-200 rounded-lg">
        <h2 className="text-lg font-bold text-red-700 mb-2">エラー</h2>
        <p className="text-red-600">{errorMsg}</p>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto mt-6 p-4 sm:p-6">
      <h1 className="text-xl font-bold mb-1">買い目設定</h1>
      <p className="text-sm text-gray-600 mb-4">
        {displayName}さんの自動投票設定
        {isDefault && <span className="ml-2 text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">初期設定</span>}
      </p>

      {errorMsg && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-600 text-sm">{errorMsg}</div>
      )}

      {status === 'saved' && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded text-green-600 text-sm">
          設定を保存しました
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* 1日トータル予算 */}
        <section>
          <label className="block text-sm font-semibold text-gray-800 mb-2">1日の予算</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={config.dailyBudget}
              onChange={e => setConfig(prev => ({ ...prev, dailyBudget: parseInt(e.target.value) || 0 }))}
              min={100}
              step={100}
              className="w-32 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-right"
            />
            <span className="text-gray-600">円</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">全レースの合計金額（100円単位）</p>
        </section>

        {/* 券種選択 */}
        <section>
          <h2 className="text-sm font-semibold text-gray-800 mb-2">券種</h2>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(BET_TYPE_LABELS).map(([key, label]) => (
              <label
                key={key}
                className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${
                  config.betTypes[key]
                    ? 'bg-blue-50 border-blue-300'
                    : 'bg-white border-gray-200 hover:bg-gray-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={config.betTypes[key] || false}
                  onChange={() => handleBetTypeToggle(key)}
                  className="w-4 h-4 text-blue-600 rounded"
                />
                <span className="text-sm font-medium">{label}</span>
              </label>
            ))}
          </div>
        </section>

        {/* 戦略選択 */}
        <section>
          <h2 className="text-sm font-semibold text-gray-800 mb-2">ベース戦略</h2>
          <div className="space-y-2">
            {Object.entries(STRATEGY_LABELS).map(([key, label]) => (
              <label
                key={key}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  config.strategies[key]
                    ? 'bg-green-50 border-green-300'
                    : 'bg-white border-gray-200 hover:bg-gray-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={config.strategies[key] || false}
                  onChange={() => handleStrategyToggle(key)}
                  className="w-4 h-4 text-green-600 rounded mt-0.5"
                />
                <div>
                  <span className="text-sm font-medium">{label}</span>
                  <p className="text-xs text-gray-400 mt-0.5">{STRATEGY_DESCRIPTIONS[key]}</p>
                </div>
              </label>
            ))}
          </div>
        </section>

        {/* 戦略配分（2つ以上有効時のみ表示） */}
        {activeStrategies.length >= 2 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-800 mb-2">予算配分</h2>
            <div className="space-y-3">
              {activeStrategies.map(key => (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-sm w-36 truncate">{STRATEGY_LABELS[key]}</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={config.strategyWeights[key] || 0}
                    onChange={e => handleWeightChange(key, parseInt(e.target.value))}
                    className="flex-1"
                  />
                  <span className="text-sm font-mono w-10 text-right">{config.strategyWeights[key] || 0}%</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* オッズフィルタ */}
        <section>
          <h2 className="text-sm font-semibold text-gray-800 mb-2">オッズフィルタ（任意）</h2>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={config.minOdds ?? ''}
              onChange={e => setConfig(prev => ({ ...prev, minOdds: e.target.value ? parseFloat(e.target.value) : null }))}
              placeholder="下限"
              step={0.1}
              min={1}
              className="w-24 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
            <span className="text-gray-400">〜</span>
            <input
              type="number"
              value={config.maxOdds ?? ''}
              onChange={e => setConfig(prev => ({ ...prev, maxOdds: e.target.value ? parseFloat(e.target.value) : null }))}
              placeholder="上限"
              step={0.1}
              min={1}
              className="w-24 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
            <span className="text-gray-500 text-sm">倍</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">指定しない場合は全オッズ対象</p>
        </section>

        {/* 自動投票ON/OFF */}
        <section>
          <label className="flex items-center gap-3 p-3 rounded-lg border bg-white cursor-pointer">
            <input
              type="checkbox"
              checked={config.active}
              onChange={() => setConfig(prev => ({ ...prev, active: !prev.active }))}
              className="w-5 h-5 text-blue-600 rounded"
            />
            <div>
              <span className="text-sm font-medium">自動投票を有効にする</span>
              <p className="text-xs text-gray-400">OFFにすると開催日でも自動投票されません</p>
            </div>
          </label>
        </section>

        {/* 保存ボタン */}
        <button
          type="submit"
          disabled={status === 'saving'}
          className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-base"
        >
          {status === 'saving' ? '保存中...' : '設定を保存'}
        </button>
      </form>

      <p className="text-xs text-gray-400 mt-6 text-center">
        設定はいつでも変更できます。次回の開催日から反映されます。
      </p>
    </div>
  );
}

export default function BettingConfigPage() {
  return (
    <Suspense fallback={<div className="text-center py-20 text-gray-500">読み込み中...</div>}>
      <ConfigForm />
    </Suspense>
  );
}
