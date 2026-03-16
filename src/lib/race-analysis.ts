/**
 * レース分析モジュール
 *
 * レース全体の分析（トラックバイアス、ペース、キー/リスク要因）、
 * コース特性の取得、信頼度スコアの計算を行う。
 *
 * prediction-engine.ts から分離。
 */

import type { RaceAnalysis, TrackType, TrackCondition } from '@/types';
import type { RaceHistoricalContext } from './historical-analyzer';
import type { TodayTrackBias } from './track-bias';
import { generatePaceAnalysisText } from './pace-analyzer';
import type { ScoredHorse } from './betting-strategy';

// ==================== レース分析 ====================

/**
 * レース全体の分析を行い、トラックバイアス・ペース予想・キーファクター・リスク要因を返す
 */
export function analyzeRace(
  scoredHorses: ScoredHorse[],
  trackType: TrackType,
  distance: number,
  condition: TrackCondition,
  racecourseName: string,
  ctx: RaceHistoricalContext,
  todayBias?: TodayTrackBias | null,
): RaceAnalysis {
  let trackBias = `${racecourseName}${trackType}${distance}m`;

  const courseInfo = getCourseCharacteristics(racecourseName, trackType, distance);
  if (condition === '重' || condition === '不良') {
    trackBias += `（${condition}馬場）- ${courseInfo}。道悪で内枠有利の傾向が強まる可能性あり。パワー型の馬に注目。`;
  } else if (condition === '稍重') {
    trackBias += `（${condition}馬場）- ${courseInfo}。やや時計がかかる馬場。`;
  } else {
    trackBias += `（${condition}馬場）- ${courseInfo}。`;
  }

  // 統計情報を分析に追加
  if (ctx.courseDistStats && ctx.courseDistStats.totalRaces >= 20) {
    const stats = ctx.courseDistStats;
    if (stats.frontRunnerRate >= 0.6) {
      trackBias += ` 過去データでは先行馬の勝率が高い（${Math.round(stats.frontRunnerRate * 100)}%）。`;
    } else if (stats.frontRunnerRate <= 0.3) {
      trackBias += ` 過去データでは差し・追込が決まりやすいコース。`;
    }

    if (Math.abs(stats.innerFrameWinRate - stats.outerFrameWinRate) > 0.03) {
      const biasDir = stats.innerFrameWinRate > stats.outerFrameWinRate ? '内枠' : '外枠';
      trackBias += ` 統計上は${biasDir}有利。`;
    }
  }

  // 当日バイアス（リアルタイム分析結果）
  if (todayBias) {
    trackBias += ` 【当日実績(${todayBias.sampleRaces}R分析)】${todayBias.summary}。`;
  }

  // ペース分析
  const escapers = scoredHorses.filter(h => h.runningStyle === '逃げ');
  const frontRunners = scoredHorses.filter(h => h.runningStyle === '先行');
  const stalkers = scoredHorses.filter(h => h.runningStyle === '差し');
  const closers = scoredHorses.filter(h => h.runningStyle === '追込');
  const forwardTotal = escapers.length + frontRunners.length;

  let paceAnalysis: string;
  if (forwardTotal >= Math.ceil(scoredHorses.length * 0.5)) {
    paceAnalysis = `ハイペース予想。逃げ${escapers.length}頭・先行${frontRunners.length}頭と前に行く馬が多い。前が厳しい展開で、差し・追込馬（${stalkers.length + closers.length}頭）に展開利。後方から一気の末脚を使える馬が有利。`;
  } else if (forwardTotal <= Math.floor(scoredHorses.length * 0.25)) {
    paceAnalysis = `スローペース予想。逃げ${escapers.length}頭・先行${frontRunners.length}頭と先行勢が少ない。${escapers.length <= 1 ? '逃げ馬が楽にハナを切れそうで、前残りに警戒。' : ''}上がり勝負になりやすく、瞬発力のある馬が有利。`;
  } else {
    paceAnalysis = `ミドルペース予想。脚質分布は逃げ${escapers.length}/先行${frontRunners.length}/差し${stalkers.length}/追込${closers.length}とバランスが取れている。実力通りの決着が見込まれる。`;
  }

  // ペースプロファイル補足
  const profileText = generatePaceAnalysisText(scoredHorses, ctx.paceProfile);
  if (profileText) {
    paceAnalysis += ` ${profileText}`;
  }

  // キーファクター
  const keyFactors: string[] = [];
  if (distance >= 2400) keyFactors.push('長距離戦。スタミナと折り合いが鍵。父母の血統的な裏付けも重要');
  else if (distance >= 1800) keyFactors.push('中距離戦。総合力が問われる距離帯');
  else if (distance <= 1200) keyFactors.push('スプリント戦。ゲートの出と前半3Fのスピードが勝敗を左右');
  else if (distance <= 1400) keyFactors.push('短距離戦。先行力とスピードの持続力がカギ');

  if (condition === '重' || condition === '不良') keyFactors.push('道悪適性が勝敗を分ける。パワー型が台頭しやすい');

  // 血統傾向
  const sireAnalysis: string[] = [];
  for (const [sire, stats] of ctx.sireStatsMap.entries()) {
    if (stats.totalRaces >= 10) {
      const trackStats = trackType === '芝' ? stats.turfStats : stats.dirtStats;
      if (trackStats.winRate >= 0.20) {
        const horses = scoredHorses.filter(h => h.fatherName === sire);
        if (horses.length > 0) {
          sireAnalysis.push(`${sire}産駒（${horses.map(h => h.entry.horseName).join('、')}）はこの条件で好成績`);
        }
      }
    }
  }
  if (sireAnalysis.length > 0) keyFactors.push(`【血統注目】${sireAnalysis.join('。')}`);

  const fastFinishers = scoredHorses.filter(h => h.scores.lastThreeFurlongs >= 70);
  if (fastFinishers.length > 0) {
    keyFactors.push(`上がり3F上位: ${fastFinishers.slice(0, 3).map(h => h.entry.horseName).join('、')}`);
  }

  if (scoredHorses.length >= 2) {
    const gap = scoredHorses[0].totalScore - scoredHorses[1].totalScore;
    keyFactors.push(`1位と2位のスコア差: ${Math.round(gap * 10) / 10}pt`);
  }

  // リスク要因
  const riskFactors: string[] = [];
  if (scoredHorses.length >= 2 && scoredHorses[0].totalScore - scoredHorses[1].totalScore < 3) {
    riskFactors.push('上位馬の差が極めて小さく、波乱含み');
  } else if (scoredHorses.length >= 2 && scoredHorses[0].totalScore - scoredHorses[1].totalScore < 5) {
    riskFactors.push('上位馬の差が小さく、波乱の可能性あり');
  }

  if (scoredHorses.some(sh => sh.entry.odds && sh.entry.odds <= 1.5)) {
    riskFactors.push('断然の1番人気がいるが、過信は禁物');
  }

  const longAbsence = scoredHorses.filter(h => h.scores.rotation <= 35);
  if (longAbsence.length > 0) {
    riskFactors.push(`休養明けの馬あり: ${longAbsence.map(h => h.entry.horseName).join('、')} - 仕上がり次第`);
  }

  const inconsistent = scoredHorses.slice(0, 3).filter(h => h.scores.consistency <= 40);
  if (inconsistent.length > 0) {
    riskFactors.push(`上位予想馬にムラ馬あり: ${inconsistent.map(h => h.entry.horseName).join('、')}`);
  }

  return { trackBias, paceAnalysis, keyFactors, riskFactors };
}

