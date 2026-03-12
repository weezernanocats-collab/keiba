/**
 * ローカル実行スクリプト: レースのラップタイムをバックフィル
 *
 * 使い方:
 *   npx tsx scripts/fetch-lap-times.ts              # 全レース (lap_times_json IS NULL)
 *   npx tsx scripts/fetch-lap-times.ts --limit 500  # 最大500件
 *   npx tsx scripts/fetch-lap-times.ts --resume     # 前回中断地点から再開
 *
 * - Turso読み取り: 起動時1回のみ (race_id一覧取得)
 * - netkeiba rate limit: ~2,600 requests → 1.2s delay
 * - 400/429エラー検出で自動停止、進捗をprogress.jsonに保存
 */
import { createClient } from '@libsql/client';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

// Load .env.local manually
const envPath = join(dirname(import.meta.url.replace('file:///', '')), '..', '.env.local');
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
const DELAY_MS = 1200;
const PROGRESS_FILE = join(dirname(import.meta.url.replace('file:///', '')), 'lap-times-progress.json');

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in .env.local');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ==================== CLI args ====================

function parseArgs(): { limit: number; resume: boolean } {
  let limit = Infinity;
  let resume = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    }
    if (args[i] === '--resume') {
      resume = true;
    }
  }
  return { limit, resume };
}

// ==================== Progress ====================

interface Progress {
  completed: string[];  // race IDs already processed
  lastRunAt: string;
  rateLimitHit: boolean;
}

