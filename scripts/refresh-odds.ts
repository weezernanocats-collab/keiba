/**
 * 未発走レースのオッズを更新するスクリプト
 *
 * GitHub Actions から定期実行し、当日のオッズを最新に保つ。
 * netkeiba API (action=init) を使用し、前売り/確定オッズどちらも取得可能。
 *
 * 使い方:
 *   npx tsx -r tsconfig-paths/register scripts/refresh-odds.ts
 *   npx tsx -r tsconfig-paths/register scripts/refresh-odds.ts --date 2026-03-15
 *   npx tsx -r tsconfig-paths/register scripts/refresh-odds.ts --tomorrow
 */
import { readFileSync, existsSync } from 'fs';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('ERROR: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
  process.exit(1);
}

import { createClient } from '@libsql/client';

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });

const BASE_URL = 'https://race.netkeiba.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function getJSTDate(offsetDays = 0): string {
  const jstOffset = 9 * 60 * 60_000;
  const jst = new Date(Date.now() + jstOffset + offsetDays * 86400000);
  return jst.toISOString().split('T')[0];
}

function getJSTTimestamp(): string {
  const jstOffset = 9 * 60 * 60_000;
  const jst = new Date(Date.now() + jstOffset);
  return jst.toISOString().replace('T', ' ').slice(0, 19);
}

function parseArgs(): string[] {
  const dates: string[] = [];
  const args = process.argv.slice(2);

  if (args.includes('--tomorrow')) {
    dates.push(getJSTDate(1));
  }

  const dateIdx = args.indexOf('--date');
  if (dateIdx >= 0 && args[dateIdx + 1]) {
    dates.push(args[dateIdx + 1]);
  }

  if (dates.length === 0) {
    dates.push(getJSTDate(0));
  }

  return dates;
}

interface WinOdds { horseNumber: number; odds: number }
interface PlaceOdds { horseNumber: number; minOdds: number; maxOdds: number }

async function scrapeOdds(raceId: string): Promise<{ win: WinOdds[]; place: PlaceOdds[] }> {
  const win: WinOdds[] = [];
  const place: PlaceOdds[] = [];

  const apiUrl = `${BASE_URL}/api/api_get_jra_odds.html?race_id=${raceId}&type=1&action=init&compress=0`;
  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return { win, place };

  const text = await response.text();
  let data: { status: string; data?: { odds?: Record<string, Record<string, [string, string, string]>> } };
  try {
    data = JSON.parse(text);
  } catch {
    return { win, place };
  }

  if (!data.data || typeof data.data !== 'object' || !data.data.odds) {
    return { win, place };
  }

  const winOdds = data.data.odds['1'];
  if (winOdds) {
    for (const [numStr, values] of Object.entries(winOdds)) {
      const horseNumber = parseInt(numStr);
      const odds = parseFloat(values[0]);
      if (horseNumber > 0 && odds > 0) {
        win.push({ horseNumber, odds });
      }
    }
  }

  const placeOdds = data.data.odds['2'];
  if (placeOdds) {
    for (const [numStr, values] of Object.entries(placeOdds)) {
      const horseNumber = parseInt(numStr);
      const minOdds = parseFloat(values[0]);
      const maxOdds = parseFloat(values[1]);
      if (horseNumber > 0 && minOdds > 0) {
        place.push({ horseNumber, minOdds, maxOdds });
      }
    }
  }

  return { win, place };
}

async function main() {
  const dates = parseArgs();
  console.log(`=== オッズ更新 ===`);
  console.log(`対象日: ${dates.join(', ')}`);

  const placeholders = dates.map(() => '?').join(',');
  const result = await db.execute({
    sql: `SELECT id, date, racecourse_name, race_number FROM races
          WHERE date IN (${placeholders}) AND status IN ('予定', '出走確定')
          ORDER BY date, racecourse_name, race_number`,
    args: dates,
  });

  const races = result.rows;
  console.log(`対象レース: ${races.length}件\n`);

  if (races.length === 0) {
    console.log('対象レースなし');
    db.close();
    return;
  }

  let totalWin = 0;
  let totalPlace = 0;
  let failCount = 0;

  for (let i = 0; i < races.length; i++) {
    const race = races[i];
    const raceId = race.id as string;

    try {
      const odds = await scrapeOdds(raceId);

      if (odds.win.length > 0) {
        const snapshotTime = getJSTTimestamp();
        for (const w of odds.win) {
          await db.execute({
            sql: `INSERT INTO odds (race_id, bet_type, horse_number1, odds) VALUES (?, '単勝', ?, ?)
                  ON CONFLICT(race_id, bet_type, horse_number1) DO UPDATE SET odds = excluded.odds, updated_at = datetime('now')`,
            args: [raceId, w.horseNumber, w.odds],
          });
          await db.execute({
            sql: `UPDATE race_entries SET odds = ? WHERE race_id = ? AND horse_number = ?`,
            args: [w.odds, raceId, w.horseNumber],
          });
          // オッズ時系列スナップショット保存
          await db.execute({
            sql: `INSERT INTO odds_snapshots (race_id, horse_number, odds, snapshot_time) VALUES (?, ?, ?, ?)`,
            args: [raceId, w.horseNumber, w.odds, snapshotTime],
          });
        }
        totalWin += odds.win.length;

        for (const p of odds.place) {
          await db.execute({
            sql: `INSERT INTO odds (race_id, bet_type, horse_number1, odds, min_odds) VALUES (?, '複勝', ?, ?, ?)
                  ON CONFLICT(race_id, bet_type, horse_number1) DO UPDATE SET odds = excluded.odds, min_odds = excluded.min_odds, updated_at = datetime('now')`,
            args: [raceId, p.horseNumber, p.maxOdds, p.minOdds],
          });
        }
        totalPlace += odds.place.length;

        process.stdout.write(`\r  [${i + 1}/${races.length}] ${raceId}: 単勝${odds.win.length} 複勝${odds.place.length}  `);
      } else {
        failCount++;
        process.stdout.write(`\r  [${i + 1}/${races.length}] ${raceId}: オッズなし        `);
      }
    } catch (e) {
      failCount++;
      process.stdout.write(`\r  [${i + 1}/${races.length}] ${raceId}: ERROR             `);
    }

    if (i < races.length - 1) await sleep(1000);
  }

  console.log(`\n\n=== 完了 ===`);
  console.log(`  単勝: ${totalWin}件`);
  console.log(`  複勝: ${totalPlace}件`);
  console.log(`  失敗: ${failCount}件`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
