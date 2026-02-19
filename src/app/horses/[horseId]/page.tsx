'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import LoadingSpinner from '@/components/LoadingSpinner';

interface HorseDetail {
  id: string;
  name: string;
  name_en: string | null;
  age: number;
  sex: string;
  color: string;
  birth_date: string;
  father_name: string;
  mother_name: string;
  trainer_name: string;
  owner_name: string;
  total_races: number;
  wins: number;
  seconds: number;
  thirds: number;
  total_earnings: number;
  condition_overall: string;
  condition_weight: number | null;
  condition_weight_change: number | null;
  training_comment: string | null;
  strengths: string[];
  weaknesses: string[];
}

interface PastPerf {
  date: string;
  race_name: string;
  racecourse_name: string;
  track_type: string;
  distance: number;
  track_condition: string;
  entries: number;
  position: number;
  jockey_name: string;
  handicap_weight: number;
  weight: number;
  weight_change: number;
  time: string;
  margin: string;
  last_three_furlongs: string;
  corner_positions: string;
  odds: number;
  popularity: number;
}

export default function HorseDetailPage() {
  const params = useParams();
  const horseId = params.horseId as string;
  const [horse, setHorse] = useState<HorseDetail | null>(null);
  const [pastPerformances, setPastPerformances] = useState<PastPerf[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch(`/api/horses/${horseId}`);
        const data = await res.json();
        setHorse(data.horse || null);
        setPastPerformances(data.pastPerformances || []);
      } catch (err) {
        console.error('エラー:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [horseId]);

  if (loading) return <LoadingSpinner />;
  if (!horse) return <div className="text-center py-12">馬が見つかりません</div>;

  const winRate = horse.total_races > 0 ? ((horse.wins / horse.total_races) * 100).toFixed(1) : '0.0';
  const placeRate = horse.total_races > 0 ? (((horse.wins + horse.seconds) / horse.total_races) * 100).toFixed(1) : '0.0';
  const showRate = horse.total_races > 0 ? (((horse.wins + horse.seconds + horse.thirds) / horse.total_races) * 100).toFixed(1) : '0.0';

  return (
    <div className="space-y-6 animate-fadeIn">
      <Link href="/horses" className="text-sm text-accent hover:underline">← 馬一覧に戻る</Link>

      {/* 基本情報 */}
      <div className="bg-card-bg border border-card-border rounded-xl p-6">
        <h1 className="text-3xl font-bold mb-1">{horse.name}</h1>
        {horse.name_en && <p className="text-muted text-sm mb-4">{horse.name_en}</p>}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
          <InfoItem label="性別" value={horse.sex === '牡' ? '牡馬' : horse.sex === '牝' ? '牝馬' : 'セン馬'} />
          <InfoItem label="年齢" value={`${horse.age}歳`} />
          <InfoItem label="毛色" value={horse.color} />
          <InfoItem label="生年月日" value={horse.birth_date || '不明'} />
          <InfoItem label="父" value={horse.father_name} />
          <InfoItem label="母" value={horse.mother_name} />
          <InfoItem label="調教師" value={horse.trainer_name} />
          <InfoItem label="馬主" value={horse.owner_name} />
        </div>
      </div>

      {/* 成績サマリー */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="通算成績" value={`${horse.total_races}戦${horse.wins}勝`} sub={`[${horse.wins}-${horse.seconds}-${horse.thirds}-${horse.total_races - horse.wins - horse.seconds - horse.thirds}]`} />
        <StatCard label="勝率" value={`${winRate}%`} />
        <StatCard label="連対率" value={`${placeRate}%`} />
        <StatCard label="複勝率" value={`${showRate}%`} />
        <StatCard label="獲得賞金" value={`${(horse.total_earnings / 10000).toFixed(0)}万円`} />
      </div>

      {/* コンディション */}
      <div className="bg-card-bg border border-card-border rounded-xl p-6">
        <h2 className="text-lg font-bold mb-4">📊 コンディション</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-muted">体調</p>
            <p className={`text-lg font-bold ${
              horse.condition_overall === '絶好調' ? 'text-red-600' :
              horse.condition_overall === '好調' ? 'text-green-600' :
              horse.condition_overall === '不調' ? 'text-blue-600' : ''
            }`}>{horse.condition_overall}</p>
          </div>
          {horse.condition_weight && (
            <div>
              <p className="text-sm text-muted">馬体重</p>
              <p className="text-lg font-bold">
                {horse.condition_weight}kg
                {horse.condition_weight_change != null && (
                  <span className={`text-sm ml-1 ${horse.condition_weight_change > 0 ? 'text-red-500' : horse.condition_weight_change < 0 ? 'text-blue-500' : ''}`}>
                    ({horse.condition_weight_change > 0 ? '+' : ''}{horse.condition_weight_change})
                  </span>
                )}
              </p>
            </div>
          )}
          {horse.training_comment && (
            <div className="col-span-2">
              <p className="text-sm text-muted">調教コメント</p>
              <p className="text-sm">{horse.training_comment}</p>
            </div>
          )}
        </div>
      </div>

      {/* 強み・弱み */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {horse.strengths.length > 0 && (
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-5">
            <h3 className="font-bold text-green-800 dark:text-green-300 mb-3">💪 強み</h3>
            <ul className="space-y-2">
              {horse.strengths.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="text-green-600 mt-0.5">●</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {horse.weaknesses.length > 0 && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-5">
            <h3 className="font-bold text-red-800 dark:text-red-300 mb-3">⚠️ 弱点</h3>
            <ul className="space-y-2">
              {horse.weaknesses.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="text-red-600 mt-0.5">●</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 過去成績 */}
      <div>
        <h2 className="text-lg font-bold mb-4">📋 過去成績</h2>
        <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="px-3 py-3 text-left font-medium">日付</th>
                  <th className="px-3 py-3 text-left font-medium">競馬場</th>
                  <th className="px-3 py-3 text-left font-medium">レース名</th>
                  <th className="px-3 py-3 text-center font-medium">条件</th>
                  <th className="px-3 py-3 text-center font-medium">着順</th>
                  <th className="px-3 py-3 text-left font-medium">騎手</th>
                  <th className="px-3 py-3 text-center font-medium">斤量</th>
                  <th className="px-3 py-3 text-right font-medium">タイム</th>
                  <th className="px-3 py-3 text-right font-medium">上り3F</th>
                  <th className="px-3 py-3 text-center font-medium">馬体重</th>
                  <th className="px-3 py-3 text-right font-medium">人気</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-card-border">
                {pastPerformances.map((pp, idx) => (
                  <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                    <td className="px-3 py-2 whitespace-nowrap text-muted">{pp.date}</td>
                    <td className="px-3 py-2">{pp.racecourse_name}</td>
                    <td className="px-3 py-2 font-medium">{pp.race_name}</td>
                    <td className="px-3 py-2 text-center text-muted">{pp.track_type}{pp.distance}m</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${
                        pp.position === 1 ? 'bg-yellow-400 text-black' :
                        pp.position === 2 ? 'bg-gray-300 text-black' :
                        pp.position === 3 ? 'bg-amber-600 text-white' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {pp.position}
                      </span>
                    </td>
                    <td className="px-3 py-2">{pp.jockey_name}</td>
                    <td className="px-3 py-2 text-center">{pp.handicap_weight}</td>
                    <td className="px-3 py-2 text-right font-mono">{pp.time}</td>
                    <td className="px-3 py-2 text-right font-mono">{pp.last_three_furlongs}</td>
                    <td className="px-3 py-2 text-center">
                      {pp.weight > 0 && (
                        <>
                          {pp.weight}
                          {pp.weight_change !== 0 && (
                            <span className={`text-xs ml-0.5 ${pp.weight_change > 0 ? 'text-red-500' : 'text-blue-500'}`}>
                              ({pp.weight_change > 0 ? '+' : ''}{pp.weight_change})
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-muted">{pp.popularity}番人気</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4 text-center">
      <p className="text-xs text-muted mb-1">{label}</p>
      <p className="text-xl font-bold">{value}</p>
      {sub && <p className="text-xs text-muted mt-1">{sub}</p>}
    </div>
  );
}
