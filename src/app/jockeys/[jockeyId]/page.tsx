'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import LoadingSpinner from '@/components/LoadingSpinner';

interface JockeyDetail {
  id: string;
  name: string;
  name_en: string | null;
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

interface RecentResult {
  race_name: string;
  date: string;
  racecourse_name: string;
  track_type: string;
  distance: number;
  horse_name: string;
  result_position: number | null;
}

export default function JockeyDetailPage() {
  const params = useParams();
  const jockeyId = params.jockeyId as string;
  const [jockey, setJockey] = useState<JockeyDetail | null>(null);
  const [recentResults, setRecentResults] = useState<RecentResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch(`/api/jockeys/${jockeyId}`);
        const data = await res.json();
        setJockey(data.jockey || null);
        setRecentResults(data.recentResults || []);
      } catch (err) {
        console.error('エラー:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [jockeyId]);

  if (loading) return <LoadingSpinner />;
  if (!jockey) return <div className="text-center py-12">騎手が見つかりません</div>;

  return (
    <div className="space-y-6 animate-fadeIn">
      <Link href="/jockeys" className="text-sm text-accent hover:underline">← 騎手一覧に戻る</Link>

      {/* 基本情報 */}
      <div className="bg-card-bg border border-card-border rounded-xl p-6">
        <h1 className="text-3xl font-bold mb-1">{jockey.name}</h1>
        {jockey.name_en && <p className="text-muted text-sm mb-4">{jockey.name_en}</p>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
          <div>
            <p className="text-xs text-muted">年齢</p>
            <p className="font-medium">{jockey.age}歳</p>
          </div>
          <div>
            <p className="text-xs text-muted">所属</p>
            <p className="font-medium">
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                jockey.region === '中央' ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'
              }`}>
                {jockey.region}
              </span>
              {' '}{jockey.belongs_to}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">通算出走</p>
            <p className="font-medium">{jockey.total_races}回</p>
          </div>
          <div>
            <p className="text-xs text-muted">通算勝利</p>
            <p className="font-medium text-accent">{jockey.wins}勝</p>
          </div>
        </div>
      </div>

      {/* 成績 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-card-bg border border-card-border rounded-xl p-4 text-center">
          <p className="text-xs text-muted mb-1">勝率</p>
          <p className="text-2xl font-bold text-accent">{(jockey.win_rate * 100).toFixed(1)}%</p>
        </div>
        <div className="bg-card-bg border border-card-border rounded-xl p-4 text-center">
          <p className="text-xs text-muted mb-1">連対率</p>
          <p className="text-2xl font-bold">{(jockey.place_rate * 100).toFixed(1)}%</p>
        </div>
        <div className="bg-card-bg border border-card-border rounded-xl p-4 text-center">
          <p className="text-xs text-muted mb-1">複勝率</p>
          <p className="text-2xl font-bold">{(jockey.show_rate * 100).toFixed(1)}%</p>
        </div>
        <div className="bg-card-bg border border-card-border rounded-xl p-4 text-center">
          <p className="text-xs text-muted mb-1">獲得賞金</p>
          <p className="text-2xl font-bold">{(jockey.total_earnings / 10000).toFixed(0)}<span className="text-sm">万円</span></p>
        </div>
      </div>

      {/* 直近成績 */}
      {recentResults.length > 0 && (
        <div>
          <h2 className="text-lg font-bold mb-4">📋 直近の騎乗成績</h2>
          <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">日付</th>
                    <th className="px-3 py-3 text-left font-medium">競馬場</th>
                    <th className="px-3 py-3 text-left font-medium">レース</th>
                    <th className="px-3 py-3 text-left font-medium">条件</th>
                    <th className="px-3 py-3 text-left font-medium">騎乗馬</th>
                    <th className="px-3 py-3 text-center font-medium">着順</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-card-border">
                  {recentResults.map((r, idx) => (
                    <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                      <td className="px-4 py-2 text-muted">{r.date}</td>
                      <td className="px-3 py-2">{r.racecourse_name}</td>
                      <td className="px-3 py-2 font-medium">{r.race_name}</td>
                      <td className="px-3 py-2 text-muted">{r.track_type}{r.distance}m</td>
                      <td className="px-3 py-2">{r.horse_name}</td>
                      <td className="px-3 py-2 text-center">
                        {r.result_position ? (
                          <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${
                            r.result_position === 1 ? 'bg-yellow-400 text-black' :
                            r.result_position === 2 ? 'bg-gray-300 text-black' :
                            r.result_position === 3 ? 'bg-amber-600 text-white' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {r.result_position}
                          </span>
                        ) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
