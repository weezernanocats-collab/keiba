/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 最適化版: 過去レースの予想一括生成
 *
 * 全データを一括プリロード（~88K行）→ メモリ内キャッシュで予想生成（DB読み取りゼロ）→ 結果をTursoに書き戻し
 *
 * 使い方: npx tsx -r tsconfig-paths/register scripts/gen-predictions-optimized.ts
 */
import { readFileSync } from 'fs';

// Load .env.local
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}


import { ensureInitialized, dbAll } from '../src/lib/database';
import { generatePrediction, type HorseAnalysisInput } from '../src/lib/prediction-engine';
import { savePrediction } from '../src/lib/queries';
import { readFileSync, existsSync } from 'fs';
import { evaluateShosanTheory, type HorseEntry, type PastPerf } from '../src/lib/shoshan-theory';
import type { TrackType, TrackCondition } from '../src/types';

// ==================== 型定義 ====================

interface RaceRow {
  id: string;
  name: string;
  date: string;
  track_type: string;
  distance: number;
  track_condition: string | null;
  racecourse_name: string;
  grade: string | null;
  racecourse_id: string;
  race_number: number;
  time: string | null;
  weather: string | null;
  status: string;
}

interface EntryRow {
  race_id: string;
  post_position: number;
  horse_number: number;
  horse_id: string;
  horse_name: string;
  age: number;
  sex: string;
  weight: number | null;
  jockey_id: string;
  jockey_name: string;
  trainer_name: string;
  handicap_weight: number;
  odds: number | null;
  popularity: number | null;
  result_position: number | null;
  result_time: string | null;
  result_margin: string | null;
  result_last_three_furlongs: string | null;
  result_corner_positions: string | null;
  result_weight: number | null;
  result_weight_change: number | null;
}

interface HorseRow {
  id: string;
  name: string;
  father_name: string | null;
  trainer_name: string | null;
}

interface PerfRow {
  horse_id: string;
  race_id: string | null;
  date: string;
  race_name: string;
  racecourse_name: string;
  track_type: string;
  distance: number;
  track_condition: string | null;
  weather: string | null;
  entries: number;
  post_position: number;
  horse_number: number;
  position: number;
  jockey_name: string | null;
  handicap_weight: number;
  weight: number;
  weight_change: number;
  time: string | null;
  margin: string | null;
  last_three_furlongs: string | null;
  corner_positions: string | null;
  odds: number;
  popularity: number;
  prize: number;
}

interface JockeyRow {
  id: string;
  name: string;
  win_rate: number;
  place_rate: number;
  total_races: number;
}

// ==================== メモリキャッシュ ====================

let racesById: Map<string, RaceRow>;
let entriesByRace: Map<string, EntryRow[]>;
let horsesById: Map<string, HorseRow>;
let perfsByHorse: Map<string, PerfRow[]>;
let jockeysById: Map<string, JockeyRow>;
let jockeyNameById: Map<string, string>;
let horseIdsByFather: Map<string, string[]>;

