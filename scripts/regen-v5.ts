/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * v5.0予測エンジンで直近N日分の予測を再生成し、精度を比較する（最適化版）
 *
 * 全データを一括プリロード（~7クエリ）→ メモリキャッシュで予想生成 → 結果をTursoに書き戻し
 * 従来版の数千回のDBリードを6-7回に削減。
 *
 * npx tsx -r tsconfig-paths/register scripts/regen-v5.ts [--days 60] [--resume] [--limit N]
 *
 * オプション:
 *   --days N     対象期間（デフォルト: 60日）
 *   --resume     既にv5.0予測がある レースをスキップ
 *   --limit N    処理レース数の上限
 */
import { readFileSync } from 'fs';

const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}


import { ensureInitialized, dbAll, dbGet, dbRun } from '../src/lib/database';
import { generatePrediction, type HorseAnalysisInput } from '../src/lib/prediction-engine';
import type { TrackType, TrackCondition, Weather, PastPerformance } from '../src/types';

// ==================== CLI引数 ====================

const DAYS = process.argv.includes('--days')
  ? parseInt(process.argv[process.argv.indexOf('--days') + 1], 10)
  : 60;
const RESUME = process.argv.includes('--resume');
const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : 0;

// ==================== 型定義 ====================

interface RaceRow {
  id: string; name: string; date: string; track_type: string;
  distance: number; track_condition: string | null; racecourse_name: string;
  grade: string | null; weather: string | null; status: string;
  racecourse_id: string; race_number: number; time: string | null;
}

interface EntryRow {
  race_id: string; post_position: number; horse_number: number;
  horse_id: string; horse_name: string; age: number; sex: string;
  weight: number | null; jockey_id: string; jockey_name: string;
  trainer_name: string; handicap_weight: number;
  odds: number | null; popularity: number | null;
  result_position: number | null; result_time: string | null;
  result_margin: string | null; result_last_three_furlongs: string | null;
  result_corner_positions: string | null;
  result_weight: number | null; result_weight_change: number | null;
}

interface HorseRow {
  id: string; name: string; father_name: string | null; trainer_name: string | null;
}

interface PerfRow {
  horse_id: string; race_id: string | null; date: string;
  race_name: string; racecourse_name: string; track_type: string;
  distance: number; track_condition: string | null; weather: string | null;
  entries: number; post_position: number; horse_number: number;
  position: number; jockey_name: string | null; handicap_weight: number;
  weight: number; weight_change: number;
  time: string | null; margin: string | null;
  last_three_furlongs: string | null; corner_positions: string | null;
  odds: number; popularity: number; prize: number;
}

interface JockeyRow {
  id: string; name: string; win_rate: number; place_rate: number; total_races: number;
}

interface OddsRow {
  race_id: string; horse_number1: number; odds: number;
}

// ==================== メモリキャッシュ ====================

let racesById: Map<string, RaceRow>;
let entriesByRace: Map<string, EntryRow[]>;
let horsesById: Map<string, HorseRow>;
let perfsByHorse: Map<string, PerfRow[]>;
let jockeysById: Map<string, JockeyRow>;
let jockeyNameById: Map<string, string>;
let horseIdsByFather: Map<string, string[]>;
let resultEntriesByVenueDate: Map<string, EntryRow[]>;
let fieldSizeByRace: Map<string, number>;

// v5.0追加キャッシュ
let oddsByRace: Map<string, Map<number, number>>;
// 騎手レース履歴: jockey_id → {result_position, date}[]
let jockeyRaceHistory: Map<string, { result_position: number; date: string }[]>;
// 高速フィルタ用: position <= 5 かつ time != null の過去成績
let topFinisherPerfs: PerfRow[];

// ==================== データプリロード ====================

