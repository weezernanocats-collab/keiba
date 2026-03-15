/**
 * 自動データ更新スケジューラー
 *
 * 開催日に合わせてレースデータ・オッズ・結果を自動取得する。
 *
 * スケジュール:
 *   - 毎朝 6:00: 当日のレース一覧 + 出馬表 + 馬詳細を取得
 *   - レース前 (9:30): オッズを取得
 *   - レース後 (17:00): 結果を取得 + 予想照合
 *   - 毎晩 22:00: 翌日のレース一覧を事前取得
 *
 * 実装: Next.js Route Handler + setInterval (プロセス内スケジューラ)
 * 本番ではVercel Cron / Cloud Scheduler / systemd timer等に切り替え可
 */

import {
  scrapeRaceList,
  scrapeRaceCard,
  scrapeOdds,
  scrapeRaceResultWithLaps,
  scrapeHorseDetail,
} from './scraper';
import type { ScrapedRaceDetail } from './scraper';
import {
  upsertRace,
  upsertRaceEntry,
  upsertOdds,
  upsertRaceEntryOdds,
  insertOddsSnapshot,
  upsertHorse,
  insertPastPerformance,
  getHorsePastPerformances,
  getHorseById,
  getRaceById,
  savePrediction,
  getJockeyStats,
  getTrainerStats,
  getSireTrackWinRate,
  getJockeyDistanceWinRate,
  getJockeyCourseWinRate,
  recordSchedulerRun,
  updateSchedulerRun,
  hasSchedulerRunToday,
  getRecentSchedulerRuns,
  upsertRaceLapTimes,
  classifyPaceType,
} from './queries';
import { generatePrediction } from './prediction-engine';
import { evaluateAllPendingRaces, ensureCalibrationLoaded, autoCalibrate } from './accuracy-tracker';
import { recalculateEVForDate } from './ev-calculator';
import { dbAll, dbRun } from './database';
import type { PastPerformance } from '@/types';

// ==================== 型定義 ====================

export interface SchedulerConfig {
  /** 有効化 */
  enabled: boolean;
  /** レース当日の朝の取得時刻 (HH:MM) */
  morningFetchTime: string;
  /** オッズ取得時刻 (HH:MM) */
  oddsFetchTime: string;
  /** 午後の予想再生成時刻 (HH:MM) */
  afternoonPredictionTime: string;
  /** 結果取得時刻 (HH:MM) */
  resultFetchTime: string;
  /** 翌日分の事前取得時刻 (HH:MM) */
  nightFetchTime: string;
  /** リクエスト間隔 (ms) */
  rateLimitMs: number;
}

export interface SchedulerStatus {
  isRunning: boolean;
  config: SchedulerConfig;
  lastRun: string | null;
  nextScheduled: string | null;
  recentLogs: SchedulerLog[];
}

export interface SchedulerLog {
  timestamp: string;
  action: string;
  detail: string;
  success: boolean;
}

// ==================== デフォルト設定 ====================

const DEFAULT_CONFIG: SchedulerConfig = {
  enabled: false,
  morningFetchTime: '06:00',
  oddsFetchTime: '09:30',
  afternoonPredictionTime: '13:00',
  resultFetchTime: '17:00',
  nightFetchTime: '22:00',
  rateLimitMs: 1200,
};

// ==================== グローバル状態 ====================

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let currentConfig: SchedulerConfig = { ...DEFAULT_CONFIG };
let lastRunTime: string | null = null;
const schedulerLogs: SchedulerLog[] = [];
const MAX_LOGS = 100;
let lastExecutedSlot: string | null = null;

// ==================== 公開API ====================

export function getSchedulerStatus(): SchedulerStatus {
  return {
    isRunning: schedulerInterval !== null,
    config: { ...currentConfig },
    lastRun: lastRunTime,
    nextScheduled: getNextScheduledTime(),
    recentLogs: schedulerLogs.slice(0, 20),
  };
}

/** DB永続化された実行履歴を取得 */
export async function getPersistedSchedulerHistory(limit: number = 20) {
  return getRecentSchedulerRuns(limit);
}

