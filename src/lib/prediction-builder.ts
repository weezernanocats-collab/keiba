/**
 * 予測生成ビルダー
 *
 * HorseAnalysisInput の構築 → generatePrediction 呼び出しを共通化。
 * scheduler.ts, bulk-importer.ts, sync/route.ts, predictions/[raceId]/route.ts
 * で重複していたデータ取得 + 予測生成ロジックを一元管理する。
 *
 * N+1 最適化: 全馬分のデータをバッチクエリで一括取得（~7クエリ/レース）
 */

import type { Prediction, RaceEntry, TrackType, TrackCondition } from '@/types';
import { generatePrediction, type HorseAnalysisInput } from './prediction-engine';
import {
  getHorsePastPerformancesBatch,
  getHorsesByIds,
  getJockeyStatsBatch,
  getTrainerStatsBatch,
  getSireTrackWinRateBatch,
  getJockeyDistanceWinRateBatch,
  getJockeyCourseWinRateBatch,
} from './queries';
import { evaluateShosanTheory, type HorseEntry as ShosanHorseEntry, type PastPerf as ShosanPastPerf } from './shoshan-theory';
import { calcEarlySpeedProfile, calcFirstCornerScore, type EarlySpeedProfile } from './time-features';
import { dbAll } from './database';

export interface BuildPredictionOptions {
  isAfternoon?: boolean;
  includeTrainerStats?: boolean;
  maxPP?: number;
}

/**
 * レースのエントリー一覧からデータを取得し、予測を生成する。
 *
 * includeTrainerStats: true の場合、調教師・種牡馬・騎手の詳細統計も取得する。
 * （scheduler 経由の本番予測で使用。sync/bulk-import では省略可）
 *
 * バッチクエリで全馬分を一括取得し、N+1 問題を回避する。
 * ~112クエリ/レース → ~7クエリ/レース に削減。
 */
