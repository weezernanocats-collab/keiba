/**
 * 馬券戦略モジュール
 *
 * レースパターン分類・馬券戦略生成・推奨馬券生成・Kelly Criterion ベースの
 * バリューベット判定をまとめたモジュール。
 *
 * prediction-engine.ts から分離。
 */

import type {
  BettingStrategy,
  RacePattern,
  RecommendedBet,
  RaceEntry,
  HorsePowerDisplay,
} from '@/types';

import { estimateWinProbabilities } from './probability-estimation';
import type { HorsePowerScore } from './horse-power';

// ==================== 型定義 ====================

export interface ScoredHorse {
  entry: RaceEntry;
  totalScore: number;
  scores: Record<string, number>;
  reasons: string[];
  runningStyle: string;
  escapeRate: number;
  fatherName: string;
  /** 馬力スコア（第1層） - generatePredictionで算出後に付与 */
  horsePower?: HorsePowerScore;
}

// ==================== 定数 ====================

/** Fractional Kelly: full Kelly を何分割するか */
export const KELLY_FRACTION_DIVISOR = 4;

/** 1ベットあたりの最大賭け割合 */
export const MAX_STAKE_FRACTION = 0.25;

// ==================== レースパターン分類 ====================

/**
 * 上位馬のスコア差からレースの構図を分類する。
 *
 * - 一強: 1位が2位を6pt以上引き離している
 * - 二強: 1-2位が僅差で3位以下と離れている
 * - 三つ巴: 上位3頭が拮抗し4位以下と離れている
 * - 大混戦: 4頭以上が僅差
 * - 混戦: 上記いずれにも該当しない
 */
export function classifyRacePattern(scoredHorses: ScoredHorse[]): {
  pattern: RacePattern;
  gap12: number;
  gap23: number;
  gap34: number;
} {
  if (scoredHorses.length < 2) {
    return { pattern: '混戦', gap12: 0, gap23: 0, gap34: 0 };
  }
  const gap12 = scoredHorses[0].totalScore - scoredHorses[1].totalScore;
  const gap23 = scoredHorses.length > 2
    ? scoredHorses[1].totalScore - scoredHorses[2].totalScore
    : 999;
  const gap34 = scoredHorses.length > 3
    ? scoredHorses[2].totalScore - scoredHorses[3].totalScore
    : 999;

  let pattern: RacePattern;
  if (gap12 >= 6) {
    pattern = '一強';
  } else if (gap12 < 3 && gap23 >= 4) {
    pattern = '二強';
  } else if (gap12 < 4 && gap23 < 4 && gap34 >= 4) {
    pattern = '三つ巴';
  } else if (gap12 < 4 && gap23 < 4 && gap34 < 4) {
    pattern = '大混戦';
  } else {
    pattern = '混戦';
  }

  return { pattern, gap12, gap23, gap34 };
}

// ==================== 馬券戦略生成 ====================

/**
 * レースパターンと信頼度に基づいて馬券の買い方戦略を生成する。
 */
