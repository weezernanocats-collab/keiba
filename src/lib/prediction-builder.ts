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

    // v9.0: totalEarnings を horses テーブルから取得
    const totalEarnings = (horseData as Record<string, unknown> | undefined)?.total_earnings as number | undefined;

    const base: HorseAnalysisInput = {
      entry: re,
      pastPerformances: pastPerfs,
      jockeyWinRate: jockeyStats.winRate,
      jockeyPlaceRate: jockeyStats.placeRate,
      fatherName,
      totalEarnings: totalEarnings ?? 0,
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
  console.log(`[perf] ${raceId} 予想生成完了: ${Date.now() - t0}ms`);
  return prediction;
}
