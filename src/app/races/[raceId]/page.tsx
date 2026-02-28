'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';

interface EntryRow {
  postPosition: number;
  horseNumber: number;
  horseId: string;
  horseName: string;
  age: number;
  sex: string;
  jockeyId: string;
  jockeyName: string;
  trainerName: string;
  handicapWeight: number;
  weight: number | null;
  result?: {
    position: number;
    time?: string;
    margin?: string;
    lastThreeFurlongs?: string;
    cornerPositions?: string;
  };
}

interface RaceDetail {
  id: string;
  name: string;
  date: string;
  time: string | null;
  racecourseName: string;
  raceNumber: number;
  grade: string | null;
  trackType: string;
  distance: number;
  trackCondition: string | null;
  weather: string | null;
  status: string;
  entries: EntryRow[];
}

interface OddsRow {
  bet_type: string;
  horse_number1: number;
  odds: number;
  min_odds: number | null;
  max_odds: number | null;
}

export default function RaceDetailPage() {
  const params = useParams();
  const raceId = params.raceId as string;
  const [race, setRace] = useState<RaceDetail | null>(null);
  const [odds, setOdds] = useState<OddsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'shutuba' | 'odds' | 'result'>('shutuba');

  useEffect(() => {
    async function fetchData() {
      try {
        const [raceRes, oddsRes] = await Promise.all([
          fetch(`/api/races/${raceId}`),
          fetch(`/api/odds?raceId=${raceId}`),
        ]);
        const raceData = await raceRes.json();
        const oddsData = await oddsRes.json();
        setRace(raceData.race || null);
        setOdds(oddsData.odds || []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [raceId]);

  if (loading) return <LoadingSpinner />;
  if (!race) return <div className="text-center py-12">レースが見つかりません</div>;

  const winOdds = odds.filter(o => o.bet_type === '単勝');
  const placeOdds = odds.filter(o => o.bet_type === '複勝');
  const hasResults = race.entries.some(e => e.result != null);

  // オッズマップ
  const winOddsMap: Record<number, number> = {};
  for (const o of winOdds) winOddsMap[o.horse_number1] = o.odds;
  const placeOddsMap: Record<number, { min: number; max: number }> = {};
  for (const o of placeOdds) placeOddsMap[o.horse_number1] = { min: o.min_odds || 0, max: o.max_odds || 0 };

  const sortedEntries = tab === 'result' && hasResults
    ? [...race.entries].sort((a, b) => (a.result?.position || 99) - (b.result?.position || 99))
    : race.entries;

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* レースヘッダー */}
      <div className="bg-card-bg border border-card-border rounded-xl p-6">
        <div className="flex flex-wrap items-start gap-3 mb-3">
          <GradeBadge grade={race.grade} />
          <h1 className="text-2xl font-bold">{race.name}</h1>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-muted">
          <span>📅 {race.date} {race.time || ''}</span>
          <span>🏟️ {race.racecourseName} {race.raceNumber}R</span>
          <span>🏁 {race.trackType}{race.distance}m</span>
          {race.trackCondition && <span>馬場: {race.trackCondition}</span>}
          {race.weather && <span>天候: {race.weather}</span>}
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
            race.status === '出走確定' ? 'bg-green-100 text-green-800' :
            race.status === '結果確定' ? 'bg-blue-100 text-blue-800' :
            'bg-gray-100 text-gray-600'
          }`}>
            {race.status}
          </span>
        </div>
        {race.status !== '結果確定' && (
          <div className="mt-4">
            <Link
              href={`/predictions/${race.id}`}
              className="inline-block bg-accent text-white px-5 py-2 rounded-lg font-medium hover:bg-accent-light transition-colors"
            >
              🤖 AI予想を見る
            </Link>
          </div>
        )}
      </div>

      {/* タブ */}
      <div className="flex rounded-lg overflow-hidden border border-card-border w-fit">
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'shutuba' ? 'bg-primary text-white' : 'bg-card-bg hover:bg-gray-100'}`}
          onClick={() => setTab('shutuba')}
        >
          出馬表
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'odds' ? 'bg-primary text-white' : 'bg-card-bg hover:bg-gray-100'}`}
          onClick={() => setTab('odds')}
        >
          オッズ
        </button>
        {hasResults && (
          <button
            className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'result' ? 'bg-primary text-white' : 'bg-card-bg hover:bg-gray-100'}`}
            onClick={() => setTab('result')}
          >
            結果
          </button>
        )}
      </div>

      {/* テーブル */}
      <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                {tab === 'result' && <th className="px-3 py-3 text-center font-medium w-12">着順</th>}
                <th className="px-3 py-3 text-center font-medium w-12">枠</th>
                <th className="px-3 py-3 text-center font-medium w-12">番</th>
                <th className="px-3 py-3 text-left font-medium">馬名</th>
                <th className="px-3 py-3 text-center font-medium">性齢</th>
                <th className="px-3 py-3 text-center font-medium">斤量</th>
                <th className="px-3 py-3 text-left font-medium">騎手</th>
                <th className="px-3 py-3 text-left font-medium">調教師</th>
                {(tab === 'odds' || tab === 'shutuba') && (
                  <>
                    <th className="px-3 py-3 text-right font-medium">単勝</th>
                    <th className="px-3 py-3 text-right font-medium">複勝</th>
                  </>
                )}
                {tab === 'result' && (
                  <>
                    <th className="px-3 py-3 text-right font-medium">タイム</th>
                    <th className="px-3 py-3 text-right font-medium">着差</th>
                    <th className="px-3 py-3 text-right font-medium">上り3F</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {sortedEntries.map(entry => (
                <tr key={entry.horseNumber} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                  {tab === 'result' && (
                    <td className="px-3 py-3 text-center font-bold">
                      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-sm ${
                        entry.result?.position === 1 ? 'bg-yellow-400 text-black' :
                        entry.result?.position === 2 ? 'bg-gray-300 text-black' :
                        entry.result?.position === 3 ? 'bg-amber-600 text-white' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {entry.result?.position || '-'}
                      </span>
                    </td>
                  )}
                  <td className="px-3 py-3 text-center">
                    <span className={`inline-flex items-center justify-center w-7 h-7 rounded text-xs font-bold waku-${entry.postPosition}`}>
                      {entry.postPosition}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center font-bold">{entry.horseNumber}</td>
                  <td className="px-3 py-3">
                    <Link href={`/horses/${entry.horseId}`} className="text-accent hover:underline font-medium">
                      {entry.horseName}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-center text-muted">{entry.sex}{entry.age}</td>
                  <td className="px-3 py-3 text-center">{entry.handicapWeight}</td>
                  <td className="px-3 py-3">
                    <Link href={`/jockeys/${entry.jockeyId}`} className="text-accent hover:underline">
                      {entry.jockeyName}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-muted">{entry.trainerName}</td>
                  {(tab === 'odds' || tab === 'shutuba') && (
                    <>
                      <td className="px-3 py-3 text-right font-medium">
                        {winOddsMap[entry.horseNumber]?.toFixed(1) || '-'}
                      </td>
                      <td className="px-3 py-3 text-right text-muted">
                        {placeOddsMap[entry.horseNumber]
                          ? `${placeOddsMap[entry.horseNumber].min.toFixed(1)} - ${placeOddsMap[entry.horseNumber].max.toFixed(1)}`
                          : '-'}
                      </td>
                    </>
                  )}
                  {tab === 'result' && (
                    <>
                      <td className="px-3 py-3 text-right">{entry.result?.time || '-'}</td>
                      <td className="px-3 py-3 text-right text-muted">{entry.result?.margin || '-'}</td>
                      <td className="px-3 py-3 text-right">{entry.result?.lastThreeFurlongs || '-'}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