// ==================== コース特性 ====================

/**
 * 競馬場ごとのコース特性テキストを返す
 */
export function getCourseCharacteristics(course: string, trackType: TrackType, distance: number): string {
  const info: Record<string, Record<string, string>> = {
    '東京': {
      '芝': '直線が長く（525m）、末脚が活きるコース。瞬発力勝負になりやすい',
      'ダート': '直線が長くスピードの持続力が問われる。差し馬も届きやすい',
    },
    '中山': {
      '芝': '直線が短く（310m）小回り急坂。先行力と坂を上るパワーが重要',
      'ダート': '小回りで先行有利。内枠の逃げ・先行馬に注意',
    },
    '阪神': {
      '芝': `${distance >= 1800 ? '外回り' : '内回り'}。急坂があり、パワーとスタミナの両立が求められる`,
      'ダート': 'コーナーがきつめで、器用さが求められる。先行有利の傾向',
    },
    '京都': {
      '芝': `${distance >= 1800 ? '外回り' : '内回り'}。平坦でスピードが活きる。瞬発力のある差し馬に注意`,
      'ダート': '平坦コースでスピード持続力が問われる',
    },
    '大井': { 'ダート': '大箱コースでスピード持続力が問われる。外回りは差しも決まる' },
    '川崎': { 'ダート': '小回りで先行有利。内枠の逃げ馬が残りやすい' },
    '船橋': { 'ダート': '直線が短く小回り。先行力が重要' },
    '浦和': { 'ダート': '最も小回りのコース。圧倒的に先行有利' },
  };

  return info[course]?.[trackType] || '標準的なコース形態';
}

