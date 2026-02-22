import { NextRequest, NextResponse } from 'next/server';
import {
  scrapeRaceList,
  scrapeRaceCard,
  scrapeOdds,
  scrapeRaceResult,
  scrapeHorseDetail,
} from '@/lib/scraper';
import type {
  ScrapedRace,
  ScrapedRaceDetail,
  ScrapedOdds,
  ScrapedResult,
  ScrapedHorseDetail,
} from '@/lib/scraper';
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
} from '@/lib/queries';
import { generatePrediction } from '@/lib/prediction-engine';
import { runBulkImport, getBulkImportProgress, abortBulkImport, type BulkImportConfig } from '@/lib/bulk-importer';
import type { PastPerformance } from '@/types';

// ==================== Types ====================

type SyncType = 'races' | 'race_detail' | 'odds' | 'results' | 'horse' | 'full' | 'bulk' | 'bulk_status' | 'bulk_abort';

interface SyncRequest {
  type: SyncType;
  date?: string;
  raceId?: string;
  horseId?: string;
  // バルクインポート用
  startDate?: string;
  endDate?: string;
  clearExisting?: boolean;
  maxPastPerformances?: number;
}

interface SyncLogEntry {
  id: string;
  type: SyncType;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  details: string;
  errors: string[];
  stats: {
    racesScraped: number;
    entriesScraped: number;
    horsesScraped: number;
    oddsScraped: number;
    resultsScraped: number;
    predictionsGenerated: number;
  };
}

// ==================== In-memory sync log ====================

const syncLog: SyncLogEntry[] = [];
const MAX_LOG_ENTRIES = 50;
let currentSync: SyncLogEntry | null = null;

// ==================== Rate limiting helper ====================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RATE_LIMIT_MS = 1000; // 1 second between requests to netkeiba

// ==================== Authorization ====================

function isAuthorized(request: NextRequest): boolean {
  const syncKey = process.env.SYNC_KEY;
  // If SYNC_KEY is not set, allow all requests
  if (!syncKey) return true;
  const provided = request.headers.get('x-sync-key');
  return provided === syncKey;
}

// ==================== GET: Sync status / history ====================

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: '認証エラー: 無効な同期キーです' }, { status: 401 });
  }

  return NextResponse.json({
    currentSync: currentSync || null,
    history: syncLog.slice(0, 20),
    isRunning: currentSync !== null && currentSync.status === 'running',
  });
}

