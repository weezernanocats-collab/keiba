/**
 * ローカル実行スクリプト: レースのオッズ（単勝・人気）を取得
 *
 * 使い方: npx tsx scripts/fetch-odds.ts [--date 2026-03-01]
 *
 * 結果確定済みレース → result.html から最終オッズ + 人気を取得
 * 未確定レース → netkeiba odds API からライブオッズを取得
 */
import { createClient } from '@libsql/client';
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
const RATE_LIMIT_MS = 500;
const CONCURRENCY = 3;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in .env.local');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

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
          await sleep(5000 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const buffer = await res.arrayBuffer();
      const preview = new TextDecoder('ascii').decode(buffer.slice(0, 1024));
      const encoding = preview.includes('charset="UTF-8"') || preview.includes('charset=utf-8') ? 'utf-8' : 'euc-jp';
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

// ==================== CLI args ====================

function parseDateArg(): string | null {
  const idx = process.argv.indexOf('--date');
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
}

// ==================== Scrape from result.html ====================

interface ResultOdds {
  horseNumber: number;
  odds: number;
  popularity: number;
}

async function scrapeOddsFromResult(raceId: string): Promise<ResultOdds[]> {
  const url = `${RACE_BASE_URL}/race/result.html?race_id=${raceId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const results: ResultOdds[] = [];

  // RaceTable01 列マッピング (2026年時点):
  // [0]着順 [1]枠 [2]馬番 [3]馬名 [4]性齢 [5]斤量 [6]騎手
  // [7]タイム [8]着差 [9]人気 [10]単勝オッズ [11]後3F
  // [12]コーナー通過順 [13]厩舎 [14]馬体重(増減)
  $('table.RaceTable01 tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 12) return;

    const horseNumber = parseInt($(tds[2]).text().trim()) || 0;
    const popularity = parseInt($(tds[9]).text().trim()) || 0;
    const odds = parseFloat($(tds[10]).text().trim()) || 0;

    if (horseNumber > 0 && odds > 0) {
      results.push({ horseNumber, odds, popularity });
    }
  });

  return results;
}

// ==================== Scrape from odds API (for upcoming races) ====================

interface ApiOdds {
  win: { horseNumber: number; odds: number }[];
  place: { horseNumber: number; minOdds: number; maxOdds: number }[];
}

async function scrapeOddsFromApi(raceId: string): Promise<ApiOdds> {
  const win: ApiOdds['win'] = [];
  const place: ApiOdds['place'] = [];

  // action=init&compress=0: 未発走レースの前売りオッズも取得可能にする
  const apiUrl = `${RACE_BASE_URL}/api/api_get_jra_odds.html?race_id=${raceId}&type=1&action=init&compress=0`;
  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) return { win, place };

  const data = await response.json() as {
    status: string;
    data?: {
      odds?: {
        '1'?: Record<string, [string, string, string]>;
        '2'?: Record<string, [string, string, string]>;
      };
    } | string;
  };

  // status=result (確定) or status=middle (前売り) どちらもオッズを取得
  if (!data.data || typeof data.data !== 'object') return { win, place };
  const oddsData = data.data as { odds?: { '1'?: Record<string, [string, string, string]>; '2'?: Record<string, [string, string, string]> } };
  if (!oddsData.odds) return { win, place };

  const winOdds = oddsData.odds['1'];
  if (winOdds) {
    for (const [numStr, values] of Object.entries(winOdds)) {
      const horseNumber = parseInt(numStr);
      const odds = parseFloat(values[0]);
      if (horseNumber > 0 && odds > 0) win.push({ horseNumber, odds });
    }
  }

  const placeOdds = oddsData.odds['2'];
  if (placeOdds) {
    for (const [numStr, values] of Object.entries(placeOdds)) {
      const horseNumber = parseInt(numStr);
      const minOdds = parseFloat(values[0]);
      const maxOdds = parseFloat(values[1]);
      if (horseNumber > 0 && minOdds > 0) place.push({ horseNumber, minOdds, maxOdds });
    }
  }

  return { win, place };
}

// ==================== DB Write ====================

async function upsertOdds(
  raceId: string,
  betType: string,
  horseNumber: number,
  oddsValue: number,
  minOdds?: number,
  maxOdds?: number,
): Promise<void> {
  // Use INSERT OR REPLACE with the unique index
  await db.execute({
    sql: `INSERT OR REPLACE INTO odds (race_id, bet_type, horse_number1, odds, min_odds, max_odds, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [raceId, betType, horseNumber, oddsValue, minOdds ?? null, maxOdds ?? null],
  });
}

async function updateEntryOdds(raceId: string, horseNumber: number, odds: number, popularity: number): Promise<void> {
  await db.execute({
    sql: `UPDATE race_entries SET odds = ?, popularity = ? WHERE race_id = ? AND horse_number = ?`,
    args: [odds, popularity, raceId, horseNumber],
  });
}

