/**
 * オッズスナップショット取得 & 急落検知スクリプト
 *
 * paddock-watcher.sh から呼ばれ、以下を行う:
 *   1. 朝一スナップショット保存 (--snapshot)
 *   2. レース直前のオッズ取得 + 朝比較 (--compare)
 *   3. 急落検知結果をJSON出力（通知用）
 *
 * 使い方:
 *   npx tsx scripts/odds-snapshot.ts --date 2026-04-20 --snapshot
 *   npx tsx scripts/odds-snapshot.ts --date 2026-04-20 --race 202605041211 --compare
 *   npx tsx scripts/odds-snapshot.ts --date 2026-04-20 --compare --threshold 30
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

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

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

interface OddsDrop {
  raceId: string;
  raceName: string;
  horseName: string;
  horseNumber: number;
  morningOdds: number;
  currentOdds: number;
  dropRate: number; // percentage drop (positive = odds decreased)
}

async function saveSnapshot(raceIds: { id: string; name: string }[], label: string): Promise<number> {
  const snapshotTime = `${getJSTTimestamp()} ${label}`;
  let savedCount = 0;

  for (let i = 0; i < raceIds.length; i++) {
    const { id: raceId } = raceIds[i];
    try {
      const odds = await scrapeOdds(raceId);
      if (odds.win.length === 0) continue;

      for (const w of odds.win) {
        await db.execute({
          sql: `INSERT INTO odds_snapshots (race_id, horse_number, odds, snapshot_time) VALUES (?, ?, ?, ?)`,
          args: [raceId, w.horseNumber, w.odds, snapshotTime],
        });
        savedCount++;
      }

      // odds テーブルも最新に更新
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
      }
      for (const p of odds.place) {
        await db.execute({
          sql: `INSERT INTO odds (race_id, bet_type, horse_number1, odds, min_odds) VALUES (?, '複勝', ?, ?, ?)
                ON CONFLICT(race_id, bet_type, horse_number1) DO UPDATE SET odds = excluded.odds, min_odds = excluded.min_odds, updated_at = datetime('now')`,
          args: [raceId, p.horseNumber, p.maxOdds, p.minOdds],
        });
      }

      process.stdout.write(`\r  [${i + 1}/${raceIds.length}] ${raceId}: ${odds.win.length}頭  `);
    } catch (e) {
      process.stdout.write(`\r  [${i + 1}/${raceIds.length}] ${raceId}: ERROR  `);
    }

    if (i < raceIds.length - 1) await sleep(1000);
  }

  return savedCount;
}

async function compareOdds(
  raceIds: { id: string; name: string }[],
  thresholdPct: number,
): Promise<OddsDrop[]> {
  const drops: OddsDrop[] = [];
  const compareTime = `${getJSTTimestamp()} pre-race`;

  for (let i = 0; i < raceIds.length; i++) {
    const { id: raceId, name: raceName } = raceIds[i];
    try {
      // 朝一スナップショットを取得（最初のスナップショット）
      const morningResult = await db.execute({
        sql: `SELECT horse_number, odds, snapshot_time
              FROM odds_snapshots
              WHERE race_id = ? AND snapshot_time LIKE '%morning%'
              ORDER BY snapshot_time ASC`,
        args: [raceId],
      });

      if (morningResult.rows.length === 0) {
        // morning snapshot がなければ最古のスナップショットを使う
        const fallback = await db.execute({
          sql: `SELECT horse_number, odds, snapshot_time
                FROM odds_snapshots
                WHERE race_id = ?
                ORDER BY snapshot_time ASC
                LIMIT 20`,
          args: [raceId],
        });
        if (fallback.rows.length === 0) continue;
        morningResult.rows.push(...fallback.rows);
      }

      // 馬番 → 朝一オッズのマップ（最初の記録を使う）
      const morningMap = new Map<number, number>();
      for (const row of morningResult.rows) {
        const hn = row.horse_number as number;
        if (!morningMap.has(hn)) {
          morningMap.set(hn, row.odds as number);
        }
      }

      // 現在のオッズを取得
      const currentOdds = await scrapeOdds(raceId);
      if (currentOdds.win.length === 0) continue;

      // スナップショット保存
      for (const w of currentOdds.win) {
        await db.execute({
          sql: `INSERT INTO odds_snapshots (race_id, horse_number, odds, snapshot_time) VALUES (?, ?, ?, ?)`,
          args: [raceId, w.horseNumber, w.odds, compareTime],
        });
      }

      // 馬名取得
      const entriesResult = await db.execute({
        sql: `SELECT horse_number, horse_name FROM race_entries WHERE race_id = ?`,
        args: [raceId],
      });
      const nameMap = new Map<number, string>();
      for (const row of entriesResult.rows) {
        nameMap.set(row.horse_number as number, row.horse_name as string);
      }

      // 比較: 朝一 vs 現在
      for (const w of currentOdds.win) {
        const morning = morningMap.get(w.horseNumber);
        if (!morning || morning <= 0) continue;

        const dropRate = ((morning - w.odds) / morning) * 100;

        if (dropRate >= thresholdPct) {
          drops.push({
            raceId,
            raceName,
            horseName: nameMap.get(w.horseNumber) || `${w.horseNumber}番`,
            horseNumber: w.horseNumber,
            morningOdds: morning,
            currentOdds: w.odds,
            dropRate: Math.round(dropRate * 10) / 10,
          });
        }
      }

      process.stdout.write(`\r  [${i + 1}/${raceIds.length}] ${raceId} 比較完了  `);
    } catch (e) {
      process.stdout.write(`\r  [${i + 1}/${raceIds.length}] ${raceId}: ERROR  `);
    }

    if (i < raceIds.length - 1) await sleep(1000);
  }

  // 急落率でソート（大きい順）
  drops.sort((a, b) => b.dropRate - a.dropRate);
  return drops;
}

async function main() {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf('--date');
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : getJSTDate(0);
  const raceIdx = args.indexOf('--race');
  const raceFilter = raceIdx >= 0 && args[raceIdx + 1] ? args[raceIdx + 1] : null;
  const thresholdIdx = args.indexOf('--threshold');
  const threshold = thresholdIdx >= 0 && args[thresholdIdx + 1] ? parseFloat(args[thresholdIdx + 1]) : 30;
  const labelIdx = args.indexOf('--label');
  const label = labelIdx >= 0 && args[labelIdx + 1] ? args[labelIdx + 1] : 'morning';
  const isSnapshot = args.includes('--snapshot');
  const isCompare = args.includes('--compare');

  if (!isSnapshot && !isCompare) {
    console.error('Usage: --snapshot (save morning odds) or --compare (compare with morning)');
    console.error('  --date YYYY-MM-DD  対象日（デフォルト: 今日）');
    console.error('  --race RACE_ID     特定レースのみ');
    console.error('  --threshold N      急落検知閾値%（デフォルト: 30）');
    console.error('  --label NAME       スナップショットラベル（デフォルト: morning）');
    db.close();
    process.exit(1);
  }

  // 対象レースを取得
  let raceQuery: string;
  let raceArgs: unknown[];

  if (raceFilter) {
    raceQuery = `SELECT id, name, racecourse_name, race_number FROM races WHERE id = ?`;
    raceArgs = [raceFilter];
  } else {
    raceQuery = `SELECT id, name, racecourse_name, race_number FROM races
                 WHERE date = ? AND status IN ('予定', '出走確定')
                 ORDER BY racecourse_name, race_number`;
    raceArgs = [date];
  }

  const result = await db.execute({ sql: raceQuery, args: raceArgs });
  const races = result.rows.map(r => ({
    id: r.id as string,
    name: `${r.racecourse_name}${r.race_number}R ${r.name || ''}`.trim(),
  }));

  if (races.length === 0) {
    console.log(`対象レースなし (date=${date})`);
    db.close();
    return;
  }

  if (isSnapshot) {
    console.log(`=== オッズスナップショット保存 (${date}, ${races.length}レース, ${label}) ===`);
    const count = await saveSnapshot(races, label);
    console.log(`\n保存完了: ${count}件のスナップショット`);
  }

  if (isCompare) {
    console.log(`=== オッズ急落チェック (${date}, 閾値${threshold}%) ===`);
    const drops = await compareOdds(races, threshold);

    if (drops.length === 0) {
      console.log('\n急落検知なし');
    } else {
      console.log(`\n=== 急落検知: ${drops.length}件 ===`);
      for (const d of drops) {
        console.log(`  ${d.raceName} ${d.horseNumber}番 ${d.horseName}: ${d.morningOdds}→${d.currentOdds} (↓${d.dropRate}%)`);
      }

      // JSON出力（paddock-watcher.shからパース用）
      console.log(`\n__DROPS_JSON__${JSON.stringify(drops)}__END_JSON__`);
    }
  }

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
