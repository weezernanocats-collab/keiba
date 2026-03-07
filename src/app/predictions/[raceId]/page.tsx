'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';

interface Pick {
  rank: number;
  horseNumber: number;
  horseName: string;
  score: number;
  reasons: string[];
}

interface Analysis {
  trackBias: string;
  paceAnalysis: string;
  keyFactors: string[];
  riskFactors: string[];
  bettingStrategy?: BettingStrategy;
}

interface BettingStrategy {
  pattern: string;
  patternLabel: string;
  recommendation: string;
  riskLevel: 'low' | 'medium' | 'high';
  primaryBets: string[];
  avoidBets: string[];
  budgetAdvice: string;
}

interface Bet {
  type: string;
  selections: number[];
  reasoning: string;
  expectedValue: number;
}

interface PredictionData {
  raceId: string;
  generatedAt: string;
  confidence: number;
  summary: string;
  topPicks: Pick[];
  analysis: Analysis;
  recommendedBets: Bet[];
}

interface RaceData {
  id: string;
  name: string;
  date: string;
  racecourseName: string;
  raceNumber: number;
  grade: string | null;
  trackType: string;
  distance: number;
  trackCondition: string | null;
}

export default function PredictionDetailPage() {
  const params = useParams();
  const raceId = params.raceId as string;
  const [prediction, setPrediction] = useState<PredictionData | null>(null);
  const [race, setRace] = useState<RaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch(`/api/predictions/${raceId}`);
        const data = await res.json();
        if (data.error) {
          setError(data.error);
        } else {
          setPrediction(data.prediction || null);
          setRace(data.race || null);
        }
      } catch (err) {
        console.error('エラー:', err);
        setError('データの取得に失敗しました');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [raceId]);

  if (loading) return <LoadingSpinner message="AI予想を読み込んでいます..." />;

  if (error) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-lg text-muted">{error}</p>
        <Link href="/predictions" className="text-accent hover:underline">← 予想一覧に戻る</Link>
      </div>
    );
  }

  if (!prediction || !race) {
    return (
      <div className="text-center py-12">
        <p>予想データがありません</p>
        <Link href="/predictions" className="text-accent hover:underline">← 予想一覧に戻る</Link>
      </div>
    );
  }

  const rankLabels = ['◎ 本命', '○ 対抗', '▲ 単穴', '△ 連下', '× 注意', '☆ 穴'];
  const rankColors = [
    'bg-red-50 border-red-300 dark:bg-red-900/20 dark:border-red-800',
    'bg-blue-50 border-blue-300 dark:bg-blue-900/20 dark:border-blue-800',
    'bg-yellow-50 border-yellow-300 dark:bg-yellow-900/20 dark:border-yellow-800',
    'bg-green-50 border-green-300 dark:bg-green-900/20 dark:border-green-800',
    'bg-purple-50 border-purple-300 dark:bg-purple-900/20 dark:border-purple-800',
    'bg-gray-50 border-gray-300 dark:bg-gray-800/20 dark:border-gray-600',
  ];

  return (
    <div className="space-y-6 animate-fadeIn">
      <Link href="/predictions" className="text-sm text-accent hover:underline">← 予想一覧に戻る</Link>

      {/* レース情報ヘッダー */}
      <div className="bg-gradient-to-r from-primary to-primary-light rounded-xl p-6 text-white">
        <div className="flex flex-wrap items-start gap-3 mb-2">
          <GradeBadge grade={race.grade} />
          <h1 className="text-2xl font-bold">{race.name}</h1>
        </div>
        <p className="text-white/80 text-sm">
          {race.date} | {race.racecourseName} {race.raceNumber}R | {race.trackType}{race.distance}m
          {race.trackCondition && ` | ${race.trackCondition}`}
        </p>
        <div className="mt-4 flex items-center gap-4">
          <div>
            <span className="text-white/60 text-xs">AI信頼度</span>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-32 h-3 bg-white/20 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${prediction.confidence}%`,
                    backgroundColor: prediction.confidence >= 70 ? '#00b894' : prediction.confidence >= 50 ? '#fdcb6e' : '#e94560',
                  }}
                />
              </div>
              <span className="font-bold">{prediction.confidence}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* サマリー */}
      <div className="bg-card-bg border border-card-border rounded-xl p-6">
        <h2 className="text-lg font-bold mb-3">📝 予想サマリー</h2>
        <div className="whitespace-pre-line text-sm leading-relaxed">{prediction.summary}</div>
      </div>

      {/* トップピック */}
      <div>
        <h2 className="text-lg font-bold mb-4">🏇 予想印</h2>
        <div className="space-y-3">
          {prediction.topPicks.map((pick, idx) => (
            <div
              key={pick.horseNumber}
              className={`border rounded-xl p-4 ${rankColors[idx] || rankColors[5]}`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold">{rankLabels[idx] || '☆'}</span>
                  <span className="text-xl font-bold">{pick.horseNumber}番 {pick.horseName}</span>
                </div>
                <div className="text-right">
                  <span className="text-sm text-muted">スコア</span>
                  <span className="ml-2 text-lg font-bold">{pick.score}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {pick.reasons.map((reason, rIdx) => (
                  <span key={rIdx} className="text-xs bg-white/60 dark:bg-black/20 px-2 py-1 rounded">
                    {reason}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* レース分析 */}
      <div className="bg-card-bg border border-card-border rounded-xl p-6">
        <h2 className="text-lg font-bold mb-4">📊 レース分析</h2>
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-bold text-muted mb-1">馬場バイアス</h3>
            <p className="text-sm">{prediction.analysis.trackBias}</p>
          </div>
          <div>
            <h3 className="text-sm font-bold text-muted mb-1">ペース予想</h3>
            <p className="text-sm">{prediction.analysis.paceAnalysis}</p>
          </div>
          {prediction.analysis.keyFactors.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-muted mb-1">注目ポイント</h3>
              <ul className="space-y-1">
                {prediction.analysis.keyFactors.map((f, i) => (
                  <li key={i} className="text-sm flex items-start gap-2">
                    <span className="text-accent">●</span> {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {prediction.analysis.riskFactors.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-muted mb-1">リスク要因</h3>
              <ul className="space-y-1">
                {prediction.analysis.riskFactors.map((f, i) => (
                  <li key={i} className="text-sm flex items-start gap-2">
                    <span className="text-warning">⚠</span> {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* 馬券戦略 */}
      {prediction.analysis.bettingStrategy && (
        <div className="bg-card-bg border border-card-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">🎯 馬券戦略</h2>
          <div className="space-y-4">
            {/* パターン表示 */}
            <div className="flex flex-wrap items-center gap-3">
              <span className={`px-4 py-2 rounded-lg text-sm font-bold ${
                prediction.analysis.bettingStrategy.pattern === '一強'
                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                  : prediction.analysis.bettingStrategy.pattern === '二強'
                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
                  : prediction.analysis.bettingStrategy.pattern === '三つ巴'
                  ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                  : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
              }`}>
                {prediction.analysis.bettingStrategy.pattern}
              </span>
              <span className={`px-3 py-1 rounded text-xs font-medium ${
                prediction.analysis.bettingStrategy.riskLevel === 'low'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : prediction.analysis.bettingStrategy.riskLevel === 'medium'
                  ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                  : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
              }`}>
                リスク: {prediction.analysis.bettingStrategy.riskLevel === 'low' ? '低' : prediction.analysis.bettingStrategy.riskLevel === 'medium' ? '中' : '高'}
              </span>
            </div>

            <p className="text-sm text-muted">{prediction.analysis.bettingStrategy.patternLabel}</p>

            {/* 戦略テキスト */}
            <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <p className="text-sm leading-relaxed">{prediction.analysis.bettingStrategy.recommendation}</p>
            </div>

            {/* 推奨・非推奨 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <h4 className="text-xs font-bold text-muted mb-2">推奨券種</h4>
                <div className="flex flex-wrap gap-2">
                  {prediction.analysis.bettingStrategy.primaryBets.map((bet) => (
                    <span key={bet} className="px-2 py-1 bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400 text-xs rounded font-medium">
                      {bet}
                    </span>
                  ))}
                </div>
              </div>
              {prediction.analysis.bettingStrategy.avoidBets.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-muted mb-2">非推奨</h4>
                  <div className="flex flex-wrap gap-2">
                    {prediction.analysis.bettingStrategy.avoidBets.map((bet) => (
                      <span key={bet} className="px-2 py-1 bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-400 text-xs rounded font-medium line-through">
                        {bet}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 資金配分 */}
            <div className="bg-gray-50 dark:bg-gray-800/30 rounded-lg p-3">
              <h4 className="text-xs font-bold text-muted mb-1">資金配分の目安</h4>
              <p className="text-sm">{prediction.analysis.bettingStrategy.budgetAdvice}</p>
            </div>
          </div>
        </div>
      )}

      {/* 推奨馬券 */}
      {prediction.recommendedBets.length > 0 && (
        <div>
          <h2 className="text-lg font-bold mb-4">🎫 推奨馬券</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {prediction.recommendedBets.map((bet, idx) => {
              const isMain = bet.reasoning.startsWith('【主力】');
              const isValue = bet.reasoning.startsWith('【バリュー】');
              return (
                <div key={idx} className={`border rounded-xl p-4 ${
                  isMain
                    ? 'bg-blue-50 border-blue-300 dark:bg-blue-900/20 dark:border-blue-700'
                    : isValue
                    ? 'bg-amber-50 border-amber-300 dark:bg-amber-900/20 dark:border-amber-700'
                    : 'bg-card-bg border-card-border'
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="bg-primary text-white px-3 py-1 rounded text-sm font-bold">
                        {bet.type}
                      </span>
                      {isMain && (
                        <span className="text-xs bg-blue-200 dark:bg-blue-800 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded">
                          主力
                        </span>
                      )}
                      {isValue && (
                        <span className="text-xs bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 px-2 py-0.5 rounded">
                          バリュー
                        </span>
                      )}
                    </div>
                    <span className="text-sm text-muted">
                      EV: {bet.expectedValue.toFixed(2)}
                    </span>
                  </div>
                  <p className="text-xl font-bold mb-2">
                    {bet.selections.join(' - ')}
                  </p>
                  <p className="text-sm text-muted">
                    {bet.reasoning.replace(/^【(主力|バリュー|押さえ)】/, '')}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 出馬表リンク */}
      <div className="text-center pt-4">
        <Link
          href={`/races/${raceId}`}
          className="inline-block bg-primary text-white px-6 py-3 rounded-lg font-medium hover:bg-primary-light transition-colors"
        >
          出馬表を見る
        </Link>
      </div>
    </div>
  );
}