export async function buildAndPredict(
  raceId: string,
  raceName: string,
  date: string,
  trackType: TrackType,
  distance: number,
  trackCondition: TrackCondition | undefined,
  racecourseName: string,
  grade: string | undefined,
  entries: RaceEntry[],
  weather?: string,
  options?: BuildPredictionOptions,
): Promise<Prediction> {
  const maxPP = options?.maxPP ?? 100;
  const includeTrainer = options?.includeTrainerStats ?? false;
  const t0 = Date.now();

  // 全馬のIDを収集
  const horseIds = entries.map(re => re.horseId);
  const jockeyIds = entries.map(re => re.jockeyId);

  // 基本データをバッチ取得（3クエリ、並列実行）
  const [pastPerfsMap, horsesMap, jockeyStatsMap] = await Promise.all([
    getHorsePastPerformancesBatch(horseIds, date, maxPP),
    getHorsesByIds(horseIds),
    getJockeyStatsBatch(jockeyIds, date),
  ]);
  console.log(`[perf] ${raceId} 基本データ取得: ${Date.now() - t0}ms (${entries.length}頭)`);

  // 拡張統計をバッチ取得（includeTrainer の場合のみ、4クエリ、並列実行）
  const trainerNames = entries.map(re => re.trainerName);
  const sireNames = entries.map(re => {
    const horse = horsesMap.get(re.horseId);
    return (horse as Record<string, unknown> | undefined)?.father_name as string || '';
  });

  const [trainerStatsMap, sireTrackWRMap, jockeyDistWRMap, jockeyCourseWRMap] = includeTrainer
    ? await Promise.all([
        getTrainerStatsBatch(trainerNames, date),
        getSireTrackWinRateBatch(sireNames, trackType, date),
        getJockeyDistanceWinRateBatch(jockeyIds, distance, date),
        getJockeyCourseWinRateBatch(jockeyIds, racecourseName, date),
      ])
    : [null, null, null, null];
  if (includeTrainer) console.log(`[perf] ${raceId} 拡張統計取得: ${Date.now() - t0}ms`);

  const distCat = distance <= 1400 ? 'sprint' : distance <= 1800 ? 'mile' : 'long';
  const isHeavy = trackCondition === '重' || trackCondition === '不良';
  const isGrade = ['G3', 'G2', 'G1'].includes(grade || '');

  // Map から各馬に配分
  const horseInputs: HorseAnalysisInput[] = entries.map((re) => {
    const pastPerfs = pastPerfsMap.get(re.horseId) || [];
    const horseData = horsesMap.get(re.horseId);
    const jockeyStats = jockeyStatsMap.get(re.jockeyId) || { winRate: 0.08, placeRate: 0.20 };
    const fatherName = (horseData as Record<string, unknown> | undefined)?.father_name as string || '';

    const base: HorseAnalysisInput = {
      entry: re,
      pastPerformances: pastPerfs,
      jockeyWinRate: jockeyStats.winRate,
      jockeyPlaceRate: jockeyStats.placeRate,
      fatherName,
    };

    if (!includeTrainer || !trainerStatsMap || !sireTrackWRMap || !jockeyDistWRMap || !jockeyCourseWRMap) {
      return base;
    }

    const defaultTrainer = {
      winRate: 0.08, placeRate: 0.20,
      sprintWinRate: 0.08, mileWinRate: 0.08, longWinRate: 0.08,
      heavyWinRate: 0.08, gradeWinRate: 0.08,
    };
    const trainerStats = trainerStatsMap.get(re.trainerName) || defaultTrainer;
    const sireTrackWR = sireTrackWRMap.get(fatherName) ?? 0.07;
    const jockeyDistWR = jockeyDistWRMap.get(re.jockeyId) ?? 0.08;
    const jockeyCourseWR = jockeyCourseWRMap.get(re.jockeyId) ?? 0.08;

    return {
      ...base,
      trainerWinRate: trainerStats.winRate,
      trainerPlaceRate: trainerStats.placeRate,
      sireTrackWinRate: sireTrackWR,
      jockeyDistanceWinRate: jockeyDistWR,
      jockeyCourseWinRate: jockeyCourseWR,
      trainerDistCatWinRate: distCat === 'sprint' ? trainerStats.sprintWinRate
        : distCat === 'mile' ? trainerStats.mileWinRate : trainerStats.longWinRate,
      trainerCondWinRate: isHeavy ? trainerStats.heavyWinRate : trainerStats.winRate,
      trainerGradeWinRate: isGrade ? trainerStats.gradeWinRate : trainerStats.winRate,
    };
  });

  console.log(`[perf] ${raceId} データ準備完了: ${Date.now() - t0}ms → generatePrediction開始`);
  const prediction = await generatePrediction(
    raceId, raceName, date, trackType, distance,
    trackCondition, racecourseName, grade, horseInputs,
    weather, { isAfternoon: options?.isAfternoon },
  );

  // しょーさん予想評価（先行力 × 休養 × アゲ騎手）
  try {
    const shosanResult = await evaluateShosanForRace(
      raceId, date, racecourseName, entries, pastPerfsMap, raceName
    );
    if (shosanResult && shosanResult.candidates.length > 0) {
      (prediction.analysis as unknown as Record<string, unknown>).shosanPrediction = shosanResult;
    }
  } catch (e) {
    console.warn(`[perf] ${raceId} しょーさん予想評価失敗:`, e instanceof Error ? e.message : e);
  }

  console.log(`[perf] ${raceId} 予想生成完了: ${Date.now() - t0}ms`);
  return prediction;
}

/**
 * しょーさん予想評価のヘルパー
 * 前走騎手をバッチで取得して評価
 */
