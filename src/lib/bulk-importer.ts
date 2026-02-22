/**
 * バルクデータインポーター
 *
 * netkeiba.com から日付範囲を指定して一括でレース・馬・騎手データを取り込む。
 * 主な機能:
 *   - 日付範囲のレース一括取り込み
 *   - 馬ごとの過去成績を全件取り込み（最大50走）
 *   - レート制限付きの逐次スクレイピング
 *   - 進捗コールバック
 */

import {
  scrapeRaceList,
  scrapeRaceCard,
  scrapeOdds,
  scrapeRaceResult,
  scrapeHorseDetail,
} from './scraper';
import type {
  ScrapedRace,
  ScrapedRaceDetail,
  ScrapedHorseDetail,
} from './scraper';
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
import { getDatabase } from './database';
import type { PastPerformance } from '@/types';

// ==================== 型定義 ====================

export interface BulkImportConfig {
  /** 開始日 (YYYY-MM-DD) */
  startDate: string;
  /** 終了日 (YYYY-MM-DD) */
  endDate: string;
  /** 馬詳細も取り込むか (デフォルト: true) */
  importHorseDetails?: boolean;
  /** オッズも取り込むか (デフォルト: true) */
  importOdds?: boolean;
  /** 結果確定済みレースの結果を取り込むか (デフォルト: true) */
  importResults?: boolean;
  /** AI予想を生成するか (デフォルト: true) */
  generatePredictions?: boolean;
  /** 過去成績の最大取得数 (デフォルト: 50) */
  maxPastPerformances?: number;
  /** リクエスト間隔 (ms, デフォルト: 1200) */
  rateLimitMs?: number;
  /** 既存データをクリアしてから取り込むか */
  clearExisting?: boolean;
}

export interface BulkImportProgress {
  phase: string;
  current: number;
  total: number;
  detail: string;
  stats: BulkImportStats;
  errors: string[];
  isRunning: boolean;
  startedAt: string;
  completedAt?: string;
}

export interface BulkImportStats {
  datesProcessed: number;
  racesScraped: number;
  entriesScraped: number;
  horsesScraped: number;
  pastPerformancesImported: number;
  oddsScraped: number;
  resultsScraped: number;
  predictionsGenerated: number;
}

// ==================== グローバル状態 ====================

let currentProgress: BulkImportProgress | null = null;
let abortRequested = false;

export function getBulkImportProgress(): BulkImportProgress | null {
  return currentProgress;
}

export function abortBulkImport(): void {
  abortRequested = true;
}

// ==================== メイン処理 ====================

