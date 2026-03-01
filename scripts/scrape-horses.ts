/**
 * ローカル実行スクリプト: 出走馬の過去成績を一括スクレイプ
 *
 * 使い方: npx tsx scripts/scrape-horses.ts
 *
 * - 今日の全レースの出走馬を取得
 * - netkeiba から馬の詳細・過去成績をスクレイプ
 * - Turso DBに直接書き込み
 * - 並列3で処理（netkeiba の負荷軽減のため）
 */
import { createClient } from '@libsql/client';
import * as cheerio from 'cheerio';
import { readFileSync } from 'fs';

// Load .env.local manually (no dotenv dependency needed)
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

const TURSO_URL = process.env.TURSO_DATABASE_URL!;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN!;
const BASE_URL = 'https://db.netkeiba.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const CONCURRENCY = 3;
const RATE_LIMIT_MS = 800; // リクエスト間隔

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in .env.local');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ==================== Fetch HTML ====================

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
      const preview = new TextDecoder('ascii').decode(buffer.slice(0, 1024));
      const isUTF8 = preview.includes('charset="UTF-8"') || preview.includes('charset=utf-8');
      return new TextDecoder(isUTF8 ? 'utf-8' : 'euc-jp').decode(buffer);
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

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ==================== Scrape Horse ====================

interface HorseData {
  id: string;
  name: string;
  birthDate: string | null;
  fatherName: string;
  motherName: string;
  trainerName: string;
  ownerName: string;
  pastPerformances: PastPerf[];
}

interface PastPerf {
  date: string;
  racecourseName: string;
  raceName: string;
  trackType: string;
  distance: number;
  trackCondition: string;
  entries: number;
  postPosition: number;
  horseNumber: number;
  odds: number;
  popularity: number;
  position: number;
  jockeyName: string;
  handicapWeight: number;
  weight: number;
  weightChange: number;
  time: string;
  margin: string;
  lastThreeFurlongs: string;
  cornerPositions: string;
  prize: number;
}