async function evaluateShosanForRace(
  raceId: string,
  date: string,
  racecourseName: string,
  entries: RaceEntry[],
  pastPerfsMap: Map<string, unknown[]>,
  raceName?: string,
) {
  // しょーさん用のHorseEntry形式に変換
  const horseEntries: ShosanHorseEntry[] = entries.map(re => ({
    horseNumber: re.horseNumber,
    horseName: re.horseName,
    horseId: re.horseId,
    jockeyId: re.jockeyId || '',
    jockeyName: re.jockeyName || '',
  }));

  // 過去成績マップをしょーさん形式に変換
  const ppForShosan = new Map<string, ShosanPastPerf[]>();
  for (const re of entries) {
    const perfs = (pastPerfsMap.get(re.horseId) || []) as Array<{
      date: string; position: number; cornerPositions?: string; entries?: number; racecourseName?: string;
    }>;
    ppForShosan.set(re.horseId, perfs.map(p => ({
      date: p.date,
      position: p.position,
      cornerPositions: p.cornerPositions || '',
      entries: p.entries || 0,
      racecourseName: p.racecourseName || '',
    })));
  }

  // 前走騎手を一括取得
  const horseIds = entries.map(re => re.horseId).filter(Boolean);
  const prevJockeyMap = new Map<string, string>();
  if (horseIds.length > 0) {
    const ph = horseIds.map(() => '?').join(',');
    // 各馬の最新の過去レースの騎手を1クエリで取得
    const rows = await dbAll<{ horse_id: string; jockey_id: string }>(
      `SELECT re.horse_id, re.jockey_id FROM race_entries re
       JOIN races r ON re.race_id = r.id
       WHERE re.horse_id IN (${ph})
         AND r.date < ?
         AND (re.horse_id, r.date) IN (
           SELECT re2.horse_id, MAX(r2.date)
           FROM race_entries re2 JOIN races r2 ON re2.race_id = r2.id
           WHERE re2.horse_id IN (${ph}) AND r2.date < ?
           GROUP BY re2.horse_id
         )`,
      [...horseIds, date, ...horseIds, date]
    );
    for (const row of rows) {
      if (row.jockey_id) prevJockeyMap.set(row.horse_id, row.jockey_id);
    }
  }

  const shosanResult = evaluateShosanTheory(date, racecourseName, horseEntries, ppForShosan, prevJockeyMap, raceName);

  // テン3F推定 & 1角確保スコアを全エントリーに対して計算
  const JRA_VENUES = ['中京', '中山', '京都', '函館', '小倉', '新潟', '札幌', '東京', '福島', '阪神'];
  const isJraVenue = (n?: string) => !!n && JRA_VENUES.some(v => n.includes(v));
  const getFC = (cp: string) => { const n = parseInt(cp.split('-')[0]); return n > 0 ? n : null; };

  const earlySpeedMap = new Map<number, { speed: EarlySpeedProfile; frontCount: number; totalRaces: number; postPosition: number }>();

  for (const re of entries) {
    const perfs = (pastPerfsMap.get(re.horseId) || []) as Array<{
      time: string; lastThreeFurlongs: string; distance: number; trackType: string;
      cornerPositions?: string; entries?: number; position: number; racecourseName?: string;
    }>;

    const speed = calcEarlySpeedProfile(
      perfs.map(p => ({
        time: p.time,
        lastThreeFurlongs: p.lastThreeFurlongs,
        distance: p.distance,
        cornerPositions: p.cornerPositions || '',
        entries: p.entries || 0,
        position: p.position,
      })),
      perfs[0]?.trackType || '芝',
    );

    // 先行回数
    let frontCount = 0, totalRaces = 0;
    for (const pp of perfs.slice(0, 10)) {
      if (!isJraVenue(pp.racecourseName)) continue;
      const pos = getFC(pp.cornerPositions || '');
      if (pos === null) continue;
      totalRaces++;
      if (pos <= 2) frontCount++;
    }

    earlySpeedMap.set(re.horseNumber, { speed, frontCount, totalRaces, postPosition: re.postPosition || 0 });
  }

  // 候補にテン3F & 1角確保スコアを付与
  if (shosanResult && shosanResult.candidates.length > 0) {
    const allRivals = [...earlySpeedMap.entries()].map(([_, v]) => ({
      earlySpeed: v.speed,
      postPosition: v.postPosition,
      frontCount: v.frontCount,
    }));

    const earlySpeedData: Record<number, { earlyPacePer200m: number; earlyPaceRelative: number; firstCornerScore: number; firstCornerFactors: string[] }> = {};

    for (const c of shosanResult.candidates) {
      const me = earlySpeedMap.get(c.horseNumber);
      if (!me) continue;

      const rivals = allRivals.filter(r => r.postPosition !== me.postPosition);
      const fcScore = calcFirstCornerScore(
        { earlySpeed: me.speed, postPosition: me.postPosition, frontCount: me.frontCount, totalRaces: me.totalRaces },
        rivals,
      );

      earlySpeedData[c.horseNumber] = {
        earlyPacePer200m: Math.round(me.speed.earlyPacePer200m * 100) / 100,
        earlyPaceRelative: Math.round(me.speed.earlyPaceRelative * 100) / 100,
        firstCornerScore: fcScore.score,
        firstCornerFactors: fcScore.factors,
      };
    }

    (shosanResult as unknown as Record<string, unknown>).earlySpeedData = earlySpeedData;
  }

  return shosanResult;
}
