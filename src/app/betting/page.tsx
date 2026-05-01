'use client';
import { useEffect, useState, useCallback } from 'react';

interface ShoshanCandidate {
  horseNumber: number;
  horseName: string;
  theory: number;
  matchScore: number;
  jockeyName: string;
  reasons: string[];
}

interface ShoshanRace {
  raceId: string;
  raceLabel: string;
  raceName: string;
  time: string | null;
  candidates: ShoshanCandidate[];
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

const USERS = ['naoto', 'friend1', 'friend2'];
const USER_KEY = 'keiba-betting-user';

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
  const [shoshanRaces, setShoshanRaces] = useState<ShoshanRace[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(getNextSaturday());
  const [userId, setUserId] = useState('naoto');

  // フォーム
  const [formBudget, setFormBudget] = useState(2000);
  const [formAutoDistribute, setFormAutoDistribute] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ count: number; skipped: number } | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(USER_KEY);
    if (saved && USERS.includes(saved)) setUserId(saved);
  }, []);

  const switchUser = (id: string) => {
    setUserId(id);
    localStorage.setItem(USER_KEY, id);
  };

  const fetchTargets = useCallback(async () => {
    try {
      const res = await fetch(`/api/betting?date=${selectedDate}&userId=${userId}`);
      const data = await res.json();
      setTargets(data.targets || []);
    } catch (e) {
      console.error(e);
    }
  }, [selectedDate, userId]);

  const fetchShoshanCandidates = useCallback(async () => {
    try {
      const res = await fetch(`/api/betting/shoshan-candidates?date=${selectedDate}`);
      const data = await res.json();
      setShoshanRaces(data.races || []);
    } catch (e) {
      console.error(e);
    }
  }, [selectedDate]);

  useEffect(() => {
    setLoading(true);
    setSaveResult(null);
    Promise.all([fetchTargets(), fetchShoshanCandidates()]).finally(() => setLoading(false));
  }, [fetchTargets, fetchShoshanCandidates]);

  // 既に登録済みのレース+馬番の組み合わせを判定
  const isAlreadyRegistered = (raceLabel: string, horseNumber: number): boolean => {
    return targets.some(
      t => t.race_label === raceLabel && t.bet_type === '単勝' && t.combinations.includes(String(horseNumber)),
    );
  };

  // 未登録の候補数
  const unregisteredCount = shoshanRaces.reduce((sum, race) =>
    sum + race.candidates.filter(c => !isAlreadyRegistered(race.raceLabel, c.horseNumber)).length, 0);

  // 全しょーさん候補を一括登録
  const handleBulkRegister = async () => {
    if (shoshanRaces.length === 0) return;
    setSaving(true);
    setSaveResult(null);

    let registered = 0;
    let skipped = 0;

    for (const race of shoshanRaces) {
      const newCombinations = race.candidates
        .map(c => String(c.horseNumber))
        .filter(num => !isAlreadyRegistered(race.raceLabel, parseInt(num)));

      if (newCombinations.length === 0) {
        skipped += race.candidates.length;
        continue;
      }

      try {
        await fetch('/api/betting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId,
            date: selectedDate,
            raceId: race.raceId,
            raceLabel: race.raceLabel,
            betType: '単勝',
            combinations: newCombinations,
            budget: formBudget,
            minSyntheticOdds: 1.0,
            autoDistribute: formAutoDistribute,
          }),
        });
        registered += newCombinations.length;
        skipped += race.candidates.length - newCombinations.length;
      } catch (e) {
        console.error(e);
      }
    }

    setSaveResult({ count: registered, skipped });
    await fetchTargets();
    setSaving(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('この買い目を削除しますか？')) return;
    await fetch(`/api/betting?id=${id}`, { method: 'DELETE' });
    await fetchTargets();
  };

  const handleDeleteAll = async () => {
    if (!confirm(`${selectedDate}の買い目を全て削除しますか？`)) return;
    for (const t of targets) {
      await fetch(`/api/betting?id=${t.id}`, { method: 'DELETE' });
    }
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

  const totalCandidates = shoshanRaces.reduce((sum, r) => sum + r.candidates.length, 0);

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold mb-4">馬券セット</h1>

      {/* ユーザー切替 */}
      <div className="flex gap-2 mb-4">
        {USERS.map(u => (
          <button
            key={u}
            onClick={() => switchUser(u)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
              userId === u
                ? 'bg-gray-800 text-white border-gray-800'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {u}
          </button>
        ))}
      </div>

      {/* 日付選択 */}
      <div className="mb-6">
        <input
          type="date"
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          className="w-full px-3 py-2 border rounded-lg text-lg"
        />
      </div>

      {/* しょーさん候補（日付選択で自動表示） */}
      {loading ? (
        <div className="text-center py-8 text-gray-400">読み込み中...</div>
      ) : (
        <>
          <div className="bg-white border rounded-xl p-4 mb-6 space-y-4">
            {shoshanRaces.length === 0 ? (
              <div className="text-center py-6 text-gray-400">
                {selectedDate} のしょーさん候補はありません
              </div>
            ) : (
              <>
                {/* サマリー */}
                <p className="text-center text-gray-700">
                  しょーさん候補: <b>{shoshanRaces.length}レース / {totalCandidates}頭</b>
                  {unregisteredCount < totalCandidates && (
                    <span className="text-gray-400 text-sm ml-2">（{totalCandidates - unregisteredCount}頭 登録済み）</span>
                  )}
                </p>

                {/* 予算 */}
                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">
                    予算（レースごと・円）
                  </label>
                  <input
                    type="number"
                    value={formBudget}
                    onChange={e => setFormBudget(parseInt(e.target.value) || 0)}
                    step={100}
                    min={100}
                    className="w-full px-3 py-2 border rounded-lg"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    {shoshanRaces.length}レース = 合計 {(formBudget * shoshanRaces.length).toLocaleString()}円
                  </p>
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
                </div>

                {/* 登録ボタン */}
                <button
                  onClick={handleBulkRegister}
                  disabled={saving || unregisteredCount === 0}
                  className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold text-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed active:bg-blue-800"
                >
                  {saving ? '登録中...' : unregisteredCount === 0
                    ? '全て登録済み'
                    : `${unregisteredCount}頭を単勝で一括登録`}
                </button>
              </>
            )}
          </div>

          {/* 登録結果通知 */}
          {saveResult && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4 text-sm text-green-800">
              {saveResult.count}点を登録しました
              {saveResult.skipped > 0 && `（${saveResult.skipped}点は登録済みのためスキップ）`}
            </div>
          )}

          {/* 登録済み買い目一覧 */}
          {targets.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-lg">登録済み（{targets.length}件）</h2>
                <button
                  onClick={handleDeleteAll}
                  className="text-xs text-red-400 hover:text-red-600"
                >
                  全て削除
                </button>
              </div>

              {targets.map(t => (
                <div key={t.id} className="bg-white rounded-xl border shadow-sm overflow-hidden">
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
                      <span>{t.auto_distribute ? '均等払戻' : '均等金額'}</span>
                    </div>

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
        </>
      )}
    </div>
  );
}