export async function runBulkImport(config: BulkImportConfig): Promise<BulkImportProgress> {
  if (currentProgress?.isRunning) {
    throw new Error('バルクインポートが既に実行中です');
  }

  abortRequested = false;
  const rateLimitMs = config.rateLimitMs ?? 1200;
  const maxPP = config.maxPastPerformances ?? 50;

  const progress: BulkImportProgress = {
    phase: '初期化',
    current: 0,
    total: 0,
    detail: '',
    stats: {
      datesProcessed: 0,
      racesScraped: 0,
      entriesScraped: 0,
      horsesScraped: 0,
      pastPerformancesImported: 0,
      oddsScraped: 0,
      resultsScraped: 0,
      predictionsGenerated: 0,
    },
    errors: [],
    isRunning: true,
    startedAt: new Date().toISOString(),
  };

  currentProgress = progress;

  try {
    // 既存データクリア
    if (config.clearExisting) {
      progress.phase = '既存データクリア';
      progress.detail = 'シードデータを削除中...';
      clearAllData();
    }

    // 日付リストを生成
    const dates = generateDateRange(config.startDate, config.endDate);
    progress.total = dates.length;

    // =============================================
    // Step 1: 全日付のレース一覧を取得
    // =============================================
    progress.phase = 'レース一覧取得';
    const allRaces: ScrapedRace[] = [];

    for (let i = 0; i < dates.length; i++) {
      if (abortRequested) break;
      const date = dates[i];
      progress.current = i + 1;
      progress.detail = `${date} のレース一覧を取得中 (${i + 1}/${dates.length})`;

      try {
        const races = await scrapeRaceList(date);
        for (const race of races) {
          upsertRace({
            id: race.id,
            name: race.name,
            date: race.date,
            racecourseName: race.racecourseName,
            raceNumber: race.raceNumber,
            status: '予定',
          });
          allRaces.push(race);
          progress.stats.racesScraped++;
        }
        progress.stats.datesProcessed++;
      } catch (error) {
        progress.errors.push(`レース一覧取得失敗 (${date}): ${errMsg(error)}`);
      }

      await sleep(rateLimitMs);
    }

    if (abortRequested) return finalize(progress);

    // =============================================
    // Step 2: 各レースの出馬表を取得
    // =============================================
    progress.phase = '出馬表取得';
    progress.total = allRaces.length;
    const raceDetails: ScrapedRaceDetail[] = [];

    for (let i = 0; i < allRaces.length; i++) {
      if (abortRequested) break;
      const race = allRaces[i];
      progress.current = i + 1;
      progress.detail = `${race.name} の出馬表を取得中 (${i + 1}/${allRaces.length})`;

      try {
        const detail = await scrapeRaceCard(race.id);
        upsertRace({
          id: detail.id,
          name: detail.name,
          racecourseName: detail.racecourseName,
          racecourseId: detail.racecourseId,
          trackType: detail.trackType,
          distance: detail.distance,
          trackCondition: detail.trackCondition,
          weather: detail.weather,
          time: detail.time,
          grade: detail.grade as import('@/types').Race['grade'],
          status: '出走確定',
        });

        for (const e of detail.entries) {
          upsertRaceEntry(race.id, {
            postPosition: e.postPosition,
            horseNumber: e.horseNumber,
            horseId: e.horseId,
            horseName: e.horseName,
            age: e.age,
            sex: e.sex,
            jockeyId: e.jockeyId,
            jockeyName: e.jockeyName,
            trainerName: e.trainerName,
            handicapWeight: e.handicapWeight,
          });
          progress.stats.entriesScraped++;
        }

        raceDetails.push(detail);
      } catch (error) {
        progress.errors.push(`出馬表取得失敗 (${race.id} ${race.name}): ${errMsg(error)}`);
      }

      await sleep(rateLimitMs);
    }

    if (abortRequested) return finalize(progress);

    // =============================================
    // Step 3: 馬詳細＋過去成績を取得
    // =============================================
    if (config.importHorseDetails !== false) {
      const horseIds = new Set<string>();
      for (const detail of raceDetails) {
        for (const e of detail.entries) {
          horseIds.add(e.horseId);
        }
      }

      const horseIdList = [...horseIds];
      progress.phase = '馬詳細・過去成績取得';
      progress.total = horseIdList.length;

      for (let i = 0; i < horseIdList.length; i++) {
        if (abortRequested) break;
        const hid = horseIdList[i];
        progress.current = i + 1;
        progress.detail = `馬詳細を取得中 (${i + 1}/${horseIdList.length})`;

        try {
          const horse = await scrapeHorseDetail(hid);
          if (horse) {
            upsertHorse({
              id: horse.id,
              name: horse.name,
              birthDate: horse.birthDate,
              fatherName: horse.fatherName,
              motherName: horse.motherName,
              trainerName: horse.trainerName,
              ownerName: horse.ownerName,
            });
            progress.stats.horsesScraped++;

            // 過去成績の取り込み (重複排除、最大maxPP件)
            const imported = importHorsePastPerformances(horse, maxPP);
            progress.stats.pastPerformancesImported += imported;

            progress.detail = `${horse.name}: 過去成績${imported}件取り込み (${i + 1}/${horseIdList.length})`;
          }
        } catch (error) {
          progress.errors.push(`馬詳細取得失敗 (${hid}): ${errMsg(error)}`);
        }

        await sleep(rateLimitMs);
      }
    }

    if (abortRequested) return finalize(progress);

    // =============================================
    // Step 4: レース結果を取得 (過去日のレース)
    // =============================================
    if (config.importResults !== false) {
      const today = new Date().toISOString().split('T')[0];
      const pastRaces = allRaces.filter(r => r.date < today);

      progress.phase = 'レース結果取得';
      progress.total = pastRaces.length;

      for (let i = 0; i < pastRaces.length; i++) {
        if (abortRequested) break;
        const race = pastRaces[i];
        progress.current = i + 1;
        progress.detail = `${race.name} の結果を取得中 (${i + 1}/${pastRaces.length})`;

        try {
          const results = await scrapeRaceResult(race.id);
          for (const r of results) {
            upsertRaceEntry(race.id, {
              horseNumber: r.horseNumber,
              horseName: r.horseName,
              result: {
                position: r.position,
                time: r.time,
                margin: r.margin,
                lastThreeFurlongs: r.lastThreeFurlongs,
                cornerPositions: r.cornerPositions,
              },
            });
            progress.stats.resultsScraped++;
          }
          if (results.length > 0) {
            upsertRace({ id: race.id, status: '結果確定' });
          }
        } catch (error) {
          progress.errors.push(`結果取得失敗 (${race.id}): ${errMsg(error)}`);
        }

        await sleep(rateLimitMs);
      }
    }

    if (abortRequested) return finalize(progress);

    // =============================================
    // Step 5: オッズ取得 (未来レースのみ)
    // =============================================
    if (config.importOdds !== false) {
      const today = new Date().toISOString().split('T')[0];
      const futureRaces = allRaces.filter(r => r.date >= today);

      progress.phase = 'オッズ取得';
      progress.total = futureRaces.length;

      for (let i = 0; i < futureRaces.length; i++) {
        if (abortRequested) break;
        const race = futureRaces[i];
        progress.current = i + 1;
        progress.detail = `${race.name} のオッズを取得中 (${i + 1}/${futureRaces.length})`;

        try {
          const odds = await scrapeOdds(race.id);
          for (const w of odds.win) {
            upsertOdds(race.id, '単勝', [w.horseNumber], w.odds);
            progress.stats.oddsScraped++;
          }
          for (const p of odds.place) {
            upsertOdds(race.id, '複勝', [p.horseNumber], p.minOdds, p.minOdds, p.maxOdds);
            progress.stats.oddsScraped++;
          }
        } catch (error) {
          progress.errors.push(`オッズ取得失敗 (${race.id}): ${errMsg(error)}`);
        }

        await sleep(rateLimitMs);
      }
    }

    if (abortRequested) return finalize(progress);

    // =============================================
    // Step 6: AI予想生成
    // =============================================
    if (config.generatePredictions !== false) {
      const today = new Date().toISOString().split('T')[0];
      const targetRaces = raceDetails.filter(r => {
        const race = allRaces.find(ar => ar.id === r.id);
        return race && race.date >= today;
      });

      progress.phase = 'AI予想生成';
      progress.total = targetRaces.length;

      for (let i = 0; i < targetRaces.length; i++) {
        if (abortRequested) break;
        const detail = targetRaces[i];
        progress.current = i + 1;
        progress.detail = `${detail.name} の予想を生成中 (${i + 1}/${targetRaces.length})`;

        try {
          const raceData = getRaceById(detail.id);
          if (!raceData || !raceData.entries || raceData.entries.length === 0) continue;

          const horseInputs = raceData.entries.map((re: import('@/types').RaceEntry) => {
            const pastPerfs = getHorsePastPerformances(re.horseId, maxPP);
            const horseData = getHorseById(re.horseId) as { father_name?: string } | null;
            return {
              entry: re,
              pastPerformances: pastPerfs,
              jockeyWinRate: 0.10,
              jockeyPlaceRate: 0.25,
              fatherName: horseData?.father_name || '',
            };
          });

          if (horseInputs.length > 0) {
            const race = allRaces.find(r => r.id === detail.id);
            const prediction = generatePrediction(
              detail.id,
              detail.name,
              race?.date || today,
              detail.trackType,
              detail.distance,
              detail.trackCondition,
              detail.racecourseName,
              detail.grade,
              horseInputs,
            );
            savePrediction(prediction);
            progress.stats.predictionsGenerated++;
          }
        } catch (error) {
          progress.errors.push(`予想生成失敗 (${detail.id}): ${errMsg(error)}`);
        }
      }
    }

    return finalize(progress);

  } catch (error) {
    progress.errors.push(`致命的エラー: ${errMsg(error)}`);
    return finalize(progress);
  }
}

