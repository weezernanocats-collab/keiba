'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import LoadingSpinner from '@/components/LoadingSpinner';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Legend, ReferenceLine,
} from 'recharts';

interface Summary {
  totalEvaluated: number;
  winRate: number;
  placeRate: number;
  avgRoi: number;
}

interface RollingPoint {
  index: number;
  date: string;
  winRate: number;
  placeRate: number;
  roi: number;
}

interface ConfidenceStat {
  range: string;
  total: number;
  winRate: number;
  placeRate: number;
}

interface VenueStat {
  venue: string;
  total: number;
  winRate: number;
  placeRate: number;
}

interface GradeStat {
  grade: string;
  total: number;
  winRate: number;
  placeRate: number;
  roi: number;
}

interface RoiBreakdown {
  winRoi: number;
  placeRoi: number;
  winInvested: number;
  winReturned: number;
  placeInvested: number;
  placeReturned: number;
}

interface BetTypeStat {
  type: string;
  total: number;
  hitRate: number;
  roi: number;
  avgOdds: number;
  hitCount: number;
}

const PERIOD_OPTIONS = [
  { label: '30日', value: '30' },
  { label: '60日', value: '60' },
  { label: '半年', value: '180' },
  { label: '全期間', value: 'all' },
] as const;

const GRADE_COLORS: Record<string, string> = {
  G1: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 border-red-300',
  G2: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border-blue-300',
  G3: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border-green-300',
};