// race_entries with results, grouped by (racecourse_name + date)
let resultEntriesByVenueDate: Map<string, EntryRow[]>;
// field sizes by race_id
let fieldSizeByRace: Map<string, number>;
// odds by race_id
let oddsByRace: Map<string, { horse_number1: number; odds: number }[]>;

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
  for (const p of allPerfs) {
    const arr = perfsByHorse.get(p.horse_id) || [];
    arr.push(p);
    perfsByHorse.set(p.horse_id, arr);
  }
  console.log(`  past_performances: ${allPerfs.length}`);

  // 5. 全騎手
  const allJockeys = await dbAll<JockeyRow>('SELECT id, name, win_rate, place_rate, total_races FROM jockeys');
  jockeysById = new Map(allJockeys.map(j => [j.id, j]));
  jockeyNameById = new Map(allJockeys.map(j => [j.id, j.name]));
  console.log(`  jockeys: ${allJockeys.length}`);

  // 6. 結果確定レースの出走馬（track bias用）
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

  // 7. 全オッズ（単勝のみ）
  const allOdds = await dbAll<{ race_id: string; horse_number1: number; odds: number }>(
    "SELECT race_id, horse_number1, odds FROM odds WHERE bet_type = '単勝'"
  );
  oddsByRace = new Map();
  for (const o of allOdds) {
    const arr = oddsByRace.get(o.race_id) || [];
    arr.push({ horse_number1: o.horse_number1, odds: o.odds });
    oddsByRace.set(o.race_id, arr);
  }
  console.log(`  odds (単勝): ${allOdds.length}`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  プリロード完了: ${elapsed}秒\n`);
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
    if (sqlNorm.includes('from races where id =')) {
      cacheHits++;
      const race = racesById.get(args[0]);
      return mockResult(race ? [race] : []);
    }

    // --- race_entries by race_id ---
    if (sqlNorm.includes('from race_entries where race_id =') && !sqlNorm.includes('update')) {
      cacheHits++;
      const entries = entriesByRace.get(args[0]) || [];
      return mockResult(entries);
    }

    // --- past_performances by horse_id (with ORDER BY date DESC LIMIT) ---
    if (sqlNorm.includes('from past_performances where horse_id =') && sqlNorm.includes('order by date desc limit')) {
      cacheHits++;
      const perfs = perfsByHorse.get(args[0]) || [];
      // beforeDate フィルタ対応: date < ? が含まれる場合 args=[horseId, beforeDate, limit]
      if (sqlNorm.includes('date <') && args.length >= 3) {
        const beforeDate = args[1] as string;
        const limit = (args[2] as number) || 100;
        const filtered = perfs.filter(p => p.date < beforeDate);
        return mockResult(filtered.slice(0, limit));
      }
      const limit = args[1] || 100;
      return mockResult(perfs.slice(0, limit));
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

    // --- jockey stats aggregate (race_entries + races) ---
    if (sqlNorm.includes('from race_entries e') && sqlNorm.includes('join races r') && sqlNorm.includes('e.jockey_id')) {
      cacheHits++;
      const beforeDate = sqlNorm.includes('date <') && args.length >= 2 ? args[1] as string : undefined;
      return mockResult([computeJockeyStats(args[0] as string, beforeDate)]);
    }

    // --- getCourseDistanceStats: past_performances by racecourse + track_type + distance range ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('racecourse_name') && sqlNorm.includes('distance between')) {
      cacheHits++;
      // args: [racecourse, trackType, minDist, maxDist, ...condGroup?, beforeDate?]
      // beforeDate is the last arg if 'date <' is in query
      const beforeDate = sqlNorm.includes('date <') ? args[args.length - 1] as string : undefined;
      return mockResult(computeCourseDistancePerfs(args[0] as string, args[1] as string, args[2] as number, args[3] as number, beforeDate));
    }

    // --- getSireStats: past_performances JOIN horses WHERE father_name ---
    if (sqlNorm.includes('from past_performances pp') && sqlNorm.includes('join horses h') && sqlNorm.includes('father_name')) {
      cacheHits++;
      const beforeDate = sqlNorm.includes('date <') ? args[args.length - 1] as string : undefined;
      return mockResult(computeSirePerfs(args[0] as string, beforeDate));
    }

    // --- getTrainerStats (race_entries + races by trainer_name) ---
    if (sqlNorm.includes('from race_entries re') && sqlNorm.includes('join races r') && sqlNorm.includes('re.trainer_name') && sqlNorm.includes('result_position is not null')) {
      cacheHits++;
      const beforeDate = sqlNorm.includes('date <') && args.length >= 2 ? args[1] as string : undefined;
      return mockResult(computeTrainerPerfs(args[0] as string, beforeDate));
    }

    // --- getJockeyTrainerCombo ---
    if (sqlNorm.includes('from past_performances pp') && sqlNorm.includes('join horses h') && sqlNorm.includes('jockey_name') && sqlNorm.includes('trainer_name')) {
      cacheHits++;
      const beforeDate = sqlNorm.includes('date <') && args.length >= 3 ? args[2] as string : undefined;
      return mockResult(computeJockeyTrainerPerfs(args[0] as string, args[1] as string, beforeDate));
    }

    // --- getHorseSeasonalStats ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('horse_id') && sqlNorm.includes('substr(date')) {
      cacheHits++;
      const beforeDate = sqlNorm.includes('date <') && args.length >= 2 ? args[1] as string : undefined;
      return mockResult(computeSeasonalPerfs(args[0] as string, beforeDate));
    }

    // --- getSecondStartBonus: past_performances by horse_id ORDER BY date ASC ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('horse_id') && sqlNorm.includes('order by date asc')) {
      cacheHits++;
      const perfs = perfsByHorse.get(args[0]) || [];
      const beforeDate = sqlNorm.includes('date <') && args.length >= 2 ? args[1] as string : undefined;
      // 元データはdate DESC順なのでreverse + entries > 0 フィルタ
      const filtered = perfs
        .filter(p => p.entries > 0 && (!beforeDate || p.date < beforeDate))
        .reverse();
      return mockResult(filtered.map(p => ({ date: p.date, position: p.position, entries: p.entries })));
    }

    // --- getJockeyRecentForm (race_entries re + re.jockey_id + re.result_position) ---
    if (sqlNorm.includes('from race_entries re') && sqlNorm.includes('re.jockey_id') && sqlNorm.includes('re.result_position')) {
      cacheHits++;
      const beforeDate = sqlNorm.includes('date <') && args.length >= 2 ? args[1] as string : undefined;
      return mockResult(computeJockeyRecentFormRows(args[0] as string, beforeDate));
    }

    // --- getDynamicStandardTimes (past_performances + time + position <= 5) ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('time is not null') && sqlNorm.includes('position <= 5')) {
      cacheHits++;
      const beforeDate = sqlNorm.includes('date <') ? args[args.length - 1] as string : undefined;
      // args は [racecourse?, trackType, minDist, maxDist, ...condGroup, beforeDate?]
      // racecourseなしバージョン: from past_performances where track_type = ?
      const hasRacecourse = sqlNorm.includes('racecourse_name');
      if (hasRacecourse) {
        const trackConditions = args.slice(4, beforeDate ? -1 : undefined) as string[];
        return mockResult(computeDynamicStdTimePerfs(args[0] as string, args[1] as string, args[2] as number, args[3] as number, trackConditions, beforeDate));
      } else {
        const trackConditions = args.slice(3, beforeDate ? -1 : undefined) as string[];
        return mockResult(computeDynamicStdTimePerfs(null, args[0] as string, args[1] as number, args[2] as number, trackConditions, beforeDate));
      }
    }

    // --- getWinOddsMap (odds by race_id + bet_type) ---
    if (sqlNorm.includes('from odds') && sqlNorm.includes('race_id') && sqlNorm.includes('bet_type')) {
      cacheHits++;
      return mockResult(computeOddsRows(args[0] as string));
    }

    // --- calculateTodayTrackBias ---
    if (sqlNorm.includes('from race_entries re') && sqlNorm.includes('join races r') && sqlNorm.includes('racecourse_name') && sqlNorm.includes('r.date')) {
      cacheHits++;
      return mockResult(computeTrackBiasEntries(args[0], args[1], args[2]));
    }

    // --- savePrediction (INSERT) ---
    if (sqlNorm.includes('insert into predictions')) {
      cacheMisses++;
      return origExecute(stmt);
    }

    // --- schema/migrations (let through) ---
    if (sqlNorm.includes('create table') || sqlNorm.includes('create index') || sqlNorm.includes('alter table') || sqlNorm.includes('insert or ignore')) {
      return origExecute(stmt);
    }

    // --- calibration weights ---
    if (sqlNorm.includes('calibration_weights')) {
      cacheMisses++;
      return origExecute(stmt);
    }

    // キャッチされなかったクエリ → 実DB（警告付き）
    cacheMisses++;
    console.warn(`[UNCACHED] ${sql.substring(0, 80)}... args=${JSON.stringify(args).substring(0, 50)}`);
    return origExecute(stmt);
  };

  // batch もパッチ（schema初期化で使用）
  const origBatch = client.batch.bind(client);
  client.batch = async function (stmts: any, mode?: any) {
    // schema初期化バッチはそのまま通す
    return origBatch(stmts, mode);
  };

  return { getCacheStats: () => ({ hits: cacheHits, misses: cacheMisses }) };
}

// ==================== メモリ内計算関数 ====================

function computeJockeyStats(jockeyId: string, beforeDate?: string) {
  let total = 0, wins = 0, places = 0;
  for (const [raceId, entries] of entriesByRace) {
    const race = racesById.get(raceId);
    if (!race || race.status !== '結果確定') continue;
    if (beforeDate && race.date >= beforeDate) continue;
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

function computeCourseDistancePerfs(racecourse: string, trackType: string, minDist: number, maxDist: number, beforeDate?: string) {
  const results: any[] = [];
  for (const perfs of perfsByHorse.values()) {
    for (const p of perfs) {
      if (p.racecourse_name === racecourse && p.track_type === trackType
          && p.distance >= minDist && p.distance <= maxDist && p.entries > 0
          && (!beforeDate || p.date < beforeDate)) {
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

function computeSirePerfs(fatherName: string, beforeDate?: string) {
  const childIds = horseIdsByFather.get(fatherName) || [];
  const results: any[] = [];
  for (const hid of childIds) {
    const perfs = perfsByHorse.get(hid) || [];
    for (const p of perfs) {
      if (p.entries > 0 && (!beforeDate || p.date < beforeDate)) {
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

function computeJockeyTrainerPerfs(jockeyId: string, trainerName: string, beforeDate?: string) {
  const jockeyName = jockeyNameById.get(jockeyId);
  if (!jockeyName) return [];

  const results: any[] = [];
  for (const [horseId, perfs] of perfsByHorse) {
    const horse = horsesById.get(horseId);
    if (!horse || horse.trainer_name !== trainerName) continue;
    for (const p of perfs) {
      if (p.jockey_name === jockeyName && p.entries > 0 && (!beforeDate || p.date < beforeDate)) {
        results.push({ position: p.position, entries: p.entries });
      }
    }
  }
  return results;
}

function computeTrainerPerfs(trainerName: string, beforeDate?: string) {
  const results: any[] = [];
  for (const [raceId, entries] of entriesByRace) {
    const race = racesById.get(raceId);
    if (!race || race.status !== '結果確定') continue;
    if (beforeDate && race.date >= beforeDate) continue;
    for (const e of entries) {
      if (e.trainer_name === trainerName && e.result_position != null) {
        results.push({
          result_position: e.result_position,
          track_type: race.track_type,
          date: race.date,
          distance: race.distance,
          track_condition: race.track_condition,
          grade: race.grade,
        });
      }
    }
  }
  return results;
}

function computeSeasonalPerfs(horseId: string, beforeDate?: string) {
  const perfs = perfsByHorse.get(horseId) || [];
  const results: any[] = [];
  for (const p of perfs) {
    if (p.date && p.entries > 0 && (!beforeDate || p.date < beforeDate)) {
      const monthStr = p.date.substring(5, 7);
      const month = parseInt(monthStr, 10);
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

function computeJockeyRecentFormRows(jockeyId: string, beforeDate?: string) {
  const results: any[] = [];
  for (const [raceId, entries] of entriesByRace) {
    const race = racesById.get(raceId);
    if (!race || race.status !== '結果確定') continue;
    if (beforeDate && race.date >= beforeDate) continue;
    for (const e of entries) {
      if (e.jockey_id === jockeyId && e.result_position != null) {
        results.push({ result_position: e.result_position, date: race.date });
      }
    }
  }
  return results;
}

function computeDynamicStdTimePerfs(
  racecourse: string | null,
  trackType: string,
  minDist: number,
  maxDist: number,
  trackConditions: string[],
  beforeDate?: string,
) {
  const results: any[] = [];
  for (const perfs of perfsByHorse.values()) {
    for (const p of perfs) {
      if (racecourse && p.racecourse_name !== racecourse) continue;
      if (p.track_type !== trackType) continue;
      if (p.distance < minDist || p.distance > maxDist) continue;
      if (!trackConditions.includes(p.track_condition || '')) continue;
      if (!p.time || p.time === '') continue;
      if (p.position > 5) continue;
      if (beforeDate && p.date >= beforeDate) continue;
      results.push({ time: p.time });
    }
  }
  // ORDER BY date DESC LIMIT 200/300 の代わりにサイズ制限
  return results.slice(0, racecourse ? 200 : 300);
}

function computeOddsRows(raceId: string) {
  return oddsByRace.get(raceId) || [];
}

// ==================== モック結果生成 ====================

function mockResult(rows: any[]) {
  return {
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    columnTypes: [],
    rows: rows.map(r => {
      // libsql Row 互換: オブジェクト + 配列アクセス
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

// ==================== メイン ====================

const TEST_MODE = process.argv.includes('--test');
const REGEN_MODE = process.argv.includes('--regen');
const DATE_FILTER = process.argv.includes('--date')
  ? process.argv[process.argv.indexOf('--date') + 1]
  : '';
const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : 0;
// --race "中山5" で特定レースのみ再生成（競馬場名+レース番号）
const RACE_FILTER = process.argv.includes('--race')
  ? process.argv[process.argv.indexOf('--race') + 1]
  : '';

/**
 * パドック文字起こしを読み込み、パドック解説部分のみ抽出・馬番ごとに整理
 */
function loadPaddockChunks(raceDate: string, raceTime: string | null, racecourse?: string, raceId?: string): string[] {
  if (!raceTime) return [];
  const jsonlPath = `/tmp/paddock_watcher/chunks_${raceDate.replace(/-/g, '')}.jsonl`;
  if (!existsSync(jsonlPath)) return [];

  // 競馬場名の表記揺れ対応（Whisperの誤変換含む）
  const venueAliases: Record<string, string[]> = {
    '中山': ['中山', '仲間', '仲山', '中やま', 'なかやま'],
    '阪神': ['阪神', '半信', '半身', 'はんしん', 'ハンシン'],
    '東京': ['東京', '府中'],
    '京都': ['京都'],
  };
  const aliases = racecourse ? (venueAliases[racecourse] || [racecourse]) : [];

  try {
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(l => l);
    const [raceH, raceM] = raceTime.split(':').map(Number);
    const raceMinutes = raceH * 60 + raceM;

    // 全競馬場のエイリアス
    const allVenues: Record<string, string[]> = {
      '中山': ['中山', '仲間', '仲山', '中やま', 'なかやま'],
      '阪神': ['阪神', '半信', '半身', 'はんしん', 'ハンシン'],
      '東京': ['東京', '府中'],
      '京都': ['京都'],
    };

    // 発走30分前〜発走時刻のチャンクを取得
    // 競馬場名が登場したら、次に別の競馬場名が出るまで同一競馬場と見なす
    const timeFilteredChunks: { text: string }[] = [];
    for (const line of lines) {
      try {
        const chunk = JSON.parse(line) as { time: string; text: string };
        const [h, m] = chunk.time.split(':').map(Number);
        const chunkMinutes = h * 60 + m;
        if (chunkMinutes >= raceMinutes - 30 && chunkMinutes < raceMinutes) {
          timeFilteredChunks.push(chunk);
        }
      } catch { /* skip */ }
    }

    // 出馬表の馬名リスト（馬名マッチング用）
    const raceHorseNames: string[] = [];
    if (raceId && entriesByRace.has(raceId)) {
      for (const e of entriesByRace.get(raceId)!) {
        const horse = horsesById.get(e.horse_id);
        if (horse) raceHorseNames.push(horse.name);
      }
    }

    // 各チャンクをフィルタ: 競馬場名追跡 + 馬名マッチング
    let currentVenue = '';
    const rawTexts: string[] = [];
    for (const chunk of timeFilteredChunks) {
      // このチャンクに競馬場名が含まれているか
      for (const [venue, vAliases] of Object.entries(allVenues)) {
        if (vAliases.some(a => chunk.text.includes(a))) {
          currentVenue = venue;
          break;
        }
      }

      // 馬名マッチング: 出馬表の馬名が3文字以上部分一致するか
      const hasHorseName = raceHorseNames.some(name =>
        name.length >= 3 && Array.from({ length: name.length - 2 }, (_, i) => name.slice(i, i + 3)).some(sub => chunk.text.includes(sub))
      );

      // 採用条件: 競馬場一致 OR 馬名一致
      if (!racecourse || currentVenue === racecourse || hasHorseName) {
        rawTexts.push(chunk.text.trim());
      }
    }
    if (rawTexts.length === 0) return [];

    return parsePaddockCommentary(rawTexts.join(' '));
  } catch { return []; }
}

/**
 * 生テキストからパドック解説をフィルタし、馬番ごとに整理
 */
function parsePaddockCommentary(raw: string): string[] {
  // 除外パターン（レース結果、払い戻し、CM等）
  const excludePatterns = [
    /単勝\d+番.*?円/, /探証\d+番/, /探索式/,
    /[枠馬ワク]連.*?[円倍]/, /生まれん|生また|生まな/,
    /三連|3連|三年|3年/, /復勝.*?円/,
    /ワイド.*?円/, /はらい戻し|払い戻し/,
    /価値タイム|勝ちタイム/, /上がり\d+メートル/,
    /グリーンチャンネル/, /視聴.*?方法/,
    /qrコー[トド]/i, /ご案内でした/,
    /確定までお待ち/, /[0-9]+\.[0-9]+倍/,
    /人気.*?です$/, /番人気\d+番人気/,
    /キロ.*?キロ.*?キロ/, // 馬体重の羅列行
    /勝利を|勝ちました|買ったのは|1着2着|2着3着/,
    /逃げた|寝ばって|外1気に|インコースから/,
    /ケーバとなりました|レースは.*?等の/,
    /職業をつかんで/, /先行して勝利/,
    /コーナー|カーブ|直線|バックストレッチ|ゴール/,
    /スタート.*?しました|発走|ゲートが開/,
    /リード.*?馬身|先頭|2番手|3番手|後方/,
    /上がって[いき]|差し[てき]|追い込[みん]/,
    /着差|決着|写真判定/, /競走中止|落馬/,
    /メートル.*?通過|ペース/, /レース中継/,
    /出走.*?頭の争い/, /市場.*?メートル/,
  ];

  // パドック関連キーワード（これらを含むセンテンスを採用）
  const paddockKeywords = [
    /\d+番/, /プラス\d|マイナス\d|増減なし/,
    /パドック|パドク/, /体[がはも]|馬体/, /歩[きけい]|アルキ/,
    /気配|仕上|前向き|集中|落ち着|テンション|硬[くい]|柔ら/,
    /削[りれ]|絞[りれっ]|太め|重め|シャープ|キッチリ|しっかり/,
    /筋肉|毛艶|毛ヅヤ|発汗|汗/, /成長|未完成|良く見え|目立つ/,
    /推奨[馬場]|注目/, /リズム|踏み込み|バネ/,
  ];

  // 文をセンテンスに分割
  const sentences = raw
    .replace(/。/g, '。\n')
    .replace(/です\s/g, 'です\n')
    .replace(/ます\s/g, 'ます\n')
    .replace(/ですね\s/g, 'ですね\n')
    .replace(/ですし\s/g, 'ですし\n')
    .replace(/ですかね\s/g, 'ですかね\n')
    .replace(/思います\s/g, '思います\n')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 5);

  // フィルタ: 除外パターンを含むものを除去し、パドックキーワードを2つ以上含むものを採用（厳格モード）
  const paddockSentences = sentences.filter(s => {
    if (excludePatterns.some(p => p.test(s))) return false;
    const matchCount = paddockKeywords.filter(p => p.test(s)).length;
    return matchCount >= 2; // 2つ以上のパドックキーワードが必要
  });

  if (paddockSentences.length === 0) return [];

  // 馬番ごとにグループ化（文の先頭の馬番で分類）
  const horseComments = new Map<number, string[]>();
  let currentHorse = 0;

  for (const s of paddockSentences) {
    // 推奨行はスキップ（後で別処理）
    if (/推奨/.test(s)) continue;

    // 文の先頭付近に馬番がある場合は切り替え
    const headMatch = s.match(/^.{0,10}?(\d{1,2})番/);
    if (headMatch) {
      const num = parseInt(headMatch[1]);
      if (num >= 1 && num <= 18) currentHorse = num;
    }
    if (currentHorse > 0) {
      if (!horseComments.has(currentHorse)) horseComments.set(currentHorse, []);
      horseComments.get(currentHorse)!.push(s);
    }
  }

  // 推奨馬番号の抽出（"推奨" を含む行と、周辺の馬番を拾う）
  const recommendLines = paddockSentences.filter(s => /推奨/.test(s));
  const recommendNums = new Set<number>();
  for (const line of recommendLines) {
    const matches = line.matchAll(/(\d{1,2})番/g);
    for (const m of matches) {
      const n = parseInt(m[1]);
      if (n >= 1 && n <= 18) recommendNums.add(n);
    }
  }

  // 整形出力
  const result: string[] = [];
  const sorted = [...horseComments.entries()].sort((a, b) => a[0] - b[0]);
  for (const [num, comments] of sorted) {
    const text = comments.join(' ');
    result.push(`【${num}番】${text}`);
  }
  if (recommendNums.size > 0) {
    result.push(`\n★解説者推奨: ${[...recommendNums].sort((a, b) => a - b).map(n => `${n}番`).join('、')}`);
  }

  return result;
}

/**
 * ローカルLLM（Ollama）でパドック解説を要約
 */
async function summarizePaddockWithLLM(rawText: string): Promise<string | null> {
  const OLLAMA_URL = 'http://localhost:11434/api/chat';
  const MODEL = 'qwen3.5:35b';

  const prompt = `あなたは競馬パドック解説のまとめ役です。
以下は音声認識で文字起こしされたパドック解説です（誤字が多い）。

【重要ルール】
- パドックでの「馬体評価」のみを抽出してください
- レース実況（○番手、コーナー、ゴール等）は完全に無視してください
- 払い戻し、オッズ、タイム、着順は完全に無視してください
- 馬体評価とは: 体つき、歩き、気配、仕上がり、テンション、馬体重増減のコメント
- 馬番ごとに1行で要約（馬体評価がない馬番は省略）
- 形式: ○（好評価）/ ×（不安あり）/ △（普通）＋ 要約コメント
- 解説者の推奨馬があれば最後に「★推奨: ○番、○番」
- 5行以上は書かないでください。簡潔に。

${rawText}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        // qwen3.5 は reasoning モデルで、think 有効だと num_predict 分が thinking に消費され
        // message.content が空になる。要約用途なので think は不要。
        think: false,
        options: { temperature: 0.1, num_predict: 500 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json() as { message?: { content?: string } };
    const content = data.message?.content?.trim();
    if (content && content.length > 10) {
      console.log(`  [パドック要約] ${content.split('\n').length}行 (LLM: ${MODEL})`);
      return content;
    }
    return null;
  } catch (e) {
    // Ollamaが起動していない場合はフォールバック
    console.log('  [パドック要約] LLM接続失敗、生テキストを使用');
    return null;
  }
}