// ==================== ヘルパー ====================

function importHorsePastPerformances(horse: ScrapedHorseDetail, maxPP: number): number {
  const existingPerfs = getHorsePastPerformances(horse.id, 200);
  const existingDates = new Set(existingPerfs.map((p: PastPerformance) => `${p.date}_${p.racecourseName}_${p.raceName}`));

  let imported = 0;
  // 最新のmaxPP件だけ取り込む
  const perfsToImport = horse.pastPerformances.slice(0, maxPP);

  for (const perf of perfsToImport) {
    const key = `${perf.date}_${perf.racecourseName}_${perf.raceName}`;
    if (existingDates.has(key)) continue;

    insertPastPerformance(horse.id, {
      date: perf.date,
      racecourseName: perf.racecourseName,
      raceName: perf.raceName,
      trackType: perf.trackType,
      distance: perf.distance,
      trackCondition: perf.trackCondition,
      entries: perf.entries,
      postPosition: perf.postPosition,
      horseNumber: perf.horseNumber,
      position: perf.position,
      jockeyName: perf.jockeyName,
      handicapWeight: perf.handicapWeight,
      weight: perf.weight,
      weightChange: perf.weightChange,
      time: perf.time,
      margin: perf.margin,
      lastThreeFurlongs: perf.lastThreeFurlongs,
      cornerPositions: perf.cornerPositions,
      odds: perf.odds,
      popularity: perf.popularity,
    });
    imported++;
  }

  return imported;
}

