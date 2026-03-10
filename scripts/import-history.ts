/**
 * ローカル実行スクリプト: 過去レース結果を一括インポート
 *
 * 使い方: npx tsx scripts/import-history.ts [--days 30]
 *
 * - 過去N日間のレース一覧をnetkeiba からスクレイプ
 * - 出馬表 + 結果を取得し Turso DB に直接書き込み
 * - 既にDBにあるレースはスキップ（差分インポート）
 * - 並列3・800ms間隔でnetkeiba への負荷を軽減
 */
import { createClient, type Client } from '@libsql/client';
import * as cheerio from 'cheerio';
import { readFileSync } from 'fs';

// Load .env.local manually
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

const TURSO_URL = process.env.TURSO_DATABASE_URL!;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN!;
const RACE_BASE_URL = 'https://race.netkeiba.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const CONCURRENCY = 3;
const RATE_LIMIT_MS = 800;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in .env.local');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ==================== CLI args ====================

function parseDaysArg(): number {
  const idx = process.argv.indexOf('--days');
  if (idx >= 0 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1]) || 30;
  }
  return 30;
}

// ==================== Fetch HTML ====================

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        if (res.status === 429 || res.status === 400) {
          console.log(`  Rate limited (${res.status}), waiting...`);
          await sleep(5000 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const buffer = await res.arrayBuffer();
      const encoding = detectEncoding(url, buffer);
      return new TextDecoder(encoding).decode(buffer);
    } catch (e) {
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
      } else {
        throw e;
      }
    }
  }
  throw new Error('Failed after retries');
}

function detectEncoding(url: string, buffer: ArrayBuffer): string {
  if (url.includes('race_list_sub.html')) return 'utf-8';
  const preview = new TextDecoder('ascii').decode(buffer.slice(0, 1024));
  if (preview.includes('charset="UTF-8"') || preview.includes('charset=utf-8')) return 'utf-8';
  return 'euc-jp';
}

// ==================== Racecourse Helpers ====================

const RACECOURSE_CODE_MAP: Record<string, string> = {
  '01': 'sapporo', '02': 'hakodate', '03': 'fukushima', '04': 'niigata',
  '05': 'tokyo', '06': 'nakayama', '07': 'chukyo', '08': 'kyoto',
  '09': 'hanshin', '10': 'kokura',
  '30': 'monbetsu', '35': 'morioka', '36': 'mizusawa',
  '42': 'urawa', '43': 'funabashi', '44': 'ooi', '45': 'kawasaki',
  '46': 'kanazawa', '48': 'kasamatsu', '50': 'nagoya',
  '51': 'sonoda', '54': 'kochi', '55': 'saga',
};

const RACECOURSE_NAME_MAP: Record<string, string> = {
  sapporo: '札幌', hakodate: '函館', fukushima: '福島', niigata: '新潟',
  tokyo: '東京', nakayama: '中山', chukyo: '中京', kyoto: '京都',
  hanshin: '阪神', kokura: '小倉',
  monbetsu: '門別', morioka: '盛岡', mizusawa: '水沢',
  urawa: '浦和', funabashi: '船橋', ooi: '大井', kawasaki: '川崎',
  kanazawa: '金沢', kasamatsu: '笠松', nagoya: '名古屋',
  sonoda: '園田', kochi: '高知', saga: '佐賀',
};

function inferRacecourseId(raceId: string): string {
  return RACECOURSE_CODE_MAP[raceId.substring(4, 6)] || 'unknown';
}

function inferRacecourseName(racecourseId: string): string {
  return RACECOURSE_NAME_MAP[racecourseId] || '不明';
}

// ==================== Scrape Race List ====================

interface RaceListItem {
  id: string;
  raceNumber: number;
  name: string;
  racecourseName: string;
  date: string;
}

