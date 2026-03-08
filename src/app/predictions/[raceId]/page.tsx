'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import FavoriteButton from '@/components/FavoriteButton';
import BudgetSimulator from '@/components/BudgetSimulator';
import MonteCarloSimulator from '@/components/MonteCarloSimulator';
import { useFavorites } from '@/lib/use-favorites';

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
  winProbabilities?: Record<number, number>;
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
  odds?: number;
  kellyFraction?: number;
  valueEdge?: number;
  recommendedStake?: number;
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
  status: string;
}

interface PickResult extends Pick {
  actualPosition: number | null;
  hit: boolean;
  placeHit: boolean;
}

interface BetResult extends Bet {
  hit: boolean;
}

interface Verification {
  winHit: boolean;
  placeHit: boolean;
  top3InTop6: number;
  roi: number;
  pickResults: PickResult[];
  betResults: BetResult[];
  actualTop3: number[];
}

interface ScoreBucket {
  scoreRange: string;
  scoreLow: number;
  total: number;
  winRate: number;
  placeRate: number;
}

export default function PredictionDetailPage() {
  const params = useParams();
  const raceId = params.raceId as string;
  const [prediction, setPrediction] = useState<PredictionData | null>(null);
  const [race, setRace] = useState<RaceData | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [scoreBuckets, setScoreBuckets] = useState<ScoreBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toggleRace, isRaceFavorite } = useFavorites();

  useEffect(() => {
    async function fetchData() {
      try {
        const [predRes, scoreRes] = await Promise.all([
          fetch(`/api/predictions/${raceId}`),
          fetch('/api/score-lookup'),
        ]);
        const predData = await predRes.json();
        if (predData.error) {
          setError(predData.error);
        } else {
          setPrediction(predData.prediction || null);
          setRace(predData.race || null);
          setVerification(predData.verification || null);
        }
        const scoreData = await scoreRes.json();
        setScoreBuckets(scoreData.buckets || []);
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
        <Link href="/predictions" className="text-accent hover:underline">&larr; 予想一覧に戻る</Link>
      </div>
    );
  }

  if (!prediction || !race) {
    return (
      <div className="text-center py-12">
        <p>予想データがありません</p>
        <Link href="/predictions" className="text-accent hover:underline">&larr; 予想一覧に戻る</Link>
      </div>
    );
  }

  const rankLabels = ['\u25CE 本命', '\u25CB 対抗', '\u25B2 単穴', '\u25B3 連下', '\u00D7 注意', '\u2606 穴'];
  const rankColors = [
    'bg-red-50 border-red-300 dark:bg-red-900/20 dark:border-red-800',
    'bg-blue-50 border-blue-300 dark:bg-blue-900/20 dark:border-blue-800',
    'bg-yellow-50 border-yellow-300 dark:bg-yellow-900/20 dark:border-yellow-800',
    'bg-green-50 border-green-300 dark:bg-green-900/20 dark:border-green-800',
    'bg-purple-50 border-purple-300 dark:bg-purple-900/20 dark:border-purple-800',
    'bg-gray-50 border-gray-300 dark:bg-gray-800/20 dark:border-gray-600',
  ];

  // スコアバケットからヒント取得
  function getScoreHint(score: number): string {
    const bucket = scoreBuckets.find(b => score >= b.scoreLow && score < b.scoreLow + 5);
    if (!bucket || bucket.total < 5) return '';
    return `同帯勝率${bucket.winRate}% (複${bucket.placeRate}%)`;
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <Link href="/predictions" className="text-sm text-accent hover:underline">&larr; 予想一覧に戻る</Link>
        <FavoriteButton isFavorite={isRaceFavorite(raceId)} onToggle={() => toggleRace(raceId)} showLabel />
      </div>

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

      {/* 答え合わせ (B2) - 結果確定済みの場合 */}
      {verification && (
        <div className="bg-card-bg border-2 border-amber-400 dark:border-amber-600 rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">📋 答え合わせ</h2>

          {/* 全体結果バッジ */}
          <div className="flex flex-wrap gap-3 mb-4">
            <span className={`px-4 py-2 rounded-lg text-sm font-bold ${
              verification.winHit
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
            }`}>
              単勝: {verification.winHit ? '的中!' : '不的中'}
            </span>
            <span className={`px-4 py-2 rounded-lg text-sm font-bold ${
              verification.placeHit
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
            }`}>
              複勝: {verification.placeHit ? '的中!' : '不的中'}
            </span>
            <span className="px-4 py-2 rounded-lg text-sm font-bold bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
              ROI: {verification.roi}%
            </span>
          </div>

          {/* 予想 vs 実結果テーブル */}
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b dark:border-gray-700 text-left">
                  <th className="py-2 pr-2">印</th>
                  <th className="py-2">馬番</th>
                  <th className="py-2">馬名</th>
                  <th className="py-2 text-right">スコア</th>
                  <th className="py-2 text-center">実着順</th>
                  <th className="py-2 text-center">判定</th>
                </tr>
              </thead>
              <tbody>
                {verification.pickResults.map((pick, idx) => (
                  <tr key={pick.horseNumber} className="border-b dark:border-gray-800">
                    <td className="py-2 pr-2 font-bold">{rankLabels[idx] || '\u2606'}</td>
                    <td className="py-2 font-mono">{pick.horseNumber}</td>
                    <td className="py-2">{pick.horseName}</td>
                    <td className="py-2 text-right font-mono">{pick.score}</td>
                    <td className="py-2 text-center font-bold">
                      {pick.actualPosition ? `${pick.actualPosition}着` : '-'}
                    </td>
                    <td className="py-2 text-center">
                      {pick.hit && (
                        <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 text-xs rounded font-bold">
                          1着!
                        </span>
                      )}
                      {!pick.hit && pick.placeHit && (
                        <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-xs rounded font-bold">
                          複勝圏
                        </span>
                      )}
                      {!pick.hit && !pick.placeHit && pick.actualPosition && (
                        <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 text-xs rounded">
                          外れ
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 推奨馬券の的中判定 */}
          {verification.betResults.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-muted mb-2">推奨馬券の結果</h3>
              <div className="flex flex-wrap gap-2">
                {verification.betResults.map((bet, idx) => (
                  <span key={idx} className={`px-3 py-1.5 rounded text-xs font-medium ${
                    bet.hit
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 border border-green-300'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-500 border border-gray-300 dark:border-gray-600'
                  }`}>
                    {bet.type} {bet.selections.join('-')} {bet.hit ? '的中' : '不的中'}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* サマリー */}
      <div className="bg-card-bg border border-card-border rounded-xl p-6">
        <h2 className="text-lg font-bold mb-3">予想サマリー</h2>
        <div className="whitespace-pre-line text-sm leading-relaxed">{prediction.summary}</div>
      </div>

      {/* トップピック */}
      <div>
        <h2 className="text-lg font-bold mb-4">予想印</h2>
        <div className="space-y-3">
          {prediction.topPicks.map((pick, idx) => {
            const scoreHint = getScoreHint(pick.score);
            return (
              <div
                key={pick.horseNumber}
                className={`border rounded-xl p-4 ${rankColors[idx] || rankColors[5]}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold">{rankLabels[idx] || '\u2606'}</span>
                    <span className="text-xl font-bold">{pick.horseNumber}番 {pick.horseName}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-sm text-muted">スコア</span>
                    <span className="ml-2 text-lg font-bold">{pick.score}</span>
                    {/* B1: スコアの意味表示 */}
                    {scoreHint && (
                      <div className="text-xs text-accent mt-0.5">{scoreHint}</div>
                    )}
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
            );
          })}
        </div>
      </div>

      {/* レース分析 */}
      <div className="bg-card-bg border border-card-border rounded-xl p-6">
        <h2 className="text-lg font-bold mb-4">レース分析</h2>
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
                    <span className="text-accent">&#9679;</span> {f}
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
                    <span className="text-warning">&#9888;</span> {f}
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
          <h2 className="text-lg font-bold mb-4">馬券戦略</h2>
          <div className="space-y-4">
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

            <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <p className="text-sm leading-relaxed">{prediction.analysis.bettingStrategy.recommendation}</p>
            </div>

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
          <h2 className="text-lg font-bold mb-4">推奨馬券</h2>
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
                      {bet.odds ? ` (${bet.odds.toFixed(1)}倍)` : ''}
                    </span>
                  </div>
                  <p className="text-xl font-bold mb-2">
                    {bet.selections.join(' - ')}
                  </p>
                  <p className="text-sm text-muted">
                    {bet.reasoning.replace(/^【(主力|バリュー|押さえ)】/, '')}
                  </p>
                  {(bet.kellyFraction !== undefined && bet.kellyFraction > 0) && (
                    <div className="flex flex-wrap gap-2 mt-2 text-xs">
                      {bet.valueEdge !== undefined && bet.valueEdge > 0 && (
                        <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-2 py-0.5 rounded">
                          エッジ +{(bet.valueEdge * 100).toFixed(0)}%
                        </span>
                      )}
                      <span className="bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-2 py-0.5 rounded">
                        Kelly {(bet.kellyFraction * 100).toFixed(1)}%
                      </span>
                      {bet.recommendedStake !== undefined && bet.recommendedStake > 0 && (
                        <span className="bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 rounded">
                          推奨 {(bet.recommendedStake * 100).toFixed(1)}%
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* B5: 金額シミュレーション */}
      {prediction.recommendedBets.length > 0 && prediction.analysis.bettingStrategy && (
        <BudgetSimulator
          bets={prediction.recommendedBets}
          riskLevel={prediction.analysis.bettingStrategy.riskLevel}
        />
      )}

      {/* モンテカルロ・シミュレーション */}
      {prediction.recommendedBets.length > 0 && (
        <MonteCarloSimulator
          bets={prediction.recommendedBets}
          winProbabilities={prediction.analysis.winProbabilities}
        />
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