// ==================== Main ====================

async function main() {
  console.log('=== Fetch Odds ===\n');

  // Ensure unique index exists
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_odds_unique ON odds(race_id, bet_type, horse_number1)');

  // Add odds/popularity columns to race_entries if missing
  const schema = await db.execute("PRAGMA table_info(race_entries)");
  const cols = new Set(schema.rows.map(r => r.name as string));
  if (!cols.has('odds')) {
    await db.execute('ALTER TABLE race_entries ADD COLUMN odds REAL');
    console.log('Added odds column to race_entries');
  }
  if (!cols.has('popularity')) {
    await db.execute('ALTER TABLE race_entries ADD COLUMN popularity INTEGER');
    console.log('Added popularity column to race_entries');
  }

  // Determine target date
  const dateArg = parseDateArg();
  let targetDates: string[];
  if (dateArg) {
    targetDates = [dateArg];
  } else {
    // Fetch all dates that have races
    const datesResult = await db.execute("SELECT DISTINCT date FROM races ORDER BY date DESC");
    targetDates = datesResult.rows.map(r => r.date as string);
  }

  let totalWin = 0;
  let totalPlace = 0;
  let totalEntryUpdates = 0;
  let errors = 0;
  const startTime = Date.now();

  for (const targetDate of targetDates) {
    const races = await db.execute({
      sql: "SELECT id, name, race_number, status FROM races WHERE date = ? ORDER BY race_number",
      args: [targetDate],
    });

    if (races.rows.length === 0) continue;

    // Check if already have odds for this date (skip unless --force)
    const forceFlag = process.argv.includes('--force');
    const existingOdds = await db.execute({
      sql: "SELECT COUNT(*) as c FROM odds WHERE race_id IN (SELECT id FROM races WHERE date = ?)",
      args: [targetDate],
    });
    if ((existingOdds.rows[0].c as number) > 0 && !forceFlag) {
      console.log(`  ${targetDate}: ${races.rows.length} races (already have odds, skip. Use --force to refresh)`);
      continue;
    }

    console.log(`  ${targetDate}: ${races.rows.length} races`);

    for (let i = 0; i < races.rows.length; i += CONCURRENCY) {
      const batch = races.rows.slice(i, i + CONCURRENCY);

      await Promise.all(batch.map(async (race) => {
        const raceId = race.id as string;
        const raceName = race.name as string;
        const raceNum = race.race_number as number;
        const status = race.status as string;

        try {
          if (status === '結果確定') {
            // Get odds from result page
            const resultOdds = await scrapeOddsFromResult(raceId);
            for (const r of resultOdds) {
              await upsertOdds(raceId, '単勝', r.horseNumber, r.odds);
              totalWin++;
              await updateEntryOdds(raceId, r.horseNumber, r.odds, r.popularity);
              totalEntryUpdates++;
            }
            process.stdout.write(`\r    ${raceNum}R ${raceName}: 単勝${resultOdds.length}件 (from results)    `);
          } else {
            // Get odds from API for upcoming races
            const apiOdds = await scrapeOddsFromApi(raceId);
            // 人気順位を計算（単勝オッズ昇順）
            const sortedWin = [...apiOdds.win].sort((a, b) => a.odds - b.odds);
            const popularityMap = new Map<number, number>();
            sortedWin.forEach((w, i) => popularityMap.set(w.horseNumber, i + 1));

            for (const w of apiOdds.win) {
              await upsertOdds(raceId, '単勝', w.horseNumber, w.odds);
              totalWin++;
              // race_entries.odds/popularity も更新
              await updateEntryOdds(raceId, w.horseNumber, w.odds, popularityMap.get(w.horseNumber) || 0);
              totalEntryUpdates++;
            }
            for (const p of apiOdds.place) {
              await upsertOdds(raceId, '複勝', p.horseNumber, p.minOdds, p.minOdds, p.maxOdds);
              totalPlace++;
            }
            process.stdout.write(`\r    ${raceNum}R ${raceName}: 単勝${apiOdds.win.length}件, 複勝${apiOdds.place.length}件 (API)    `);
          }
        } catch {
          errors++;
          process.stdout.write(`\r    ${raceNum}R ${raceName}: ERROR    `);
        }
      }));

      if (i + CONCURRENCY < races.rows.length) {
        await sleep(RATE_LIMIT_MS);
      }
    }

    console.log(''); // newline
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Done in ${elapsed}s ===`);
  console.log(`  Win odds: ${totalWin}`);
  console.log(`  Place odds: ${totalPlace}`);
  console.log(`  Entry updates: ${totalEntryUpdates}`);
  console.log(`  Errors: ${errors}`);

  const total = await db.execute('SELECT COUNT(*) as c FROM odds');
  console.log(`  Total odds in DB: ${total.rows[0].c}`);

  db.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
