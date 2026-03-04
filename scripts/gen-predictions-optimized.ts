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

// Gemini無料枠切れ → タイムアウト待ちを回避するため無効化
delete process.env.GEMINI_API_KEY;

import { ensureInitialized, dbAll, dbRun } from '../src/lib/database';
import { generatePrediction, type HorseAnalysisInput } from '../src/lib/prediction-engine';
import { savePrediction } from '../src/lib/queries';
import type { TrackType, TrackCondition, Prediction } from '../src/types';

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
      return mockResult([computeJockeyStats(args[0])]);
    }

    // --- getCourseDistanceStats: past_performances by racecourse + track_type + distance range ---
    if (sqlNorm.includes('from past_performances') && sqlNorm.includes('racecourse_name') && sqlNorm.includes('distance between')) {
      cacheHits++;
      return mockResult(computeCourseDistancePerfs(args[0], args[1], args[2], args[3]));
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
      // 元データはdate DESC順なのでreverse + entries > 0 フィルタ
      const filtered = perfs.filter(p => p.entries > 0).reverse();
      return mockResult(filtered.map(p => ({ date: p.date, position: p.position, entries: p.entries })));
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
const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : 0;

async function main() {
  const startTime = Date.now();

  if (TEST_MODE) console.log('*** テストモード: 1件のみ ***\n');
  if (LIMIT > 0) console.log(`*** 件数制限: ${LIMIT}件 ***\n`);

  // 1. クライアント取得 + キャッシュインストール
  const client = await ensureInitialized();

  // 2. データプリロード（Tursoから一括読み込み）
  await preloadData();

  // 3. 予想未生成の結果確定レース一覧
  const racesWithoutPreds = await dbAll<{ id: string }>(
    `SELECT r.id FROM races r
     WHERE r.status = '結果確定'
       AND r.id NOT IN (SELECT race_id FROM predictions)
     ORDER BY r.date, r.id`
  );

  const targetCount = TEST_MODE ? 1 : (LIMIT > 0 ? Math.min(LIMIT, racesWithoutPreds.length) : racesWithoutPreds.length);
  const targets = racesWithoutPreds.slice(0, targetCount);

  console.log(`予想未生成レース: ${racesWithoutPreds.length}件 (処理対象: ${targets.length}件)\n`);

  if (racesWithoutPreds.length === 0) {
    console.log('全レースに予想あり。終了。');
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
      // 馬データ構築（メモリキャッシュから応答）
      const horseInputs = entries.map(re => {
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
