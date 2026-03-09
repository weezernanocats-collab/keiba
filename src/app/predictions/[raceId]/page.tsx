'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import FavoriteButton from '@/components/FavoriteButton';
import BudgetSimulator from '@/components/BudgetSimulator';
import MonteCarloSimulator from '@/components/MonteCarloSimulator';
import ModelVsMarket from '@/components/ModelVsMarket';
import { useFavorites } from '@/lib/use-favorites';

interface Pick {
  rank: number;
  horseNumber: number;
  horseName: string;
  score: number;
  reasons: string[];
  runningStyle?: string;
  escapeRate?: number;
}

interface MarketEntry {
  modelProb: number;
  marketProb: number;
  blendedProb: number;
  disagreement: number;
  isValue: boolean;
}

interface Analysis {
  trackBias: string;
  paceAnalysis: string;
  keyFactors: string[];
  riskFactors: string[];
  bettingStrategy?: BettingStrategy;
  winProbabilities?: Record<number, number>;
  marketAnalysis?: Record<number, MarketEntry>;
  valueHorses?: number[];
  overround?: number;
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

interface BetResultDetail extends Bet {
  hit: boolean;
  odds: number;
  isEstimated: boolean;
  investment: number;
  payout: number;
  profit: number;
}

interface BetSummary {
  totalInvestment: number;
  totalPayout: number;
  totalProfit: number;
}

interface ActualTop3Entry {
  horseNumber: number;
  horseName: string;
}

interface Verification {
  winHit: boolean;
  placeHit: boolean;
  top3InTop6: number;
  roi: number;
  pickResults: PickResult[];
  betResults: BetResultDetail[];
  betSummary?: BetSummary;
  actualTop3: number[];
  actualTop3Detailed?: ActualTop3Entry[];
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

  // セクションナビ用（Hooksは条件分岐の前に置く必要がある）
  const [activeSection, setActiveSection] = useState('');
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const setSectionRef = useCallback((id: string) => (el: HTMLElement | null) => {
    sectionRefs.current[id] = el;
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0.1 }
    );
    const refs = sectionRefs.current;
    for (const el of Object.values(refs)) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [prediction, verification]);

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

  const sections = [
    ...(verification ? [{ id: 'verification', label: '答え合わせ' }] : []),
    { id: 'summary', label: 'サマリー' },
    { id: 'picks', label: '予想印' },
    ...(prediction?.analysis.marketAnalysis ? [{ id: 'market', label: '市場比較' }] : []),
    { id: 'analysis', label: 'レース分析' },
    ...(prediction?.analysis.bettingStrategy ? [{ id: 'strategy', label: '馬券戦略' }] : []),
    ...(prediction && prediction.recommendedBets.length > 0 ? [{ id: 'bets', label: '推奨馬券' }] : []),
    ...(prediction && prediction.recommendedBets.length > 0 && prediction.analysis.bettingStrategy ? [{ id: 'simulator', label: 'シミュレーション' }] : []),
  ];

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