// ==================== POST: Trigger sync ====================

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: '認証エラー: 無効な同期キーです' }, { status: 401 });
  }

  // Reject if a sync is already running
  if (currentSync && currentSync.status === 'running') {
    return NextResponse.json(
      {
        error: '同期処理が既に実行中です',
        currentSync,
      },
      { status: 409 }
    );
  }

  let body: SyncRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'リクエストボディのパースに失敗しました。JSON形式で送信してください。' },
      { status: 400 }
    );
  }

  const { type, date, raceId, horseId } = body;

  // Validate type
  const validTypes: SyncType[] = ['races', 'race_detail', 'odds', 'results', 'horse', 'full', 'bulk', 'bulk_status', 'bulk_abort'];
  if (!type || !validTypes.includes(type)) {
    return NextResponse.json(
      {
        error: `無効なtypeです。有効な値: ${validTypes.join(', ')}`,
      },
      { status: 400 }
    );
  }

  // バルクインポートの状態確認
  if (type === 'bulk_status') {
    const progress = getBulkImportProgress();
    return NextResponse.json({ progress });
  }

  // バルクインポートの中断
  if (type === 'bulk_abort') {
    abortBulkImport();
    return NextResponse.json({ message: 'バルクインポートの中断を要求しました' });
  }

  // バルクインポート開始
  if (type === 'bulk') {
    const { startDate, endDate, clearExisting, maxPastPerformances } = body;
    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: 'type="bulk" にはstartDateとendDateが必要です (YYYY-MM-DD)' },
        { status: 400 }
      );
    }

    const config: BulkImportConfig = {
      startDate,
      endDate,
      clearExisting: clearExisting || false,
      maxPastPerformances: maxPastPerformances || 50,
    };

    // バックグラウンドで実行開始
    runBulkImport(config).catch(err => {
      console.error('バルクインポートエラー:', err);
    });

    return NextResponse.json({
      message: 'バルクインポートを開始しました',
      config,
    });
  }

  // Validate required parameters per type
  if ((type === 'race_detail' || type === 'odds' || type === 'results') && !raceId) {
    return NextResponse.json(
      { error: `type="${type}" にはraceIdパラメータが必要です` },
      { status: 400 }
    );
  }
  if (type === 'horse' && !horseId) {
    return NextResponse.json(
      { error: 'type="horse" にはhorseIdパラメータが必要です' },
      { status: 400 }
    );
  }

  // Initialize sync log entry
  const syncEntry: SyncLogEntry = {
    id: `sync_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    type,
    status: 'running',
    startedAt: new Date().toISOString(),
    details: '',
    errors: [],
    stats: {
      racesScraped: 0,
      entriesScraped: 0,
      horsesScraped: 0,
      oddsScraped: 0,
      resultsScraped: 0,
      predictionsGenerated: 0,
    },
  };

  currentSync = syncEntry;

  // Execute sync in background (non-blocking for the HTTP response)
  executeSyncInBackground(syncEntry, type, date, raceId, horseId);

  return NextResponse.json({
    message: '同期処理を開始しました',
    syncId: syncEntry.id,
    type,
  });
}

// ==================== Background sync execution ====================

async function executeSyncInBackground(
  entry: SyncLogEntry,
  type: SyncType,
  date?: string,
  raceId?: string,
  horseId?: string
): Promise<void> {
  try {
    switch (type) {
      case 'races':
        await syncRaceList(entry, date);
        break;
      case 'race_detail':
        await syncRaceDetail(entry, raceId!);
        break;
      case 'odds':
        await syncOdds(entry, raceId!);
        break;
      case 'results':
        await syncResults(entry, raceId!);
        break;
      case 'horse':
        await syncHorseDetail(entry, horseId!);
        break;
      case 'full':
        await syncFull(entry, date);
        break;
    }
    entry.status = 'completed';
    entry.details = `同期完了: ${buildStatsSummary(entry.stats)}`;
  } catch (error) {
    entry.status = 'failed';
    const errMsg = error instanceof Error ? error.message : String(error);
    entry.errors.push(errMsg);
    entry.details = `同期失敗: ${errMsg}`;
  } finally {
    entry.completedAt = new Date().toISOString();
    currentSync = null;

    // Add to log history
    syncLog.unshift(entry);
    if (syncLog.length > MAX_LOG_ENTRIES) {
      syncLog.length = MAX_LOG_ENTRIES;
    }
  }
}

function buildStatsSummary(stats: SyncLogEntry['stats']): string {
  const parts: string[] = [];
  if (stats.racesScraped > 0) parts.push(`レース${stats.racesScraped}件`);
  if (stats.entriesScraped > 0) parts.push(`出走馬${stats.entriesScraped}頭`);
  if (stats.horsesScraped > 0) parts.push(`馬詳細${stats.horsesScraped}件`);
  if (stats.oddsScraped > 0) parts.push(`オッズ${stats.oddsScraped}件`);
  if (stats.resultsScraped > 0) parts.push(`結果${stats.resultsScraped}件`);
  if (stats.predictionsGenerated > 0) parts.push(`予想${stats.predictionsGenerated}件`);
  return parts.length > 0 ? parts.join('、') : 'データなし';
}

// ==================== Sync: Race List ====================

async function syncRaceList(entry: SyncLogEntry, date?: string): Promise<ScrapedRace[]> {
  const targetDate = date || new Date().toISOString().split('T')[0];
  entry.details = `レース一覧を取得中: ${targetDate}`;

  const races: ScrapedRace[] = await scrapeRaceList(targetDate);

  for (const race of races) {
    upsertRace({
      id: race.id,
      name: race.name,
      date: race.date,
      racecourseName: race.racecourseName,
      raceNumber: race.raceNumber,
      status: '予定',
    });
    entry.stats.racesScraped++;
  }

  entry.details = `レース一覧取得完了: ${targetDate} - ${races.length}件`;
  return races;
}

// ==================== Sync: Race Detail ====================

async function syncRaceDetail(entry: SyncLogEntry, raceId: string): Promise<ScrapedRaceDetail> {
  entry.details = `出馬表を取得中: ${raceId}`;

  const detail: ScrapedRaceDetail = await scrapeRaceCard(raceId);

  // Update race with full details
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
    grade: detail.grade as Race['grade'],
    status: '出走確定',
  });
  entry.stats.racesScraped++;

  // Upsert each entry
  for (const e of detail.entries) {
    upsertRaceEntry(raceId, {
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
    entry.stats.entriesScraped++;
  }

  entry.details = `出馬表取得完了: ${detail.name} - ${detail.entries.length}頭`;
  return detail;
}

// ==================== Sync: Odds ====================

async function syncOdds(entry: SyncLogEntry, raceId: string): Promise<ScrapedOdds> {
  entry.details = `オッズを取得中: ${raceId}`;

  const odds: ScrapedOdds = await scrapeOdds(raceId);

  // Upsert win odds
  for (const w of odds.win) {
    upsertOdds(raceId, '単勝', [w.horseNumber], w.odds);
    entry.stats.oddsScraped++;
  }

  // Upsert place odds
  for (const p of odds.place) {
    upsertOdds(raceId, '複勝', [p.horseNumber], p.minOdds, p.minOdds, p.maxOdds);
    entry.stats.oddsScraped++;
  }

  entry.details = `オッズ取得完了: 単勝${odds.win.length}件、複勝${odds.place.length}件`;
  return odds;
}

// ==================== Sync: Results ====================

async function syncResults(entry: SyncLogEntry, raceId: string): Promise<ScrapedResult[]> {
  entry.details = `レース結果を取得中: ${raceId}`;

  const results: ScrapedResult[] = await scrapeRaceResult(raceId);

  for (const r of results) {
    upsertRaceEntry(raceId, {
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
    entry.stats.resultsScraped++;
  }

  // Update race status
  if (results.length > 0) {
    upsertRace({
      id: raceId,
      status: '結果確定',
    });
  }

  entry.details = `結果取得完了: ${results.length}頭`;
  return results;
}

// ==================== Sync: Horse Detail ====================

async function syncHorseDetail(entry: SyncLogEntry, horseId: string): Promise<ScrapedHorseDetail | null> {
  entry.details = `馬詳細を取得中: ${horseId}`;

  const horse: ScrapedHorseDetail | null = await scrapeHorseDetail(horseId);
  if (!horse) {
    entry.errors.push(`馬が見つかりません: ${horseId}`);
    entry.details = `馬詳細取得失敗: ${horseId}`;
    return null;
  }

  // Upsert horse basic info
  upsertHorse({
    id: horse.id,
    name: horse.name,
    birthDate: horse.birthDate,
    fatherName: horse.fatherName,
    motherName: horse.motherName,
    trainerName: horse.trainerName,
    ownerName: horse.ownerName,
  });
  entry.stats.horsesScraped++;

  // Insert past performances (only new ones)
  const existingPerfs = getHorsePastPerformances(horse.id, 100);
  const existingDates = new Set(existingPerfs.map((p: PastPerformance) => p.date));

  for (const perf of horse.pastPerformances) {
    if (!existingDates.has(perf.date)) {
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
    }
  }

  entry.details = `馬詳細取得完了: ${horse.name} - 過去成績${horse.pastPerformances.length}件`;
  return horse;
}

// ==================== Sync: Full ====================

async function syncFull(entry: SyncLogEntry, date?: string): Promise<void> {
  const targetDate = date || new Date().toISOString().split('T')[0];
  entry.details = `フル同期開始: ${targetDate}`;

  // Step 1: Scrape race list
  entry.details = `[1/5] レース一覧を取得中: ${targetDate}`;
  const races = await syncRaceList(entry, targetDate);
  await sleep(RATE_LIMIT_MS);

  if (races.length === 0) {
    entry.details = `フル同期完了: ${targetDate} - レースが見つかりませんでした`;
    return;
  }

  // Step 2: For each race, scrape race card details
  entry.details = `[2/5] 出馬表を取得中: 全${races.length}レース`;
  const raceDetails: ScrapedRaceDetail[] = [];
  for (const race of races) {
    try {
      const detail = await syncRaceDetail(entry, race.id);
      raceDetails.push(detail);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      entry.errors.push(`出馬表取得失敗 (${race.id}): ${errMsg}`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  // Step 3: Scrape odds for each race
  entry.details = `[3/5] オッズを取得中: 全${raceDetails.length}レース`;
  for (const detail of raceDetails) {
    try {
      await syncOdds(entry, detail.id);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      entry.errors.push(`オッズ取得失敗 (${detail.id}): ${errMsg}`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  // Step 4: For each horse in entries, scrape horse details
  entry.details = `[4/5] 馬詳細を取得中`;
  const processedHorseIds = new Set<string>();
  for (const detail of raceDetails) {
    for (const e of detail.entries) {
      if (processedHorseIds.has(e.horseId)) continue;
      processedHorseIds.add(e.horseId);

      try {
        await syncHorseDetail(entry, e.horseId);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        entry.errors.push(`馬詳細取得失敗 (${e.horseId} ${e.horseName}): ${errMsg}`);
      }
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Step 5: Generate predictions for each race
  entry.details = `[5/5] AI予想を生成中`;
  for (const detail of raceDetails) {
    try {
      const raceData = getRaceById(detail.id);
      if (!raceData || !raceData.entries || raceData.entries.length === 0) continue;

      // Build horse analysis inputs for prediction engine
      const horseInputs = raceData.entries.map((re) => {
        const pastPerfs = getHorsePastPerformances(re.horseId, 50);
        const horseData = getHorseById(re.horseId) as { father_name?: string } | null;
        return {
          entry: re,
          pastPerformances: pastPerfs,
          jockeyWinRate: 0.08, // default if jockey stats not available
          jockeyPlaceRate: 0.20,
          fatherName: horseData?.father_name || '',
        };
      });

      const prediction = generatePrediction(
        detail.id,
        detail.name,
        targetDate,
        detail.trackType,
        detail.distance,
        detail.trackCondition,
        detail.racecourseName,
        detail.grade,
        horseInputs,
      );

      savePrediction(prediction);
      entry.stats.predictionsGenerated++;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      entry.errors.push(`予想生成失敗 (${detail.id}): ${errMsg}`);
    }
  }

  entry.details = `フル同期完了: ${targetDate} - ${buildStatsSummary(entry.stats)}`;
}

// ==================== Type import for Race (used in upsertRace grade cast) ====================

type Race = import('@/types').Race;