export default function StatsPage() {
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<string>('all');
  const [periodLabel, setPeriodLabel] = useState<string>('全期間');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rolling, setRolling] = useState<RollingPoint[]>([]);
  const [rollingWindowSize, setRollingWindowSize] = useState(50);
  const [confidenceStats, setConfidenceStats] = useState<ConfidenceStat[]>([]);
  const [venueStats, setVenueStats] = useState<VenueStat[]>([]);
  const [gradeStats, setGradeStats] = useState<GradeStat[]>([]);
  const [roiBreakdown, setRoiBreakdown] = useState<RoiBreakdown | null>(null);
  const [betTypeStats, setBetTypeStats] = useState<BetTypeStat[]>([]);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const params = period !== 'all' ? `?days=${period}` : '';
        const res = await fetch(`/api/accuracy-stats${params}`);
        const data = await res.json();
        setSummary(data.summary);
        setRolling(data.rolling || []);
        setRollingWindowSize(data.rollingWindowSize || 50);
        setConfidenceStats(data.confidenceStats || []);
        setVenueStats(data.venueStats || []);
        setGradeStats(data.gradeStats || []);
        setRoiBreakdown(data.roiBreakdown || null);
        setBetTypeStats(data.betTypeStats || []);
        setPeriodLabel(data.period || '全期間');
      } catch (err) {
        console.error('統計データ取得エラー:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [period]);

  if (loading) return <LoadingSpinner message="統計データを読み込んでいます..." />;

  return (
    <div className="space-y-8 animate-fadeIn">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">的中率・ROI分析</h1>
        <Link href="/" className="text-sm text-accent hover:underline">&larr; トップに戻る</Link>
      </div>

      {/* 期間セレクター */}
      <div className="flex gap-2">
        {PERIOD_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setPeriod(opt.value)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              period === opt.value
                ? 'bg-primary text-white'
                : 'bg-card-bg border border-card-border hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* サマリーカード */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="評価済みレース" value={`${summary.totalEvaluated}`} />
          <StatCard label="単勝的中率" value={`${summary.winRate}%`} color={summary.winRate >= 30 ? 'text-green-600' : 'text-red-500'} />
          <StatCard label="複勝的中率" value={`${summary.placeRate}%`} color={summary.placeRate >= 60 ? 'text-green-600' : 'text-yellow-500'} />
          <StatCard label="平均ROI" value={`${summary.avgRoi}%`} color={summary.avgRoi >= 100 ? 'text-green-600' : 'text-red-500'} />
        </div>
      )}

      {/* 単勝/複勝別ROI */}
      {roiBreakdown && (
        <div className="bg-card-bg border border-card-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">単勝・複勝別 ROI ({periodLabel})</h2>
          <div className="grid grid-cols-2 gap-6">
            <div className="text-center">
              <div className="text-sm text-muted mb-1">単勝 ROI</div>
              <div className={`text-3xl font-bold ${roiBreakdown.winRoi >= 100 ? 'text-green-600' : 'text-red-500'}`}>
                {roiBreakdown.winRoi}%
              </div>
              <div className="text-xs text-muted mt-1">
                投資: {roiBreakdown.winInvested.toLocaleString()}円 / 回収: {roiBreakdown.winReturned.toLocaleString()}円
              </div>
            </div>
            <div className="text-center">
              <div className="text-sm text-muted mb-1">複勝 ROI (推定)</div>
              <div className={`text-3xl font-bold ${roiBreakdown.placeRoi >= 100 ? 'text-green-600' : 'text-red-500'}`}>
                {roiBreakdown.placeRoi}%
              </div>
              <div className="text-xs text-muted mt-1">
                投資: {roiBreakdown.placeInvested.toLocaleString()}円 / 回収: {roiBreakdown.placeReturned.toLocaleString()}円
              </div>
              <div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                ※ 複勝オッズは単勝×0.35で推定
              </div>
            </div>
          </div>
        </div>
      )}

      {/* グレード別的中率・ROI */}
      {gradeStats.length > 0 && (
        <div className="bg-card-bg border border-card-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">グレード別 的中率・ROI ({periodLabel})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b dark:border-gray-700 text-left">
                  <th className="py-2 pr-3 font-medium">グレード</th>
                  <th className="py-2 px-3 font-medium text-center">レース数</th>
                  <th className="py-2 px-3 font-medium text-center">単勝的中率</th>
                  <th className="py-2 px-3 font-medium text-center">複勝的中率</th>
                  <th className="py-2 px-3 font-medium text-center">ROI</th>
                </tr>
              </thead>
              <tbody>
                {gradeStats.map(gs => (
                  <tr key={gs.grade} className="border-b dark:border-gray-800">
                    <td className="py-2 pr-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold border ${
                        GRADE_COLORS[gs.grade] || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-300'
                      }`}>
                        {gs.grade}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-center">{gs.total}</td>
                    <td className="py-2 px-3 text-center">
                      <span className={gs.winRate >= 30 ? 'text-green-600 font-bold' : ''}>
                        {gs.winRate}%
                      </span>
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className={gs.placeRate >= 60 ? 'text-green-600 font-bold' : ''}>
                        {gs.placeRate}%
                      </span>
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className={`font-bold ${gs.roi >= 100 ? 'text-green-600' : 'text-red-500'}`}>
                        {gs.roi}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 推奨馬券種別 的中率・ROI */}
      {betTypeStats.length > 0 && (
        <div className="bg-card-bg border border-card-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">推奨馬券種別 的中率・ROI ({periodLabel})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b dark:border-gray-700 text-left">
                  <th className="py-2 pr-3 font-medium">券種</th>
                  <th className="py-2 px-3 font-medium text-center">推奨数</th>
                  <th className="py-2 px-3 font-medium text-center">的中</th>
                  <th className="py-2 px-3 font-medium text-center">的中率</th>
                  <th className="py-2 px-3 font-medium text-center">平均オッズ</th>
                  <th className="py-2 px-3 font-medium text-center">ROI</th>
                </tr>
              </thead>
              <tbody>
                {betTypeStats.map(bt => (
                  <tr key={bt.type} className="border-b dark:border-gray-800">
                    <td className="py-2 pr-3">
                      <span className="inline-block bg-primary text-white px-2 py-0.5 rounded text-xs font-bold">
                        {bt.type}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-center">{bt.total}</td>
                    <td className="py-2 px-3 text-center">{bt.hitCount}</td>
                    <td className="py-2 px-3 text-center">
                      <span className={bt.hitRate >= 30 ? 'text-green-600 font-bold' : ''}>
                        {bt.hitRate}%
                      </span>
                    </td>
                    <td className="py-2 px-3 text-center font-mono">
                      {bt.avgOdds > 0 ? `${bt.avgOdds}倍` : '-'}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className={`font-bold ${bt.roi >= 100 ? 'text-green-600' : 'text-red-500'}`}>
                        {bt.roi}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 的中率推移グラフ */}
      {rolling.length > 0 && (
        <div className="bg-card-bg border border-card-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">的中率推移 ({rollingWindowSize}R ローリング / {periodLabel})</h2>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={rolling}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis
                dataKey="index"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => {
                  const point = rolling.find(r => r.index === v);
                  return point?.date?.slice(5) || '';
                }}
                interval={Math.max(1, Math.floor(rolling.length / 8))}
              />
              <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                formatter={(value, name) => [
                  `${value}%`,
                  name === 'winRate' ? '単勝' : name === 'placeRate' ? '複勝' : 'ROI',
                ]}
                labelFormatter={(label) => {
                  const point = rolling.find(r => r.index === label);
                  return point ? `${point.date} (#${point.index})` : '';
                }}
              />
              <Legend formatter={(value) => value === 'winRate' ? '単勝的中率' : value === 'placeRate' ? '複勝的中率' : 'ROI'} />
              <Line type="monotone" dataKey="winRate" stroke="#e94560" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="placeRate" stroke="#0066ff" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="roi" stroke="#00b894" strokeWidth={1.5} dot={false} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 信頼度別的中率 */}
      {confidenceStats.length > 0 && (
        <div className="bg-card-bg border border-card-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">信頼度別 的中率 ({periodLabel})</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={confidenceStats}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="range" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
              <Tooltip contentStyle={{ fontSize: 12 }} formatter={(value) => `${value}%`} />
              <Legend formatter={(value) => value === 'winRate' ? '単勝' : '複勝'} />
              <Bar dataKey="winRate" fill="#e94560" radius={[4, 4, 0, 0]} />
              <Bar dataKey="placeRate" fill="#0066ff" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-2 text-xs text-muted text-center">
            {confidenceStats.map(s => `${s.range}: ${s.total}件`).join(' | ')}
          </div>
        </div>
      )}

      {/* 競馬場別的中率 */}
      {venueStats.length > 0 && (
        <div className="bg-card-bg border border-card-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">競馬場別 的中率 ({periodLabel})</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={venueStats.slice(0, 15)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis type="number" tick={{ fontSize: 11 }} domain={[0, 100]} />
              <YAxis type="category" dataKey="venue" tick={{ fontSize: 11 }} width={60} />
              <Tooltip contentStyle={{ fontSize: 12 }} formatter={(value) => `${value}%`} />
              <Legend formatter={(value) => value === 'winRate' ? '単勝' : '複勝'} />
              <ReferenceLine x={30} stroke="#ccc" strokeDasharray="3 3" />
              <Bar dataKey="winRate" fill="#e94560" radius={[0, 4, 4, 0]} />
              <Bar dataKey="placeRate" fill="#0066ff" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-2 text-xs text-muted text-center">
            {venueStats.slice(0, 15).map(s => `${s.venue}: ${s.total}件`).join(' | ')}
          </div>
        </div>
      )}

      {rolling.length === 0 && (
        <div className="text-center py-12 text-muted">
          <p>まだ評価済みレースがありません。</p>
          <p className="text-sm mt-2">結果取得後に自動で統計が集計されます。</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4 text-center">
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color || ''}`}>{value}</div>
    </div>
  );
}
