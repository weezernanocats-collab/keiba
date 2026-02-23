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
  scrapeRaceResult,
  scrapeHorseDetail,
} from './scraper';
import type { ScrapedRaceDetail } from './scraper';
import {
  upsertRace,
  upsertRaceEntry,
  upsertOdds,
  upsertHorse,
  insertPastPerformance,
  getHorsePastPerformances,
  getHorseById,
  getRaceById,
  savePrediction,
} from './queries';
import { generatePrediction } from './prediction-engine';
import { evaluateAllPendingRaces } from './accuracy-tracker';
import { dbAll } from './database';
import type { PastPerformance } from '@/types';

// ==================== 型定義 ====================

export interface SchedulerConfig {
  /** 有効化 */
  enabled: boolean;
  /** レース当日の朝の取得時刻 (HH:MM) */
  morningFetchTime: string;
  /** オッズ取得時刻 (HH:MM) */
  oddsFetchTime: string;
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
  resultFetchTime: '17:00',
  nightFetchTime: '22:00',
  rateLimitMs: 1200,
};

// ==================== グローバル状態 ====================

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let currentConfig: SchedulerConfig = { ...DEFAULT_CONFIG };
let lastRunTime: string | null = null;
let schedulerLogs: SchedulerLog[] = [];
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
export async function runSchedulerJob(job: 'morning' | 'odds' | 'results' | 'night'): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  switch (job) {
    case 'morning':
      await executeMorningFetch(today);
      break;
    case 'odds':
      await executeOddsFetch(today);
      break;
    case 'results':
      await executeResultFetch(today);
      break;
    case 'night':
      await executeMorningFetch(tomorrow);
      break;
  }
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
    for (const race of races) {
      try {
        const detail = await scrapeRaceCard(race.id);
        raceDetails.push(detail);
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

    // 3. 馬詳細
    const horseIds = new Set<string>();
    for (const d of raceDetails) {
      for (const e of d.entries) horseIds.add(e.horseId);
    }
    for (const hid of horseIds) {
      try {
        const horse = await scrapeHorseDetail(hid);
        if (horse) {
          await upsertHorse({
            id: horse.id, name: horse.name, birthDate: horse.birthDate,
            fatherName: horse.fatherName, motherName: horse.motherName,
            trainerName: horse.trainerName, ownerName: horse.ownerName,
          });
          const existingPerfs = await getHorsePastPerformances(horse.id, 200);
          const existingKeys = new Set(existingPerfs.map((p: PastPerformance) => `${p.date}_${p.raceName}`));
          for (const perf of horse.pastPerformances.slice(0, 50)) {
            const key = `${perf.date}_${perf.raceName}`;
            if (existingKeys.has(key)) continue;
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

    // 4. AI予想生成
    for (const detail of raceDetails) {
      try {
        const raceData = await getRaceById(detail.id);
        if (!raceData?.entries?.length) continue;
        const horseInputs = [];
        for (const re of raceData.entries as import('@/types').RaceEntry[]) {
          const pastPerfs = await getHorsePastPerformances(re.horseId, 100);
          const horseData = await getHorseById(re.horseId) as { father_name?: string } | null;
          horseInputs.push({
            entry: re, pastPerformances: pastPerfs,
            jockeyWinRate: 0.10, jockeyPlaceRate: 0.25,
            fatherName: horseData?.father_name || '',
          });
        }
        const prediction = await generatePrediction(
          detail.id, detail.name, date, detail.trackType, detail.distance,
          detail.trackCondition, detail.racecourseName, detail.grade, horseInputs,
        );
        await savePrediction(prediction);
      } catch (error) {
        addLog('予想生成失敗', `${detail.id}: ${errMsg(error)}`, false);
      }
    }

    addLog('朝のデータ取得完了', `${date}: レース${races.length}件, 馬${horseIds.size}頭`, true);
  } catch (error) {
    addLog('朝のデータ取得失敗', errMsg(error), false);
  }
}

async function executeOddsFetch(date: string): Promise<void> {
  addLog('オッズ取得開始', date, true);
  lastRunTime = new Date().toISOString();

  try {
    const races = await dbAll<{ id: string; name: string }>(
      "SELECT id, name FROM races WHERE date = ? AND status IN ('予定', '出走確定')",
      [date]
    );

    let count = 0;
    for (const race of races) {
      try {
        const odds = await scrapeOdds(race.id);
        for (const w of odds.win) {
          await upsertOdds(race.id, '単勝', [w.horseNumber], w.odds);
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

    addLog('オッズ取得完了', `${date}: ${count}レース分`, true);
  } catch (error) {
    addLog('オッズ取得失敗', errMsg(error), false);
  }
}

async function executeResultFetch(date: string): Promise<void> {
  addLog('結果取得開始', date, true);
  lastRunTime = new Date().toISOString();

  try {
    const races = await dbAll<{ id: string; name: string }>(
      "SELECT id, name FROM races WHERE date = ? AND status != '結果確定'",
      [date]
    );

    let resultCount = 0;
    for (const race of races) {
      try {
        const results = await scrapeRaceResult(race.id);
        for (const r of results) {
          await upsertRaceEntry(race.id, {
            horseNumber: r.horseNumber, horseName: r.horseName,
            result: {
              position: r.position, time: r.time, margin: r.margin,
              lastThreeFurlongs: r.lastThreeFurlongs, cornerPositions: r.cornerPositions,
            },
          });
        }
        if (results.length > 0) {
          await upsertRace({ id: race.id, status: '結果確定' });
          resultCount++;
        }
      } catch (error) {
        addLog('結果取得失敗', `${race.id}: ${errMsg(error)}`, false);
      }
      await sleep(currentConfig.rateLimitMs);
    }

    // 予想 vs 実結果の自動照合
    const evalResults = await evaluateAllPendingRaces();
    const wins = evalResults.filter(r => r.winHit).length;
    const places = evalResults.filter(r => r.placeHit).length;

    addLog(
      '結果取得完了',
      `${date}: ${resultCount}レース確定, 照合${evalResults.length}件 (単勝${wins}的中, 複勝${places}的中)`,
      true,
    );
  } catch (error) {
    addLog('結果取得失敗', errMsg(error), false);
  }
}

// ==================== ヘルパー ====================

function addLog(action: string, detail: string, success: boolean): void {
  schedulerLogs.unshift({
    timestamp: new Date().toISOString(),
    action,
    detail,
    success,
  });
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
