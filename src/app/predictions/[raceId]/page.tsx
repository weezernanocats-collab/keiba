'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import FavoriteProfilePopover from '@/components/FavoriteProfilePopover';
import BudgetSimulator from '@/components/BudgetSimulator';
import MonteCarloSimulator from '@/components/MonteCarloSimulator';
import ModelVsMarket from '@/components/ModelVsMarket';
import { useFavorites } from '@/lib/use-favorites';
import { useApi, useDeferredApi, formatLastFetched } from '@/hooks/use-api';
import type { MarketAnalysisEntry as MarketEntry, BetDisplay as Bet, BetTypeStat, BetSummaryDisplay as BetSummary } from '@/types';

interface Pick {
  rank: number;
  horseNumber: number;
  horseName: string;
  score: number;
  reasons: string[];
  runningStyle?: string;
  escapeRate?: number;
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

interface AIIndependentBetData {
  horseNumber: number;
  horseName: string;
  betTypes: string[];
  reasoning: string;
  aiProb: number;
  marketOdds: number;
  favoriteNumber: number;
  favoriteName: string;
}

interface AIOnlyRankingEntry {
  rank: number;
  horseNumber: number;
  horseName: string;
  aiProb: number;
  marketRank: number | null;
}

interface AIOnlyRanking {
  entries: AIOnlyRankingEntry[];
  modelAccuracy: number;
}

interface AIRankingBetHorse {
  horseNumber: number;
  horseName: string;
  aiRank: number;
  aiProb: number;
}

interface AIRankingBetItem {
  type: string;
  horses: AIRankingBetHorse[];
  reasoning: string;
  confidence: 'high' | 'medium' | 'low';
}

interface AIRankingBetsData {
  bets: AIRankingBetItem[];
  pattern: string;
  summary: string;
}

interface PredictionData {
  raceId: string;
  generatedAt: string;
  confidence: number;
  summary: string;
  topPicks: Pick[];
  analysis: Analysis;
  recommendedBets: Bet[];
  aiIndependentBets?: AIIndependentBetData[];
  aiOnlyRanking?: AIOnlyRanking;
  aiRankingBets?: AIRankingBetsData;
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
  time?: string;
  entries: { horseNumber: number; jockeyName: string }[];
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

/** 第2層: 買い方補正係数（betting-strategy.ts と同値） */
const BET_TYPE_CALIBRATION: Record<string, number> = {
  '単勝': 1.0, '複勝': 1.0, '馬連': 0.75, 'ワイド': 0.66,
  '馬単': 0.69, '三連複': 0.52, '三連単': 3.4,
};

function PredictionLoadingIndicator() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(prev => prev + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const message = elapsed < 3
    ? 'AI予想を読み込んでいます...'
    : elapsed < 8
      ? 'データ取得中...（馬場バイアスを確認しています）'
      : 'AI予想を再生成しています...（通常10〜20秒）';

  const showSubtext = elapsed >= 5;

  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
      <p className="mt-4 text-sm text-muted">{message}</p>
      {showSubtext && (
        <p className="mt-2 text-xs text-muted/60">{elapsed}秒経過</p>
      )}
    </div>
  );
}

export default function PredictionDetailPage() {
  const params = useParams();
  const raceId = params.raceId as string;
  const { isRaceFavoriteInProfile, toggleRaceForProfile } = useFavorites();

  const [biasUpdating, setBiasUpdating] = useState(false);

  // メイン予想データ: SWRで即表示 + バックグラウンド再検証
  const { data: predData, error: predError, isValidating, lastFetched, mutate } = useApi<{
    prediction: PredictionData | null;
    race: RaceData | null;
    verification: Verification | null;
    regeneratedWithBias?: boolean;
    regeneratedWithOdds?: boolean;
    biasUpdateAvailable?: boolean;
    error?: string;
  }>(`/api/predictions/${raceId}`);

  // 補助データ: 遅延読み込み（メイン描画をブロックしない）
  const { data: scoreData } = useDeferredApi<{ buckets: ScoreBucket[] }>('/api/score-lookup');
  const { data: statsData } = useDeferredApi<{ betTypeStats: BetTypeStat[] }>('/api/accuracy-stats');

  const prediction = predData?.prediction || null;
  const race = predData?.race || null;
  const verification = predData?.verification || null;
  const scoreBuckets = scoreData?.buckets || [];
  const betTypeStats = statsData?.betTypeStats || [];
  const error = predData?.error || (predError ? 'データの取得に失敗しました' : null);

  // 馬番→騎手名マップ
  const jockeyMap = new Map<number, string>();
  if (race?.entries) {
    for (const e of race.entries) {
      if (e.jockeyName) jockeyMap.set(e.horseNumber, e.jockeyName);
    }
  }

  // ヘッダー固定表示: メインヘッダーが画面外に出たらコンパクトバーを表示
  const [headerHidden, setHeaderHidden] = useState(false);
  const headerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setHeaderHidden(!entry.isIntersecting),
      { threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [prediction, race]);

  // セクションナビ用
  const [activeSection, setActiveSection] = useState('');
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const observerRef = useRef<IntersectionObserver | null>(null);
  if (typeof window !== 'undefined' && !observerRef.current) {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0.1 }
    );
  }

  const setSectionRefWrapped = useCallback((id: string) => (el: HTMLElement | null) => {
    sectionRefs.current[id] = el;
    if (el && observerRef.current) {
      observerRef.current.observe(el);
    }
  }, []);

  if (!predData && !predError) return <PredictionLoadingIndicator />;

  const isTimeout = error?.includes('タイムアウト') || predError?.message?.includes('timeout');

  if (error) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-lg text-muted">{error}</p>
        {isTimeout && (
          <p className="text-sm text-muted/70">
            予想生成に時間がかかっています。再試行すると2回目以降はキャッシュが効いて速くなります。
          </p>
        )}
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => mutate()}
            className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-light transition-colors text-sm"
          >
            {isTimeout ? '再試行する' : 'もう一度試す'}
          </button>
          <Link href="/predictions" className="text-accent hover:underline text-sm">&larr; 予想一覧に戻る</Link>
        </div>
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

  // 期待値 > 100（的中率×オッズが損益分岐を超える）の馬券をピックアップ
  const betTypeStatsMap = new Map(betTypeStats.map(s => [s.type, s]));
  const valueBets = prediction.recommendedBets
    .map(bet => {
      const stat = betTypeStatsMap.get(bet.type);
      const odds = bet.odds || 0;
      // 馬券固有の的中率を優先
      const hasModelProb = bet.hitProbability != null;
      const betHitProb = hasModelProb ? bet.hitProbability! * 100 : 0;
      const typeHitRate = stat?.hitRate || 0;
      const hitRate = hasModelProb && typeHitRate > 0
        ? betHitProb * 0.7 + typeHitRate * 0.3
        : hasModelProb ? betHitProb : typeHitRate;
      const evScore = odds > 0 && hitRate > 0 ? Math.round(odds * hitRate) : 0;
      return { bet, stat, odds, hitRate, evScore };
    })
    .filter(v => v.evScore > 100);

  // 買い判定ロジック
  const pattern = prediction.aiRankingBets?.pattern || '';
  const hasRealBets = prediction.aiRankingBets?.bets.some(b => b.type !== '見送り') ?? false;
  const hasValueBets = valueBets.length > 0;
  const bestValueBet = valueBets.length > 0
    ? valueBets.reduce((best, v) => v.evScore > best.evScore ? v : best)
    : null;
  const confidence = prediction.confidence;

  type BetVerdict = { level: 'strong' | 'buy' | 'watch' | 'skip'; label: string; color: string; bgColor: string; borderColor: string; description: string };
  const betVerdict: BetVerdict = (() => {
    if ((pattern === '一強' || pattern === '二強') && hasRealBets && confidence >= 60) {
      return {
        level: 'strong', label: '強く推奨',
        color: 'text-green-800 dark:text-green-200',
        bgColor: 'bg-green-50 dark:bg-green-900/30',
        borderColor: 'border-green-400 dark:border-green-600',
        description: hasValueBets
          ? `${pattern}パターン・信頼度${confidence}%。期待値プラスの馬券あり。`
          : `${pattern}パターン・信頼度${confidence}%。AI上位が明確。`,
      };
    }
    if (hasRealBets && confidence >= 45 && (pattern === '一強' || pattern === '二強' || pattern === '三つ巴')) {
      return {
        level: 'buy', label: '推奨',
        color: 'text-blue-800 dark:text-blue-200',
        bgColor: 'bg-blue-50 dark:bg-blue-900/30',
        borderColor: 'border-blue-400 dark:border-blue-600',
        description: `${pattern || '—'}パターン・信頼度${confidence}%。検討の価値あり。`,
      };
    }
    if (pattern === '混戦' || !hasRealBets || confidence < 30) {
      return {
        level: 'skip', label: '見送り',
        color: 'text-gray-600 dark:text-gray-400',
        bgColor: 'bg-gray-50 dark:bg-gray-800/50',
        borderColor: 'border-gray-300 dark:border-gray-600',
        description: pattern === '混戦'
          ? '混戦レース。差が小さく的中困難。資金温存推奨。'
          : `信頼度${confidence}%。無理に買わず次のレースを待つ。`,
      };
    }
    return {
      level: 'watch', label: '様子見',
      color: 'text-amber-800 dark:text-amber-200',
      bgColor: 'bg-amber-50 dark:bg-amber-900/30',
      borderColor: 'border-amber-300 dark:border-amber-600',
      description: `${pattern || '—'}パターン・信頼度${confidence}%。オッズ次第で検討。`,
    };
  })();

  const sections = [
    ...(verification ? [{ id: 'verification', label: '答え合わせ' }] : []),
    ...(prediction?.aiRankingBets && prediction.aiRankingBets.bets.length > 0 ? [{ id: 'ai-ranking-bets', label: 'AI買い目' }] : []),
    { id: 'summary', label: 'サマリー' },
    { id: 'picks', label: 'ブレンド予想' },
    { id: 'details', label: '詳細分析' },
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
        <FavoriteProfilePopover checkFavorite={(p) => isRaceFavoriteInProfile(raceId, p)} onToggle={(p) => toggleRaceForProfile(raceId, p)} />
      </div>

      {/* レース情報ヘッダー */}
      <div ref={headerRef} className="bg-gradient-to-r from-primary to-primary-light rounded-xl p-6 text-white">
        <div className="flex flex-wrap items-start gap-3 mb-2">
          <GradeBadge grade={race.grade} />
          <h1 className="text-2xl font-bold">{race.name}</h1>
        </div>
        <p className="text-white/80 text-sm">
          {race.date} | {race.racecourseName} {race.raceNumber}R | {race.trackType}{race.distance}m
          {race.trackCondition && ` | ${race.trackCondition}`}
          {race.time && ` | 発走 ${race.time}`}
        </p>
        <p className="text-white/50 text-xs mt-1">
          予想生成: {new Date(prediction.generatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
          {isValidating ? (
            <span className="ml-3 animate-pulse">更新中...</span>
          ) : lastFetched ? (
            <span className="ml-3">最終取得: {formatLastFetched(lastFetched)}</span>
          ) : null}
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

      {/* 買い判定バナー */}
      <div className={`${betVerdict.bgColor} border-2 ${betVerdict.borderColor} rounded-xl p-4`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-black px-3 py-1 rounded-lg ${
              betVerdict.level === 'strong' ? 'bg-green-500 text-white' :
              betVerdict.level === 'buy' ? 'bg-blue-500 text-white' :
              betVerdict.level === 'watch' ? 'bg-amber-500 text-white' :
              'bg-gray-400 text-white'
            }`}>
              {betVerdict.label}
            </span>
            <div>
              <p className={`text-sm font-medium ${betVerdict.color}`}>{betVerdict.description}</p>
            </div>
          </div>
          {bestValueBet && (betVerdict.level === 'strong' || betVerdict.level === 'buy') && (
            <div className="bg-white/80 dark:bg-black/30 rounded-lg px-4 py-2 text-sm">
              <span className="text-xs text-muted block">ベストベット</span>
              <span className="font-bold">{bestValueBet.bet.type} {bestValueBet.bet.selections.join('-')}</span>
              <span className="ml-2 text-xs">
                {bestValueBet.odds > 0 && <span className="text-muted">{bestValueBet.odds.toFixed(1)}倍</span>}
                <span className="ml-1 font-bold text-green-600 dark:text-green-400">EV {bestValueBet.evScore}</span>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* オッズ反映再生成通知 */}
      {predData?.regeneratedWithOdds && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 rounded-lg px-4 py-3 text-sm text-blue-800 dark:text-blue-200">
          <span className="font-medium">オッズ反映済み</span>
          <span className="text-blue-600 dark:text-blue-400 ml-2">
            最新オッズを反映して予想を再生成しました
          </span>
        </div>
      )}

      {/* 馬場バイアス再生成通知 */}
      {predData?.regeneratedWithBias && (
        <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-300 dark:border-emerald-700 rounded-lg px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
          <span className="font-medium">馬場バイアス反映済み</span>
          <span className="text-emerald-600 dark:text-emerald-400 ml-2">
            本日の完走レース結果から馬場傾向を分析し、予想を更新しました
          </span>
        </div>
      )}

      {/* 馬場バイアス更新可能通知（タイムアウトで再生成スキップ時） */}
      {predData?.biasUpdateAvailable && !predData?.regeneratedWithBias && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded-lg px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex items-center justify-between">
          <div>
            <span className="font-medium">馬場バイアスの更新あり</span>
            <span className="text-amber-600 dark:text-amber-400 ml-2">
              新しい馬場データで予想を更新できます
            </span>
          </div>
          <button
            onClick={async () => {
              setBiasUpdating(true);
              try {
                const res = await fetch(`/api/predictions/${raceId}?biasUpdate=1`);
                const data = await res.json();
                mutate(data, false);
              } catch { /* ignore */ }
              setBiasUpdating(false);
            }}
            disabled={biasUpdating || isValidating}
            className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-500 disabled:opacity-50 transition-colors whitespace-nowrap ml-3"
          >
            {biasUpdating ? '更新中...' : '更新する'}
          </button>
        </div>
      )}

      {/* スティッキーヘッダー（レース情報 + セクションナビ統合） */}
      <div className={`sticky top-16 z-10 -mx-4 px-4 transition-all duration-200 ${
        headerHidden
          ? 'bg-primary/95 backdrop-blur-sm shadow-md'
          : sections.length > 2 ? 'bg-background/95 backdrop-blur-sm border-b border-card-border' : ''
      }`}>
        {/* コンパクトレース情報（メインヘッダーが隠れた時のみ表示） */}
        {headerHidden && (
          <div className="text-white py-2 text-sm flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-bold truncate">{race.racecourseName}{race.raceNumber}R {race.name}</span>
              <span className="text-white/70 whitespace-nowrap">
                {race.trackType}{race.distance}m
                {race.time && ` / ${race.time}`}
              </span>
            </div>
            <span className="text-white/70 text-xs whitespace-nowrap">信頼度 {prediction.confidence}%</span>
          </div>
        )}
        {/* セクションナビ */}
        {sections.length > 2 && (
          <nav className="py-2 overflow-x-auto">
            <div className="flex gap-1 min-w-max">
              {sections.map(s => (
                <button
                  key={s.id}
                  onClick={() => sectionRefs.current[s.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    activeSection === s.id
                      ? headerHidden ? 'bg-white/25 text-white' : 'bg-accent text-white'
                      : headerHidden ? 'text-white/70 hover:bg-white/15' : 'bg-card-bg text-muted hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </nav>
        )}
      </div>

      {/* 答え合わせ (B2) - 結果確定済みの場合 */}
      {verification && (
        <div id="verification" ref={setSectionRefWrapped('verification')} className="bg-card-bg border-2 border-amber-400 dark:border-amber-600 rounded-xl p-6 scroll-mt-32">
          <h2 className="text-lg font-bold mb-4">📋 答え合わせ</h2>

          {/* 的中馬券ハイライトバナー */}
          {verification.betResults.some(b => b.hit) && (
            <div className="bg-gradient-to-r from-green-500 to-emerald-500 dark:from-green-600 dark:to-emerald-600 rounded-xl p-4 mb-4 text-white">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-2xl">🎯</span>
                <div className="flex flex-wrap gap-2">
                  {verification.betResults.filter(b => b.hit).map((bet, i) => (
                    <span key={i} className="px-3 py-1.5 bg-white/20 backdrop-blur rounded-lg text-sm font-bold">
                      {bet.type}的中! {bet.odds > 0 ? `${bet.odds.toFixed(1)}倍` : ''}
                    </span>
                  ))}
                </div>
                {verification.betSummary && verification.betSummary.totalPayout > verification.betSummary.totalInvestment && (
                  <span className="ml-auto text-lg font-bold">
                    +{(verification.betSummary.totalPayout - verification.betSummary.totalInvestment).toLocaleString()}円
                  </span>
                )}
              </div>
            </div>
          )}

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
            {verification.betSummary && verification.betSummary.totalInvestment > 0 && (() => {
              const roi = Math.round(verification.betSummary!.totalPayout / verification.betSummary!.totalInvestment * 100);
              return (
                <span className={`px-4 py-2 rounded-lg text-sm font-bold ${
                  roi >= 100
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                    : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                }`}>
                  ROI: {roi}%
                </span>
              );
            })()}
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
                    <td className="py-2">{pick.horseName}{jockeyMap.get(pick.horseNumber) && <span className="text-muted text-xs ml-1">({jockeyMap.get(pick.horseNumber)})</span>}</td>
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
                      <th className="py-2 text-right">ROI</th>
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
                          bet.payout >= bet.investment ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                        }`}>
                          {bet.investment > 0 ? Math.round(bet.payout / bet.investment * 100) : 0}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {verification.betSummary && verification.betSummary.totalInvestment > 0 && (
                    <tfoot>
                      <tr className="border-t-2 dark:border-gray-600 font-bold">
                        <td colSpan={2} className="py-2">合計</td>
                        <td className="py-2 text-right text-muted text-xs">投資{verification.betSummary.totalInvestment}円</td>
                        <td className="py-2 text-center text-xs">回収{verification.betSummary.totalPayout}円</td>
                        <td className={`py-2 text-right ${
                          verification.betSummary.totalPayout >= verification.betSummary.totalInvestment ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                        }`}>
                          ROI {Math.round(verification.betSummary.totalPayout / verification.betSummary.totalInvestment * 100)}%
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

      {/* AI推奨買い目（最上部に配置） */}
      {prediction.aiRankingBets && prediction.aiRankingBets.bets.length > 0 && (
        <div id="ai-ranking-bets" ref={setSectionRefWrapped('ai-ranking-bets')} className="scroll-mt-32">
          <div className="border-2 border-emerald-400 dark:border-emerald-600 rounded-xl p-6 bg-emerald-50/50 dark:bg-emerald-900/20">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-lg font-bold">AI推奨買い目</h2>
              <span className="text-xs bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200 px-2 py-0.5 rounded font-bold">
                {prediction.aiRankingBets.pattern}
              </span>
            </div>
            <p className="text-xs text-muted mb-4">
              AI独自ランキング（オッズ不使用）の上位から自動生成。{prediction.aiRankingBets.summary}
            </p>
            <div className="space-y-3">
              {prediction.aiRankingBets.bets.map((bet, idx) => {
                const confColor = bet.confidence === 'high'
                  ? 'bg-emerald-600'
                  : bet.confidence === 'medium'
                    ? 'bg-blue-600'
                    : 'bg-gray-500';
                const confLabel = bet.confidence === 'high' ? '本線' : bet.confidence === 'medium' ? '押さえ' : '低信頼';
                return (
                  <div key={idx} className="border rounded-lg p-4 bg-white dark:bg-gray-800">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`${confColor} text-white px-3 py-1 rounded text-sm font-bold`}>
                        {bet.type}
                      </span>
                      <span className="text-xs bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded">
                        {confLabel}
                      </span>
                    </div>
                    {bet.horses.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {bet.horses.map(h => (
                          <span key={h.horseNumber} className="text-lg font-bold">
                            {h.horseNumber} {h.horseName}
                            <span className="text-xs text-muted font-normal ml-1">
                              (AI{h.aiRank}位 {(h.aiProb * 100).toFixed(1)}%)
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-sm text-muted">{bet.reasoning}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* サマリー */}
      <div id="summary" ref={setSectionRefWrapped('summary')} className="bg-card-bg border border-card-border rounded-xl p-6 scroll-mt-32">
        <h2 className="text-lg font-bold mb-3">予想サマリー</h2>
        <div className="whitespace-pre-line text-sm leading-relaxed">{prediction.summary}</div>
      </div>

      {/* 市場オッズとAIのブレンド予想 */}
      <div id="picks" ref={setSectionRefWrapped('picks')} className="scroll-mt-32">
        <h2 className="text-lg font-bold mb-4">市場オッズとAIのブレンド予想</h2>
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
                    {jockeyMap.get(pick.horseNumber) && (
                      <span className="text-sm text-muted font-normal">({jockeyMap.get(pick.horseNumber)})</span>
                    )}
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

      {/* 詳細分析（折りたたみ） */}
      <details id="details" ref={setSectionRefWrapped('details')} className="scroll-mt-32 group">
        <summary className="bg-card-bg border border-card-border rounded-xl p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors list-none">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">詳細分析</h2>
            <span className="text-muted text-sm group-open:rotate-180 transition-transform">&#9660;</span>
          </div>
          <p className="text-xs text-muted mt-1">レース分析・馬券戦略・市場比較・AI独自推奨・推奨馬券・シミュレーション</p>
        </summary>
        <div className="space-y-6 mt-4">

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

      {/* モデル vs 市場オッズ */}
      {prediction.analysis.marketAnalysis && prediction.analysis.valueHorses && prediction.analysis.overround ? (
        <div>
        <ModelVsMarket
          marketAnalysis={prediction.analysis.marketAnalysis}
          valueHorses={prediction.analysis.valueHorses}
          overround={prediction.analysis.overround}
          horseNames={Object.fromEntries(
            prediction.topPicks.map(p => [p.horseNumber, p.horseName])
          )}
        />
        </div>
      ) : race.status !== '結果確定' && (
        <div className="bg-card-bg border border-card-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-2">モデル vs 市場オッズ</h2>
          <p className="text-sm text-muted">
            市場オッズがまだ取得されていません。オッズ取得後にモデル勝率との比較が表示されます。
          </p>
          <Link href={`/races/${race.id}`} className="text-accent hover:underline text-sm mt-2 inline-block">
            出馬表ページでオッズを確認 &rarr;
          </Link>
        </div>
      )}

      {/* AI独自推奨 */}
      {prediction.aiIndependentBets && prediction.aiIndependentBets.length > 0 && (
        <div>
          <div className="border-2 border-cyan-400 dark:border-cyan-600 rounded-xl p-6 bg-cyan-50/50 dark:bg-cyan-900/20">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-lg font-bold">AI独自推奨</h2>
              <span className="text-xs bg-cyan-200 dark:bg-cyan-800 text-cyan-800 dark:text-cyan-200 px-2 py-0.5 rounded font-bold">
                市場非依存
              </span>
            </div>
            <p className="text-xs text-muted mb-4">
              オッズ情報を一切使わないAIモデルが、市場1番人気と異なる馬を1位評価した場合の推奨です。
              5-fold CV検証済（複勝ROI 116%, p&lt;0.0001）
            </p>
            {prediction.aiIndependentBets.map((aiBet, idx) => {
              const aiOdds = aiBet.marketOdds;
              const isSweet = aiOdds >= 5 && aiOdds <= 10;
              return (
                <div key={idx} className="border rounded-lg p-4 bg-white dark:bg-gray-800">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      {aiBet.betTypes.map(bt => (
                        <span key={bt} className="bg-cyan-600 text-white px-3 py-1 rounded text-sm font-bold">
                          {bt}
                        </span>
                      ))}
                      {isSweet && (
                        <span className="text-xs bg-yellow-200 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200 px-2 py-0.5 rounded font-bold">
                          最適ゾーン
                        </span>
                      )}
                      {aiBet.betTypes.length > 1 && (
                        <span className="text-xs bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-300 px-2 py-0.5 rounded">
                          高確信度
                        </span>
                      )}
                    </div>
                    {aiOdds > 0 && (
                      <span className="text-sm text-muted">
                        {aiOdds.toFixed(1)}倍
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-3 mb-2">
                    <p className="text-2xl font-bold">
                      {aiBet.horseNumber} {aiBet.horseName}
                      {jockeyMap.get(aiBet.horseNumber) && (
                        <span className="text-sm text-muted font-normal ml-1">({jockeyMap.get(aiBet.horseNumber)})</span>
                      )}
                    </p>
                    <span className="text-sm text-muted">
                      AI評価 {(aiBet.aiProb * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-xs text-muted mb-2">
                    vs 1番人気: {aiBet.favoriteNumber} {aiBet.favoriteName}
                  </div>
                  <p className="text-sm text-muted">{aiBet.reasoning}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* AI単独予想（No-Oddsモデル全順位） */}
      {prediction.aiOnlyRanking && (
        <div id="ai-only-ranking" ref={setSectionRefWrapped('ai-only-ranking')} className="scroll-mt-32">
          <div className="border rounded-xl p-6 bg-card-bg">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-lg font-bold">AI単独予想</h2>
              <span className="text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded font-bold">
                参考情報
              </span>
            </div>
            <p className="text-xs text-muted mb-4">
              オッズ・人気情報を一切使わないAI単独モデルの順位評価です。
              Top-1的中率: {(prediction.aiOnlyRanking.modelAccuracy * 100).toFixed(1)}%（市場1番人気: 32.7%）。
              市場と大きく異なる評価の馬に注目してください。
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted">
                    <th className="py-2 px-2 text-left">AI順位</th>
                    <th className="py-2 px-2 text-left">馬番</th>
                    <th className="py-2 px-2 text-left">馬名</th>
                    <th className="py-2 px-2 text-right">AI確率</th>
                    <th className="py-2 px-2 text-right">市場順位</th>
                    <th className="py-2 px-2 text-right">差</th>
                  </tr>
                </thead>
                <tbody>
                  {prediction.aiOnlyRanking.entries.map((entry) => {
                    const diff = entry.marketRank != null ? entry.marketRank - entry.rank : null;
                    const isUndervalued = diff != null && diff >= 3;
                    return (
                      <tr
                        key={entry.horseNumber}
                        className={
                          entry.rank <= 3
                            ? 'bg-blue-50/50 dark:bg-blue-900/10 border-b'
                            : isUndervalued
                              ? 'bg-amber-50/50 dark:bg-amber-900/10 border-b'
                              : 'border-b'
                        }
                      >
                        <td className="py-2 px-2 font-bold">{entry.rank}</td>
                        <td className="py-2 px-2">{entry.horseNumber}</td>
                        <td className="py-2 px-2 font-medium">
                          {entry.horseName}
                          {jockeyMap.get(entry.horseNumber) && (
                            <span className="text-muted text-xs ml-1">({jockeyMap.get(entry.horseNumber)})</span>
                          )}
                          {isUndervalued && (
                            <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                              AI注目
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {(entry.aiProb * 100).toFixed(1)}%
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {entry.marketRank != null ? `${entry.marketRank}位` : '---'}
                        </td>
                        <td className={`py-2 px-2 text-right tabular-nums ${
                          diff != null && diff >= 3
                            ? 'text-amber-600 dark:text-amber-400 font-bold'
                            : diff != null && diff <= -3
                              ? 'text-blue-400 dark:text-blue-500'
                              : 'text-muted'
                        }`}>
                          {diff != null
                            ? diff > 0 ? `+${diff}` : diff === 0 ? '-' : `${diff}`
                            : '---'
                          }
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted mt-3">
              差: 正の値 = AIが市場より高評価（市場が過小評価の可能性）。「AI注目」は市場順位より3位以上高評価の馬。
            </p>
          </div>
        </div>
      )}

      {/* 推奨馬券 */}
      {prediction.recommendedBets.length > 0 && (
        <div id="bets" ref={setSectionRefWrapped('bets')} className="scroll-mt-32">
          <h2 className="text-lg font-bold mb-1">推奨馬券</h2>
          <p className="text-xs text-muted mb-4">
            市場オッズとAIモデルのブレンド確率に基づく推奨。的中率算出要素: 過去成績・騎手適性・競馬場相性・脚質相性・安定性・買い方実績
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {prediction.recommendedBets.map((bet, idx) => {
              const isMain = bet.reasoning.startsWith('【主力】');
              const isValue = bet.reasoning.startsWith('【バリュー】');
              // Match with verification betResults if available
              const betResult = verification?.betResults.find(
                br => br.type === bet.type && br.selections.join('-') === bet.selections.join('-')
              );
              // ROI: actual result if available, otherwise expected value based
              const hasActualResult = betResult !== undefined;
              const roi = hasActualResult
                ? (betResult.investment > 0 ? Math.round(betResult.payout / betResult.investment * 100) : 0)
                : Math.round(bet.expectedValue * 100);
              const roiPositive = roi >= 100;
              // 的中率・期待値の算出
              const betStat = betTypeStatsMap.get(bet.type);
              const typeHitRate = betStat?.hitRate || 0;
              // モデル推定と買い方実績をブレンド（モデル70% + 実績30%）
              const hasModelProb = bet.hitProbability != null;
              const betHitProb = hasModelProb ? bet.hitProbability! * 100 : 0;
              const betHitRate = hasModelProb && typeHitRate > 0
                ? betHitProb * 0.7 + typeHitRate * 0.3
                : hasModelProb ? betHitProb : typeHitRate;
              const betOdds = bet.odds || (hasActualResult && betResult.odds > 0 ? betResult.odds : 0);
              // 期待値 = ブレンド的中率 × オッズ（100が損益分岐点）
              const evScore = betOdds > 0 && betHitRate > 0 ? Math.round(betOdds * betHitRate) : 0;
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
                      {bet.isValueBet && (
                        <span className="text-xs bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200 px-2 py-0.5 rounded font-bold animate-pulse">
                          VALUE BET
                        </span>
                      )}
                      {hasActualResult && (
                        betResult.hit ? (
                          <span className="text-xs bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200 px-2 py-0.5 rounded font-bold">
                            的中
                          </span>
                        ) : (
                          <span className="text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded">
                            不的中
                          </span>
                        )
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-sm font-bold ${
                        roiPositive
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}>
                        {hasActualResult ? '' : '予想'}ROI {roi}%
                      </span>
                      {betOdds > 0 && (
                        <span className="text-sm text-muted">
                          {betOdds.toFixed(1)}倍
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xl font-bold">
                      {bet.selections.join(' - ')}
                    </p>
                    <div className="flex items-center gap-3">
                      {hasModelProb ? (() => {
                        const calib = BET_TYPE_CALIBRATION[bet.type] ?? 1.0;
                        const baseProb = calib !== 0 ? (bet.hitProbability! * 100) / calib : betHitProb;
                        return (
                          <span className="text-sm text-muted">
                            的中率 <span className="font-bold text-foreground">{betHitRate.toFixed(1)}%</span>
                            <span className="text-xs ml-1 text-gray-400 dark:text-gray-500">
                              (基礎{baseProb.toFixed(1)}%×補正{calib})
                            </span>
                          </span>
                        );
                      })() : typeHitRate > 0 ? (
                        <span className="text-sm text-muted">
                          的中率 <span className="font-bold text-foreground">{typeHitRate.toFixed(1)}%</span>
                          <span className="text-xs ml-0.5">({betStat?.total || 0}件)</span>
                        </span>
                      ) : null}
                      {evScore > 0 && (
                        <span className={`text-sm font-bold ${
                          evScore >= 100
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}>
                          期待値 {evScore}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-muted">
                    {bet.reasoning.replace(/^【(主力|バリュー|押さえ)】/, '')}
                  </p>
                  {/* 馬力スコア（折りたたみ） */}
                  {bet.horsePower && (
                    <details className="mt-2 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <summary className="flex items-center justify-between px-3 py-2 cursor-pointer bg-gray-50 dark:bg-gray-800/40 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-colors select-none">
                        <span className="text-sm font-bold">
                          馬力スコア {bet.horsePower.total}/100
                        </span>
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${bet.horsePower.total}%`,
                                background: bet.horsePower.total >= 70
                                  ? 'linear-gradient(90deg, #10b981, #059669)'
                                  : bet.horsePower.total >= 45
                                  ? 'linear-gradient(90deg, #f59e0b, #d97706)'
                                  : 'linear-gradient(90deg, #ef4444, #dc2626)',
                              }}
                            />
                          </div>
                          <span className="text-xs text-muted">詳細</span>
                        </div>
                      </summary>
                      <div className="px-3 py-3 text-sm space-y-1.5 bg-white dark:bg-gray-900/30">
                        {/* 馬の実力 */}
                        <div className="flex items-center gap-2">
                          <span className="w-20 text-muted text-xs shrink-0">馬の実力</span>
                          <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-blue-400 to-blue-600"
                              style={{ width: `${(bet.horsePower.horseAbility / 40) * 100}%` }}
                            />
                          </div>
                          <span className="w-12 text-right font-mono text-xs font-bold">{bet.horsePower.horseAbility}/40</span>
                        </div>
                        <div className="pl-[5.5rem] text-xs text-muted">
                          単勝率{(bet.horsePower.horseCatWinRate * 100).toFixed(1)}% 連対率{(bet.horsePower.horseCatPlaceRate * 100).toFixed(1)}%
                        </div>
                        {/* 騎手力 */}
                        <div className="flex items-center gap-2">
                          <span className="w-20 text-muted text-xs shrink-0">騎手力</span>
                          <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-purple-400 to-purple-600"
                              style={{ width: `${(bet.horsePower.jockeyAbility / 25) * 100}%` }}
                            />
                          </div>
                          <span className="w-12 text-right font-mono text-xs font-bold">{bet.horsePower.jockeyAbility}/25</span>
                        </div>
                        <div className="pl-[5.5rem] text-xs text-muted">
                          勝率{(bet.horsePower.jockeyWinRate * 100).toFixed(1)}%
                        </div>
                        {/* 相性 */}
                        <div className="flex items-center gap-2">
                          <span className="w-20 text-muted text-xs shrink-0">相性</span>
                          <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600"
                              style={{ width: `${(bet.horsePower.compatibility / 25) * 100}%` }}
                            />
                          </div>
                          <span className="w-12 text-right font-mono text-xs font-bold">{bet.horsePower.compatibility}/25</span>
                        </div>
                        {/* 安定性 */}
                        <div className="flex items-center gap-2">
                          <span className="w-20 text-muted text-xs shrink-0">安定性</span>
                          <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600"
                              style={{ width: `${(bet.horsePower.stability / 10) * 100}%` }}
                            />
                          </div>
                          <span className="w-12 text-right font-mono text-xs font-bold">{bet.horsePower.stability}/10</span>
                        </div>
                        {/* サンプル警告 */}
                        {bet.horsePower.sampleWarning && (
                          <div className={`mt-1 text-xs flex items-center gap-1 ${
                            bet.horsePower.sampleWarning.level === 'danger'
                              ? 'text-red-500 dark:text-red-400'
                              : 'text-amber-500 dark:text-amber-400'
                          }`}>
                            <span>{bet.horsePower.sampleWarning.level === 'danger' ? '\u26A0' : '\u26A0'}</span>
                            <span>{bet.horsePower.sampleWarning.message}</span>
                          </div>
                        )}
                      </div>
                    </details>
                  )}
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
                      {bet.divergence !== undefined && bet.divergence > 0 && (
                        <span className={`px-2 py-0.5 rounded ${
                          bet.isValueBet
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 font-bold'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                        }`}>
                          乖離 {bet.divergence.toFixed(1)}%
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

      {/* 期待値プラスの馬券ピックアップ */}
      {valueBets.length > 0 && (
        <div id="value-pickup" ref={setSectionRefWrapped('value-pickup')} className="bg-card-bg border-2 border-green-400 dark:border-green-600 rounded-xl p-6 scroll-mt-32">
          <h2 className="text-lg font-bold mb-2">期待値プラスの馬券</h2>
          <p className="text-xs text-muted mb-4">
            市場オッズとAIモデルのブレンド確率から算出。各券種の的中率とオッズの積が100を超える（期待値がプラスになる）馬券をピックアップしています。
          </p>
          <div className="space-y-3">
            {valueBets
              .sort((a, b) => b.evScore - a.evScore)
              .map((v, idx) => (
              <div key={idx} className="bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="bg-green-600 text-white px-3 py-1 rounded text-sm font-bold">
                      {v.bet.type}
                    </span>
                    <span className="text-xl font-bold">{v.bet.selections.join(' - ')}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-green-600 dark:text-green-400">
                      {v.evScore}%
                    </div>
                    <div className="text-xs text-muted">期待値</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 text-sm">
                  <span className="text-muted">
                    オッズ: <span className="font-bold">{v.odds.toFixed(1)}倍</span>
                  </span>
                  <span className="text-muted">
                    {v.bet.type}的中率: <span className="font-bold">{v.hitRate}%</span>
                    <span className="text-xs ml-1">(過去{v.stat?.total || 0}件)</span>
                  </span>
                  {v.bet.expectedValue > 0 && (
                    <span className="text-muted">
                      EV: <span className="font-bold">{v.bet.expectedValue.toFixed(2)}</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* B5: 金額シミュレーション & モンテカルロ */}
      {prediction.recommendedBets.length > 0 && prediction.analysis.bettingStrategy && (
        <div id="simulator" ref={setSectionRefWrapped('simulator')} className="scroll-mt-32 space-y-6">
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

        </div>{/* /details inner space-y-6 */}
      </details>

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
