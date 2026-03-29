/**
 * ローカル実行スクリプト: 全予想を再生成
 *
 * 使い方: npx tsx scripts/regen-predictions.ts
 *
 * - Turso DBから既存の予想を削除
 * - 本番APIのbulk_chunkedエンドポイントを呼び出し
 * - predictions フェーズから直接開始（スクレイピングをスキップ）
 */
import { createClient } from '@libsql/client';
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
const PROD_URL = 'https://keiba.vercel.app';

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in .env.local');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function main() {
  console.log('=== Prediction Regeneration ===\n');

  // Step 1: Check current state
  const predCount = await db.execute('SELECT COUNT(*) as count FROM predictions');
  const raceCount = await db.execute(
    "SELECT COUNT(*) as count FROM races WHERE date = (SELECT MAX(date) FROM races) AND status IN ('出走確定', '結果確定')"
  );
  console.log(`Current predictions: ${predCount.rows[0].count}`);
  console.log(`Today's races: ${raceCount.rows[0].count}`);

  // Step 2: Safety check — 全件削除の確認
  const currentCount = Number(predCount.rows[0].count);
  if (currentCount > 0 && !process.argv.includes('--confirm-delete-all')) {
    console.error(`\nERROR: ${currentCount}件の予想が削除されます。`);
    console.error('全件削除を実行するには --confirm-delete-all フラグを付けてください。');
    console.error('日付指定で再生成する場合は gen-predictions-optimized.ts --date YYYY-MM-DD --regen を使用してください。');
    process.exit(1);
  }

  console.log('\nDeleting prediction results (FK child)...');
  const deleteEval = await db.execute('DELETE FROM prediction_results');
  console.log(`Deleted ${deleteEval.rowsAffected} prediction results`);

  console.log('Deleting all existing predictions...');
  const deleteResult = await db.execute('DELETE FROM predictions');
  console.log(`Deleted ${deleteResult.rowsAffected} predictions`);

  // Step 3: Call bulk_chunked API, starting directly at 'predictions' phase
  console.log('\nTriggering prediction regeneration via bulk_chunked API...');
  console.log('(Skipping scraping phases, jumping straight to predictions)\n');

  const today = new Date().toISOString().split('T')[0];

  // Pre-baked state that starts at the predictions phase
  let state: Record<string, unknown> = {
    phase: 'predictions',
    config: { startDate: today, endDate: today, clearExisting: false },
    remainingDates: [],
    totalDates: 1,
    stats: {
      datesProcessed: 1,
      racesScraped: 0,
      entriesScraped: 0,
      horsesScraped: 0,
      pastPerformancesImported: 0,
      oddsScraped: 0,
      resultsScraped: 0,
      predictionsGenerated: 0,
    },
    errors: [],
    startedAt: new Date().toISOString(),
    phaseLabel: 'AI予想生成',
    phaseRemaining: 0,
  };

  let iteration = 0;
  const startTime = Date.now();

  while (true) {
    iteration++;
    const body = { type: 'bulk_chunked', state };

    try {
      const res = await fetch(`${PROD_URL}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000), // 2 minute timeout per chunk
      });

      if (!res.ok) {
        if (res.status === 504) {
          // Vercel function timeout - prediction may have been saved
          // Reset state and retry (the LEFT JOIN check will skip already-generated predictions)
          console.log(`  Chunk ${iteration}: timeout (504) - retrying with fresh state...`);
          state = {
            phase: 'predictions',
            config: { startDate: today, endDate: today, clearExisting: false },
            remainingDates: [],
            totalDates: 1,
            stats: { ...(state.stats as Record<string, number>) },
            errors: (state.errors as string[]).slice(),
            startedAt: state.startedAt as string,
            phaseLabel: 'AI予想生成',
            phaseRemaining: 0,
          };
          await new Promise(r => setTimeout(r, 3000)); // Wait before retry
          continue;
        }
        console.error(`API error: ${res.status} ${res.statusText}`);
        const text = await res.text();
        console.error(text);
        break;
      }

      const data = await res.json();

      if (!data.state) {
        console.log('No state returned:', data);
        break;
      }

      state = data.state;
      const stats = state.stats as Record<string, number>;
      const phase = state.phase as string;
      const errors = state.errors as string[];

      console.log(
        `  Chunk ${iteration}: phase=${phase}, predictions=${stats.predictionsGenerated}, errors=${errors.length}`
      );

      if (phase === 'done') {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\nDone! ${stats.predictionsGenerated} predictions generated in ${elapsed}s`);
        if (errors.length > 0) {
          console.log('\nErrors:');
          errors.forEach(e => console.log(`  - ${e}`));
        }
        break;
      }
    } catch (error) {
      console.error(`Chunk ${iteration} failed:`, (error as Error).message);
      // Wait a bit and retry
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Step 4: Verify
  const newPredCount = await db.execute('SELECT COUNT(*) as count FROM predictions');
  console.log(`\nFinal prediction count: ${newPredCount.rows[0].count}`);

  db.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
