'use client';
import { useEffect, useState, useCallback } from 'react';

interface Race {
  id: string;
  name: string;
  racecourseName: string;
  raceNumber: number;
  date: string;
  time: string | null;
}

interface BetTarget {
  id: number;
  user_id: string;
  date: string;
  race_id: string | null;
  race_label: string;
  bet_type: string;
  combinations: string[];
  budget: number;
  min_synthetic_odds: number;
  auto_distribute: number;
  status: string;
  resultJson: {
    syntheticOdds: number;
    conditionMet: boolean;
    allocations: { label: string; odds: number; amount: number; payout: number }[];
    totalInvestment: number;
    minPayout: number;
    actualROI: number;
  } | null;
  created_at: string;
}

const BET_TYPES = ['単勝', '複勝', '馬連', '馬単', 'ワイド', '三連複', '三連単'];

function getToday(): string {
  const d = new Date();
  d.setHours(d.getHours() + 9);
  return d.toISOString().split('T')[0];
}

function getNextSaturday(): string {
  const d = new Date();
  d.setHours(d.getHours() + 9);
  const day = d.getDay();
  const daysUntilSat = (6 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + (day === 0 || day === 6 ? 0 : daysUntilSat));
  return d.toISOString().split('T')[0];
}

export default function BettingPage() {
  const [targets, setTargets] = useState<BetTarget[]>([]);
  const [races, setRaces] = useState<Race[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selectedDate, setSelectedDate] = useState(getNextSaturday());

  // フォーム
  const [formDate, setFormDate] = useState(getNextSaturday());
  const [formRaceId, setFormRaceId] = useState('');
  const [formRaceLabel, setFormRaceLabel] = useState('');
  const [formBetType, setFormBetType] = useState('馬連');
  const [formCombinations, setFormCombinations] = useState('');
  const [formBudget, setFormBudget] = useState(2000);
  const [formMinSyntheticOdds, setFormMinSyntheticOdds] = useState(2.5);
  const [formAutoDistribute, setFormAutoDistribute] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchTargets = useCallback(async () => {
    try {
      const res = await fetch(`/api/betting?date=${selectedDate}`);
      const data = await res.json();
      setTargets(data.targets || []);
    } catch (e) {
      console.error(e);
    }
  }, [selectedDate]);

  const fetchRaces = useCallback(async (date: string) => {
    try {
      const res = await fetch(`/api/races?date=${date}`);
      const data = await res.json();
      setRaces(data.races || []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchTargets(), fetchRaces(selectedDate)]).finally(() => setLoading(false));
  }, [fetchTargets, fetchRaces, selectedDate]);

  useEffect(() => {
    fetchRaces(formDate);
  }, [formDate, fetchRaces]);

  const handleRaceSelect = (raceId: string) => {
    setFormRaceId(raceId);
    const race = races.find(r => r.id === raceId);
    if (race) {
      setFormRaceLabel(`${race.racecourseName}${race.raceNumber}R`);
    }
  };

  const handleSubmit = async () => {
    if (!formRaceLabel || !formCombinations || !formBudget) return;
    setSaving(true);

    const combinations = formCombinations
      .split(/[,、\n]/)
      .map(s => s.trim())
      .filter(Boolean);

    try {
      await fetch('/api/betting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: formDate,
          raceId: formRaceId || null,
          raceLabel: formRaceLabel,
          betType: formBetType,
          combinations,
          budget: formBudget,
          minSyntheticOdds: formMinSyntheticOdds,
          autoDistribute: formAutoDistribute,
        }),
      });
      setShowForm(false);
      setFormCombinations('');
      await fetchTargets();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('この買い目を削除しますか？')) return;
    await fetch(`/api/betting?id=${id}`, { method: 'DELETE' });
    await fetchTargets();
  };

  const statusLabel = (s: string) => {
    switch (s) {
      case 'active': return '待機中';
      case 'triggered': return '条件クリア';
      case 'purchased': return '購入済';
      case 'expired': return '期限切れ';
      case 'skipped': return 'スキップ';
      default: return s;
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case 'active': return 'bg-blue-100 text-blue-800';
      case 'triggered': return 'bg-green-100 text-green-800';
      case 'purchased': return 'bg-purple-100 text-purple-800';
      case 'expired': return 'bg-gray-100 text-gray-500';
      case 'skipped': return 'bg-yellow-100 text-yellow-800';
      default: return 'bg-gray-100';
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">馬券セット</h1>
        <button
          onClick={() => { setShowForm(!showForm); setFormDate(selectedDate); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 active:bg-blue-800"
        >
          {showForm ? '閉じる' : '+ 新規'}
        </button>
      </div>

      {/* 日付選択 */}
      <div className="mb-4">
        <input
          type="date"
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          className="w-full px-3 py-2 border rounded-lg text-lg"
        />
      </div>

      {/* 新規登録フォーム */}
      {showForm && (
        <div className="bg-white border-2 border-blue-200 rounded-xl p-4 mb-6 space-y-4">
          <h2 className="font-bold text-lg">買い目登録</h2>

          {/* 日付 */}
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">開催日</label>
            <input
              type="date"
              value={formDate}
              onChange={e => setFormDate(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>

          {/* レース選択 */}
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">レース</label>
            {races.length > 0 ? (
              <select
                value={formRaceId}
                onChange={e => handleRaceSelect(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="">レースを選択</option>
                {races.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.racecourseName}{r.raceNumber}R {r.name} {r.time || ''}
                  </option>
                ))}
              </select>
            ) : (
              <div>
                <input
                  type="text"
                  value={formRaceLabel}
                  onChange={e => setFormRaceLabel(e.target.value)}
                  placeholder="例: 中山11R"
                  className="w-full px-3 py-2 border rounded-lg"
                />
                <p className="text-xs text-gray-400 mt-1">レース未登録の場合は手入力</p>
              </div>
            )}
          </div>

          {/* 券種 */}
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">券種</label>
            <div className="flex flex-wrap gap-2">
              {BET_TYPES.map(bt => (
                <button
                  key={bt}
                  onClick={() => setFormBetType(bt)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
                    formBetType === bt
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {bt}
                </button>
              ))}
            </div>
          </div>

          {/* 組み合わせ */}
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">
              組み合わせ（カンマ区切り）
            </label>
            <textarea
              value={formCombinations}
              onChange={e => setFormCombinations(e.target.value)}
              placeholder="例: 1-2, 1-3, 1-4, 1-5, 1-6"
              rows={3}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">
              単勝/複勝: 馬番（例: 1, 3, 5） / 馬連等: 組み合わせ（例: 1-2, 1-3）
            </p>
          </div>

          {/* 予算 */}
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">予算（円）</label>
            <input
              type="number"
              value={formBudget}
              onChange={e => setFormBudget(parseInt(e.target.value) || 0)}
              step={100}
              min={100}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>

          {/* 合成オッズ条件 */}
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">
              最低合成オッズ（倍）
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={formMinSyntheticOdds}
                onChange={e => setFormMinSyntheticOdds(parseFloat(e.target.value) || 1)}
                step={0.1}
                min={1}
                className="w-32 px-3 py-2 border rounded-lg"
              />
              <span className="text-sm text-gray-500">
                = 回収率 {Math.round(formMinSyntheticOdds * 100)}% 以上で購入
              </span>
            </div>
          </div>

          {/* 配分方式 */}
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">配分方式</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={formAutoDistribute}
                  onChange={() => setFormAutoDistribute(true)}
                  className="w-4 h-4"
                />
                <span className="text-sm">均等払い戻し</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={!formAutoDistribute}
                  onChange={() => setFormAutoDistribute(false)}
                  className="w-4 h-4"
                />
                <span className="text-sm">均等金額</span>
              </label>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              均等払い戻し: どの目が来ても同額戻る / 均等金額: 全点同額
            </p>
          </div>

          <button
            onClick={handleSubmit}
            disabled={saving || !formRaceLabel || !formCombinations || !formBudget}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold text-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed active:bg-blue-800"
          >
            {saving ? '登録中...' : '登録する'}
          </button>
        </div>
      )}

      {/* 買い目一覧 */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">読み込み中...</div>
      ) : targets.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-400 text-lg mb-2">買い目がありません</p>
          <p className="text-gray-300 text-sm">「+ 新規」から買い目をセットしてください</p>
        </div>
      ) : (
        <div className="space-y-4">
          {targets.map(t => (
            <div key={t.id} className="bg-white rounded-xl border shadow-sm overflow-hidden">
              {/* ヘッダー */}
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-lg">{t.race_label}</span>
                  <span className="px-2 py-0.5 bg-gray-200 rounded text-sm">{t.bet_type}</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(t.status)}`}>
                    {statusLabel(t.status)}
                  </span>
                </div>
                <button
                  onClick={() => handleDelete(t.id)}
                  className="text-red-400 hover:text-red-600 text-sm"
                >
                  削除
                </button>
              </div>

              {/* 内容 */}
              <div className="px-4 py-3 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {t.combinations.map((c, i) => (
                    <span key={i} className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-sm font-mono">
                      {c}
                    </span>
                  ))}
                </div>

                <div className="flex items-center gap-4 text-sm text-gray-600">
                  <span>予算: <b>{t.budget.toLocaleString()}円</b></span>
                  <span>条件: <b>{t.min_synthetic_odds}倍</b>以上</span>
                  <span>{t.auto_distribute ? '均等払戻' : '均等金額'}</span>
                </div>

                {/* 計算結果（条件判定後に表示） */}
                {t.resultJson && (
                  <div className={`mt-3 p-3 rounded-lg ${t.resultJson.conditionMet ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`font-bold ${t.resultJson.conditionMet ? 'text-green-700' : 'text-red-700'}`}>
                        合成オッズ: {t.resultJson.syntheticOdds}倍
                        {t.resultJson.conditionMet ? ' → 購入OK' : ' → 条件未達'}
                      </span>
                    </div>
                    {t.resultJson.conditionMet && (
                      <div className="space-y-1">
                        {t.resultJson.allocations.map((a, i) => (
                          <div key={i} className="flex justify-between text-sm font-mono">
                            <span>{a.label} ({a.odds}倍)</span>
                            <span className="font-bold">{a.amount.toLocaleString()}円</span>
                          </div>
                        ))}
                        <div className="border-t pt-1 mt-1 flex justify-between text-sm font-bold">
                          <span>合計</span>
                          <span>{t.resultJson.totalInvestment.toLocaleString()}円</span>
                        </div>
                        <div className="text-xs text-gray-500">
                          最低払戻: {t.resultJson.minPayout.toLocaleString()}円 (実質{Math.round(t.resultJson.actualROI * 100)}%)
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