export function generateBettingStrategy(
  scoredHorses: ScoredHorse[],
  confidence: number,
): BettingStrategy {
  const { pattern, gap12 } = classifyRacePattern(scoredHorses);
  const top = scoredHorses[0];
  const second = scoredHorses[1];
  const third = scoredHorses[2];

  switch (pattern) {
    case '一強': {
      const hasValue = top.entry.odds && top.entry.odds >= 2.0;
      return {
        pattern,
        patternLabel: `◎${top.entry.horseName}が抜けた一強レース（スコア差${gap12.toFixed(1)}）`,
        recommendation: hasValue
          ? `${top.entry.horseName}の単勝が中心。2着以下が絞りにくいため、◎頭固定の馬単・三連単で相手を広げるのが有効。`
          : `${top.entry.horseName}は堅いが人気で妙味薄。馬単◎→○▲流しで配当を狙うか、複勝で手堅く。`,
        riskLevel: 'low',
        primaryBets: ['単勝', '馬単', '三連単'],
        avoidBets: ['ワイド'],
        budgetAdvice: '単勝40% + 馬単◎頭固定40% + 三連単◎頭固定20%',
      };
    }
    case '二強':
      return {
        pattern,
        patternLabel: `◎${top.entry.horseName}と○${second.entry.horseName}の二強対決（差${gap12.toFixed(1)}）`,
        recommendation: `上位2頭が拮抗。どちらが来てもカバーできる馬連・ワイドが中心。着順が読めないため馬単は裏表で。3着に穴馬が来る可能性も考慮して三連複を広めに。`,
        riskLevel: 'medium',
        primaryBets: ['馬連', 'ワイド', '三連複'],
        avoidBets: ['三連単'],
        budgetAdvice: '馬連◎○30% + ワイド◎○→▲△30% + 三連複BOX30% + 複勝10%',
      };
    case '三つ巴':
      return {
        pattern,
        patternLabel: `◎○▲の三つ巴（上位3頭が僅差）`,
        recommendation: `上位3頭が拮抗しており着順予想が困難。ワイドBOXで手広くカバーするか、三連複1点に絞って高配当を狙う。単勝・馬単は避けるべき。`,
        riskLevel: 'medium',
        primaryBets: ['ワイド', '三連複', '複勝'],
        avoidBets: ['単勝', '馬単', '三連単'],
        budgetAdvice: 'ワイドBOX◎○▲40% + 三連複◎○▲30% + 複勝◎○30%',
      };
    case '混戦':
      return {
        pattern,
        patternLabel: `混戦模様（上位馬のスコアが接近）`,
        recommendation: `有力馬が多く絞りにくい展開。ワイドBOXか複勝で手堅く回収するのが賢明。大勝負は避け、的中率重視で。`,
        riskLevel: 'high',
        primaryBets: ['複勝', 'ワイド'],
        avoidBets: ['単勝', '馬単', '三連単'],
        budgetAdvice: '複勝◎○50% + ワイド◎→○▲△50%',
      };
    case '大混戦':
      return {
        pattern,
        patternLabel: `大混戦（4頭以上が僅差で予想困難）`,
        recommendation: confidence >= 40
          ? `混戦のため的中難易度が高い。複勝で手堅く拾うか、思い切って穴馬の単勝を少額で狙う。ワイドBOX（4頭）も面白い。`
          : `予想困難なレース。無理に勝負せず見送りも選択肢。買うなら複勝1点か少額ワイドまで。`,
        riskLevel: 'high',
        primaryBets: confidence >= 40 ? ['複勝', 'ワイド'] : ['複勝'],
        avoidBets: ['馬単', '三連単', '三連複'],
        budgetAdvice: confidence >= 40
          ? '複勝◎60% + ワイドBOX40%（少額推奨）'
          : '見送り推奨。買うなら複勝1点のみ（少額）',
      };
  }
}

// ==================== 確率・期待値計算 ====================

/**
 * 期待値 = 推定勝率 x 実オッズ
 * オッズ未取得の場合はスコアベースのフェアオッズを使用。
 */
export function calcExpectedValue(
  horse: ScoredHorse,
  winProbs: Map<ScoredHorse, number>,
): number {
  const prob = winProbs.get(horse) || 0;
  if (prob <= 0) return 0;
  const odds = horse.entry.odds && horse.entry.odds > 0
    ? horse.entry.odds
    : 1 / prob; // オッズ未取得時はフェアオッズ（EV=1.0）
  return Math.round(prob * odds * 100) / 100;
}

/**
 * Kelly Criterion: f* = (b x p - q) / b
 *   b = odds - 1 (ネットオッズ)
 *   p = 推定勝率
 *   q = 1 - p
 *
 * Fractional Kelly (f star / 4) で保守的に運用。
 * 負の値（エッジなし）は 0 にクランプ。
 */
export function calcKellyFraction(prob: number, odds: number): number {
  if (prob <= 0 || odds <= 1) return 0;
  const b = odds - 1;
  const q = 1 - prob;
  const fullKelly = (b * prob - q) / b;
  return Math.max(0, fullKelly);
}

/**
 * バリューエッジ = (推定勝率 x オッズ) - 1
 * 正の値 = 期待値がプラス（市場が過小評価）
 */
export function calcValueEdge(prob: number, odds: number): number {
  if (prob <= 0 || odds <= 0) return -1;
  return prob * odds - 1;
}

/** Fractional Kelly (1/4) + 上限キャップ */
export function calcRecommendedStake(kellyFraction: number): number {
  const fractional = kellyFraction / KELLY_FRACTION_DIVISOR;
  return Math.min(fractional, MAX_STAKE_FRACTION);
}

// ==================== 推奨馬券 ====================

/**
 * レースパターン・信頼度・オッズ・確率情報を元に具体的な馬券推奨を生成する。
 * Kelly Criterion とバリューベット判定を組み込み、各ベットに推奨賭け割合を付与。
 */