function clearAllData(): void {
  const db = getDatabase();
  db.exec(`
    DELETE FROM predictions;
    DELETE FROM odds;
    DELETE FROM race_entries;
    DELETE FROM past_performances;
    DELETE FROM horse_traits;
    DELETE FROM races;
    DELETE FROM jockeys;
    DELETE FROM horses;
  `);
}

function generateDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const startDate = new Date(start);
  const endDate = new Date(end);

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }

  return dates;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finalize(progress: BulkImportProgress): BulkImportProgress {
  progress.isRunning = false;
  progress.completedAt = new Date().toISOString();
  if (abortRequested) {
    progress.phase = '中断';
    progress.detail = 'ユーザーによる中断';
  } else {
    progress.phase = '完了';
    progress.detail = buildSummary(progress.stats);
  }
  currentProgress = progress;
  return progress;
}

function buildSummary(s: BulkImportStats): string {
  const parts: string[] = [];
  if (s.datesProcessed > 0) parts.push(`${s.datesProcessed}日分処理`);
  if (s.racesScraped > 0) parts.push(`レース${s.racesScraped}件`);
  if (s.horsesScraped > 0) parts.push(`馬${s.horsesScraped}頭`);
  if (s.pastPerformancesImported > 0) parts.push(`過去成績${s.pastPerformancesImported}件`);
  if (s.resultsScraped > 0) parts.push(`結果${s.resultsScraped}件`);
  if (s.oddsScraped > 0) parts.push(`オッズ${s.oddsScraped}件`);
  if (s.predictionsGenerated > 0) parts.push(`予想${s.predictionsGenerated}件`);
  return parts.join('、') || 'データなし';
}