      {/* セクションナビ */}
      {sections.length > 2 && (
        <nav className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-card-border -mx-4 px-4 py-2 overflow-x-auto">
          <div className="flex gap-1 min-w-max">
            {sections.map(s => (
              <button
                key={s.id}
                onClick={() => sectionRefs.current[s.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                  activeSection === s.id
                    ? 'bg-accent text-white'
                    : 'bg-card-bg text-muted hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* 答え合わせ (B2) - 結果確定済みの場合 */}
      {verification && (
        <div id="verification" ref={setSectionRef('verification')} className="bg-card-bg border-2 border-amber-400 dark:border-amber-600 rounded-xl p-6 scroll-mt-16">
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
            {verification.betSummary && (
              <span className={`px-4 py-2 rounded-lg text-sm font-bold ${
                verification.betSummary.totalProfit > 0
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                  : verification.betSummary.totalProfit === 0
                  ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                  : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
              }`}>
                収支: {verification.betSummary.totalProfit > 0 ? '+' : ''}{verification.betSummary.totalProfit}円
              </span>
            )}
          </div>

          {/* 実着順TOP3サマリー */}
          {verification.actualTop3.length > 0 && (
            <div className="bg-gray-50 dark:bg-gray-800/30 rounded-lg p-4 mb-4">
              <h3 className="text-xs font-bold text-muted mb-2">実際の結果</h3>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {(verification.actualTop3Detailed || verification.actualTop3.map(n => ({ horseNumber: n, horseName: '' }))).map((horse, i) => {
                  const pickIdx = prediction.topPicks.findIndex(p => p.horseNumber === horse.horseNumber);
                  const label = pickIdx >= 0 ? rankLabels[pickIdx] : null;
                  const picked = verification.pickResults.find(p => p.horseNumber === horse.horseNumber);
                  const name = horse.horseName || picked?.horseName || '';
                  return (
                    <span key={horse.horseNumber} className="flex items-center gap-1">
                      {i > 0 && <span className="text-muted mx-1">→</span>}
                      <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                        i === 0 ? 'bg-yellow-400 text-black' :
                        i === 1 ? 'bg-gray-300 text-black' :
                        'bg-amber-600 text-white'
                      }`}>{i + 1}</span>
                      <span className="font-bold">{horse.horseNumber}番</span>
                      {name && <span>{name}</span>}
                      {label ? (
                        <span className="text-xs bg-accent/15 text-accent px-1.5 py-0.5 rounded font-medium">{label}</span>
                      ) : (
                        <span className="text-xs bg-gray-200 dark:bg-gray-700 text-muted px-1.5 py-0.5 rounded">圏外</span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

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

          {/* 推奨馬券の収支 */}
          {verification.betResults.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-muted mb-2">推奨馬券の結果</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b dark:border-gray-700 text-left">
                      <th className="py-2">券種</th>
                      <th className="py-2">買い目</th>
                      <th className="py-2 text-right">オッズ</th>
                      <th className="py-2 text-center">結果</th>
                      <th className="py-2 text-right">収支</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verification.betResults.map((bet, idx) => (
                      <tr key={idx} className="border-b dark:border-gray-800">
                        <td className="py-2 font-medium">{bet.type}</td>
                        <td className="py-2 font-mono">{bet.selections.join('-')}</td>
                        <td className="py-2 text-right text-muted">
                          {bet.odds > 0 ? `${bet.odds.toFixed(1)}倍` : '-'}
                          {bet.isEstimated && bet.odds > 0 && <span className="text-xs ml-0.5">(推定)</span>}
                        </td>
                        <td className="py-2 text-center">
                          {bet.hit ? (
                            <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 text-xs rounded font-bold">的中</span>
                          ) : (
                            <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 text-xs rounded">不的中</span>
                          )}
                        </td>
                        <td className={`py-2 text-right font-bold ${
                          bet.profit > 0 ? 'text-green-600 dark:text-green-400' :
                          bet.profit < 0 ? 'text-red-600 dark:text-red-400' : ''
                        }`}>
                          {bet.profit > 0 ? '+' : ''}{bet.profit}円
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {verification.betSummary && (
                    <tfoot>
                      <tr className="border-t-2 dark:border-gray-600 font-bold">
                        <td colSpan={2} className="py-2">合計</td>
                        <td className="py-2 text-right text-muted text-xs">投資{verification.betSummary.totalInvestment}円</td>
                        <td className="py-2 text-center text-xs">回収{verification.betSummary.totalPayout}円</td>
                        <td className={`py-2 text-right ${
                          verification.betSummary.totalProfit > 0 ? 'text-green-600 dark:text-green-400' :
                          verification.betSummary.totalProfit < 0 ? 'text-red-600 dark:text-red-400' : ''
                        }`}>
                          {verification.betSummary.totalProfit > 0 ? '+' : ''}{verification.betSummary.totalProfit}円
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* サマリー */}
      <div id="summary" ref={setSectionRef('summary')} className="bg-card-bg border border-card-border rounded-xl p-6 scroll-mt-16">
        <h2 className="text-lg font-bold mb-3">予想サマリー</h2>
        <div className="whitespace-pre-line text-sm leading-relaxed">{prediction.summary}</div>
      </div>

      {/* トップピック */}
      <div id="picks" ref={setSectionRef('picks')} className="scroll-mt-16">
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
                    {pick.runningStyle && (
                      <span className={`text-xs px-2 py-0.5 rounded font-bold ${
                        pick.runningStyle === '逃げ'
                          ? 'bg-orange-100 dark:bg-orange-800/40 text-orange-700 dark:text-orange-300'
                          : pick.runningStyle === '先行'
                          ? 'bg-sky-100 dark:bg-sky-800/40 text-sky-700 dark:text-sky-300'
                          : pick.runningStyle === '差し'
                          ? 'bg-emerald-100 dark:bg-emerald-800/40 text-emerald-700 dark:text-emerald-300'
                          : pick.runningStyle === '追込'
                          ? 'bg-purple-100 dark:bg-purple-800/40 text-purple-700 dark:text-purple-300'
                          : 'bg-gray-100 dark:bg-gray-800/40 text-gray-500'
                      }`}>
                        {pick.runningStyle}
                        {pick.escapeRate != null && pick.runningStyle === '逃げ' ? ` ${pick.escapeRate}%` : ''}
                      </span>
                    )}
                    {prediction.analysis.valueHorses?.includes(pick.horseNumber) && (
                      <span className="text-xs bg-amber-100 dark:bg-amber-800/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded font-bold">
                        妙味あり
                      </span>
                    )}
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

      {/* モデル vs 市場オッズ */}
      {prediction.analysis.marketAnalysis && prediction.analysis.valueHorses && prediction.analysis.overround && (
        <div id="market" ref={setSectionRef('market')} className="scroll-mt-16">
        <ModelVsMarket
          marketAnalysis={prediction.analysis.marketAnalysis}
          valueHorses={prediction.analysis.valueHorses}
          overround={prediction.analysis.overround}
          horseNames={Object.fromEntries(
            prediction.topPicks.map(p => [p.horseNumber, p.horseName])
          )}
        />
        </div>
      )}

      {/* レース分析 */}
      <div id="analysis" ref={setSectionRef('analysis')} className="bg-card-bg border border-card-border rounded-xl p-6 scroll-mt-16">
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
        <div id="strategy" ref={setSectionRef('strategy')} className="bg-card-bg border border-card-border rounded-xl p-6 scroll-mt-16">
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
        <div id="bets" ref={setSectionRef('bets')} className="scroll-mt-16">
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

      {/* B5: 金額シミュレーション & モンテカルロ */}
      {prediction.recommendedBets.length > 0 && prediction.analysis.bettingStrategy && (
        <div id="simulator" ref={setSectionRef('simulator')} className="scroll-mt-16 space-y-6">
          <BudgetSimulator
            bets={prediction.recommendedBets}
            riskLevel={prediction.analysis.bettingStrategy.riskLevel}
          />
          <MonteCarloSimulator
            bets={prediction.recommendedBets}
            winProbabilities={prediction.analysis.winProbabilities}
          />
        </div>
      )}

      {/* モンテカルロのみ（bettingStrategyがない場合） */}
      {prediction.recommendedBets.length > 0 && !prediction.analysis.bettingStrategy && (
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
