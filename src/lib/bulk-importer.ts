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
  upsertRaceEntryOdds,
  upsertHorse,
  insertPastPerformance,
  getHorsePastPerformances,
  getHorseById,
  getRaceById,
  savePrediction,
  getJockeyStats,
} from './queries';
import { generatePrediction } from './prediction-engine';
import { evaluateAllPendingRaces, ensureCalibrationLoaded } from './accuracy-tracker';
import { dbAll, dbGet, dbRun, dbExec } from './database';
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

  // 校正済み重みがあれば適用
  await ensureCalibrationLoaded();

  abortRequested = false;
  const rateLimitMs = config.rateLimitMs ?? 1200;
  const maxPP = config.maxPastPerformances ?? 100;

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
      await clearAllData();
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
          await upsertRace({
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
        await upsertRace({
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
          await upsertRaceEntry(race.id, {
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
            await upsertHorse({
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
            const imported = await importHorsePastPerformances(horse, maxPP);
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
      const pastRaces = allRaces.filter(r => r.date <= today);

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
            await upsertRaceEntry(race.id, {
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
            if (r.odds > 0) {
              await upsertOdds(race.id, '単勝', [r.horseNumber], r.odds);
              await upsertRaceEntryOdds(race.id, r.horseNumber, r.odds, r.popularity);
            }
            progress.stats.resultsScraped++;
          }
          if (results.length > 0) {
            await upsertRace({ id: race.id, status: '結果確定' });
          }
        } catch (error) {
          progress.errors.push(`結果取得失敗 (${race.id}): ${errMsg(error)}`);
        }

        await sleep(rateLimitMs);
      }
    }

    if (abortRequested) return finalize(progress);

    // =============================================
    // Step 5: オッズ取得（API → result.html フォールバック）
    // =============================================
    if (config.importOdds !== false) {
      progress.phase = 'オッズ取得';
      progress.total = allRaces.length;

      for (let i = 0; i < allRaces.length; i++) {
        if (abortRequested) break;
        const race = allRaces[i];
        progress.current = i + 1;
        progress.detail = `${race.name} のオッズを取得中 (${i + 1}/${allRaces.length})`;

        try {
          // まず odds API を試行
          const odds = await scrapeOdds(race.id);
          if (odds.win.length > 0) {
            for (const w of odds.win) {
              await upsertOdds(race.id, '単勝', [w.horseNumber], w.odds);
              progress.stats.oddsScraped++;
            }
            for (const p of odds.place) {
              await upsertOdds(race.id, '複勝', [p.horseNumber], p.minOdds, p.minOdds, p.maxOdds);
              progress.stats.oddsScraped++;
            }
          } else {
            // API が空 → result.html からオッズ取得
            const results = await scrapeRaceResult(race.id);
            for (const r of results) {
              if (r.odds > 0) {
                await upsertOdds(race.id, '単勝', [r.horseNumber], r.odds);
                await upsertRaceEntryOdds(race.id, r.horseNumber, r.odds, r.popularity);
                progress.stats.oddsScraped++;
              }
            }
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
          const raceData = await getRaceById(detail.id);
          if (!raceData || !raceData.entries || raceData.entries.length === 0) continue;

          const horseInputs = await Promise.all(
            raceData.entries.map(async (re: import('@/types').RaceEntry) => {
              const pastPerfs = await getHorsePastPerformances(re.horseId, maxPP);
              const horseData = await getHorseById(re.horseId) as { father_name?: string } | null;
              const jockeyStats = await getJockeyStats(re.jockeyId);
              return {
                entry: re,
                pastPerformances: pastPerfs,
                jockeyWinRate: jockeyStats.winRate,
                jockeyPlaceRate: jockeyStats.placeRate,
                fatherName: horseData?.father_name || '',
              };
            })
          );

          if (horseInputs.length > 0) {
            const race = allRaces.find(r => r.id === detail.id);
            const prediction = await generatePrediction(
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
            await savePrediction(prediction);
            progress.stats.predictionsGenerated++;
          }
        } catch (error) {
          progress.errors.push(`予想生成失敗 (${detail.id}): ${errMsg(error)}`);
        }
      }
    }

    // Step 7: 結果確定レースの予想を自動照合
    progress.phase = '予想照合';
    progress.detail = '結果確定レースの予想を自動照合中...';
    const evalResults = await evaluateAllPendingRaces();
    if (evalResults.length > 0) {
      const wins = evalResults.filter(r => r.winHit).length;
      const places = evalResults.filter(r => r.placeHit).length;
      progress.detail = `照合完了: ${evalResults.length}件 (単勝${wins}的中, 複勝${places}的中)`;
    }

    return finalize(progress);

  } catch (error) {
    progress.errors.push(`致命的エラー: ${errMsg(error)}`);
    return finalize(progress);
  }
}

// ==================== ヘルパー ====================

async function importHorsePastPerformances(horse: ScrapedHorseDetail, maxPP: number): Promise<number> {
  const existingPerfs = await getHorsePastPerformances(horse.id, 200);
  const existingDates = new Set(existingPerfs.map((p: PastPerformance) => `${p.date}_${p.racecourseName}_${p.raceName}`));

  let imported = 0;
  // 最新のmaxPP件だけ取り込む
  const perfsToImport = horse.pastPerformances.slice(0, maxPP);

  for (const perf of perfsToImport) {
    const key = `${perf.date}_${perf.racecourseName}_${perf.raceName}`;
    if (existingDates.has(key)) continue;

    await insertPastPerformance(horse.id, {
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

async function clearAllData(): Promise<void> {
  await dbExec(`
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

// ==================== チャンク処理（Vercel対応） ====================
//
// Vercelのサーバーレス関数はタイムアウト制限（Hobby: 60秒）があるため、
// 長時間のバルクインポートを小さなチャンクに分割して処理する。
// フロントエンドが繰り返しAPIを呼び出し、各呼び出しで50秒以内の処理を行う。

export type ChunkedPhase = 'init' | 'dates' | 'race_details' | 'horses' | 'results' | 'odds' | 'predictions' | 'evaluate' | 'done';

export interface BulkChunkedState {
  phase: ChunkedPhase;
  config: {
    startDate: string;
    endDate: string;
    clearExisting: boolean;
  };
  remainingDates: string[];
  totalDates: number;
  stats: BulkImportStats;
  errors: string[];
  startedAt: string;
  completedAt?: string;
  phaseLabel: string;
  phaseRemaining: number;
}

const CHUNK_TIME_BUDGET_MS = 35_000; // 35秒（Gemini 2.5-flash thinking対応、Vercel 60秒制限に余裕）
const CHUNK_RATE_LIMIT_MS = 1200;
const MAX_CHUNK_ERRORS = 100;

export function createInitialChunkedState(config: {
  startDate: string;
  endDate: string;
  clearExisting: boolean;
}): BulkChunkedState {
  return {
    phase: 'init',
    config,
    remainingDates: [],
    totalDates: 0,
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
    startedAt: new Date().toISOString(),
    phaseLabel: '初期化',
    phaseRemaining: 0,
  };
}

export async function runBulkChunk(state: BulkChunkedState): Promise<BulkChunkedState> {
  // 校正済み重みがあれば適用
  await ensureCalibrationLoaded();

  const startTime = Date.now();
  const hasTime = () => (Date.now() - startTime) < CHUNK_TIME_BUDGET_MS;
  const addError = (msg: string) => {
    if (state.errors.length < MAX_CHUNK_ERRORS) state.errors.push(msg);
  };

  try {
    // 現在のフェーズを処理し、完了したら次のフェーズへ自動遷移
    while (state.phase !== 'done' && hasTime()) {
      const prevPhase = state.phase;
      await processChunkPhase(state, hasTime, addError);
      // フェーズが変わらなければ = まだ処理中 → クライアントに返す
      if (state.phase === prevPhase) break;
    }
  } catch (error) {
    addError(`致命的エラー: ${errMsg(error)}`);
  }

  return state;
}

async function processChunkPhase(
  state: BulkChunkedState,
  hasTime: () => boolean,
  addError: (msg: string) => void,
): Promise<void> {
  switch (state.phase) {
    case 'init': {
      if (state.config.clearExisting) await clearAllData();
      state.remainingDates = generateDateRange(state.config.startDate, state.config.endDate);
      state.totalDates = state.remainingDates.length;
      state.phase = 'dates';
      return;
    }

    case 'dates': {
      state.phaseLabel = 'レース一覧取得';

      while (state.remainingDates.length > 0 && hasTime()) {
        const date = state.remainingDates.shift()!;
        try {
          const races = await scrapeRaceList(date);
          for (const race of races) {
            const exists = await dbGet<{ id: string }>('SELECT id FROM races WHERE id = ?', [race.id]);
            if (!exists) {
              await upsertRace({
                id: race.id,
                name: race.name,
                date: race.date,
                racecourseName: race.racecourseName,
                raceNumber: race.raceNumber,
                status: '予定',
              });
            }
          }
          state.stats.datesProcessed++;
        } catch (error) {
          addError(`レース一覧取得失敗 (${date}): ${errMsg(error)}`);
        }
        await sleep(CHUNK_RATE_LIMIT_MS);
      }

      state.phaseRemaining = state.remainingDates.length;
      if (state.remainingDates.length === 0) state.phase = 'race_details';
      return;
    }

    case 'race_details': {
      state.phaseLabel = '出馬表取得';
      const unprocessed = await dbAll<{ id: string; name: string }>(
        "SELECT id, name FROM races WHERE (status = '予定' OR (status = '出走確定' AND distance = 0)) AND date BETWEEN ? AND ? ORDER BY date",
        [state.config.startDate, state.config.endDate]
      );

      state.phaseRemaining = unprocessed.length;

      if (unprocessed.length === 0) {
        state.phase = 'horses';
        return;
      }

      for (const race of unprocessed) {
        if (!hasTime()) return;
        try {
          const detail = await scrapeRaceCard(race.id);
          await upsertRace({
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
            await upsertRaceEntry(race.id, {
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
            state.stats.entriesScraped++;
          }
          state.stats.racesScraped++;
          state.phaseRemaining--;
        } catch (error) {
          addError(`出馬表取得失敗 (${race.id}): ${errMsg(error)}`);
          try { await upsertRace({ id: race.id, status: '出走確定' }); } catch { /* skip */ }
          state.phaseRemaining--;
        }
        await sleep(CHUNK_RATE_LIMIT_MS);
      }

      // 残りを再確認
      const remaining = await dbGet<{ c: number }>(
        "SELECT COUNT(*) as c FROM races WHERE (status = '予定' OR (status = '出走確定' AND distance = 0)) AND date BETWEEN ? AND ?",
        [state.config.startDate, state.config.endDate]
      );
      state.phaseRemaining = remaining?.c ?? 0;
      if ((remaining?.c ?? 0) === 0) state.phase = 'horses';
      return;
    }

    case 'horses': {
      state.phaseLabel = '馬詳細・過去成績取得';
      // プレースホルダー馬（birth_date が NULL）は未処理として扱う
      // FETCH_FAILED / 取得失敗 マーク済みの馬はスキップ
      const unprocessed = await dbAll<{ id: string }>(
        `SELECT DISTINCT h.id
        FROM horses h
        JOIN race_entries re ON h.id = re.horse_id
        WHERE h.birth_date IS NULL AND h.name != '取得失敗'`
      );

      state.phaseRemaining = unprocessed.length;

      if (unprocessed.length === 0) {
        state.phase = 'results';
        return;
      }

      for (const { id: horse_id } of unprocessed) {
        if (!hasTime()) return;
        try {
          const horse = await scrapeHorseDetail(horse_id);
          if (horse) {
            await upsertHorse({
              id: horse.id,
              name: horse.name,
              birthDate: horse.birthDate,
              fatherName: horse.fatherName,
              motherName: horse.motherName,
              trainerName: horse.trainerName,
              ownerName: horse.ownerName,
            });
            state.stats.horsesScraped++;
            const imported = await importHorsePastPerformances(horse, 100);
            state.stats.pastPerformancesImported += imported;
          }
        } catch (error) {
          addError(`馬詳細取得失敗 (${horse_id}): ${errMsg(error)}`);
          // 取得失敗をマークしてリトライを防ぐ（名前は上書きしない）
          try {
            await dbRun(
              "UPDATE horses SET birth_date = 'FETCH_FAILED' WHERE id = ? AND birth_date IS NULL",
              [horse_id]
            );
          } catch { /* skip */ }
        }
        state.phaseRemaining--;
        await sleep(CHUNK_RATE_LIMIT_MS);
      }

      // 残りを再確認
      const remainingRow = await dbGet<{ c: number }>(
        `SELECT COUNT(DISTINCT h.id) as c
        FROM horses h
        JOIN race_entries re ON h.id = re.horse_id
        WHERE h.birth_date IS NULL AND h.name != '取得失敗'`
      );
      const remainingCount = remainingRow?.c ?? 0;
      state.phaseRemaining = remainingCount;
      if (remainingCount === 0) state.phase = 'results';
      return;
    }

    case 'results': {
      state.phaseLabel = 'レース結果取得';
      const today = new Date().toISOString().split('T')[0];
      const unprocessed = await dbAll<{ id: string }>(
        "SELECT id FROM races WHERE status = '出走確定' AND date <= ? AND date BETWEEN ? AND ? ORDER BY date",
        [today, state.config.startDate, state.config.endDate]
      );

      state.phaseRemaining = unprocessed.length;

      if (unprocessed.length === 0) {
        state.phase = 'predictions';
        return;
      }

      for (const race of unprocessed) {
        if (!hasTime()) return;
        try {
          const results = await scrapeRaceResult(race.id);
          for (const r of results) {
            await upsertRaceEntry(race.id, {
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
            if (r.odds > 0) {
              await upsertOdds(race.id, '単勝', [r.horseNumber], r.odds);
              await upsertRaceEntryOdds(race.id, r.horseNumber, r.odds, r.popularity);
            }
            state.stats.resultsScraped++;
          }
          await upsertRace({ id: race.id, status: '結果確定' });
        } catch (error) {
          addError(`結果取得失敗 (${race.id}): ${errMsg(error)}`);
          // スクレイプ失敗時は結果確定にしない（リトライ可能にする）
        }
        state.phaseRemaining--;
        await sleep(CHUNK_RATE_LIMIT_MS);
      }

      // 残りを再確認
      const remainingRow = await dbGet<{ c: number }>(
        "SELECT COUNT(*) as c FROM races WHERE status = '出走確定' AND date <= ? AND date BETWEEN ? AND ?",
        [today, state.config.startDate, state.config.endDate]
      );
      const remainingCount = remainingRow?.c ?? 0;
      state.phaseRemaining = remainingCount;
      if (remainingCount === 0) state.phase = 'odds';
      return;
    }

    case 'odds': {
      state.phaseLabel = 'オッズ取得';
      // オッズ未取得のレースを対象（ステータス問わず）
      const targetRaces = await dbAll<{ id: string; name: string; status: string }>(
        `SELECT r.id, r.name, r.status FROM races r
         WHERE r.date BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM odds o WHERE o.race_id = r.id)
         ORDER BY r.date`,
        [state.config.startDate, state.config.endDate]
      );

      state.phaseRemaining = targetRaces.length;

      if (targetRaces.length === 0) {
        state.phase = 'predictions';
        return;
      }

      for (const race of targetRaces) {
        if (!hasTime()) return;
        try {
          // まず odds API を試行（未確定レース向け）
          const odds = await scrapeOdds(race.id);
          if (odds.win.length > 0) {
            for (const w of odds.win) {
              await upsertOdds(race.id, '単勝', [w.horseNumber], w.odds);
              state.stats.oddsScraped++;
            }
            for (const p of odds.place) {
              await upsertOdds(race.id, '複勝', [p.horseNumber], p.minOdds, p.minOdds, p.maxOdds);
              state.stats.oddsScraped++;
            }
          } else {
            // API が空 → result.html からオッズを取得（確定レース向け）
            const results = await scrapeRaceResult(race.id);
            for (const r of results) {
              if (r.odds > 0) {
                await upsertOdds(race.id, '単勝', [r.horseNumber], r.odds);
                await upsertRaceEntryOdds(race.id, r.horseNumber, r.odds, r.popularity);
                state.stats.oddsScraped++;
              }
            }
          }
        } catch (error) {
          addError(`オッズ取得失敗 (${race.id}): ${errMsg(error)}`);
        }
        state.phaseRemaining--;
        await sleep(CHUNK_RATE_LIMIT_MS);
      }

      state.phase = 'predictions';
      return;
    }

    case 'predictions': {
      state.phaseLabel = 'AI予想生成';
      const today = new Date().toISOString().split('T')[0];
      const unprocessed = await dbAll<{
        id: string; name: string; date: string; track_type: string;
        distance: number; track_condition: string; racecourse_name: string; grade: string;
      }>(
        `SELECT DISTINCT r.id, r.name, r.date, r.track_type, r.distance,
               r.track_condition, r.racecourse_name, r.grade
        FROM races r
        LEFT JOIN predictions p ON r.id = p.race_id
        WHERE p.id IS NULL AND r.date >= ?
        AND r.status IN ('出走確定', '結果確定')
        AND r.date BETWEEN ? AND ?`,
        [today, state.config.startDate, state.config.endDate]
      );

      state.phaseRemaining = unprocessed.length;

      if (unprocessed.length === 0) {
        state.phase = 'evaluate';
        return;
      }

      for (const race of unprocessed) {
        if (!hasTime()) return;
        try {
          const raceData = await getRaceById(race.id);
          if (!raceData?.entries?.length) {
            state.phaseRemaining--;
            continue;
          }

          const horseInputs = await Promise.all(
            raceData.entries.map(async (re: import('@/types').RaceEntry) => {
              const pastPerfs = await getHorsePastPerformances(re.horseId, 100);
              const horseData = await getHorseById(re.horseId) as { father_name?: string } | null;
              const jockeyStats = await getJockeyStats(re.jockeyId);
              return {
                entry: re,
                pastPerformances: pastPerfs,
                jockeyWinRate: jockeyStats.winRate,
                jockeyPlaceRate: jockeyStats.placeRate,
                fatherName: horseData?.father_name || '',
              };
            })
          );

          if (horseInputs.length > 0) {
            const prediction = await generatePrediction(
              race.id, race.name, race.date,
              race.track_type as '芝' | 'ダート' | '障害', race.distance,
              race.track_condition as '良' | '稍重' | '重' | '不良' | undefined, race.racecourse_name, race.grade,
              horseInputs,
            );
            await savePrediction(prediction);
            state.stats.predictionsGenerated++;
          }
        } catch (error) {
          addError(`予想生成失敗 (${race.id}): ${errMsg(error)}`);
        }
        state.phaseRemaining--;
      }

      const remainingRow = await dbGet<{ c: number }>(
        `SELECT COUNT(DISTINCT r.id) as c
        FROM races r
        LEFT JOIN predictions p ON r.id = p.race_id
        WHERE p.id IS NULL AND r.date >= ?
        AND r.status IN ('出走確定', '結果確定')
        AND r.date BETWEEN ? AND ?`,
        [today, state.config.startDate, state.config.endDate]
      );
      const remainingCount = remainingRow?.c ?? 0;
      state.phaseRemaining = remainingCount;
      if (remainingCount === 0) state.phase = 'evaluate';
      return;
    }

    case 'evaluate': {
      state.phaseLabel = '予想照合';
      await evaluateAllPendingRaces();
      state.phase = 'done';
      state.completedAt = new Date().toISOString();
      state.phaseLabel = '完了';
      state.phaseRemaining = 0;
      return;
    }

    case 'done':
      return;
  }
}
