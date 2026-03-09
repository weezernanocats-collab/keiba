'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import LoadingSpinner from '@/components/LoadingSpinner';

interface JockeyRow {
  id: string;
  name: string;
  age: number;
  region: string;
  belongs_to: string;
  total_races: number;
  wins: number;
  win_rate: number;
  place_rate: number;
  show_rate: number;
  total_earnings: number;
}

export default function JockeysPage() {
  const [jockeys, setJockeys] = useState<JockeyRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJockeys();
  }, []);

  async function fetchJockeys(query?: string) {
    setLoading(true);
    try {
      const url = query ? `/api/jockeys?q=${encodeURIComponent(query)}` : '/api/jockeys';
      const res = await fetch(url);
      const data = await res.json();
      setJockeys(data.jockeys || []);
    } catch (err) {
      console.error('騎手取得エラー:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchJockeys(search);
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold">🏆 騎手情報</h1>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          placeholder="騎手名で検索..."
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
            {jockeys.map(jockey => (
              <Link key={jockey.id} href={`/jockeys/${jockey.id}`} className="block bg-card-bg border border-card-border rounded-xl p-4 hover:border-accent/50 transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-accent font-bold">{jockey.name}</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    jockey.region === '中央' ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'
                  }`}>
                    {jockey.region}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center text-sm">
                  <div>
                    <p className="text-xs text-muted">勝率</p>
                    <p className="font-bold text-accent">{(jockey.win_rate * 100).toFixed(1)}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">連対率</p>
                    <p className="font-bold">{(jockey.place_rate * 100).toFixed(1)}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">複勝率</p>
                    <p className="font-bold">{(jockey.show_rate * 100).toFixed(1)}%</p>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-muted">
                  <span>{jockey.total_races}戦{jockey.wins}勝</span>
                  <span>{(jockey.total_earnings / 10000).toFixed(0)}万円</span>
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
                    <th className="px-4 py-3 text-left font-medium">騎手名</th>
                    <th className="px-3 py-3 text-center font-medium">年齢</th>
                    <th className="px-3 py-3 text-center font-medium">所属</th>
                    <th className="px-3 py-3 text-center font-medium">出走数</th>
                    <th className="px-3 py-3 text-center font-medium">勝利数</th>
                    <th className="px-3 py-3 text-center font-medium">勝率</th>
                    <th className="px-3 py-3 text-center font-medium">連対率</th>
                    <th className="px-3 py-3 text-center font-medium">複勝率</th>
                    <th className="px-3 py-3 text-right font-medium">獲得賞金</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-card-border">
                  {jockeys.map(jockey => (
                    <tr key={jockey.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <Link href={`/jockeys/${jockey.id}`} className="text-accent hover:underline font-medium">
                          {jockey.name}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-center text-muted">{jockey.age}歳</td>
                      <td className="px-3 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          jockey.region === '中央' ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'
                        }`}>
                          {jockey.region} {jockey.belongs_to}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center">{jockey.total_races}</td>
                      <td className="px-3 py-3 text-center font-bold">{jockey.wins}</td>
                      <td className="px-3 py-3 text-center">{(jockey.win_rate * 100).toFixed(1)}%</td>
                      <td className="px-3 py-3 text-center">{(jockey.place_rate * 100).toFixed(1)}%</td>
                      <td className="px-3 py-3 text-center">{(jockey.show_rate * 100).toFixed(1)}%</td>
                      <td className="px-3 py-3 text-right">{(jockey.total_earnings / 10000).toFixed(0)}万円</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