export function generateBetRecommendations(
  scoredHorses: ScoredHorse[],
  confidence: number,
  strategy: BettingStrategy,
  oddsMap?: Map<number, number>,
  precomputedProbs?: Map<number, number>,
  trackType?: string,
  distance?: number,
  marketAnalysis?: Record<number, { modelProb: number; marketProb: number; disagreement: number; isValue: boolean }>,
  precomputedPlaceProbs?: Map<number, number>,
): RecommendedBet[] {
  const bets: RecommendedBet[] = [];
  if (scoredHorses.length < 3) return bets;

  // ブレンド確率が渡されていればそちらを使用、なければsoftmaxで算出
  let winProbs: Map<ScoredHorse, number>;
  if (precomputedProbs && precomputedProbs.size > 0) {
    winProbs = new Map<ScoredHorse, number>();
    for (const sh of scoredHorses) {
      const prob = precomputedProbs.get(sh.entry.horseNumber);
      if (prob !== undefined) {
        winProbs.set(sh, prob);
      }
    }
  } else {
    winProbs = estimateWinProbabilities(scoredHorses);
  }
  const top = scoredHorses[0];
  const second = scoredHorses[1];
  const third = scoredHorses[2];
  const fourth = scoredHorses[3];
  const { pattern, gap12, gap23, gap34 } = classifyRacePattern(scoredHorses);

  const evOf = (h: ScoredHorse) => calcExpectedValue(h, winProbs);
  const oddsOf = (h: ScoredHorse) => {
    if (h.entry.odds && h.entry.odds > 0) return h.entry.odds;
    return oddsMap?.get(h.entry.horseNumber) ?? undefined;
  };
  const probOf = (h: ScoredHorse) => winProbs.get(h) || 0;
  const kellyOf = (h: ScoredHorse) => {
    const odds = oddsOf(h);
    if (!odds) return { kelly: 0, edge: -1, stake: 0 };
    const prob = probOf(h);
    const kelly = calcKellyFraction(prob, odds);
    const edge = calcValueEdge(prob, odds);
    const stake = calcRecommendedStake(kelly);
    return { kelly, edge, stake };
  };

  const isPrimary = (type: string) => strategy.primaryBets.includes(type);
  const isAvoided = (type: string) => strategy.avoidBets.includes(type);

  // --- バリューベット判定（バックテスト検証済フィルタ: ROI 243%） ---
  // 条件: (1) ダートスプリント以外 (2) オッズ3-50倍 (3) 乖離度>3%
  const isValueBetCategory = (() => {
    if (!trackType || !distance) return true;
    if (trackType === 'ダート' && distance <= 1400) return false; // ダsprint除外
    if (trackType === '障害') return false;
    return true;
  })();

  const checkValueBet = (h: ScoredHorse): { isValue: boolean; divergence: number } => {
    const odds = oddsOf(h);
    if (!odds || !isValueBetCategory) return { isValue: false, divergence: 0 };
    const inOddsRange = odds >= 3 && odds <= 50;
    const ma = marketAnalysis?.[h.entry.horseNumber];
    const divergence = ma ? ma.disagreement * 100 : 0; // %に変換
    const hasDivergence = divergence > 3;
    return { isValue: inOddsRange && hasDivergence && ma?.isValue === true, divergence };
  };

  // --- 馬力スコア表示用ヘルパー ---
  const getHorsePowerDisplay = (horseNum: number): HorsePowerDisplay | undefined => {
    const sh = scoredHorses.find(h => h.entry.horseNumber === horseNum);
    if (!sh?.horsePower) return undefined;
    const hp = sh.horsePower;
    return {
      total: hp.total,
      horseAbility: hp.horseAbility,
      jockeyAbility: hp.jockeyAbility,
      compatibility: hp.compatibility,
      stability: hp.stability,
      horseCatWinRate: hp.breakdown.horseCategoryWinRate,
      horseCatPlaceRate: hp.breakdown.horseCategoryPlaceRate,
      jockeyWinRate: hp.breakdown.jockeyWinRate,
      sampleWarning: hp.sampleWarning
        ? { level: hp.sampleWarning.level, message: hp.sampleWarning.message }
        : undefined,
    };
  };

  // --- 戦略ベースの馬券推奨 ---

  // --- 馬券ごとの的中確率計算ヘルパー ---

  // MLモデルの placeProb（3着以内確率）を使って精度を上げる
  const placeProbOf = (horseNum: number): number => {
    if (precomputedPlaceProbs && precomputedPlaceProbs.has(horseNum)) {
      return precomputedPlaceProbs.get(horseNum)!;
    }
    const sh = scoredHorses.find(h => h.entry.horseNumber === horseNum);
    const wp = sh ? probOf(sh) : 0;
    return Math.min(0.90, wp * 3 + 0.05);
  };

  // 2着以内確率の近似: 勝率と3着以内確率の中間
  const top2ProbOf = (horseNum: number): number => {
    const sh = scoredHorses.find(h => h.entry.horseNumber === horseNum);
    const wp = sh ? probOf(sh) : 0;
    const pp = placeProbOf(horseNum);
    // 2着以内 ≈ 勝率 + (3着以内率 - 勝率) * 0.6
    return Math.min(0.85, wp + (pp - wp) * 0.6);
  };

  // 脚質相性: 同じ脚質の馬同士は互いに競合して同時上位が難しい
  const runningStyleCompat = (numA: number, numB: number): number => {
    const a = scoredHorses.find(h => h.entry.horseNumber === numA);
    const b = scoredHorses.find(h => h.entry.horseNumber === numB);
    if (!a || !b) return 1.0;
    if (a.runningStyle === b.runningStyle) {
      if (a.runningStyle === '逃げ') return 0.60; // 逃げ同士はハナ争いで共倒れリスク大
      if (a.runningStyle === '先行') return 0.80; // 先行同士もやや競合
      if (a.runningStyle === '差し') return 0.90;
      return 0.90; // 追込同士
    }
    // 逃げ+差し/追込は相性良好（異なるポジションで走る）
    const styles = [a.runningStyle, b.runningStyle].sort();
    if (styles[0] === '逃げ' && (styles[1] === '差し' || styles[1] === '追込')) return 1.10;
    if (styles[0] === '先行' && styles[1] === '追込') return 1.05;
    return 1.0;
  };

  // 安定性の調整: consistency が高い馬ほど期待通りの着順に来やすい
  const consistencyFactor = (horseNum: number): number => {
    const sh = scoredHorses.find(h => h.entry.horseNumber === horseNum);
    if (!sh) return 1.0;
    const cons = sh.scores.consistency ?? 50;
    // consistency 80+ → 1.1倍, 50 → 1.0倍, 20- → 0.85倍
    return 0.85 + (Math.min(cons, 80) / 80) * 0.25;
  };

  const findProb = (horseNumber: number | undefined): number => {
    if (!horseNumber) return 0;
    const found = scoredHorses.find(h => h.entry.horseNumber === horseNumber);
    return found ? probOf(found) : 0;
  };

  // --- 第1層: 馬力スコアから基礎確率を取得 ---
  const getHorsePowerProbs = (horseNum: number) => {
    const sh = scoredHorses.find(h => h.entry.horseNumber === horseNum);
    if (sh?.horsePower) {
      return {
        win: sh.horsePower.estimatedWinProb,
        place: sh.horsePower.estimatedPlaceRate,
        show: sh.horsePower.estimatedShowRate,
      };
    }
    // fallback: 従来のsoftmax確率
    const wp = findProb(horseNum);
    return {
      win: wp,
      place: Math.min(0.85, wp + (placeProbOf(horseNum) - wp) * 0.6),
      show: placeProbOf(horseNum),
    };
  };

  // --- 第2層: 買い方補正係数（実績データから算出した固定値） ---
  // 検証結果: 予測hitProb vs 実的中率の比率
  const BET_TYPE_CALIBRATION: Record<string, number> = {
    '単勝': 1.0,    // 第1層の推定確率をそのまま使用
    '複勝': 1.0,    // 第1層の推定確率をそのまま使用
    '馬連': 0.75,   // 実績: 予測の75%程度が的中
    'ワイド': 0.66,  // 実績: 予測の66%程度
    '馬単': 0.69,   // 着順指定の困難さを反映
    '三連複': 0.52, // 実績: 予測の52%程度
    '三連単': 3.4,  // 現状過小評価のため上方修正
  };

  const calcBetHitProb = (type: string, selections: number[]): number => {
    const hp0 = getHorsePowerProbs(selections[0]);
    const hp1 = selections[1] ? getHorsePowerProbs(selections[1]) : null;
    const hp2 = selections[2] ? getHorsePowerProbs(selections[2]) : null;
    const calibration = BET_TYPE_CALIBRATION[type] ?? 1.0;

    switch (type) {
      case '単勝':
        // 第1層: 馬力ベースの勝率推定
        return hp0.win * calibration;
      case '複勝':
        // 第1層: 馬力ベースの複勝率推定
        return Math.min(0.95, hp0.show * calibration);
      case '馬連': {
        // 2頭の2着以内確率 × 脚質相性 × 補正
        const compat = runningStyleCompat(selections[0], selections[1]);
        const raw = hp0.place * (hp1?.place ?? 0) * compat;
        return Math.min(0.50, raw * calibration);
      }
      case 'ワイド': {
        // 2頭の3着以内確率 × 脚質相性 × 補正
        const compat = runningStyleCompat(selections[0], selections[1]);
        const raw = hp0.show * (hp1?.show ?? 0) * compat;
        return Math.min(0.60, raw * calibration);
      }
      case '馬単': {
        // A勝利 × Bの2着以内 × 脚質相性 × 補正
        const compat = runningStyleCompat(selections[0], selections[1]);
        const pB2ndGivenAWins = Math.min(0.80, (hp1?.place ?? 0) * 1.2);
        const raw = hp0.win * pB2ndGivenAWins * compat;
        return Math.min(0.30, raw * calibration);
      }
      case '三連複': {
        // 3頭の3着以内確率 × 脚質相性 × 補正
        const compat01 = runningStyleCompat(selections[0], selections[1]);
        const compat02 = runningStyleCompat(selections[0], selections[2]);
        const compat12 = runningStyleCompat(selections[1], selections[2]);
        const avgCompat = (compat01 + compat02 + compat12) / 3;
        const raw = hp0.show * (hp1?.show ?? 0) * (hp2?.show ?? 0) * avgCompat;
        return Math.min(0.30, raw * calibration);
      }
      case '三連単': {
        // 3頭の勝率積 × 脚質相性 × 補正
        const compat01 = runningStyleCompat(selections[0], selections[1]);
        const compat02 = runningStyleCompat(selections[0], selections[2]);
        const avgCompat = (compat01 + compat02) / 2;
        const raw = hp0.win * (hp1?.win ?? 0) * (hp2?.win ?? 0) * avgCompat;
        return Math.min(0.10, raw * calibration);
      }
      default:
        return 0;
    }
  };

  // 単勝: 一強パターンまたは高信頼度時
  if (!isAvoided('単勝') && (pattern === '一強' || (gap12 > 5 && confidence >= 50))) {
    const ev = evOf(top);
    const isMain = isPrimary('単勝');
    const kv = kellyOf(top);
    const vb = checkValueBet(top);
    const hitProb = calcBetHitProb('単勝', [top.entry.horseNumber]);
    bets.push({
      type: '単勝',
      selections: [top.entry.horseNumber],
      reasoning: isMain
        ? `【主力】${top.entry.horseName}が総合力で抜けている。${top.reasons[0] || ''}${ev >= 1.0 ? ` 期待値${ev.toFixed(2)}。` : ''}${vb.isValue ? ` 🎯バリューベット(乖離${vb.divergence.toFixed(1)}%)` : ''}`
        : `${top.entry.horseName}の勝利を狙う。ただし${pattern}のため控えめに。`,
      expectedValue: ev,
      odds: oddsOf(top),
      kellyFraction: kv.kelly,
      valueEdge: kv.edge,
      recommendedStake: kv.stake,
      isValueBet: vb.isValue,
      divergence: vb.divergence,
      hitProbability: hitProb,
      horsePower: getHorsePowerDisplay(top.entry.horseNumber),
    });
  }

  // 複勝: ほぼ常に推奨（安定枠）
  if (!isAvoided('複勝')) {
    const isMain = isPrimary('複勝');
    const placeOdds = oddsOf(top) ? Math.max(1.1, oddsOf(top)! * 0.35) : undefined;
    // 複勝のKelly: 3着内確率 ≈ 上位3頭の勝率合計で按分
    const topPlaceProb = Math.min(0.9, probOf(top) * 3 + 0.1);
    const placeKelly = placeOdds ? calcKellyFraction(topPlaceProb, placeOdds) : 0;
    const placeEdge = placeOdds ? calcValueEdge(topPlaceProb, placeOdds) : -1;
    bets.push({
      type: '複勝',
      selections: [top.entry.horseNumber],
      reasoning: isMain
        ? `【主力】${top.entry.horseName}の3着以内で手堅く回収。${pattern === '混戦' || pattern === '大混戦' ? '混戦のため複勝が最も安全。' : ''}${top.scores.consistency >= 70 ? '着順安定型。' : ''}`
        : `${top.entry.horseName}の3着以内は堅い。安定感重視。`,
      expectedValue: evOf(top) * 0.7,
      odds: placeOdds,
      kellyFraction: placeKelly,
      valueEdge: placeEdge,
      recommendedStake: calcRecommendedStake(placeKelly),
      hitProbability: calcBetHitProb('複勝', [top.entry.horseNumber]),
      horsePower: getHorsePowerDisplay(top.entry.horseNumber),
    });
    // 混戦時は○も複勝推奨
    if ((pattern === '混戦' || pattern === '大混戦' || pattern === '二強') && isMain) {
      const secPlaceOdds = oddsOf(second) ? Math.max(1.1, oddsOf(second)! * 0.35) : undefined;
      const secPlaceProb = Math.min(0.9, probOf(second) * 3 + 0.1);
      const secKelly = secPlaceOdds ? calcKellyFraction(secPlaceProb, secPlaceOdds) : 0;
      const secEdge = secPlaceOdds ? calcValueEdge(secPlaceProb, secPlaceOdds) : -1;
      bets.push({
        type: '複勝',
        selections: [second.entry.horseNumber],
        reasoning: `【押さえ】${second.entry.horseName}も3着以内有力。◎と迷う実力。`,
        expectedValue: evOf(second) * 0.7,
        odds: secPlaceOdds,
        kellyFraction: secKelly,
        valueEdge: secEdge,
        recommendedStake: calcRecommendedStake(secKelly),
        hitProbability: calcBetHitProb('複勝', [second.entry.horseNumber]),
        horsePower: getHorsePowerDisplay(second.entry.horseNumber),
      });
    }
  }

  // 馬連: 二強パターンやスコアが近い上位2頭
  if (!isAvoided('馬連')) {
    const isMain = isPrimary('馬連');
    const umarenOdds = (oddsOf(top) && oddsOf(second)) ? oddsOf(top)! * oddsOf(second)! * 0.5 : undefined;
    // 馬連確率 ≈ 上位2頭が1-2着に入る確率
    const umarenProb = probOf(top) * probOf(second) * 2;
    const umarenKelly = umarenOdds ? calcKellyFraction(umarenProb, umarenOdds) : 0;
    const umarenEdge = umarenOdds ? calcValueEdge(umarenProb, umarenOdds) : -1;
    bets.push({
      type: '馬連',
      selections: [top.entry.horseNumber, second.entry.horseNumber],
      reasoning: isMain
        ? `【主力】${top.entry.horseName}と${second.entry.horseName}の組み合わせ。${pattern === '二強' ? '二強対決の本線。' : ''}${second.reasons[0] || ''}`
        : `上位2頭の組み合わせ。${second.reasons[0] || ''}`,
      expectedValue: (evOf(top) + evOf(second)) / 2,
      odds: umarenOdds,
      kellyFraction: umarenKelly,
      valueEdge: umarenEdge,
      recommendedStake: calcRecommendedStake(umarenKelly),
      hitProbability: calcBetHitProb('馬連', [top.entry.horseNumber, second.entry.horseNumber]),
      horsePower: getHorsePowerDisplay(top.entry.horseNumber),
    });
  }

  // ワイド: 三つ巴・混戦で特に有効
  if (!isAvoided('ワイド')) {
    const isMain = isPrimary('ワイド');
    if (isMain && (pattern === '三つ巴' || pattern === '混戦' || pattern === '大混戦')) {
      const boxHorses = pattern === '大混戦' && fourth
        ? [top, second, third, fourth]
        : [top, second, third];
      const pairs: [ScoredHorse, ScoredHorse][] = [];
      for (let i = 0; i < boxHorses.length; i++) {
        for (let j = i + 1; j < boxHorses.length; j++) {
          pairs.push([boxHorses[i], boxHorses[j]]);
        }
      }
      for (const [a, b] of pairs) {
        const wideOdds = (oddsOf(a) && oddsOf(b)) ? oddsOf(a)! * oddsOf(b)! * 0.25 : undefined;
        const wideProb = (probOf(a) + probOf(b)) * 0.5;
        bets.push({
          type: 'ワイド',
          selections: [a.entry.horseNumber, b.entry.horseNumber],
          reasoning: `【主力】ワイドBOXの一角。${a.entry.horseName}-${b.entry.horseName}。${pattern}のため着順不問で広く拾う。`,
          expectedValue: (evOf(a) + evOf(b)) / 2,
          odds: wideOdds,
          kellyFraction: wideOdds ? calcKellyFraction(wideProb, wideOdds) : 0,
          valueEdge: wideOdds ? calcValueEdge(wideProb, wideOdds) : -1,
          recommendedStake: wideOdds ? calcRecommendedStake(calcKellyFraction(wideProb, wideOdds)) : 0,
          hitProbability: calcBetHitProb('ワイド', [a.entry.horseNumber, b.entry.horseNumber]),
          horsePower: getHorsePowerDisplay(a.entry.horseNumber),
        });
      }
    } else if (!isAvoided('ワイド') && third.totalScore > 40) {
      const wideOdds = (oddsOf(top) && oddsOf(third)) ? oddsOf(top)! * oddsOf(third)! * 0.25 : undefined;
      const wideProb = (probOf(top) + probOf(third)) * 0.5;
      bets.push({
        type: 'ワイド',
        selections: [top.entry.horseNumber, third.entry.horseNumber],
        reasoning: `${top.entry.horseName}軸で${third.entry.horseName}へ。${third.reasons[0] || '好走条件が揃っている'}`,
        expectedValue: (evOf(top) + evOf(third)) / 2,
        odds: wideOdds,
        kellyFraction: wideOdds ? calcKellyFraction(wideProb, wideOdds) : 0,
        valueEdge: wideOdds ? calcValueEdge(wideProb, wideOdds) : -1,
        recommendedStake: wideOdds ? calcRecommendedStake(calcKellyFraction(wideProb, wideOdds)) : 0,
        hitProbability: calcBetHitProb('ワイド', [top.entry.horseNumber, third.entry.horseNumber]),
        horsePower: getHorsePowerDisplay(top.entry.horseNumber),
      });
    }
  }

  // 馬単: 一強パターンで◎頭固定
  if (!isAvoided('馬単') && gap12 > 5 && confidence >= 50) {
    const isMain = isPrimary('馬単');
    const umatanOdds = (oddsOf(top) && oddsOf(second)) ? oddsOf(top)! * oddsOf(second)! * 0.9 : undefined;
    const umatanProb = probOf(top) * probOf(second);
    const umatanKelly = umatanOdds ? calcKellyFraction(umatanProb, umatanOdds) : 0;
    bets.push({
      type: '馬単',
      selections: [top.entry.horseNumber, second.entry.horseNumber],
      reasoning: isMain
        ? `【主力】${top.entry.horseName}頭固定。2着${second.entry.horseName}。${gap12 > 8 ? '1着は堅い。' : ''}`
        : `${top.entry.horseName}が頭鉄板。2着に${second.entry.horseName}。`,
      expectedValue: evOf(top) * 1.5,
      odds: umatanOdds,
      kellyFraction: umatanKelly,
      valueEdge: umatanOdds ? calcValueEdge(umatanProb, umatanOdds) : -1,
      recommendedStake: calcRecommendedStake(umatanKelly),
      hitProbability: calcBetHitProb('馬単', [top.entry.horseNumber, second.entry.horseNumber]),
      horsePower: getHorsePowerDisplay(top.entry.horseNumber),
    });
    if (isMain && third.totalScore > 40) {
      const umatanOdds2 = (oddsOf(top) && oddsOf(third)) ? oddsOf(top)! * oddsOf(third)! * 0.9 : undefined;
      const umatanProb2 = probOf(top) * probOf(third);
      const umatanKelly2 = umatanOdds2 ? calcKellyFraction(umatanProb2, umatanOdds2) : 0;
      bets.push({
        type: '馬単',
        selections: [top.entry.horseNumber, third.entry.horseNumber],
        reasoning: `${top.entry.horseName}頭固定→${third.entry.horseName}。穴目の組み合わせ。`,
        expectedValue: evOf(top) * 1.3,
        odds: umatanOdds2,
        kellyFraction: umatanKelly2,
        valueEdge: umatanOdds2 ? calcValueEdge(umatanProb2, umatanOdds2) : -1,
        recommendedStake: calcRecommendedStake(umatanKelly2),
        hitProbability: calcBetHitProb('馬単', [top.entry.horseNumber, third.entry.horseNumber]),
        horsePower: getHorsePowerDisplay(top.entry.horseNumber),
      });
    }
  }

  // 三連複: 上位が明確に抜けている場合
  if (!isAvoided('三連複') && fourth && gap34 > 1.5) {
    const isMain = isPrimary('三連複');
    const sanrenpukuOdds = (oddsOf(top) && oddsOf(second) && oddsOf(third)) ? oddsOf(top)! * oddsOf(second)! * oddsOf(third)! * 0.3 : undefined;
    const sanrenpukuProb = probOf(top) * probOf(second) * probOf(third) * 6;
    const sanrenpukuKelly = sanrenpukuOdds ? calcKellyFraction(sanrenpukuProb, sanrenpukuOdds) : 0;
    bets.push({
      type: '三連複',
      selections: [top.entry.horseNumber, second.entry.horseNumber, third.entry.horseNumber],
      reasoning: isMain
        ? `【主力】上位3頭のBOX。${confidence >= 60 ? '信頼度高め。' : ''}${pattern === '三つ巴' ? '3頭の着順は不問で取れる。' : ''}`
        : `上位3頭で堅く決まる想定。${confidence >= 60 ? '信頼度高め。' : '波乱の余地あり、抑え程度に。'}`,
      expectedValue: (evOf(top) + evOf(second) + evOf(third)) / 3,
      odds: sanrenpukuOdds,
      kellyFraction: sanrenpukuKelly,
      valueEdge: sanrenpukuOdds ? calcValueEdge(sanrenpukuProb, sanrenpukuOdds) : -1,
      recommendedStake: calcRecommendedStake(sanrenpukuKelly),
      hitProbability: calcBetHitProb('三連複', [top.entry.horseNumber, second.entry.horseNumber, third.entry.horseNumber]),
      horsePower: getHorsePowerDisplay(top.entry.horseNumber),
    });
  }

  // 三連単: 一強パターンかつ高信頼度
  if (!isAvoided('三連単') && gap12 > 6 && confidence >= 60 && fourth && gap34 > 2) {
    const sanrentanOdds = (oddsOf(top) && oddsOf(second) && oddsOf(third)) ? oddsOf(top)! * oddsOf(second)! * oddsOf(third)! * 0.6 : undefined;
    const sanrentanProb = probOf(top) * probOf(second) * probOf(third);
    const sanrentanKelly = sanrentanOdds ? calcKellyFraction(sanrentanProb, sanrentanOdds) : 0;
    bets.push({
      type: '三連単',
      selections: [top.entry.horseNumber, second.entry.horseNumber, third.entry.horseNumber],
      reasoning: `高配当狙い。${top.entry.horseName}→${second.entry.horseName}→${third.entry.horseName}の順。`,
      expectedValue: (evOf(top) + evOf(second) + evOf(third)) / 3 * 2,
      odds: sanrentanOdds,
      kellyFraction: sanrentanKelly,
      valueEdge: sanrentanOdds ? calcValueEdge(sanrentanProb, sanrentanOdds) : -1,
      recommendedStake: calcRecommendedStake(sanrentanKelly),
      hitProbability: calcBetHitProb('三連単', [top.entry.horseNumber, second.entry.horseNumber, third.entry.horseNumber]),
      horsePower: getHorsePowerDisplay(top.entry.horseNumber),
    });
  }

  // --- バリューベット検出（Kelly Criterion ベース） ---
  // valueEdge > 0.10 (期待値10%+) かつ Kelly > 0.02 のみ推奨
  const VALUE_EDGE_THRESHOLD = 0.10;
  const MIN_KELLY_THRESHOLD = 0.02;
  for (const horse of scoredHorses) {
    if (!horse.entry.odds || horse.entry.odds <= 0) continue;
    const rank = scoredHorses.indexOf(horse) + 1;
    if (rank <= 3) continue;

    const prob = probOf(horse);
    const odds = horse.entry.odds;
    const edge = calcValueEdge(prob, odds);
    const kelly = calcKellyFraction(prob, odds);

    if (edge < VALUE_EDGE_THRESHOLD || kelly < MIN_KELLY_THRESHOLD) continue;

    const stake = calcRecommendedStake(kelly);
    bets.push({
      type: '単勝',
      selections: [horse.entry.horseNumber],
      reasoning: `【バリュー】${horse.entry.horseName}（${rank}位）。推定勝率${(prob * 100).toFixed(1)}%に対しオッズ${odds.toFixed(1)}倍は過小評価。エッジ+${(edge * 100).toFixed(0)}% Kelly${(kelly * 100).toFixed(1)}%。`,
      expectedValue: evOf(horse),
      odds: oddsOf(horse),
      kellyFraction: kelly,
      valueEdge: edge,
      recommendedStake: stake,
      hitProbability: prob,
    });
  }

  // 主力ベットを先頭、その後EVが高い順
  bets.sort((a, b) => {
    const aMain = a.reasoning.startsWith('【主力】') ? 1 : 0;
    const bMain = b.reasoning.startsWith('【主力】') ? 1 : 0;
    if (aMain !== bMain) return bMain - aMain;
    return b.expectedValue - a.expectedValue;
  });

  return bets;
}