export function startScheduler(config?: Partial<SchedulerConfig>): void {
  if (schedulerInterval) return;

  if (config) {
    currentConfig = { ...currentConfig, ...config };
  }
  currentConfig.enabled = true;

  // 1分ごとにチェック
  schedulerInterval = setInterval(checkAndExecute, 60_000);
  addLog('スケジューラー開始', `設定: 朝${currentConfig.morningFetchTime} オッズ${currentConfig.oddsFetchTime} 結果${currentConfig.resultFetchTime}`, true);

  // 即座にチェック
  checkAndExecute();
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  currentConfig.enabled = false;
  addLog('スケジューラー停止', '', true);
}

export function updateSchedulerConfig(config: Partial<SchedulerConfig>): void {
  currentConfig = { ...currentConfig, ...config };
  addLog('設定変更', JSON.stringify(config), true);
}

/** 手動で特定のジョブを即座に実行 */
export async function runSchedulerJob(job: 'morning' | 'odds' | 'afternoon' | 'results' | 'night'): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  switch (job) {
    case 'morning':
      await executeMorningFetch(today);
      break;
    case 'odds':
      await executeOddsFetch(today);
      break;
    case 'afternoon':
      await executeAfternoonPredictions(today);
      break;
    case 'results':
      await executeResultFetch(today);
      break;
    case 'night':
      await executeMorningFetch(tomorrow);
      break;
  }
}

/**
 * Vercel Cron 用のエントリーポイント。
 * 現在のJST時刻に基づいて適切なジョブを実行する。
 * Cron は毎時/30分で呼ばれる前提。
 */
export async function runCronJob(): Promise<{ executed: string[]; skipped: string[] }> {
  const executed: string[] = [];
  const skipped: string[] = [];

  // JST 現在時刻を取得
  const now = new Date();
  const jstOffset = 9 * 60; // UTC+9
  const jstMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + jstOffset;
  const jstHour = Math.floor((jstMinutes % 1440) / 60);
  const jstMin = jstMinutes % 60;
  const timeStr = `${jstHour.toString().padStart(2, '0')}:${jstMin.toString().padStart(2, '0')}`;

  // JST日付を計算
  const jstTime = new Date(now.getTime() + jstOffset * 60_000);
  const today = jstTime.toISOString().split('T')[0];
  const tomorrow = new Date(jstTime.getTime() + 86400000).toISOString().split('T')[0];

  // 時間帯に基づいてジョブを判定（±30分の範囲で実行）
  const isNear = (target: string) => {
    const [h, m] = target.split(':').map(Number);
    const targetMin = h * 60 + m;
    const currentMin = jstHour * 60 + jstMin;
    return Math.abs(currentMin - targetMin) <= 30;
  };

  if (isNear(currentConfig.morningFetchTime)) {
    try {
      await executeMorningFetch(today);
      executed.push(`morning (${today})`);
    } catch (e) {
      skipped.push(`morning: ${errMsg(e)}`);
    }
  }

  if (isNear(currentConfig.oddsFetchTime)) {
    try {
      await executeOddsFetch(today);
      executed.push(`odds (${today})`);
    } catch (e) {
      skipped.push(`odds: ${errMsg(e)}`);
    }
  }

  if (isNear(currentConfig.afternoonPredictionTime)) {
    try {
      await executeAfternoonPredictions(today);
      executed.push(`afternoon predictions (${today})`);
    } catch (e) {
      skipped.push(`afternoon: ${errMsg(e)}`);
    }
  }

  if (isNear(currentConfig.resultFetchTime)) {
    try {
      await executeResultFetch(today);
      executed.push(`results (${today})`);
    } catch (e) {
      skipped.push(`results: ${errMsg(e)}`);
    }
  }

  if (isNear(currentConfig.nightFetchTime)) {
    try {
      await executeMorningFetch(tomorrow);
      executed.push(`night/tomorrow (${tomorrow})`);
    } catch (e) {
      skipped.push(`night: ${errMsg(e)}`);
    }
  }

  if (executed.length === 0 && skipped.length === 0) {
    skipped.push(`現在時刻 ${timeStr} (JST) は実行対象外`);
  }

  return { executed, skipped };
}

// ==================== スケジュール実行 ====================

