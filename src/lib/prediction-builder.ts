/**
 * 予測生成ビルダー
 *
 * HorseAnalysisInput の構築 → generatePrediction 呼び出しを共通化。
 * scheduler.ts, bulk-importer.ts, sync/route.ts, predictions/[raceId]/route.ts
 * で重複していたデータ取得 + 予測生成ロジックを一元管理する。
 */

import type { Prediction, RaceEntry, TrackType, TrackCondition } from '@/types';
import { generatePrediction, type HorseAnalysisInput } from './prediction-engine';
import {
  getHorsePastPerformances,
  getHorseById,
  getJockeyStats,
  getTrainerStats,
  getSireTrackWinRate,
  getJockeyDistanceWinRate,
  getJockeyCourseWinRate,
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

  const horseInputs: HorseAnalysisInput[] = await Promise.all(
    entries.map(async (re) => {
      // 基本データ取得（並列）
      const [pastPerfs, horseData, jockeyStats] = await Promise.all([
        getHorsePastPerformances(re.horseId, date, maxPP),
        getHorseById(re.horseId) as Promise<{ father_name?: string } | null>,
        getJockeyStats(re.jockeyId, date),
      ]);

      const fatherName = horseData?.father_name || '';

      const base: HorseAnalysisInput = {
        entry: re,
        pastPerformances: pastPerfs,
        jockeyWinRate: jockeyStats.winRate,
        jockeyPlaceRate: jockeyStats.placeRate,
        fatherName,
      };

      if (!includeTrainer) return base;

      // 拡張統計取得（並列）
      const [trainerStats, sireTrackWR, jockeyDistWR, jockeyCourseWR] = await Promise.all([
        getTrainerStats(re.trainerName, date),
        getSireTrackWinRate(fatherName, trackType, date),
        getJockeyDistanceWinRate(re.jockeyId, distance, date),
        getJockeyCourseWinRate(re.jockeyId, racecourseName, date),
      ]);

      const distCat = distance <= 1400 ? 'sprint' : distance <= 1800 ? 'mile' : 'long';
      const isHeavy = trackCondition === '重' || trackCondition === '不良';
      const isGrade = ['G3', 'G2', 'G1'].includes(grade || '');

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
    })
  );

  return generatePrediction(
    raceId, raceName, date, trackType, distance,
    trackCondition, racecourseName, grade, horseInputs,
    weather, { isAfternoon: options?.isAfternoon },
  );
}