function loadProgress(): Progress {
  if (existsSync(PROGRESS_FILE)) {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { completed: [], lastRunAt: '', rateLimitHit: false };
}

function saveProgress(progress: Progress): void {
  progress.lastRunAt = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ==================== Scrape lap times ====================

interface LapResult {
  lapTimes: number[];
  error?: string;
  rateLimited?: boolean;
}

async function scrapeLapTimes(raceId: string): Promise<LapResult> {
  const url = `${RACE_BASE_URL}/race/result.html?race_id=${raceId}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        if (res.status === 429 || res.status === 400) {
          if (attempt < 2) {
            await sleep(5000 * (attempt + 1));
            continue;
          }
          return { lapTimes: [], rateLimited: true };
        }
        return { lapTimes: [], error: `HTTP ${res.status}` };
      }

      const buffer = await res.arrayBuffer();
      const preview = new TextDecoder('ascii').decode(buffer.slice(0, 1024));
      const encoding = preview.includes('charset="UTF-8"') || preview.includes('charset=utf-8') ? 'utf-8' : 'euc-jp';
      const html = new TextDecoder(encoding).decode(buffer);
      const $ = cheerio.load(html);

      const lapTimes: number[] = [];

      // セレクタ優先順
      const lapSelectors = [
        '.RapLap',
        '.Race_HaronTime',
        '.HaronTime',
        'td.Header:contains("ラップ")',
      ];

      for (const selector of lapSelectors) {
        const lapEl = $(selector);
        if (lapEl.length > 0) {
          const lapText = lapEl.text().trim();
          const matches = lapText.match(/\d{1,2}\.\d/g);
          if (matches && matches.length >= 3) {
            for (const m of matches) {
              lapTimes.push(parseFloat(m));
            }
            break;
          }
        }
      }

      // テーブルフォールバック
      if (lapTimes.length === 0) {
        $('table').each((_, table) => {
          if (lapTimes.length > 0) return;
          const headerText = $(table).find('th, td.Header').first().text().trim();
          if (headerText.includes('ラップ') || headerText.includes('Lap')) {
            $(table).find('td').each((__, td) => {
              const text = $(td).text().trim();
              const val = parseFloat(text);
              if (val >= 9.0 && val <= 15.0) {
                lapTimes.push(val);
              }
            });
          }
        });
      }

      return { lapTimes };

    } catch (e) {
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
      } else {
        return { lapTimes: [], error: String(e) };
      }
    }
  }

  return { lapTimes: [], error: 'Failed after retries' };
}

// ==================== Pace classification ====================

function classifyPaceType(lapTimes: number[]): string {
  // 最初の1ラップはスタート加速区間のため除外
  const laps = lapTimes.length > 4 ? lapTimes.slice(1) : lapTimes;
  if (laps.length < 4) return 'ミドル';
  const halfIdx = Math.floor(laps.length / 2);
  const firstHalf = laps.slice(0, halfIdx);
  const secondHalf = laps.slice(halfIdx);
  const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
  const diff = secondAvg - firstAvg;
  if (diff > 0.3) return 'ハイ';
  if (diff < -0.3) return 'スロー';
  return 'ミドル';
}

// ==================== Lap time cleaning ====================

/**
 * 生スクレイプデータから正しいハロンタイムだけを抽出
 * 累積タイム + ハロンタイムが混在 → 9.0-15.0の範囲フィルタ + 期待数で補正
 */
function extractActualLapTimes(rawLaps: number[], distance: number): number[] {
  const expectedCount = Math.round(distance / 200);
  const filtered = rawLaps.filter(v => v >= 9.0 && v <= 15.0);

  if (filtered.length === expectedCount) return filtered;
  if (filtered.length > expectedCount) return filtered.slice(-expectedCount);

  if (rawLaps.length >= expectedCount) {
    const candidate = rawLaps.slice(-expectedCount);
    if (candidate.every(v => v >= 9.0 && v <= 16.0)) return candidate;
  }

  return filtered.length >= 3 ? filtered : [];
}

// ==================== DB Write (batch) ====================

async function batchUpsertLapTimes(
  updates: { raceId: string; lapTimes: number[]; paceType: string }[]
): Promise<void> {
  if (updates.length === 0) return;
  await db.batch(
    updates.map(u => ({
      sql: 'UPDATE races SET lap_times_json = ?, pace_type = ? WHERE id = ?',
      args: [JSON.stringify(u.lapTimes), u.paceType, u.raceId],
    }))
  );
}

// ==================== Main ====================

async function main() {
  const { limit, resume } = parseArgs();
  console.log('=== Fetch Lap Times ===\n');

  const progress = resume ? loadProgress() : { completed: [], lastRunAt: '', rateLimitHit: false };
  const completedSet = new Set(progress.completed);

  if (resume && completedSet.size > 0) {
    console.log(`Resuming: ${completedSet.size} races already completed`);
  }

  // 1回だけTursoから未取得レース一覧を取得
  console.log('Fetching race IDs without lap times from Turso...');
  const result = await db.execute(
    "SELECT id, distance FROM races WHERE status = '結果確定' AND (lap_times_json IS NULL OR lap_times_json = '[]') ORDER BY date DESC"
  );
  const allRaces = result.rows.map(r => ({ id: r.id as string, distance: r.distance as number }));
  const allRaceIds = allRaces.map(r => r.id);
  const raceDistMap = new Map(allRaces.map(r => [r.id, r.distance]));
  const raceIds = allRaceIds.filter(id => !completedSet.has(id));

  const targetCount = Math.min(raceIds.length, limit);
  console.log(`Total without lap times: ${allRaceIds.length}`);
  console.log(`After resume filter: ${raceIds.length}`);
  console.log(`Target this session: ${targetCount}\n`);

  if (targetCount === 0) {
    console.log('Nothing to do!');
    db.close();
    return;
  }

  let processed = 0;
  let withLaps = 0;
  let noLaps = 0;
  let errors = 0;
  let batchBuffer: { raceId: string; lapTimes: number[]; paceType: string }[] = [];
  const BATCH_SIZE = 20;
  const startTime = Date.now();

  for (let i = 0; i < targetCount; i++) {
    const raceId = raceIds[i];

    const lapResult = await scrapeLapTimes(raceId);

    if (lapResult.rateLimited) {
      console.log(`\n\nRate limit detected at race ${i + 1}/${targetCount}. Saving progress...`);
      // flush remaining batch
      await batchUpsertLapTimes(batchBuffer);
      batchBuffer = [];
      progress.completed = [...completedSet];
      progress.rateLimitHit = true;
      saveProgress(progress);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`Saved ${completedSet.size} completed races to ${PROGRESS_FILE}`);
      console.log(`Run again with --resume to continue after rate limit resets`);
      console.log(`\n=== Stopped (rate limit) in ${elapsed}s ===`);
      console.log(`  With laps: ${withLaps}`);
      console.log(`  No laps: ${noLaps}`);
      console.log(`  Errors: ${errors}`);
      db.close();
      return;
    }

    if (lapResult.error) {
      errors++;
      process.stdout.write(`\r  [${i + 1}/${targetCount}] ${raceId}: ERROR (${lapResult.error})          `);
    } else if (lapResult.lapTimes.length >= 3) {
      const dist = raceDistMap.get(raceId) ?? 0;
      const actualLaps = dist >= 800 ? extractActualLapTimes(lapResult.lapTimes, dist) : lapResult.lapTimes;
      if (actualLaps.length >= 3) {
        const paceType = classifyPaceType(actualLaps);
        batchBuffer.push({ raceId, lapTimes: actualLaps, paceType });
        withLaps++;
        completedSet.add(raceId);
        process.stdout.write(`\r  [${i + 1}/${targetCount}] ${raceId}: ${actualLaps.length} laps (${paceType})          `);
      } else {
        noLaps++;
        completedSet.add(raceId);
        process.stdout.write(`\r  [${i + 1}/${targetCount}] ${raceId}: laps filtered out          `);
      }
    } else {
      // ラップタイムなし（古いレースなど）→ completed扱いにして再試行しない
      noLaps++;
      completedSet.add(raceId);
      process.stdout.write(`\r  [${i + 1}/${targetCount}] ${raceId}: no laps found          `);
    }

    // バッチ書き込み
    if (batchBuffer.length >= BATCH_SIZE) {
      await batchUpsertLapTimes(batchBuffer);
      batchBuffer = [];
    }

    processed++;

    // 100件ごとにプログレス保存
    if (processed % 100 === 0) {
      progress.completed = [...completedSet];
      saveProgress(progress);
    }

    // Rate limit delay
    if (i < targetCount - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Flush remaining
  await batchUpsertLapTimes(batchBuffer);

  // Final progress save
  progress.completed = [...completedSet];
  progress.rateLimitHit = false;
  saveProgress(progress);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n=== Done in ${elapsed}s ===`);
  console.log(`  Processed: ${processed}`);
  console.log(`  With laps: ${withLaps}`);
  console.log(`  No laps (old races): ${noLaps}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total completed (cumulative): ${completedSet.size}`);

  // 最終確認
  const check = await db.execute(
    "SELECT COUNT(*) as c FROM races WHERE lap_times_json IS NOT NULL AND lap_times_json != '[]'"
  );
  console.log(`  Races with lap times in DB: ${check.rows[0].c}`);

  db.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