async function scrapeRaceList(date: string): Promise<RaceListItem[]> {
  const dateStr = date.replace(/-/g, '');
  const url = `${RACE_BASE_URL}/top/race_list_sub.html?kaisai_date=${dateStr}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const races: RaceListItem[] = [];

  $('li a[href*="race_id="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (href.includes('movie.html')) return;

    const raceIdMatch = href.match(/race_id=(\d+)/);
    if (!raceIdMatch) return;

    const raceId = raceIdMatch[1];
    const raceText = $(a).text().trim();
    const raceNumMatch = raceText.match(/(\d+)R/);
    const namePart = raceText
      .replace(/\d+R\s*/, '')
      .replace(/\d{2}:\d{2}/, '')
      .replace(/[芝ダ障]\d+m/, '')
      .replace(/\d+頭/, '')
      .trim();

    const racecourseId = inferRacecourseId(raceId);

    races.push({
      id: raceId,
      raceNumber: raceNumMatch ? parseInt(raceNumMatch[1]) : 0,
      name: namePart || `${raceNumMatch?.[1] || ''}R`,
      racecourseName: inferRacecourseName(racecourseId),
      date,
    });
  });

  return races;
}

// ==================== Scrape Race Card ====================

interface RaceDetail {
  id: string;
  name: string;
  racecourseName: string;
  racecourseId: string;
  trackType: string;
  distance: number;
  trackCondition: string | null;
  weather: string | null;
  time: string | null;
  grade: string | null;
  entries: EntryData[];
}

interface EntryData {
  postPosition: number;
  horseNumber: number;
  horseId: string;
  horseName: string;
  age: number;
  sex: string;
  jockeyId: string;
  jockeyName: string;
  trainerName: string;
  handicapWeight: number;
}

async function scrapeRaceCard(raceId: string): Promise<RaceDetail | null> {
  try {
    const url = `${RACE_BASE_URL}/race/shutuba.html?race_id=${raceId}`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const raceInfo = $('div.RaceData01').text().trim();
    const raceName = $('h1.RaceName').text().trim();
    const distMatch = raceInfo.match(/(芝|ダート|ダ|障害|障)(\d+)m/);
    const condMatch = raceInfo.match(/(良|稍重|稍|重|不良|不)/);
    const normalizedCond = condMatch?.[1] === '稍' ? '稍重' : condMatch?.[1] === '不' ? '不良' : condMatch?.[1] || null;
    const weatherMatch = raceInfo.match(/(晴|曇|小雨|雨|小雪|雪)/);
    const timeMatch = raceInfo.match(/(\d{1,2}:\d{2})/);

    const gradeText = $('span.RaceGrade, span.Icon_GradeType').text().trim();
    const gradeClassList = $('span.Icon_GradeType').map((_, el) => $(el).attr('class') || '').get();
    const allClasses = gradeClassList.flatMap((c: string) => c.split(/\s+/));
    const hasGradeClass = (suffix: string) => allClasses.includes(`Icon_GradeType${suffix}`);
    let grade: string | null = null;
    if (gradeText.includes('G1') || gradeText.includes('Ｇ１') || hasGradeClass('1')) grade = 'G1';
    else if (gradeText.includes('G2') || gradeText.includes('Ｇ２') || hasGradeClass('2')) grade = 'G2';
    else if (gradeText.includes('G3') || gradeText.includes('Ｇ３') || hasGradeClass('3')) grade = 'G3';
    else if (hasGradeClass('5')) grade = 'リステッド';
    else if (hasGradeClass('10')) grade = 'オープン';
    else if (hasGradeClass('15')) grade = '3勝クラス';
    else if (hasGradeClass('16')) grade = '2勝クラス';
    else if (hasGradeClass('17')) grade = '1勝クラス';
    else if (hasGradeClass('18')) grade = '未勝利';
    else if (hasGradeClass('19')) grade = '新馬';

    // RaceData02 からクラス情報を補完
    if (!grade) {
      const raceData02 = $('div.RaceData02, span.RaceData02').text().trim();
      const raceTitleFull = raceName + ' ' + raceData02;
      if (raceTitleFull.includes('新馬')) grade = '新馬';
      else if (raceTitleFull.includes('未勝利')) grade = '未勝利';
      else if (raceTitleFull.includes('1勝クラス')) grade = '1勝クラス';
      else if (raceTitleFull.includes('2勝クラス')) grade = '2勝クラス';
      else if (raceTitleFull.includes('3勝クラス')) grade = '3勝クラス';
      else if (raceTitleFull.includes('オープン')) grade = 'オープン';
    }

    const entries: EntryData[] = [];
    $('table.Shutuba_Table tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 8) return;

      const postPosition = parseInt($(tds[0]).text().trim()) || 0;
      const horseNumber = parseInt($(tds[1]).text().trim()) || 0;
      const horseName = $(tds[3]).find('a').text().trim();
      const horseLink = $(tds[3]).find('a').attr('href') || '';
      const horseIdMatch = horseLink.match(/horse\/(\w+)/);
      const ageSex = $(tds[4]).text().trim();
      const handicapWeight = parseFloat($(tds[5]).text().trim()) || 0;
      const jockeyName = $(tds[6]).find('a').text().trim();
      const jockeyLink = $(tds[6]).find('a').attr('href') || '';
      const jockeyIdMatch = jockeyLink.match(/jockey\/(?:result\/recent\/)?(\w+)/);
      const trainerName = $(tds[7]).find('a').text().trim();

      if (horseName) {
        entries.push({
          postPosition,
          horseNumber,
          horseId: horseIdMatch ? horseIdMatch[1] : `h_${horseNumber}`,
          horseName,
          age: parseInt(ageSex.replace(/[^\d]/g, '')) || 0,
          sex: (ageSex.match(/(牡|牝|セ)/)?.[1] || '牡'),
          jockeyId: jockeyIdMatch ? jockeyIdMatch[1] : `j_${jockeyName}`,
          jockeyName,
          trainerName,
          handicapWeight,
        });
      }
    });

    const racecourseId = inferRacecourseId(raceId);
    let trackType = distMatch?.[1] || 'ダート';
    if (trackType === 'ダ') trackType = 'ダート';
    if (trackType === '障') trackType = '障害';

    return {
      id: raceId,
      name: raceName,
      racecourseName: inferRacecourseName(racecourseId),
      racecourseId,
      trackType,
      distance: parseInt(distMatch?.[2] || '0'),
      trackCondition: normalizedCond,
      weather: weatherMatch?.[1] || null,
      time: timeMatch?.[1] || null,
      grade,
      entries,
    };
  } catch (e) {
    console.error(`  Error scraping card for ${raceId}:`, (e as Error).message);
    return null;
  }
}

// ==================== Scrape Race Result ====================

interface ResultData {
  position: number;
  horseNumber: number;
  horseName: string;
  time: string;
  margin: string;
  lastThreeFurlongs: string;
  cornerPositions: string;
}

async function scrapeRaceResult(raceId: string): Promise<ResultData[]> {
  try {
    const url = `${RACE_BASE_URL}/race/result.html?race_id=${raceId}`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const results: ResultData[] = [];

    // RaceTable01 列マッピング (2026年時点):
    // [0]着順 [1]枠 [2]馬番 [3]馬名 [4]性齢 [5]斤量 [6]騎手
    // [7]タイム [8]着差 [9]人気 [10]単勝オッズ [11]後3F
    // [12]コーナー通過順 [13]厩舎 [14]馬体重(増減)
    $('table.RaceTable01 tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 12) return;

      const position = parseInt($(tds[0]).text().trim()) || 0;
      const horseNumber = parseInt($(tds[2]).text().trim()) || 0;
      const horseName = $(tds[3]).find('a').text().trim();
      const time = $(tds[7]).text().trim();
      const margin = $(tds[8]).text().trim();
      const lastThreeFurlongs = $(tds[11]).text().trim();
      const cornerPositions = $(tds[12]).text().trim();

      if (position > 0) {
        results.push({ position, horseNumber, horseName, time, margin, lastThreeFurlongs, cornerPositions });
      }
    });

    return results;
  } catch (e) {
    console.error(`  Error scraping result for ${raceId}:`, (e as Error).message);
    return [];
  }
}

// ==================== DB Write ====================

async function writeRaceToDB(
  turso: Client,
  raceListItem: RaceListItem,
  detail: RaceDetail,
  results: ResultData[],
): Promise<{ entries: number; results: number }> {
  const racecourseId = detail.racecourseId;
  const status = results.length > 0 ? '結果確定' : '出走確定';

  // Upsert race
  await turso.execute({
    sql: `INSERT INTO races (id, name, date, time, racecourse_id, racecourse_name, race_number, grade, track_type, distance, track_condition, weather, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = COALESCE(NULLIF(excluded.name, ''), races.name),
            date = COALESCE(NULLIF(excluded.date, ''), races.date),
            time = COALESCE(excluded.time, races.time),
            racecourse_id = COALESCE(NULLIF(excluded.racecourse_id, ''), races.racecourse_id),
            racecourse_name = COALESCE(NULLIF(excluded.racecourse_name, ''), races.racecourse_name),
            race_number = CASE WHEN excluded.race_number > 0 THEN excluded.race_number ELSE races.race_number END,
            grade = COALESCE(excluded.grade, races.grade),
            track_type = COALESCE(NULLIF(excluded.track_type, ''), races.track_type),
            distance = CASE WHEN excluded.distance > 0 THEN excluded.distance ELSE races.distance END,
            track_condition = COALESCE(excluded.track_condition, races.track_condition),
            weather = COALESCE(excluded.weather, races.weather),
            status = excluded.status`,
    args: [
      detail.id, detail.name, raceListItem.date, detail.time,
      racecourseId, detail.racecourseName, raceListItem.raceNumber,
      detail.grade, detail.trackType, detail.distance,
      detail.trackCondition, detail.weather, status,
    ],
  });

  // Build results map for quick lookup
  const resultMap = new Map(results.map(r => [r.horseNumber, r]));

  // Upsert entries with results
  let entryCount = 0;
  let resultCount = 0;

  for (const entry of detail.entries) {
    const result = resultMap.get(entry.horseNumber);

    // Insert placeholder horse if needed
    await turso.execute({
      sql: "INSERT OR IGNORE INTO horses (id, name, age, sex) VALUES (?, ?, ?, ?)",
      args: [entry.horseId, entry.horseName, entry.age, entry.sex],
    });

    // Check existing entry
    const existing = await turso.execute({
      sql: 'SELECT id FROM race_entries WHERE race_id = ? AND horse_number = ?',
      args: [detail.id, entry.horseNumber],
    });

    if (existing.rows.length > 0) {
      await turso.execute({
        sql: `UPDATE race_entries SET
                post_position = COALESCE(?, post_position),
                horse_id = COALESCE(NULLIF(?, ''), horse_id),
                horse_name = COALESCE(NULLIF(?, ''), horse_name),
                age = COALESCE(?, age),
                sex = COALESCE(?, sex),
                jockey_id = COALESCE(NULLIF(?, ''), jockey_id),
                jockey_name = COALESCE(NULLIF(?, ''), jockey_name),
                trainer_name = COALESCE(NULLIF(?, ''), trainer_name),
                handicap_weight = COALESCE(?, handicap_weight),
                result_position = COALESCE(?, result_position),
                result_time = COALESCE(?, result_time),
                result_margin = COALESCE(?, result_margin),
                result_last_three_furlongs = COALESCE(?, result_last_three_furlongs),
                result_corner_positions = COALESCE(?, result_corner_positions)
              WHERE race_id = ? AND horse_number = ?`,
        args: [
          entry.postPosition, entry.horseId, entry.horseName,
          entry.age, entry.sex, entry.jockeyId, entry.jockeyName,
          entry.trainerName, entry.handicapWeight,
          result?.position ?? null, result?.time ?? null,
          result?.margin ?? null, result?.lastThreeFurlongs ?? null,
          result?.cornerPositions ?? null,
          detail.id, entry.horseNumber,
        ],
      });
    } else {
      await turso.execute({
        sql: `INSERT INTO race_entries (
                race_id, post_position, horse_number, horse_id, horse_name, age, sex,
                jockey_id, jockey_name, trainer_name, handicap_weight,
                result_position, result_time, result_margin,
                result_last_three_furlongs, result_corner_positions
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          detail.id, entry.postPosition, entry.horseNumber,
          entry.horseId, entry.horseName, entry.age, entry.sex,
          entry.jockeyId, entry.jockeyName, entry.trainerName,
          entry.handicapWeight,
          result?.position ?? null, result?.time ?? null,
          result?.margin ?? null, result?.lastThreeFurlongs ?? null,
          result?.cornerPositions ?? null,
        ],
      });
    }

    entryCount++;
    if (result) resultCount++;
  }

  return { entries: entryCount, results: resultCount };
}

