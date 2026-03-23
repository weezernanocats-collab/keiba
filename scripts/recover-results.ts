/**
 * ローカル実行スクリプト: 滞留レースの結果を手動回収
 *
 * 使い方: npx tsx scripts/recover-results.ts [--date 2026-03-22] [--all]
 *
 * --date: 特定日の結果を取得
 * --all:  全滞留レース（出走確定のまま過去日付）を処理
 */
import { createClient } from '@libsql/client';
import * as cheerio from 'cheerio';
import * as iconv from 'iconv-lite';
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
const RATE_LIMIT_MS = 800;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in .env.local');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const preview = buf.slice(0, 2048).toString('ascii').toLowerCase();
  const encoding = preview.includes('charset=utf-8') ? 'utf-8' : 'euc-jp';
  return iconv.decode(buf, encoding);
}

interface RaceResult {
  position: number;
  horseNumber: number;
  horseName: string;
  time: string;
  margin: string;
  lastThreeFurlongs: string;
  cornerPositions: string;
  odds: number;
  popularity: number;
}

function parseResults(html: string): { results: RaceResult[]; lapTimes: number[] } {
  const $ = cheerio.load(html);
  const results: RaceResult[] = [];

  $('table.RaceTable01 tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 12) return;
    const position = parseInt($(tds[0]).text().trim()) || 0;
    const horseNumber = parseInt($(tds[2]).text().trim()) || 0;
    const horseName = $(tds[3]).find('a').text().trim();
    const time = $(tds[7]).text().trim();
    const margin = $(tds[8]).text().trim();
    const popularity = parseInt($(tds[9]).text().trim()) || 0;
    const odds = parseFloat($(tds[10]).text().trim()) || 0;
    const lastThreeFurlongs = $(tds[11]).text().trim();
    const cornerPositions = $(tds[12]).text().trim();
    if (position > 0) {
      results.push({ position, horseNumber, horseName, time, margin, lastThreeFurlongs, cornerPositions, odds, popularity });
    }
  });

  const lapTimes: number[] = [];
  for (const sel of ['.RapLap', '.Race_HaronTime', '.HaronTime']) {
    const el = $(sel);
    if (el.length > 0) {
      const matches = el.text().trim().match(/\d{1,2}\.\d/g);
      if (matches && matches.length >= 3) {
        for (const m of matches) lapTimes.push(parseFloat(m));
        break;
      }
    }
  }

  return { results, lapTimes };
}

function classifyPaceType(lapTimes: number[]): string {
  if (lapTimes.length < 4) return 'unknown';
  const half = Math.floor(lapTimes.length / 2);
  const firstHalf = lapTimes.slice(0, half).reduce((a, b) => a + b, 0);
  const secondHalf = lapTimes.slice(half).reduce((a, b) => a + b, 0);
  const diff = firstHalf - secondHalf;
  if (diff < -1.0) return 'slow';
  if (diff > 1.0) return 'fast';
  return 'even';
}

async function main() {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf('--date');
  const targetDate = dateIdx >= 0 ? args[dateIdx + 1] : null;
  const allMode = args.includes('--all');

  let query: string;
  let params: string[];
  if (targetDate) {
    query = "SELECT id, name, date FROM races WHERE date = ? AND status != '結果確定' ORDER BY id";
    params = [targetDate];
  } else if (allMode) {
    const now = new Date();
    const jstToday = new Date(now.getTime() + 9 * 60 * 60000).toISOString().split('T')[0];
    query = "SELECT id, name, date FROM races WHERE date < ? AND status IN ('予定', '出走確定') ORDER BY date DESC, id LIMIT 200";
    params = [jstToday];
  } else {
    console.log('Usage: npx tsx scripts/recover-results.ts --date 2026-03-22');
    console.log('       npx tsx scripts/recover-results.ts --all');
    process.exit(0);
  }

  const races = (await db.execute({ sql: query, args: params })).rows;
  console.log(`\n対象: ${races.length}レース\n`);

  let success = 0, failed = 0, empty = 0;

  for (const race of races) {
    const raceId = race.id as string;
    const raceName = race.name as string;
    const raceDate = race.date as string;

    try {
      const url = `${RACE_BASE_URL}/race/result.html?race_id=${raceId}`;
      const html = await fetchHtml(url);
      const { results, lapTimes } = parseResults(html);

      if (results.length === 0) {
        console.log(`  ⚠ ${raceDate} ${raceId} ${raceName}: 結果データなし`);
        empty++;
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      // 結果をDB書き込み
      for (const r of results) {
        await db.execute({
          sql: `UPDATE race_entries SET
                  result_position = ?, result_time = ?, result_margin = ?,
                  result_last_three_furlongs = ?, result_corner_positions = ?,
                  odds = ?, popularity = ?
                WHERE race_id = ? AND horse_number = ?`,
          args: [r.position, r.time, r.margin, r.lastThreeFurlongs, r.cornerPositions, r.odds, r.popularity, raceId, r.horseNumber],
        });
        // 単勝オッズも保存
        if (r.odds > 0) {
          await db.execute({
            sql: `INSERT INTO odds (race_id, bet_type, horse_number1, odds, updated_at)
                  VALUES (?, '単勝', ?, ?, datetime('now'))
                  ON CONFLICT(race_id, bet_type, horse_number1) DO UPDATE SET odds = excluded.odds, updated_at = excluded.updated_at`,
            args: [raceId, r.horseNumber, r.odds],
          });
        }
      }

      // ラップタイム保存
      if (lapTimes.length > 0) {
        const paceType = classifyPaceType(lapTimes);
        await db.execute({
          sql: `UPDATE races SET lap_times_json = ?, pace_type = ? WHERE id = ?`,
          args: [JSON.stringify(lapTimes), paceType, raceId],
        });
      }

      // ステータス更新
      await db.execute({
        sql: `UPDATE races SET status = '結果確定' WHERE id = ?`,
        args: [raceId],
      });

      console.log(`  ✓ ${raceDate} ${raceId} ${raceName}: ${results.length}頭 (1着: ${results[0].horseName})`);
      success++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ${raceDate} ${raceId} ${raceName}: ${msg}`);
      failed++;
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n完了: 成功${success} / 空${empty} / 失敗${failed} / 合計${races.length}`);

  // 評価実行
  if (success > 0) {
    console.log('\n予想照合を実行中...');
    const pending = (await db.execute({
      sql: `SELECT DISTINCT p.race_id FROM predictions p
            JOIN races r ON p.race_id = r.id
            LEFT JOIN prediction_results pr ON p.race_id = pr.race_id
            WHERE r.status = '結果確定' AND pr.id IS NULL`,
      args: [],
    })).rows;
    console.log(`未照合: ${pending.length}レース`);
    // 照合はデプロイ後のcronに任せる（ローカルでは evaluateRacePrediction の依存が複雑）
    console.log('→ 次回のcron実行で自動照合されます');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