async function preloadData() {
  console.log('=== データプリロード（Tursoから一括読み込み） ===');
  const t0 = Date.now();

  // 1. 全レース
  const allRaces = await dbAll<RaceRow>('SELECT * FROM races');
  racesById = new Map(allRaces.map(r => [r.id, r]));
  console.log(`  races: ${allRaces.length}`);

  // 2. 全出走馬
  const allEntries = await dbAll<EntryRow>('SELECT * FROM race_entries ORDER BY race_id, horse_number');
  entriesByRace = new Map();
  fieldSizeByRace = new Map();
  for (const e of allEntries) {
    const arr = entriesByRace.get(e.race_id) || [];
    arr.push(e);
    entriesByRace.set(e.race_id, arr);
  }
  for (const [rid, entries] of entriesByRace) {
    fieldSizeByRace.set(rid, entries.length);
  }
  console.log(`  race_entries: ${allEntries.length}`);

  // 3. 全馬
  const allHorses = await dbAll<HorseRow>('SELECT id, name, father_name, trainer_name FROM horses');
  horsesById = new Map(allHorses.map(h => [h.id, h]));
  horseIdsByFather = new Map();
  for (const h of allHorses) {
    if (h.father_name) {
      const arr = horseIdsByFather.get(h.father_name) || [];
      arr.push(h.id);
      horseIdsByFather.set(h.father_name, arr);
    }
  }
  console.log(`  horses: ${allHorses.length}`);

  // 4. 全過去成績
  const allPerfs = await dbAll<PerfRow>('SELECT * FROM past_performances ORDER BY horse_id, date DESC');
  perfsByHorse = new Map();
  topFinisherPerfs = [];
  for (const p of allPerfs) {
    const arr = perfsByHorse.get(p.horse_id) || [];
    arr.push(p);
    perfsByHorse.set(p.horse_id, arr);
    // v5.0: getDynamicStandardTimes用の高速フィルタ
    if (p.position > 0 && p.position <= 5 && p.time && p.time !== '') {
      topFinisherPerfs.push(p);
    }
  }
  // date DESC でソート済みを保証
  topFinisherPerfs.sort((a, b) => b.date.localeCompare(a.date));
  console.log(`  past_performances: ${allPerfs.length} (position<=5 w/time: ${topFinisherPerfs.length})`);

  // 5. 全騎手
  const allJockeys = await dbAll<JockeyRow>('SELECT id, name, win_rate, place_rate, total_races FROM jockeys');
  jockeysById = new Map(allJockeys.map(j => [j.id, j]));
  jockeyNameById = new Map(allJockeys.map(j => [j.id, j.name]));
  console.log(`  jockeys: ${allJockeys.length}`);

  // 6. 単勝オッズ
  const allOdds = await dbAll<OddsRow>(
    "SELECT race_id, horse_number1, odds FROM odds WHERE bet_type = '単勝'"
  );
  oddsByRace = new Map();
  for (const o of allOdds) {
    let raceMap = oddsByRace.get(o.race_id);
    if (!raceMap) {
      raceMap = new Map();
      oddsByRace.set(o.race_id, raceMap);
    }
    if (o.horse_number1 && o.odds > 0) {
      raceMap.set(o.horse_number1, o.odds);
    }
  }
  console.log(`  odds (単勝): ${allOdds.length}`);

  // 結果確定レースの出走馬（track bias用）
  resultEntriesByVenueDate = new Map();
  for (const [raceId, entries] of entriesByRace) {
    const race = racesById.get(raceId);
    if (!race || race.status !== '結果確定') continue;
    const key = `${race.racecourse_name}__${race.date}`;
    const arr = resultEntriesByVenueDate.get(key) || [];
    for (const e of entries) {
      if (e.result_position != null && e.result_position > 0) {
        arr.push(e);
      }
    }
    resultEntriesByVenueDate.set(key, arr);
  }

  // 騎手レース履歴（getJockeyRecentForm用）
  jockeyRaceHistory = new Map();
  for (const [raceId, entries] of entriesByRace) {
    const race = racesById.get(raceId);
    if (!race || race.status !== '結果確定') continue;
    for (const e of entries) {
      if (e.jockey_id && e.result_position != null) {
        const arr = jockeyRaceHistory.get(e.jockey_id) || [];
        arr.push({ result_position: e.result_position, date: race.date });
        jockeyRaceHistory.set(e.jockey_id, arr);
      }
    }
  }
  // 日付降順ソート
  for (const [, arr] of jockeyRaceHistory) {
    arr.sort((a, b) => b.date.localeCompare(a.date));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  プリロード完了: ${elapsed}秒\n`);
}

// ==================== メモリ内計算関数 ====================

function computeJockeyStats(jockeyId: string) {
  let total = 0, wins = 0, places = 0;
  for (const [raceId, entries] of entriesByRace) {
    const race = racesById.get(raceId);
    if (!race || race.status !== '結果確定') continue;
    for (const e of entries) {
      if (e.jockey_id === jockeyId && e.result_position != null) {
        total++;
        if (e.result_position === 1) wins++;
        if (e.result_position <= 2) places++;
      }
    }
  }
  return { total, wins, places };
}

function computeCourseDistancePerfs(racecourse: string, trackType: string, minDist: number, maxDist: number) {
  const results: any[] = [];
  for (const perfs of perfsByHorse.values()) {
    for (const p of perfs) {
      if (p.racecourse_name === racecourse && p.track_type === trackType
          && p.distance >= minDist && p.distance <= maxDist && p.entries > 0) {
        results.push({
          post_position: p.post_position,
          position: p.position,
          entries: p.entries,
          last_three_furlongs: p.last_three_furlongs,
          corner_positions: p.corner_positions,
        });
      }
    }
  }
  return results;
}

function computeSirePerfs(fatherName: string) {
  const childIds = horseIdsByFather.get(fatherName) || [];
  const results: any[] = [];
  for (const hid of childIds) {
    const perfs = perfsByHorse.get(hid) || [];
    for (const p of perfs) {
      if (p.entries > 0) {
        results.push({
          track_type: p.track_type,
          distance: p.distance,
          track_condition: p.track_condition,
          position: p.position,
          entries: p.entries,
        });
      }
    }
  }
  return results;
}

function computeJockeyTrainerPerfs(jockeyId: string, trainerName: string) {
  const jockeyName = jockeyNameById.get(jockeyId);
  if (!jockeyName) return [];
  const results: any[] = [];
  for (const [horseId, perfs] of perfsByHorse) {
    const horse = horsesById.get(horseId);
    if (!horse || horse.trainer_name !== trainerName) continue;
    for (const p of perfs) {
      if (p.jockey_name === jockeyName && p.entries > 0) {
        results.push({ position: p.position, entries: p.entries });
      }
    }
  }
  return results;
}

function computeTrainerPerfs(trainerName: string) {
  const results: any[] = [];
  for (const [raceId, entries] of entriesByRace) {
    const race = racesById.get(raceId);
    if (!race || race.status !== '結果確定') continue;
    for (const e of entries) {
      if (e.trainer_name === trainerName && e.result_position != null) {
        results.push({
          result_position: e.result_position,
          track_type: race.track_type,
          date: race.date,
        });
      }
    }
  }
  return results;
}

function computeSeasonalPerfs(horseId: string) {
  const perfs = perfsByHorse.get(horseId) || [];
  const results: any[] = [];
  for (const p of perfs) {
    if (p.date && p.entries > 0) {
      const month = parseInt(p.date.substring(5, 7), 10);
      if (month >= 1 && month <= 12) {
        results.push({ month, position: p.position, entries: p.entries });
      }
    }
  }
  return results;
}

function computeTrackBiasEntries(racecourse: string, date: string, trackType?: string) {
  const key = `${racecourse}__${date}`;
  const allEntries = resultEntriesByVenueDate.get(key) || [];
  const results: any[] = [];
  for (const e of allEntries) {
    const race = racesById.get(e.race_id);
    if (trackType && race && race.track_type !== trackType) continue;
    results.push({
      race_id: e.race_id,
      post_position: e.post_position,
      horse_number: e.horse_number,
      result_position: e.result_position,
      field_size: fieldSizeByRace.get(e.race_id) || 0,
      result_corner_positions: e.result_corner_positions,
    });
  }
  return results;
}

// v5.1新規: getPaceProfile用メモリ計算
function computePaceProfilePerfs(racecourse: string, trackType: string, minDist: number, maxDist: number) {
  const results: any[] = [];
  for (const perfs of perfsByHorse.values()) {
    for (const p of perfs) {
      if (results.length >= 500) break;
      if (p.racecourse_name === racecourse && p.track_type === trackType
          && p.distance >= minDist && p.distance <= maxDist
          && p.entries > 0 && p.position > 0
          && p.corner_positions && p.corner_positions.includes('-')) {
        results.push({
          corner_positions: p.corner_positions,
          position: p.position,
          entries: p.entries,
        });
      }
    }
    if (results.length >= 500) break;
  }
  // date DESC ソート相当（perfsByHorseは各馬内でdate DESCだが、全体はソートされていない）
  return results;
}

// v5.0新規: getDynamicStandardTimes用メモリ計算
function computeDynamicStdTimes(args: any[], hasCourseFilter: boolean) {
  let racecourse: string | undefined;
  let trackType: string;
  let minDist: number;
  let maxDist: number;
  let condGroup: string[];
  let limit: number;

  if (hasCourseFilter) {
    // args: [racecourse, trackType, minDist, maxDist, ...condGroup]
    racecourse = args[0];
    trackType = args[1];
    minDist = args[2];
    maxDist = args[3];
    condGroup = args.slice(4);
    limit = 200;
  } else {
    // args: [trackType, minDist, maxDist, ...condGroup]
    trackType = args[0];
    minDist = args[1];
    maxDist = args[2];
    condGroup = args.slice(3);
    limit = 300;
  }

  const results: any[] = [];
  for (const p of topFinisherPerfs) {
    if (results.length >= limit) break;
    if (racecourse && p.racecourse_name !== racecourse) continue;
    if (p.track_type !== trackType) continue;
    if (p.distance < minDist || p.distance > maxDist) continue;
    if (!condGroup.includes(p.track_condition || '')) continue;
    results.push({ time: p.time });
  }
  return results;
}

// v5.0新規: getJockeyRecentForm用メモリ計算
function computeJockeyRecentFormData(jockeyId: string) {
  const history = jockeyRaceHistory.get(jockeyId) || [];
  return history.map(h => ({
    result_position: h.result_position,
    date: h.date,
  }));
}

// v5.0新規: getWinOddsMap用メモリ計算
function computeWinOdds(raceId: string) {
  const raceOdds = oddsByRace.get(raceId);
  if (!raceOdds) return [];
  return Array.from(raceOdds.entries()).map(([hn, odds]) => ({
    horse_number1: hn,
    odds,
  }));
}

// ==================== モック結果生成 ====================

function mockResult(rows: any[]) {
  return {
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    columnTypes: [],
    rows: rows.map(r => {
      const row: any = { ...r };
      const values = Object.values(r);
      values.forEach((v, i) => { row[i] = v; });
      row.length = values.length;
      return row;
    }),
    rowsAffected: 0,
    lastInsertRowid: undefined,
  };
}

// ==================== SQLインターセプター ====================

function installCacheInterceptor(client: any) {
  const origExecute = client.execute.bind(client);
  let cacheHits = 0;
  let cacheMisses = 0;

  client.execute = async function (stmt: any) {
    const sql: string = typeof stmt === 'string' ? stmt : stmt.sql;
    const args: any[] = typeof stmt === 'string' ? [] : (stmt.args || []);
    const sqlNorm = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    // --- races ---
    if (sqlNorm.includes('from races where id =') || sqlNorm.includes('from races r where r.id =')) {
      cacheHits++;
      const race = racesById.get(args[0]);
      return mockResult(race ? [race] : []);
    }

    // --- race_entries by race_id (SELECT only) ---
    if (sqlNorm.includes('from race_entries where race_id =') && !sqlNorm.includes('update') && !sqlNorm.includes('delete')) {
      cacheHits++;
      const entries = entriesByRace.get(args[0]) || [];
      return mockResult(entries);
    }

    // --- v5.0: getDynamicStandardTimes (course-specific) ---
    // past_performances with racecourse_name + distance between + position <= 5 + time is not null
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('position <= 5')
        && sqlNorm.includes('time is not null') && sqlNorm.includes('racecourse_name')) {
      cacheHits++;
      return mockResult(computeDynamicStdTimes(args, true));
    }

    // --- v5.0: getDynamicStandardTimes (fallback, no racecourse) ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('position <= 5')
        && sqlNorm.includes('time is not null') && !sqlNorm.includes('racecourse_name')) {
      cacheHits++;
      return mockResult(computeDynamicStdTimes(args, false));
    }

    // --- past_performances by horse_id (with ORDER BY date DESC LIMIT) ---
    if (sqlNorm.includes('from past_performances where horse_id =') && sqlNorm.includes('order by date desc limit')) {
      cacheHits++;
      const perfs = perfsByHorse.get(args[0]) || [];
      const limit = args[1] || 100;
      return mockResult(perfs.slice(0, limit));
    }

    // --- getPaceProfile: past_performances by racecourse + track_type + distance + entries > 0 + position > 0 + corner_positions ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('racecourse_name') && sqlNorm.includes('distance between')
        && sqlNorm.includes('position > 0') && sqlNorm.includes('corner_positions')) {
      cacheHits++;
      return mockResult(computePaceProfilePerfs(args[0], args[1], args[2], args[3]));
    }

    // --- getCourseDistanceStats: past_performances by racecourse + track_type + distance range ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('racecourse_name') && sqlNorm.includes('distance between')) {
      cacheHits++;
      return mockResult(computeCourseDistancePerfs(args[0], args[1], args[2], args[3]));
    }

    // --- horses by id ---
    if (sqlNorm.includes('from horses where id =')) {
      cacheHits++;
      const horse = horsesById.get(args[0]);
      return mockResult(horse ? [horse] : []);
    }

    // --- horse_traits (always empty) ---
    if (sqlNorm.includes('from horse_traits where horse_id')) {
      cacheHits++;
      return mockResult([]);
    }

    // --- jockeys by id ---
    if (sqlNorm.includes('from jockeys where id =')) {
      cacheHits++;
      const j = jockeysById.get(args[0]);
      return mockResult(j ? [j] : []);
    }

    // --- jockey stats aggregate (race_entries + races, NOT jockey recent form) ---
    if (sqlNorm.includes('from race_entries e') && sqlNorm.includes('join races r') && sqlNorm.includes('e.jockey_id')) {
      cacheHits++;
      return mockResult([computeJockeyStats(args[0])]);
    }

    // --- v5.0: getJockeyRecentForm (race_entries re JOIN races r, jockey_id, result_position is not null) ---
    if (sqlNorm.includes('from race_entries re') && sqlNorm.includes('join races r')
        && sqlNorm.includes('jockey_id') && sqlNorm.includes('result_position is not null')) {
      cacheHits++;
      return mockResult(computeJockeyRecentFormData(args[0]));
    }

    // --- v5.0: getWinOddsMap (odds table) ---
    if (sqlNorm.includes('from odds where') && sqlNorm.includes('race_id') && sqlNorm.includes('bet_type')) {
      cacheHits++;
      return mockResult(computeWinOdds(args[0]));
    }

    // --- getSireStats: past_performances JOIN horses WHERE father_name ---
    if (sqlNorm.includes('from past_performances pp') && sqlNorm.includes('join horses h') && sqlNorm.includes('father_name')) {
      cacheHits++;
      return mockResult(computeSirePerfs(args[0]));
    }

    // --- getTrainerStats (race_entries + races by trainer_name) ---
    if (sqlNorm.includes('from race_entries re') && sqlNorm.includes('join races r') && sqlNorm.includes('re.trainer_name') && sqlNorm.includes('result_position is not null')) {
      cacheHits++;
      return mockResult(computeTrainerPerfs(args[0]));
    }

    // --- getJockeyTrainerCombo ---
    if (sqlNorm.includes('from past_performances pp') && sqlNorm.includes('join horses h') && sqlNorm.includes('jockey_name') && sqlNorm.includes('trainer_name')) {
      cacheHits++;
      return mockResult(computeJockeyTrainerPerfs(args[0], args[1]));
    }

    // --- getHorseSeasonalStats ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('horse_id') && sqlNorm.includes('substr(date')) {
      cacheHits++;
      return mockResult(computeSeasonalPerfs(args[0]));
    }

    // --- getSecondStartBonus: past_performances by horse_id ORDER BY date ASC ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('horse_id') && sqlNorm.includes('order by date asc')) {
      cacheHits++;
      const perfs = perfsByHorse.get(args[0]) || [];
      const filtered = perfs.filter(p => p.entries > 0).reverse();
      return mockResult(filtered.map(p => ({ date: p.date, position: p.position, entries: p.entries })));
    }

    // --- calculateTodayTrackBias ---
    if (sqlNorm.includes('from race_entries re') && sqlNorm.includes('join races r') && sqlNorm.includes('racecourse_name') && sqlNorm.includes('r.date')) {
      cacheHits++;
      return mockResult(computeTrackBiasEntries(args[0], args[1], args[2]));
    }

    // --- 書き込み操作: INSERT / DELETE / UPDATE → Tursoに通す ---
    if (sqlNorm.includes('insert into') || sqlNorm.includes('delete from') || sqlNorm.includes('update ')) {
      cacheMisses++;
      return origExecute(stmt);
    }

    // --- schema/migrations ---
    if (sqlNorm.includes('create table') || sqlNorm.includes('create index') || sqlNorm.includes('alter table') || sqlNorm.includes('insert or ignore')) {
      return origExecute(stmt);
    }

    // --- calibration_weights / category_calibration ---
    if (sqlNorm.includes('calibration_weights') || sqlNorm.includes('category_calibration')) {
      cacheMisses++;
      return origExecute(stmt);
    }

    // キャッチされなかったクエリ → 実DB（警告付き）
    cacheMisses++;
    console.warn(`[UNCACHED] ${sql.substring(0, 100)}... args=${JSON.stringify(args).substring(0, 60)}`);
    return origExecute(stmt);
  };

  const origBatch = client.batch.bind(client);
  client.batch = async function (stmts: any, mode?: any) {
    return origBatch(stmts, mode);
  };

  return { getCacheStats: () => ({ hits: cacheHits, misses: cacheMisses }) };
}

// ==================== インメモリ評価 ====================

interface EvalResult {
  raceId: string;
  topPickHorseId: string;
  topPickActualPosition: number;
  winHit: boolean;
  placeHit: boolean;
  top3Hit: number;
  confidence: number;
  investment: number;
  returnAmt: number;
}

function evaluateInMemory(
  raceId: string,
  topPicks: { horseId: string; horseName: string; rank: number; horseNumber: number }[],
  confidence: number,
): EvalResult | null {
  const entries = entriesByRace.get(raceId) || [];
  const results = entries.filter(e => e.result_position != null && e.result_position > 0);
  if (results.length === 0 || topPicks.length === 0) return null;

  const topPick = topPicks[0];
  const topResult = results.find(r =>
    r.horse_id === topPick.horseId || r.horse_number === topPick.horseNumber
  );
  const actualPos = topResult?.result_position ?? 99;
  const winHit = actualPos === 1;
  const placeHit = actualPos <= 3;

  let top3Hit = 0;
  for (const pick of topPicks.slice(0, 3)) {
    const result = results.find(r =>
      r.horse_id === pick.horseId || r.horse_number === pick.horseNumber
    );
    if (result && result.result_position != null && result.result_position <= 3) top3Hit++;
  }

  // ROI: 単勝100円想定
  const BET = 100;
  let returnAmt = 0;
  if (winHit) {
    const raceOdds = oddsByRace.get(raceId);
    const oddsFromTable = raceOdds?.get(topPick.horseNumber);
    const oddsFromEntry = topResult?.odds;
    const odds = oddsFromTable ?? oddsFromEntry ?? 0;
    returnAmt = BET * odds;
  }

  return {
    raceId,
    topPickHorseId: topPick.horseId || '',
    topPickActualPosition: actualPos,
    winHit, placeHit, top3Hit,
    confidence,
    investment: BET,
    returnAmt,
  };
}

// ==================== メイン ====================

async function main() {
  const startTime = Date.now();

  console.log(`=== v5.0 予測再生成 最適化版 ===`);
  console.log(`期間: 直近${DAYS}日, resume=${RESUME}, limit=${LIMIT || '無制限'}\n`);

  // 1. DB初期化 + プリロード
  const client = await ensureInitialized();
  await preloadData();

  // 2. 対象レース算出
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const targetRaces: RaceRow[] = [];
  for (const race of racesById.values()) {
    if (race.status === '結果確定' && race.date >= cutoffStr) {
      targetRaces.push(race);
    }
  }
  targetRaces.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  console.log(`対象レース数: ${targetRaces.length} (${cutoffStr}〜)\n`);

  // 3. 旧予測の精度（比較用、削除前に取得）
  const oldStats = await dbGet<any>(`
    SELECT
      COUNT(*) as total,
      ROUND(AVG(win_hit) * 100, 1) as win_rate,
      ROUND(AVG(place_hit) * 100, 1) as place_rate,
      CASE WHEN SUM(bet_investment) > 0
        THEN ROUND(SUM(bet_return) / SUM(bet_investment) * 100, 1)
        ELSE 0 END as roi_pct
    FROM prediction_results pr
    JOIN races r ON pr.race_id = r.id
    WHERE r.date >= ?
  `, [cutoffStr]);
  console.log(`旧予測: 単勝${oldStats?.win_rate ?? 'N/A'}%, 複勝${oldStats?.place_rate ?? 'N/A'}%, ROI ${oldStats?.roi_pct ?? 'N/A'}% (${oldStats?.total || 0}件)\n`);

  // 4. キャッシュインターセプター設置
  const { getCacheStats } = installCacheInterceptor(client);

  // 5. 旧予測+結果を削除（RESUMEモード以外）
  let skipSet: Set<string> | undefined;
  if (RESUME) {
    // 既にv5.0予測があるレースを特定してスキップ
    const existingPreds = await dbAll<{ race_id: string }>(
      'SELECT DISTINCT race_id FROM predictions'
    );
    skipSet = new Set(existingPreds.map(p => p.race_id));
    console.log(`RESUMEモード: ${skipSet.size}件の既存予測をスキップ\n`);
  } else {
    // 全削除して再生成
    const raceIds = targetRaces.map(r => r.id);
    // 800+プレースホルダでタイムアウトするためバッチで削除
    const batchSize = 200;
    for (let i = 0; i < raceIds.length; i += batchSize) {
      const batch = raceIds.slice(i, i + batchSize);
      const ph = batch.map(() => '?').join(',');
      await dbRun(`DELETE FROM prediction_results WHERE race_id IN (${ph})`, batch);
      await dbRun(`DELETE FROM predictions WHERE race_id IN (${ph})`, batch);
    }
    console.log(`旧予測削除完了 (${raceIds.length}件)\n`);
  }

  // 6. 予測再生成
  let generated = 0;
  let skipped = 0;
  let errors = 0;
  const evalResults: EvalResult[] = [];

  const racesToProcess = LIMIT > 0
    ? targetRaces.slice(0, LIMIT)
    : targetRaces;

  for (let i = 0; i < racesToProcess.length; i++) {
    const race = racesToProcess[i];

    // RESUMEモード: 既存予測スキップ
    if (skipSet?.has(race.id)) {
      skipped++;
      continue;
    }

    const entries = entriesByRace.get(race.id);
    if (!entries || entries.length === 0) { errors++; continue; }

    try {
      // 馬データ構築（全てメモリキャッシュから）
      const horseInputs: HorseAnalysisInput[] = entries.map(re => {
        const perfs = perfsByHorse.get(re.horse_id) || [];
        const horse = horsesById.get(re.horse_id);
        const jockey = jockeysById.get(re.jockey_id);

        let jockeyWinRate = 0.08;
        let jockeyPlaceRate = 0.20;
        if (jockey && jockey.total_races > 0 && jockey.win_rate > 0) {
          jockeyWinRate = jockey.win_rate;
          jockeyPlaceRate = jockey.place_rate;
        }

        return {
          entry: {
            postPosition: re.post_position,
            horseNumber: re.horse_number,
            horseId: re.horse_id,
            horseName: re.horse_name,
            age: re.age || 0,
            sex: (re.sex || '牡') as '牡' | '牝' | 'セ',
            weight: re.weight ?? undefined,
            jockeyId: re.jockey_id || '',
            jockeyName: re.jockey_name || '',
            trainerName: re.trainer_name || '',
            handicapWeight: re.handicap_weight || 0,
            odds: re.odds ?? undefined,
            popularity: re.popularity ?? undefined,
            result: re.result_position != null ? {
              position: re.result_position,
              time: re.result_time ?? undefined,
              margin: re.result_margin ?? undefined,
              lastThreeFurlongs: re.result_last_three_furlongs ?? undefined,
              cornerPositions: re.result_corner_positions ?? undefined,
            } : undefined,
          },
          pastPerformances: perfs.slice(0, 100).map(p => ({
            horseId: p.horse_id,
            raceId: p.race_id || '',
            date: p.date,
            raceName: p.race_name,
            racecourseName: p.racecourse_name,
            trackType: p.track_type as TrackType,
            distance: p.distance,
            trackCondition: (p.track_condition || '良') as TrackCondition,
            weather: (p.weather || '晴') as Weather,
            entries: p.entries,
            postPosition: p.post_position,
            horseNumber: p.horse_number,
            position: p.position,
            jockeyName: p.jockey_name || '',
            handicapWeight: p.handicap_weight,
            weight: p.weight,
            weightChange: p.weight_change,
            time: p.time || '',
            margin: p.margin || '',
            lastThreeFurlongs: p.last_three_furlongs || '',
            cornerPositions: p.corner_positions || '',
            odds: p.odds ?? 0,
            popularity: p.popularity ?? 0,
            prize: p.prize,
          })) as PastPerformance[],
          jockeyWinRate,
          jockeyPlaceRate,
          fatherName: horse?.father_name || '',
        };
      });

      // v5.0予測生成（内部クエリはキャッシュインターセプターで応答）
      const prediction = await generatePrediction(
        race.id,
        race.name,
        race.date,
        race.track_type as TrackType,
        race.distance,
        (race.track_condition || undefined) as TrackCondition | undefined,
        race.racecourse_name,
        race.grade || undefined,
        horseInputs,
        race.weather || undefined,
      );

      // DB保存（Turso書き込み）
      await dbRun(`
        INSERT INTO predictions (race_id, generated_at, confidence, summary, analysis_json, picks_json, bets_json)
        VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
      `, [
        prediction.raceId, prediction.confidence, prediction.summary,
        JSON.stringify(prediction.analysis),
        JSON.stringify(prediction.topPicks),
        JSON.stringify(prediction.recommendedBets),
      ]);

      // インメモリ評価
      const evalResult = evaluateInMemory(race.id, prediction.topPicks.map(p => ({
        horseId: p.horseId || '',
        horseName: p.horseName,
        rank: p.rank,
        horseNumber: p.horseNumber,
      })), prediction.confidence);
      if (evalResult) {
        evalResults.push(evalResult);
        // prediction_results にも書き込み
        await dbRun(`
          INSERT INTO prediction_results
            (race_id, prediction_id, top_pick_horse_id, top_pick_actual_position,
             win_hit, place_hit, top3_picks_hit, predicted_confidence,
             bet_investment, bet_return, bet_roi)
          VALUES (?, (SELECT id FROM predictions WHERE race_id = ? ORDER BY generated_at DESC LIMIT 1),
                  ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          race.id, race.id,
          evalResult.topPickHorseId,
          evalResult.topPickActualPosition,
          evalResult.winHit ? 1 : 0,
          evalResult.placeHit ? 1 : 0,
          evalResult.top3Hit,
          evalResult.confidence,
          evalResult.investment,
          evalResult.returnAmt,
          evalResult.investment > 0 ? evalResult.returnAmt / evalResult.investment : 0,
        ]);
      }

      generated++;

      if (generated % 50 === 0 || generated === 1 || i === racesToProcess.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const stats = getCacheStats();
        const winRate = evalResults.length > 0
          ? (evalResults.filter(r => r.winHit).length / evalResults.length * 100).toFixed(1)
          : '---';
        console.log(`  [${generated}/${racesToProcess.length - (skipSet?.size || 0)}] ${elapsed}分 | 暫定単勝${winRate}% | Hit:${stats.hits} Miss:${stats.misses}`);
      }
    } catch (error) {
      errors++;
      const msg = error instanceof Error ? error.message : String(error);
      if (errors <= 5) {
        console.error(`  エラー (${race.id} ${race.name}): ${msg}`);
      }
    }
  }

  // 7. 結果集計
  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const stats = getCacheStats();

  const winCount = evalResults.filter(r => r.winHit).length;
  const placeCount = evalResults.filter(r => r.placeHit).length;
  const totalInvested = evalResults.reduce((s, r) => s + r.investment, 0);
  const totalReturned = evalResults.reduce((s, r) => s + r.returnAmt, 0);

  console.log(`\n========================================`);
  console.log(`  v5.0 再生成結果`);
  console.log(`========================================`);
  console.log(`期間: ${cutoffStr}〜`);
  console.log(`生成: ${generated}件, スキップ: ${skipped}件, エラー: ${errors}件`);
  console.log(`評価: ${evalResults.length}件`);
  console.log(``)
  console.log(`              旧予測        v5.0         差分`);
  const newWinRate = evalResults.length > 0 ? (winCount / evalResults.length * 100) : 0;
  const newPlaceRate = evalResults.length > 0 ? (placeCount / evalResults.length * 100) : 0;
  const newRoi = totalInvested > 0 ? (totalReturned / totalInvested * 100) : 0;
  const oldWin = oldStats?.win_rate || 0;
  const oldPlace = oldStats?.place_rate || 0;
  const oldRoi = oldStats?.roi_pct || 0;
  const fmtDiff = (n: number) => (n > 0 ? '+' : '') + n.toFixed(1);

  console.log(`単勝的中率:  ${oldWin.toString().padStart(5)}%     ${newWinRate.toFixed(1).padStart(5)}%     ${fmtDiff(newWinRate - oldWin)}%`);
  console.log(`複勝的中率:  ${oldPlace.toString().padStart(5)}%     ${newPlaceRate.toFixed(1).padStart(5)}%     ${fmtDiff(newPlaceRate - oldPlace)}%`);
  console.log(`ROI:         ${oldRoi.toString().padStart(5)}%     ${newRoi.toFixed(1).padStart(5)}%     ${fmtDiff(newRoi - oldRoi)}%`);
  console.log(`========================================`);
  console.log(`所要時間: ${totalElapsed}分`);
  console.log(`キャッシュHit: ${stats.hits}, Turso直接: ${stats.misses}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