// ==================== Date Helpers ====================

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function generateDateRange(days: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  // Start from yesterday (today's races may still be running)
  for (let i = 1; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(formatDate(d));
  }
  return dates;
}

// ==================== Main ====================

async function main() {
  const days = parseDaysArg();
  console.log(`=== Historical Race Import (past ${days} days) ===\n`);
  console.log(`Turso: ${TURSO_URL.substring(0, 30)}...`);

  const dates = generateDateRange(days);

  // Check which dates already have races (to show skip info)
  const existingDates = await db.execute(
    `SELECT date, COUNT(*) as c FROM races WHERE date >= ? GROUP BY date`,
    [dates[dates.length - 1]] // oldest date
  );
  const existingDateMap = new Map(
    existingDates.rows.map(r => [r.date as string, r.c as number])
  );

  let totalRaces = 0;
  let totalEntries = 0;
  let totalResults = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const startTime = Date.now();

  for (const date of dates) {
    // Fetch race list for this date
    let raceList: RaceListItem[];
    try {
      raceList = await scrapeRaceList(date);
      await sleep(RATE_LIMIT_MS);
    } catch (e) {
      console.log(`  ${date}: Failed to get race list - ${(e as Error).message}`);
      totalErrors++;
      continue;
    }

    if (raceList.length === 0) {
      // No races on this date (maybe not a race day)
      continue;
    }

    const existingCount = existingDateMap.get(date) || 0;
    const hasResults = existingCount > 0;

    // Check which races already have results in DB
    let existingRaceIds = new Set<string>();
    if (hasResults) {
      const existing = await db.execute(
        `SELECT r.id FROM races r
         JOIN race_entries re ON r.id = re.race_id
         WHERE r.date = ? AND re.result_position IS NOT NULL
         GROUP BY r.id`,
        [date]
      );
      existingRaceIds = new Set(existing.rows.map(r => r.id as string));
    }

    // Filter to races that need importing (no results yet)
    const racesToImport = raceList.filter(r => !existingRaceIds.has(r.id));
    const skippedCount = raceList.length - racesToImport.length;
    totalSkipped += skippedCount;

    if (racesToImport.length === 0) {
      console.log(`  ${date}: ${raceList.length} races (all already imported, skipping)`);
      continue;
    }

    console.log(`  ${date}: ${raceList.length} races found (${skippedCount} already done, importing ${racesToImport.length})`);

    // Process races in parallel batches
    for (let i = 0; i < racesToImport.length; i += CONCURRENCY) {
      const batch = racesToImport.slice(i, i + CONCURRENCY);

      const batchResults = await Promise.all(
        batch.map(async (race) => {
          try {
            // Scrape race card
            const detail = await scrapeRaceCard(race.id);
            if (!detail || detail.entries.length === 0) {
              return { race, ok: false, entries: 0, results: 0, error: 'no entries' };
            }

            await sleep(RATE_LIMIT_MS);

            // Scrape results
            const results = await scrapeRaceResult(race.id);

            // Write to DB
            const counts = await writeRaceToDB(db, race, detail, results);
            return { race, ok: true, ...counts, error: '' };
          } catch (e) {
            return { race, ok: false, entries: 0, results: 0, error: (e as Error).message };
          }
        })
      );

      for (const r of batchResults) {
        if (r.ok) {
          totalRaces++;
          totalEntries += r.entries;
          totalResults += r.results;
        } else {
          totalErrors++;
          console.log(`    FAIL: ${r.race.name} (${r.race.id}) - ${r.error}`);
        }
      }

      // Rate limit between batches
      if (i + CONCURRENCY < racesToImport.length) {
        await sleep(RATE_LIMIT_MS);
      }
    }

    // Progress update
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`    → ${totalRaces} races imported so far (${elapsed}s elapsed)`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Done in ${elapsed}s ===`);
  console.log(`  Races imported: ${totalRaces}`);
  console.log(`  Entries written: ${totalEntries}`);
  console.log(`  Results recorded: ${totalResults}`);
  console.log(`  Skipped (already done): ${totalSkipped}`);
  console.log(`  Errors: ${totalErrors}`);

  // Verify final counts
  const raceCount = await db.execute('SELECT COUNT(*) as c FROM races');
  const entryCount = await db.execute('SELECT COUNT(*) as c FROM race_entries');
  const resultCount = await db.execute('SELECT COUNT(*) as c FROM race_entries WHERE result_position IS NOT NULL');
  console.log(`\n  DB totals: ${raceCount.rows[0].c} races, ${entryCount.rows[0].c} entries, ${resultCount.rows[0].c} with results`);

  db.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