// ==================== 信頼度 ====================

/**
 * 予測の信頼度スコア (10-92) を計算する
 * - 予測の分離度 (最大40pt)
 * - データ充実度 (最大35pt)
 * - 統計データの充実度 (最大15pt)
 */
export function calculateConfidence(scoredHorses: ScoredHorse[], ctx: RaceHistoricalContext): number {
  if (scoredHorses.length < 3) return 15;

  const gap1_2 = scoredHorses[0].totalScore - scoredHorses[1].totalScore;
  const gap1_3 = scoredHorses[0].totalScore - scoredHorses[2].totalScore;

  // === 予測の分離度 (最大40pt) ===
  let separation = 0;
  if (gap1_2 > 10) separation += 20;
  else if (gap1_2 > 7) separation += 15;
  else if (gap1_2 > 4) separation += 8;
  else separation -= 5;

  if (gap1_3 > 15) separation += 15;
  else if (gap1_3 > 10) separation += 10;
  else if (gap1_3 > 6) separation += 5;

  if (scoredHorses[0].scores.consistency >= 70) separation += 5;

  // === データ充実度 (最大35pt) ===
  // 全馬平均のデータ信頼度
  const avgDataReliability = scoredHorses.reduce((sum, sh) =>
    sum + (sh.scores._dataReliability || 0), 0
  ) / scoredHorses.length;

  // 平均データ点数
  const avgDataPoints = scoredHorses.reduce((sum, sh) =>
    sum + (sh.scores._totalDataPoints || 0), 0
  ) / scoredHorses.length;

  let dataScore = 0;
  // データ信頼度 (0-100) → 最大20pt
  dataScore += Math.min(20, avgDataReliability * 0.25);

  // 平均データ点数 → 最大15pt
  if (avgDataPoints >= 50) dataScore += 15;
  else if (avgDataPoints >= 30) dataScore += 12;
  else if (avgDataPoints >= 15) dataScore += 8;
  else if (avgDataPoints >= 5) dataScore += 4;
  else dataScore -= 5; // データ不足でペナルティ

  // === 統計データの充実度 (最大15pt) ===
  let statScore = 0;
  if (ctx.courseDistStats && ctx.courseDistStats.totalRaces >= 30) statScore += 5;
  else if (ctx.courseDistStats && ctx.courseDistStats.totalRaces >= 10) statScore += 2;
  if (ctx.sireStatsMap.size >= 5) statScore += 4;
  else if (ctx.sireStatsMap.size >= 2) statScore += 2;
  if (ctx.jockeyTrainerMap.size >= 3) statScore += 3;
  if (ctx.seasonalMap.size >= 3) statScore += 3;

  const confidence = 20 + separation + dataScore + statScore;
  return Math.min(92, Math.max(10, Math.round(confidence)));
}
