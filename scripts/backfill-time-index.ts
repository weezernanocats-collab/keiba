/**
 * タイム指数・馬場指数のバックフィル
 *
 * 既存馬のpast_performancesを再スクレイプしてtime_index/track_indexを埋める。
 * netkeiba制限（2,600req/回）を考慮し、チャンク実行に対応。
 *
 * Usage:
 *   npx tsx scripts/backfill-time-index.ts --offset 0 --limit 2000
 *   npx tsx scripts/backfill-time-index.ts --offset 2000 --limit 2000
 *   npx tsx scripts/backfill-time-index.ts --offset 4000 --limit 2000
 *   npx tsx scripts/backfill-time-index.ts --offset 6000 --limit 2000
 */
import { createClient } from '@libsql/client';
import * as cheerio from 'cheerio';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const BASE_URL = 'https://db.netkeiba.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const RATE_LIMIT_MS = 1200; // 安全側に寄せる
const CONCURRENCY = 2;

function parseArgs() {
  const args = process.argv.slice(2);
  let offset = 0, limit = 2000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--offset' && args[i + 1]) offset = parseInt(args[i + 1]);
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[i + 1]);
  }
  return { offset, limit };
}

async function fetchHtml(url: string): Promise<string> {
  await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  // netkeiba uses EUC-JP
  try {
    const text = new TextDecoder('euc-jp').decode(buf);
    if (text.includes('<!DOCTYPE') || text.includes('<html')) return text;
  } catch { /* fall through */ }
  return new TextDecoder('utf-8').decode(buf);
}

interface PerfUpdate {
  horseId: string;
  date: string;
  timeIndex: number | null;
  trackIndex: number | null;
}

async function scrapeTimeIndices(horseId: string): Promise<PerfUpdate[]> {
  const url = `${BASE_URL}/horse/result/${horseId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const updates: PerfUpdate[] = [];

  $('table.db_h_race_results tr').each((_, row) => {
    const tds = $(row).find('td').toArray();
    if (tds.length < 21) return;

    const $r = (el: cheerio.Element) => $(el);
    const date = $r(tds[0]).find('a').text().trim();
    if (!date) return;

    const trackIndexRaw = parseFloat($r(tds[17]).text().trim()) || null;
    const timeIndexRaw = parseFloat($r(tds[20]).text().trim()) || null;

    updates.push({
      horseId,
      date: date.replace(/\//g, '-'),
      timeIndex: timeIndexRaw,
      trackIndex: trackIndexRaw,
    });
  });

  return updates;
}

async function main() {
  const { offset, limit } = parseArgs();
  console.log(`=== Backfill time_index/track_index ===`);
  console.log(`Offset: ${offset}, Limit: ${limit}`);

  // ALTERが未実行の場合に備えてカラム追加を試みる
  for (const col of ['time_index', 'track_index']) {
    try {
      await db.execute(`ALTER TABLE past_performances ADD COLUMN ${col} REAL`);
      console.log(`Added column: ${col}`);
    } catch {
      // already exists
    }
  }

  // 全馬IDをソート順で取得
  const result = await db.execute(
    `SELECT DISTINCT horse_id FROM past_performances ORDER BY horse_id LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  const horseIds = result.rows.map(r => r.horse_id as string);
  console.log(`Horses in this chunk: ${horseIds.length}`);

  if (horseIds.length === 0) {
    console.log('No horses to process. Done.');
    return;
  }

  let completed = 0;
  let updatedRows = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < horseIds.length; i += CONCURRENCY) {
    const batch = horseIds.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (horseId) => {
        const updates = await scrapeTimeIndices(horseId);
        let updated = 0;
        for (const u of updates) {
          if (u.timeIndex !== null || u.trackIndex !== null) {
            await db.execute(
              `UPDATE past_performances SET time_index = ?, track_index = ? WHERE horse_id = ? AND date = ?`,
              [u.timeIndex, u.trackIndex, u.horseId, u.date]
            );
            updated++;
          }
        }
        return { horseId, total: updates.length, updated };
      })
    );

    for (const r of results) {
      completed++;
      if (r.status === 'fulfilled') {
        updatedRows += r.value.updated;
      } else {
        errors++;
        if (errors <= 5) console.error(`  Error: ${r.reason?.message || r.reason}`);
      }
    }

    if (completed % 50 === 0 || completed === horseIds.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = completed / elapsed * 60;
      const eta = (horseIds.length - completed) / (completed / elapsed);
      console.log(
        `  [${completed}/${horseIds.length}] updated=${updatedRows} errors=${errors} ` +
        `rate=${rate.toFixed(0)}/min ETA=${(eta / 60).toFixed(1)}min`
      );
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n=== Done ===`);
  console.log(`Processed: ${completed} horses in ${(elapsed / 60).toFixed(1)}min`);
  console.log(`Updated rows: ${updatedRows}, Errors: ${errors}`);
  console.log(`\nNext chunk: --offset ${offset + limit} --limit ${limit}`);
}

main().catch(console.error);