async function main() {
  const startTime = Date.now();

  if (TEST_MODE) console.log('*** テストモード: 1件のみ ***\n');
  if (REGEN_MODE) console.log('*** 再生成モード: 全予想を削除して再生成 ***\n');
  if (DATE_FILTER) console.log(`*** 日付フィルタ: ${DATE_FILTER} (出走確定含む) ***\n`);
  if (RACE_FILTER) console.log(`*** レースフィルタ: ${RACE_FILTER} ***\n`);
  if (LIMIT > 0) console.log(`*** 件数制限: ${LIMIT}件 ***\n`);

  // 1. クライアント取得 + キャッシュインストール
  const client = await ensureInitialized();

  // 校正済みウェイトをDBから読み込んで適用
  const { ensureCalibrationLoaded } = await import('../src/lib/accuracy-tracker');
  await ensureCalibrationLoaded();
  console.log('校正済みウェイト適用完了');

  // --regen は一括削除を行わない。savePrediction() がレース単位で
  // DELETE→INSERT するため、生成対象のフィルタを変えるだけで安全に再生成できる。
  if (REGEN_MODE && !DATE_FILTER) {
    console.error('ERROR: --regen には --date が必須です（全件再生成防止）');
    process.exit(1);
  }

  // 2. データプリロード（Tursoから一括読み込み）
  await preloadData();

  // 3. 対象レース一覧
  const statusFilter = DATE_FILTER
    ? `r.status IN ('出走確定', '予定') AND r.date = ?`
    : `r.status = '出走確定'`;
  const statusArgs = DATE_FILTER ? [DATE_FILTER] : [];

  // --regen: 既存予想があるレースも対象に含める（savePrediction()がレース単位で安全に上書き）
  // 通常: 予想未生成レースのみ
  // 結果確定済み（prediction_resultsあり）はどちらの場合もスキップ
  const predFilter = REGEN_MODE
    ? `AND r.id NOT IN (SELECT race_id FROM prediction_results)`
    : `AND r.id NOT IN (SELECT race_id FROM predictions)`;

  // --race フィルタ: "中山5" → racecourse_name='中山' AND race_number=5
  let raceFilterSql = '';
  const raceFilterArgs: (string | number)[] = [];
  if (RACE_FILTER) {
    const match = RACE_FILTER.match(/^(.+?)(\d+)$/);
    if (match) {
      raceFilterSql = `AND r.racecourse_name = ? AND r.race_number = ?`;
      raceFilterArgs.push(match[1], parseInt(match[2], 10));
    }
  }

  const targetRaces = await dbAll<{ id: string }>(
    `SELECT r.id FROM races r
     WHERE ${statusFilter}
       ${predFilter}
       ${raceFilterSql}
     ORDER BY r.date, r.id`,
    [...statusArgs, ...raceFilterArgs]
  );

  const targetCount = TEST_MODE ? 1 : (LIMIT > 0 ? Math.min(LIMIT, targetRaces.length) : targetRaces.length);
  const targets = targetRaces.slice(0, targetCount);

  const modeLabel = REGEN_MODE ? '再生成対象' : '予想未生成';
  console.log(`${modeLabel}レース: ${targetRaces.length}件 (処理対象: ${targets.length}件)\n`);

  if (targetRaces.length === 0) {
    console.log(REGEN_MODE ? '対象レースなし。終了。' : '全レースに予想あり。終了。');
    return;
  }

  // 4. キャッシュインターセプター設置
  const { getCacheStats } = installCacheInterceptor(client);

  // 5. 予想を生成
  let generated = 0;
  let errors = 0;
  const batchSize = 50;

  for (let i = 0; i < targets.length; i++) {
    const { id: raceId } = targets[i];
    const race = racesById.get(raceId);
    if (!race) { errors++; continue; }

    const entries = entriesByRace.get(raceId);
    if (!entries || entries.length === 0) { errors++; continue; }

    try {
      // 馬データ構築（メモリキャッシュから応答、raceDate以前のデータのみ使用）
      const raceDate = race.date;
      const horseInputs = entries.map(re => {
        const allPerfs = perfsByHorse.get(re.horse_id) || [];
        // Data Leakage防止: レース日以前の過去成績のみ使用
        const perfs = allPerfs.filter(p => p.date < raceDate);
        const horse = horsesById.get(re.horse_id);
        const jockey = jockeysById.get(re.jockey_id);

        // beforeDate付きのため、jockeysテーブルの集計値は使わず
        // キャッシュインターセプター経由で日付フィルタ済み値を取得する
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
            raceId: p.race_id,
            date: p.date,
            raceName: p.race_name,
            racecourseName: p.racecourse_name,
            trackType: p.track_type,
            distance: p.distance,
            trackCondition: p.track_condition,
            weather: p.weather,
            entries: p.entries,
            postPosition: p.post_position,
            horseNumber: p.horse_number,
            position: p.position,
            jockeyName: p.jockey_name,
            handicapWeight: p.handicap_weight,
            weight: p.weight,
            weightChange: p.weight_change,
            time: p.time,
            margin: p.margin,
            lastThreeFurlongs: p.last_three_furlongs,
            cornerPositions: p.corner_positions,
            odds: p.odds,
            popularity: p.popularity,
            prize: p.prize,
          })),
          jockeyWinRate,
          jockeyPlaceRate,
          fatherName: horse?.father_name || '',
        };
      });

      // 予想生成（buildRaceContext + calculateTodayTrackBias もキャッシュから応答）
      const prediction = await generatePrediction(
        raceId,
        race.name,
        race.date,
        race.track_type as TrackType,
        race.distance,
        race.track_condition as TrackCondition | undefined,
        race.racecourse_name,
        race.grade || undefined,
        horseInputs as HorseAnalysisInput[],
      );

      // しょーさん予想を評価してanalysisに埋め込み
      {
        const horseEntries: HorseEntry[] = entries.map(re => ({
          horseNumber: re.horse_number,
          horseName: re.horse_name,
          horseId: re.horse_id,
          jockeyId: re.jockey_id || '',
          jockeyName: jockeyNameById.get(re.jockey_id) || '',
        }));
        const pastPerfsForShoshan = new Map<string, PastPerf[]>();
        for (const re of entries) {
          const allPerfs = perfsByHorse.get(re.horse_id) || [];
          pastPerfsForShoshan.set(re.horse_id, allPerfs
            .filter(p => p.date < race.date)
            .map(p => ({
              date: p.date,
              position: p.position,
              cornerPositions: p.corner_positions || '',
              entries: p.entries,
              racecourseName: (p as { racecourse_name?: string }).racecourse_name || '',
            })));
        }
        // 前走騎手マップ
        const prevJockeyMap = new Map<string, string>();
        for (const re of entries) {
          // キャッシュ内で前走騎手を探す
          const perfs = perfsByHorse.get(re.horse_id) || [];
          const prevPerf = perfs.filter(p => p.date < race.date)[0];
          if (prevPerf) {
            let found = false;
            for (const [rid, rEntries] of entriesByRace) {
              const r = racesById.get(rid);
              if (r && r.date === prevPerf.date) {
                const prevEntry = rEntries.find(e => e.horse_id === re.horse_id);
                if (prevEntry) {
                  prevJockeyMap.set(re.horse_id, prevEntry.jockey_id);
                  found = true;
                  break;
                }
              }
            }
            // キャッシュになければDBから直接取得
            if (!found) {
              const dbResult = await dbAll<{ jockey_id: string }>(
                `SELECT re.jockey_id FROM race_entries re JOIN races r ON re.race_id = r.id
                 WHERE re.horse_id = ? AND r.date < ? ORDER BY r.date DESC LIMIT 1`,
                [re.horse_id, race.date]
              );
              if (dbResult.length > 0) {
                prevJockeyMap.set(re.horse_id, dbResult[0].jockey_id);
              }
            }
          }
        }
        const shosanResult = evaluateShosanTheory(
          race.date, race.racecourse_name, horseEntries, pastPerfsForShoshan, prevJockeyMap, race.name
        );
        if (shosanResult.candidates.length > 0) {
          (prediction.analysis as Record<string, unknown>).shosanPrediction = shosanResult;
        }
      }

      // パドック文字起こしをanalysisに埋め込み（ファイルがあれば）
      if (REGEN_MODE) {
        const paddockChunks = loadPaddockChunks(race.date, race.time, race.racecourse_name, raceId);
        if (paddockChunks.length > 0) {
          const filtered = paddockChunks.join('\n');
          const summary = await summarizePaddockWithLLM(filtered);
          (prediction.analysis as Record<string, unknown>).paddockCommentary = summary || filtered;
        }
      }

      // 保存（これだけTursoに書き込み）
      await savePrediction(prediction);
      generated++;

      if (generated % batchSize === 0 || generated === 1) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const stats = getCacheStats();
        console.log(`  [${generated}/${targets.length}] ${elapsed}分 | キャッシュHit: ${stats.hits}, Miss: ${stats.misses}`);
      }
    } catch (error) {
      errors++;
      const msg = error instanceof Error ? error.message : String(error);
      if (errors <= 5) {
        console.error(`  エラー (${raceId} ${race.name}): ${msg}`);
      }
    }
  }

  // 6. 結果表示
  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const stats = getCacheStats();

  console.log(`\n=== 完了 ===`);
  console.log(`  生成: ${generated}件, エラー: ${errors}件`);
  console.log(`  所要時間: ${totalElapsed}分`);
  console.log(`  キャッシュHit: ${stats.hits}, Turso直接: ${stats.misses}`);
  console.log(`  推定Tursoリード: プリロード~${88000 + stats.misses}行 (非最適化比: ${Math.round((88000 + stats.misses) / 57755364 * 100 * 100) / 100}%)`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