async function checkAndExecute(): Promise<void> {
  if (!currentConfig.enabled) return;

  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  const today = now.toISOString().split('T')[0];
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

  // 日付+時間帯で重複実行を防ぐ
  const slot = `${today}_${timeStr}`;
  if (lastExecutedSlot === slot) return;

  if (timeStr === currentConfig.morningFetchTime) {
    lastExecutedSlot = slot;
    await executeMorningFetch(today);
  } else if (timeStr === currentConfig.oddsFetchTime) {
    lastExecutedSlot = slot;
    await executeOddsFetch(today);
  } else if (timeStr === currentConfig.resultFetchTime) {
    lastExecutedSlot = slot;
    await executeResultFetch(today);
  } else if (timeStr === currentConfig.nightFetchTime) {
    lastExecutedSlot = slot;
    await executeMorningFetch(tomorrow);
  }
}

// ==================== ジョブ実行 ====================

async function executeMorningFetch(date: string): Promise<void> {
  // 重複実行防止: 今日すでに同ジョブを実行済みならスキップ
  if (await hasSchedulerRunToday('morning', date)) {
    addLog('朝のデータ取得スキップ', `${date} は既に実行済み`, true);
    return;
  }

  const runId = await recordSchedulerRun('morning', date, 'running');
  addLog('朝のデータ取得開始', date, true);
  lastRunTime = new Date().toISOString();

  try {
    // 1. レース一覧
    const races = await scrapeRaceList(date);
    for (const race of races) {
      await upsertRace({
        id: race.id, name: race.name, date: race.date,
        racecourseName: race.racecourseName, raceNumber: race.raceNumber,
        status: '予定',
      });
    }
    addLog('レース一覧取得', `${date}: ${races.length}件`, true);
    await sleep(currentConfig.rateLimitMs);

    // 2. 出馬表
    const raceDetails: ScrapedRaceDetail[] = [];
    let totalEntries = 0;
    for (const race of races) {
      try {
        const detail = await scrapeRaceCard(race.id);
        raceDetails.push(detail);
        totalEntries += detail.entries.length;
        await upsertRace({
          id: detail.id, name: detail.name, racecourseName: detail.racecourseName,
          racecourseId: detail.racecourseId, trackType: detail.trackType,
          distance: detail.distance, trackCondition: detail.trackCondition,
          weather: detail.weather, time: detail.time,
          grade: detail.grade as import('@/types').Race['grade'],
          status: '出走確定',
        });
        for (const e of detail.entries) {
          await upsertRaceEntry(race.id, {
            postPosition: e.postPosition, horseNumber: e.horseNumber,
            horseId: e.horseId, horseName: e.horseName,
            age: e.age, sex: e.sex, jockeyId: e.jockeyId,
            jockeyName: e.jockeyName, trainerName: e.trainerName,
            handicapWeight: e.handicapWeight,
          });
        }
      } catch (error) {
        addLog('出馬表取得失敗', `${race.id}: ${errMsg(error)}`, false);
      }
      await sleep(currentConfig.rateLimitMs);
    }
    addLog('出馬表取得', `${raceDetails.length}レース, ${totalEntries}頭`, true);

    // 3. 馬詳細
    const horseIds = new Set<string>();
    for (const d of raceDetails) {
      for (const e of d.entries) horseIds.add(e.horseId);
    }
    let horseCount = 0;
    let newPerfCount = 0;
    for (const hid of horseIds) {
      try {
        const horse = await scrapeHorseDetail(hid);
        if (horse) {
          horseCount++;
          await upsertHorse({
            id: horse.id, name: horse.name, birthDate: horse.birthDate,
            fatherName: horse.fatherName, motherName: horse.motherName,
            trainerName: horse.trainerName, ownerName: horse.ownerName,
          });
          const existingPerfs = await getHorsePastPerformances(horse.id, undefined, 200);
          const existingKeys = new Set(existingPerfs.map((p: PastPerformance) => `${p.date}_${p.raceName}`));
          for (const perf of horse.pastPerformances.slice(0, 50)) {
            const key = `${perf.date}_${perf.raceName}`;
            if (existingKeys.has(key)) continue;
            newPerfCount++;
            await insertPastPerformance(horse.id, {
              date: perf.date, racecourseName: perf.racecourseName, raceName: perf.raceName,
              trackType: perf.trackType, distance: perf.distance, trackCondition: perf.trackCondition,
              entries: perf.entries, postPosition: perf.postPosition, horseNumber: perf.horseNumber,
              position: perf.position, jockeyName: perf.jockeyName, handicapWeight: perf.handicapWeight,
              weight: perf.weight, weightChange: perf.weightChange, time: perf.time,
              margin: perf.margin, lastThreeFurlongs: perf.lastThreeFurlongs,
              cornerPositions: perf.cornerPositions, odds: perf.odds, popularity: perf.popularity,
            });
          }
        }
      } catch (error) {
        addLog('馬詳細取得失敗', `${hid}: ${errMsg(error)}`, false);
      }
      await sleep(currentConfig.rateLimitMs);
    }
    addLog('馬詳細取得', `${horseCount}/${horseIds.size}頭, 新規戦績${newPerfCount}件`, true);

    // 4. AI予想生成（校正済み重みがあれば適用）
    await ensureCalibrationLoaded();

    let predictionCount = 0;
    for (const detail of raceDetails) {
      try {
        const raceData = await getRaceById(detail.id);
        if (!raceData?.entries?.length) continue;
        // 全馬のデータを並列取得
        const horseInputs = await Promise.all(
          (raceData.entries as import('@/types').RaceEntry[]).map(async (re) => {
            const [pastPerfs, horseData, jockeyStats, trainerStats] = await Promise.all([
              getHorsePastPerformances(re.horseId, date, 100),
              getHorseById(re.horseId) as Promise<{ father_name?: string } | null>,
              getJockeyStats(re.jockeyId, date),
              getTrainerStats(re.trainerName, date),
            ]);
            const fatherName = horseData?.father_name || '';
            const [sireTrackWR, jockeyDistWR, jockeyCourseWR] = await Promise.all([
              getSireTrackWinRate(fatherName, detail.trackType, date),
              getJockeyDistanceWinRate(re.jockeyId, detail.distance, date),
              getJockeyCourseWinRate(re.jockeyId, detail.racecourseName, date),
            ]);
            const distCat = detail.distance <= 1400 ? 'sprint' : detail.distance <= 1800 ? 'mile' : 'long';
            const isHeavy = detail.trackCondition === '重' || detail.trackCondition === '不良';
            const isGrade = ['G3', 'G2', 'G1'].includes(detail.grade || '');
            return {
              entry: re, pastPerformances: pastPerfs,
              jockeyWinRate: jockeyStats.winRate, jockeyPlaceRate: jockeyStats.placeRate,
              fatherName,
              trainerWinRate: trainerStats.winRate, trainerPlaceRate: trainerStats.placeRate,
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
        const prediction = await generatePrediction(
          detail.id, detail.name, date, detail.trackType, detail.distance,
          detail.trackCondition, detail.racecourseName, detail.grade, horseInputs,
          detail.weather,
        );
        await savePrediction(prediction);
        predictionCount++;
      } catch (error) {
        addLog('予想生成失敗', `${detail.id}: ${errMsg(error)}`, false);
      }
    }
    addLog('予想生成', `${predictionCount}/${raceDetails.length}レース`, true);

    const detail = `${date}: レース${races.length}件, 馬${horseIds.size}頭, 予想${predictionCount}件`;
    addLog('朝のデータ取得完了', detail, true);
    await updateSchedulerRun(runId, 'completed', detail);
  } catch (error) {
    addLog('朝のデータ取得失敗', errMsg(error), false);
    await updateSchedulerRun(runId, 'failed', undefined, errMsg(error));
  }
}

/**
 * 午後の予想再生成
 * 午前のレース結果から馬場バイアスを取得し、未実施レースの予想を更新する。
 * サマリに「午前の傾向」セクションを追加。
 */
async function executeAfternoonPredictions(date: string): Promise<void> {
  if (await hasSchedulerRunToday('afternoon', date)) {
    addLog('午後予想スキップ', `${date} は既に実行済み`, true);
    return;
  }

  const runId = await recordSchedulerRun('afternoon', date, 'running');
  addLog('午後予想再生成開始', date, true);
  lastRunTime = new Date().toISOString();

  try {
    await ensureCalibrationLoaded();

    // 未実施のレースのみ対象
    const races = await dbAll<{
      id: string; name: string; track_type: string; distance: number;
      track_condition: string; racecourse_name: string; grade: string; weather: string;
    }>(
      "SELECT id, name, track_type, distance, track_condition, racecourse_name, grade, weather FROM races WHERE date = ? AND status = '出走確定' ORDER BY id",
      [date]
    );

    if (races.length === 0) {
      addLog('午後予想スキップ', '未実施レースなし', true);
      await updateSchedulerRun(runId, 'completed', '未実施レースなし');
      return;
    }

    addLog('午後予想対象', `${races.length}レース（未実施分のみ）`, true);

    // 既存予想を削除
    const raceIds = races.map(r => r.id);
    const placeholders = raceIds.map(() => '?').join(',');
    await dbRun(`DELETE FROM predictions WHERE race_id IN (${placeholders})`, raceIds);

    let predictionCount = 0;
    for (const race of races) {
      try {
        const raceData = await getRaceById(race.id);
        if (!raceData?.entries?.length) continue;
        const horseInputs = await Promise.all(
          (raceData.entries as import('@/types').RaceEntry[]).map(async (re) => {
            const [pastPerfs, horseData, jockeyStats, trainerStats] = await Promise.all([
              getHorsePastPerformances(re.horseId, date, 100),
              getHorseById(re.horseId) as Promise<{ father_name?: string } | null>,
              getJockeyStats(re.jockeyId, date),
              getTrainerStats(re.trainerName, date),
            ]);
            const fatherName = horseData?.father_name || '';
            const [sireTrackWR, jockeyDistWR, jockeyCourseWR] = await Promise.all([
              getSireTrackWinRate(fatherName, race.track_type, date),
              getJockeyDistanceWinRate(re.jockeyId, race.distance, date),
              getJockeyCourseWinRate(re.jockeyId, race.racecourse_name, date),
            ]);
            const distCat2 = race.distance <= 1400 ? 'sprint' : race.distance <= 1800 ? 'mile' : 'long';
            const isHeavy2 = race.track_condition === '重' || race.track_condition === '不良';
            const isGrade2 = ['G3', 'G2', 'G1'].includes(race.grade || '');
            return {
              entry: re, pastPerformances: pastPerfs,
              jockeyWinRate: jockeyStats.winRate, jockeyPlaceRate: jockeyStats.placeRate,
              fatherName,
              trainerWinRate: trainerStats.winRate, trainerPlaceRate: trainerStats.placeRate,
              sireTrackWinRate: sireTrackWR,
              jockeyDistanceWinRate: jockeyDistWR,
              jockeyCourseWinRate: jockeyCourseWR,
              trainerDistCatWinRate: distCat2 === 'sprint' ? trainerStats.sprintWinRate
                : distCat2 === 'mile' ? trainerStats.mileWinRate : trainerStats.longWinRate,
              trainerCondWinRate: isHeavy2 ? trainerStats.heavyWinRate : trainerStats.winRate,
              trainerGradeWinRate: isGrade2 ? trainerStats.gradeWinRate : trainerStats.winRate,
            };
          })
        );
        const prediction = await generatePrediction(
          race.id, race.name, date,
          race.track_type as import('@/types').TrackType, race.distance,
          race.track_condition as import('@/types').TrackCondition | undefined,
          race.racecourse_name, race.grade, horseInputs,
          race.weather as '晴' | '曇' | '小雨' | '雨' | '小雪' | '雪' | undefined,
          { isAfternoon: true },
        );
        await savePrediction(prediction);
        predictionCount++;
      } catch (error) {
        addLog('午後予想失敗', `${race.id}: ${errMsg(error)}`, false);
      }
    }

    const detail = `${date}: ${predictionCount}/${races.length}レース 午後予想更新`;
    addLog('午後予想完了', detail, true);
    await updateSchedulerRun(runId, 'completed', detail);
  } catch (error) {
    addLog('午後予想失敗', errMsg(error), false);
    await updateSchedulerRun(runId, 'failed', undefined, errMsg(error));
  }
}

/**
 * 予想未生成レースの補完（不足分のみ、既存予想は削除しない）
 * 朝の bulk_chunked パイプラインが途中で切れた場合の安全網
 */
export async function executeMissingPredictions(date: string, timeBudgetMs?: number): Promise<{ generated: number; total: number }> {
  const missing = await dbAll<{
    id: string; name: string; track_type: string; distance: number;
    track_condition: string; racecourse_name: string; grade: string; weather: string;
  }>(
    `SELECT r.id, r.name, r.track_type, r.distance, r.track_condition,
            r.racecourse_name, r.grade, r.weather
     FROM races r
     LEFT JOIN predictions p ON r.id = p.race_id
     WHERE p.id IS NULL AND r.date = ?
       AND r.status IN ('出走確定', '結果確定')
       AND (SELECT COUNT(*) FROM race_entries re WHERE re.race_id = r.id) >= 2
     ORDER BY r.id`,
    [date]
  );

  if (missing.length === 0) {
    return { generated: 0, total: 0 };
  }

  await ensureCalibrationLoaded();

  const startTime = Date.now();
  const hasTime = timeBudgetMs
    ? () => (Date.now() - startTime) < timeBudgetMs
    : () => true;

  let generated = 0;
  for (const race of missing) {
    if (!hasTime()) {
      console.log(`[executeMissingPredictions] タイムバジェット超過: ${generated}/${missing.length}件生成済み`);
      break;
    }
    try {
      const raceData = await getRaceById(race.id);
      if (!raceData?.entries?.length || raceData.entries.length < 2) continue;

      const horseInputs = await Promise.all(
        (raceData.entries as import('@/types').RaceEntry[]).map(async (re) => {
          const [pastPerfs, horseData, jockeyStats, trainerStats] = await Promise.all([
            getHorsePastPerformances(re.horseId, date, 100),
            getHorseById(re.horseId) as Promise<{ father_name?: string } | null>,
            getJockeyStats(re.jockeyId, date),
            getTrainerStats(re.trainerName, date),
          ]);
          const fatherName = horseData?.father_name || '';
          const [sireTrackWR, jockeyDistWR, jockeyCourseWR] = await Promise.all([
            getSireTrackWinRate(fatherName, race.track_type, date),
            getJockeyDistanceWinRate(re.jockeyId, race.distance, date),
            getJockeyCourseWinRate(re.jockeyId, race.racecourse_name, date),
          ]);
          const distCat = race.distance <= 1400 ? 'sprint' : race.distance <= 1800 ? 'mile' : 'long';
          const isHeavy = race.track_condition === '重' || race.track_condition === '不良';
          const isGrade = ['G3', 'G2', 'G1'].includes(race.grade || '');
          return {
            entry: re, pastPerformances: pastPerfs,
            jockeyWinRate: jockeyStats.winRate, jockeyPlaceRate: jockeyStats.placeRate,
            fatherName,
            trainerWinRate: trainerStats.winRate, trainerPlaceRate: trainerStats.placeRate,
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

      const prediction = await generatePrediction(
        race.id, race.name, date,
        race.track_type as import('@/types').TrackType, race.distance,
        race.track_condition as import('@/types').TrackCondition | undefined,
        race.racecourse_name, race.grade, horseInputs,
      );
      await savePrediction(prediction);
      generated++;
    } catch (error) {
      addLog('予想補完失敗', `${race.id}: ${errMsg(error)}`, false);
    }
  }

  return { generated, total: missing.length };
}

async function executeOddsFetch(date: string): Promise<void> {
  if (await hasSchedulerRunToday('odds', date)) {
    addLog('オッズ取得スキップ', `${date} は既に実行済み`, true);
    return;
  }

  const runId = await recordSchedulerRun('odds', date, 'running');
  addLog('オッズ取得開始', date, true);
  lastRunTime = new Date().toISOString();

  try {
    const races = await dbAll<{ id: string; name: string }>(
      "SELECT id, name FROM races WHERE date = ? AND status IN ('予定', '出走確定')",
      [date]
    );
    addLog('オッズ取得対象', `${date}: ${races.length}レース`, true);

    let count = 0;
    for (const race of races) {
      try {
        const odds = await scrapeOdds(race.id);
        const snapshotTime = new Date().toISOString();
        for (const w of odds.win) {
          await upsertOdds(race.id, '単勝', [w.horseNumber], w.odds);
          await upsertRaceEntryOdds(race.id, w.horseNumber, w.odds, 0);
          // 時系列スナップショット保存
          await insertOddsSnapshot(race.id, w.horseNumber, w.odds, snapshotTime);
        }
        for (const p of odds.place) {
          await upsertOdds(race.id, '複勝', [p.horseNumber], p.minOdds, p.minOdds, p.maxOdds);
        }
        count++;
      } catch (error) {
        addLog('オッズ取得失敗', `${race.id}: ${errMsg(error)}`, false);
      }
      await sleep(currentConfig.rateLimitMs);
    }

    // オッズ取得後に EV を再計算
    let evCount = 0;
    try {
      evCount = await recalculateEVForDate(date);
      addLog('EV再計算', `${evCount}レースの期待値を更新`, true);
    } catch (evError) {
      addLog('EV再計算失敗', errMsg(evError), false);
    }

    const detail = `${date}: ${count}レース分, EV更新${evCount}件`;
    addLog('オッズ取得完了', detail, true);
    await updateSchedulerRun(runId, 'completed', detail);
  } catch (error) {
    addLog('オッズ取得失敗', errMsg(error), false);
    await updateSchedulerRun(runId, 'failed', undefined, errMsg(error));
  }
}

async function executeResultFetch(date: string): Promise<void> {
  if (await hasSchedulerRunToday('results', date)) {
    addLog('結果取得スキップ', `${date} は既に実行済み`, true);
    return;
  }

  const runId = await recordSchedulerRun('results', date, 'running');
  addLog('結果取得開始', date, true);
  lastRunTime = new Date().toISOString();

  try {
    const races = await dbAll<{ id: string; name: string }>(
      "SELECT id, name FROM races WHERE date = ? AND status != '結果確定'",
      [date]
    );
    addLog('結果取得対象', `${date}: ${races.length}レース`, true);

    // 結果取得はレスポンスが軽いので 500ms 間隔で十分（60秒制限対応）
    const resultRateMs = 500;
    let resultCount = 0;
    let entryResultCount = 0;
    for (const race of races) {
      try {
        const { results, lapTimes } = await scrapeRaceResultWithLaps(race.id);
        for (const r of results) {
          await upsertRaceEntry(race.id, {
            horseNumber: r.horseNumber, horseName: r.horseName,
            result: {
              position: r.position, time: r.time, margin: r.margin,
              lastThreeFurlongs: r.lastThreeFurlongs, cornerPositions: r.cornerPositions,
            },
          });
          entryResultCount++;
          // オッズ・人気も保存
          if (r.odds > 0) {
            await upsertOdds(race.id, '単勝', [r.horseNumber], r.odds);
            await upsertRaceEntryOdds(race.id, r.horseNumber, r.odds, r.popularity);
          }
        }
        // ラップタイム保存
        if (lapTimes.length > 0) {
          const paceType = classifyPaceType(lapTimes);
          await upsertRaceLapTimes(race.id, lapTimes, paceType);
        }
        if (results.length > 0) {
          await upsertRace({ id: race.id, status: '結果確定' });
          resultCount++;
        }
      } catch (error) {
        addLog('結果取得失敗', `${race.id}: ${errMsg(error)}`, false);
      }
      await sleep(resultRateMs);
    }
    addLog('結果スクレイピング完了', `${resultCount}レース確定, ${entryResultCount}頭分`, true);

    // 予想 vs 実結果の自動照合
    const evalResults = await evaluateAllPendingRaces();
    const wins = evalResults.filter(r => r.winHit).length;
    const places = evalResults.filter(r => r.placeHit).length;
    addLog('予想照合', `${evalResults.length}件照合 → 単勝${wins}的中, 複勝${places}的中`, true);

    const detail = `${date}: ${resultCount}レース確定, 照合${evalResults.length}件 (単勝${wins}的中, 複勝${places}的中)`;
    addLog('結果取得完了', detail, true);
    await updateSchedulerRun(runId, 'completed', detail);

    // 結果取得後に自動キャリブレーションを試行
    const calibResult = await autoCalibrate();
    addLog('自動キャリブレーション', calibResult.message, calibResult.applied);
  } catch (error) {
    addLog('結果取得失敗', errMsg(error), false);
    await updateSchedulerRun(runId, 'failed', undefined, errMsg(error));
  }
}

// ==================== ヘルパー ====================

function addLog(action: string, detail: string, success: boolean): void {
  const timestamp = new Date().toISOString();
  const prefix = success ? '✓' : '✗';
  const msg = detail ? `${prefix} [${action}] ${detail}` : `${prefix} [${action}]`;
  console.log(msg);

  schedulerLogs.unshift({ timestamp, action, detail, success });
  if (schedulerLogs.length > MAX_LOGS) {
    schedulerLogs.length = MAX_LOGS;
  }
}

function getNextScheduledTime(): string | null {
  if (!currentConfig.enabled) return null;

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const times = [
    currentConfig.morningFetchTime,
    currentConfig.oddsFetchTime,
    currentConfig.resultFetchTime,
    currentConfig.nightFetchTime,
  ].sort();

  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  for (const t of times) {
    if (t > currentTime) return `${today}T${t}:00`;
  }

  // 明日の最初のスケジュール
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  return `${tomorrow}T${times[0]}:00`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