async function scrapeHorse(horseId: string): Promise<HorseData | null> {
  try {
    // Profile page
    const profileHtml = await fetchHtml(`${BASE_URL}/horse/${horseId}`);
    const $ = cheerio.load(profileHtml);

    const name = $('.horse_title h1').text().trim().split('\n')[0]
      || $('h1').first().text().trim().split('\n')[0];
    if (!name) return null;

    const profileTable = $('table.db_prof_table');
    const birthDate = profileTable.find('tr').eq(0).find('td').text().trim() || null;
    const trainerName = profileTable.find('tr').eq(4).find('td a').text().trim();
    const ownerName = profileTable.find('tr').eq(5).find('td a').text().trim();
    const fatherName = $('a[href*="/horse/ped/"]').eq(0).text().trim();
    const motherName = $('a[href*="/horse/ped/"]').eq(1).text().trim();

    // Past performances
    await sleep(RATE_LIMIT_MS);
    const resultHtml = await fetchHtml(`${BASE_URL}/horse/result/${horseId}`);
    const $r = cheerio.load(resultHtml);

    const pastPerformances: PastPerf[] = [];
    $r('table.db_h_race_results tbody tr').each((_, tr) => {
      const tds = $r(tr).find('td');
      if (tds.length < 20) return;

      const date = $r(tds[0]).find('a').text().trim();
      if (!date) return;

      const racecourseName = $r(tds[1]).text().trim();
      const raceName = $r(tds[4]).find('a').text().trim();
      const entries = parseInt($r(tds[7]).text().trim()) || 0;
      const postPosition = parseInt($r(tds[8]).text().trim()) || 0;
      const horseNumber = parseInt($r(tds[9]).text().trim()) || 0;
      const odds = parseFloat($r(tds[10]).text().trim()) || 0;
      const popularity = parseInt($r(tds[11]).text().trim()) || 0;
      const position = parseInt($r(tds[12]).text().trim()) || 99;
      const jockeyName = $r(tds[13]).find('a').text().trim();
      const handicapWeight = parseFloat($r(tds[14]).text().trim()) || 0;
      const distText = $r(tds[15]).text().trim();
      const trackMatch = distText.match(/(芝|ダート|ダ|障害|障)(\d+)/);
      const condText = $r(tds[16]).text().trim();
      const time = $r(tds[17]).text().trim();
      const margin = $r(tds[18]).text().trim();
      const lastThreeFurlongs = $r(tds[22])?.text().trim() || '';
      const cornerPositions = $r(tds[21])?.text().trim() || '';
      const weightText = $r(tds[23])?.text().trim() || '';
      const weightMatch = weightText.match(/(\d+)\(([+-]?\d+)\)/);
      const prizeText = $r(tds[27])?.text().trim() || '0';
      const prize = parseFloat(prizeText.replace(/,/g, '')) || 0;

      let trackType = trackMatch?.[1] || 'ダート';
      if (trackType === 'ダ') trackType = 'ダート';
      if (trackType === '障') trackType = '障害';

      pastPerformances.push({
        date: date.replace(/\//g, '-'),
        racecourseName,
        raceName,
        trackType,
        distance: parseInt(trackMatch?.[2] || '0'),
        trackCondition: condText || '良',
        entries,
        postPosition,
        horseNumber,
        odds,
        popularity,
        position,
        jockeyName,
        handicapWeight,
        weight: weightMatch ? parseInt(weightMatch[1]) : 0,
        weightChange: weightMatch ? parseInt(weightMatch[2]) : 0,
        time,
        margin,
        lastThreeFurlongs,
        cornerPositions,
        prize,
      });
    });

    return {
      id: horseId,
      name,
      birthDate,
      fatherName,
      motherName,
      trainerName,
      ownerName,
      pastPerformances,
    };
  } catch (e) {
    console.error(`  Error scraping ${horseId}:`, (e as Error).message);
    return null;
  }
}

// ==================== DB Write ====================

async function writeHorseToDB(horse: HorseData): Promise<number> {
  // Parse age from birthDate
  let age = 0;
  if (horse.birthDate) {
    const m = horse.birthDate.match(/(\d{4})/);
    if (m) {
      age = new Date().getFullYear() - parseInt(m[1]);
    }
  }

  // Upsert horse
  await db.execute({
    sql: `INSERT INTO horses (id, name, birth_date, father_name, mother_name, trainer_name, owner_name, age, sex, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '牡', datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN excluded.name != '' AND excluded.name != '取得失敗' THEN excluded.name ELSE horses.name END,
            birth_date = COALESCE(NULLIF(excluded.birth_date, ''), horses.birth_date),
            father_name = COALESCE(NULLIF(excluded.father_name, ''), horses.father_name),
            mother_name = COALESCE(NULLIF(excluded.mother_name, ''), horses.mother_name),
            trainer_name = COALESCE(NULLIF(excluded.trainer_name, ''), horses.trainer_name),
            owner_name = COALESCE(NULLIF(excluded.owner_name, ''), horses.owner_name),
            age = CASE WHEN excluded.age > 0 THEN excluded.age ELSE horses.age END,
            total_races = ?,
            wins = ?,
            updated_at = datetime('now')`,
    args: [
      horse.id, horse.name, horse.birthDate, horse.fatherName,
      horse.motherName, horse.trainerName, horse.ownerName, age,
      horse.pastPerformances.length,
      horse.pastPerformances.filter(p => p.position === 1).length,
    ],
  });

  // Write past performances (delete old, insert new)
  await db.execute({ sql: 'DELETE FROM past_performances WHERE horse_id = ?', args: [horse.id] });

  if (horse.pastPerformances.length > 0) {
    // Batch insert in groups of 20
    for (let i = 0; i < horse.pastPerformances.length; i += 20) {
      const batch = horse.pastPerformances.slice(i, i + 20);
      const stmts = batch.map(pp => ({
        sql: `INSERT INTO past_performances (horse_id, date, race_name, racecourse_name, track_type, distance, track_condition, weather, entries, post_position, horse_number, position, jockey_name, handicap_weight, weight, weight_change, time, margin, last_three_furlongs, corner_positions, odds, popularity, prize)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          horse.id, pp.date, pp.raceName, pp.racecourseName, pp.trackType,
          pp.distance, pp.trackCondition, pp.entries, pp.postPosition,
          pp.horseNumber, pp.position, pp.jockeyName, pp.handicapWeight,
          pp.weight, pp.weightChange, pp.time, pp.margin,
          pp.lastThreeFurlongs, pp.cornerPositions, pp.odds, pp.popularity, pp.prize,
        ],
      }));
      await db.batch(stmts, 'write');
    }
  }

  return horse.pastPerformances.length;
}

// ==================== Main ====================

async function main() {
  console.log('=== Horse Past Performance Scraper ===');
  console.log(`Turso: ${TURSO_URL.substring(0, 30)}...`);

  // Get all unique horse IDs from today's race entries
  const rows = await db.execute(
    `SELECT DISTINCT re.horse_id
     FROM race_entries re
     JOIN races r ON re.race_id = r.id
     WHERE r.date = (SELECT MAX(date) FROM races)
     ORDER BY re.horse_id`
  );

  const horseIds = rows.rows.map(r => r.horse_id as string);
  console.log(`Found ${horseIds.length} unique horses to scrape`);

  // Check which already have past performances
  const existing = await db.execute(
    `SELECT DISTINCT horse_id FROM past_performances WHERE horse_id IN (${horseIds.map(() => '?').join(',')})`,
    horseIds
  );
  const existingSet = new Set(existing.rows.map(r => r.horse_id as string));
  const toScrape = horseIds.filter(id => !existingSet.has(id));

  console.log(`Already have data: ${existingSet.size}, Need to scrape: ${toScrape.length}`);

  let completed = 0;
  let totalPerfs = 0;
  let errors = 0;
  const startTime = Date.now();

  // Process in parallel batches
  for (let i = 0; i < toScrape.length; i += CONCURRENCY) {
    const batch = toScrape.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (horseId) => {
        const horse = await scrapeHorse(horseId);
        if (horse) {
          const perfCount = await writeHorseToDB(horse);
          return { horseId, name: horse.name, perfs: perfCount, ok: true };
        }
        return { horseId, name: '?', perfs: 0, ok: false };
      })
    );

    for (const r of results) {
      completed++;
      if (r.ok) {
        totalPerfs += r.perfs;
        process.stdout.write(`\r  [${completed}/${toScrape.length}] ${r.name} (${r.perfs} races)    `);
      } else {
        errors++;
        process.stdout.write(`\r  [${completed}/${toScrape.length}] ${r.horseId} FAILED    `);
      }
    }

    // Rate limiting between batches
    if (i + CONCURRENCY < toScrape.length) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\nDone! ${completed} horses processed in ${elapsed}s`);
  console.log(`  Past performances: ${totalPerfs}`);
  console.log(`  Errors: ${errors}`);

  db.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
