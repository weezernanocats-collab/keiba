/**
 * 全予想再生成用: prediction_results → predictions の順で全削除
 *
 * 使い方: npx tsx scripts/regen-all-predictions.ts --delete-only
 *         (削除のみ。その後 gen-predictions-optimized.ts + evaluate-all.ts を実行)
 */
import { readFileSync } from 'fs';
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import { ensureInitialized, dbAll, dbRun } from '../src/lib/database';

async function main() {
  if (!process.argv.includes('--delete-only')) {
    console.error('安全のため --delete-only フラグが必須です');
    process.exit(1);
  }

  await ensureInitialized();

  // 件数確認
  const [predCount] = await dbAll<{cnt: number}>('SELECT COUNT(*) as cnt FROM predictions', []);
  const [resCount] = await dbAll<{cnt: number}>('SELECT COUNT(*) as cnt FROM prediction_results', []);
  console.log(`削除対象: predictions ${predCount.cnt}件, prediction_results ${resCount.cnt}件`);

  if (predCount.cnt === 0) {
    console.log('削除対象なし。終了。');
    return;
  }

  // prediction_results を先に削除（外部キー参照）
  console.log('prediction_results 削除中...');
  await dbRun('DELETE FROM prediction_results', []);
  console.log('prediction_results 削除完了');

  // predictions 削除
  console.log('predictions 削除中...');
  await dbRun('DELETE FROM predictions', []);
  console.log('predictions 削除完了');

  // 確認
  const [afterPred] = await dbAll<{cnt: number}>('SELECT COUNT(*) as cnt FROM predictions', []);
  const [afterRes] = await dbAll<{cnt: number}>('SELECT COUNT(*) as cnt FROM prediction_results', []);
  console.log(`\n削除後: predictions ${afterPred.cnt}件, prediction_results ${afterRes.cnt}件`);
  console.log('\n次のステップ:');
  console.log('1. npx tsx scripts/gen-predictions-optimized.ts');
  console.log('2. npx tsx -r tsconfig-paths/register scripts/evaluate-all.ts');
}

main().catch(e => { console.error(e); process.exit(1); });
