/**
 * GitHub Actions 用 日次パイプラインスクリプト
 *
 * スケジューラーのジョブを CLI から実行する。
 * GitHub Actions の cron でトリガーし、本番 Turso DB に対して動作する。
 *
 * 使い方:
 *   npx tsx -r tsconfig-paths/register scripts/daily-pipeline.ts --job morning
 *   npx tsx -r tsconfig-paths/register scripts/daily-pipeline.ts --job odds
 *   npx tsx -r tsconfig-paths/register scripts/daily-pipeline.ts --job results
 *   npx tsx -r tsconfig-paths/register scripts/daily-pipeline.ts --job night
 *
 * ジョブ一覧:
 *   morning  - 当日レース取得 + 出馬表 + 馬詳細 + 予想生成
 *   odds     - オッズ取得
 *   results  - レース結果取得 + 予想照合 + 自動キャリブレーション
 *   night    - 翌日分レース事前取得
 */
import { readFileSync, existsSync } from 'fs';

// Load .env.local (GitHub Actions で作成される)
if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('ERROR: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
  process.exit(1);
}

import { runSchedulerJob } from '@/lib/scheduler';
import { closeDatabase } from '@/lib/database';

const VALID_JOBS = ['morning', 'odds', 'afternoon', 'results', 'night'] as const;
type JobType = typeof VALID_JOBS[number];

function parseArgs(): JobType {
  const idx = process.argv.indexOf('--job');
  if (idx < 0 || !process.argv[idx + 1]) {
    console.error(`Usage: npx tsx -r tsconfig-paths/register scripts/daily-pipeline.ts --job <${VALID_JOBS.join('|')}>`);
    process.exit(1);
  }
  const job = process.argv[idx + 1] as JobType;
  if (!VALID_JOBS.includes(job)) {
    console.error(`Invalid job: ${job}. Valid jobs: ${VALID_JOBS.join(', ')}`);
    process.exit(1);
  }
  return job;
}

async function main() {
  const job = parseArgs();

  // JST 日付を計算
  const now = new Date();
  const jstOffset = 9 * 60 * 60_000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const jstDate = jstNow.toISOString().split('T')[0];
  const jstTime = jstNow.toISOString().split('T')[1].substring(0, 5);

  console.log(`=== Daily Pipeline ===`);
  console.log(`Job: ${job}`);
  console.log(`JST: ${jstDate} ${jstTime}`);
  console.log(`DB:  ${process.env.TURSO_DATABASE_URL!.substring(0, 30)}...`);
  console.log(`======================`);

  const startTime = Date.now();

  try {
    await runSchedulerJob(job);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✓ Job "${job}" completed in ${elapsed}s`);
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n✗ Job "${job}" failed after ${elapsed}s`);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

main();
