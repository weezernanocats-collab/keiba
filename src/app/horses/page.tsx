'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import LoadingSpinner from '@/components/LoadingSpinner';

interface HorseRow {
  id: string;
  name: string;
  age: number;
  sex: string;
  father_name: string;
  mother_name: string;
  trainer_name: string;
  total_races: number;
  wins: number;
  seconds: number;
  thirds: number;
  total_earnings: number;
  condition_overall: string;
}

export default function HorsesPage() {
  const [horses, setHorses] = useState<HorseRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchHorses();
  }, []);

  async function fetchHorses(query?: string) {
    setLoading(true);
    try {
      const url = query ? `/api/horses?q=${encodeURIComponent(query)}` : '/api/horses';
      const res = await fetch(url);
      const data = await res.json();
      setHorses(data.horses || []);
    } catch (err) {
      console.error('馬取得エラー:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchHorses(search);
  }

  function conditionColor(cond: string) {
    if (cond === '絶好調') return 'text-red-600 font-bold';
    if (cond === '好調') return 'text-green-600 font-medium';
    if (cond === '不調') return 'text-blue-600';
    if (cond === '絶不調') return 'text-gray-400';
    return 'text-muted';
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold">🐴 馬情報</h1>

      {/* 検索 */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          placeholder="馬名で検索..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 px-4 py-2 border border-card-border rounded-lg bg-card-bg text-sm"
        />
        <button
          type="submit"
          className="px-6 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-light transition-colors"
        >
          検索
        </button>
      </form>

      {loading ? (
        <LoadingSpinner />
      ) : (
        <>
          {/* モバイル: カード表示 */}
          <div className="md:hidden space-y-3">
            {horses.map(horse => (
              <Link key={horse.id} href={`/horses/${horse.id}`} className="block bg-card-bg border border-card-border rounded-xl p-4 hover:border-accent/50 transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-accent font-bold">{horse.name}</span>
                  <span className={conditionColor(horse.condition_overall) + ' text-xs'}>{horse.condition_overall}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted mb-2">
                  <span>{horse.sex}{horse.age}</span>
                  {horse.father_name && <span>父: {horse.father_name}</span>}
                  {horse.trainer_name && <span>{horse.trainer_name}</span>}
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-mono">{horse.total_races}戦{horse.wins}勝 [{horse.wins}-{horse.seconds}-{horse.thirds}-{horse.total_races - horse.wins - horse.seconds - horse.thirds}]</span>
                  <span className="text-muted">{(horse.total_earnings / 10000).toFixed(0)}万円</span>
                </div>
              </Link>
            ))}
          </div>

          {/* デスクトップ: テーブル表示 */}
          <div className="hidden md:block bg-card-bg border border-card-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">馬名</th>
                    <th className="px-3 py-3 text-center font-medium">性齢</th>
                    <th className="px-3 py-3 text-left font-medium">父</th>
                    <th className="px-3 py-3 text-left font-medium">調教師</th>
                    <th className="px-3 py-3 text-center font-medium">成績</th>
                    <th className="px-3 py-3 text-right font-medium">獲得賞金</th>
                    <th className="px-3 py-3 text-center font-medium">調子</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-card-border">
                  {horses.map(horse => (
                    <tr key={horse.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <Link href={`/horses/${horse.id}`} className="text-accent hover:underline font-medium">
                          {horse.name}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-center text-muted">{horse.sex}{horse.age}</td>
                      <td className="px-3 py-3 text-muted">{horse.father_name}</td>
                      <td className="px-3 py-3 text-muted">{horse.trainer_name}</td>
                      <td className="px-3 py-3 text-center">
                        <span className="font-mono">
                          {horse.total_races}戦{horse.wins}勝
                          <span className="text-muted"> [{horse.wins}-{horse.seconds}-{horse.thirds}-{horse.total_races - horse.wins - horse.seconds - horse.thirds}]</span>
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right">{(horse.total_earnings / 10000).toFixed(0)}万円</td>
                      <td className="px-3 py-3 text-center">
                        <span className={conditionColor(horse.condition_overall)}>
                          {horse.condition_overall}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!loading && horses.length === 0 && (
        <div className="text-center py-12 text-muted">
          <p>馬が見つかりません</p>
        </div>
      )}
    </div>
  );
}
