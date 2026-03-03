/**
 * 全レースのprediction_resultsを一括評価・登録
 *
 * npx tsx -r tsconfig-paths/register scripts/evaluate-all.ts
 */
import { readFileSync } from 'fs';
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import { ensureInitialized } from '../src/lib/database';
import { evaluateAllPendingRaces, getAccuracyStats, calibrateWeights } from '../src/lib/accuracy-tracker';

async function main() {
  await ensureInitialized();

  console.log('=== 全レース照合 ===');
  const results = await evaluateAllPendingRaces();
  console.log(`照合完了: ${results.length}件`);

  console.log('\n=== 的中率統計 ===');
  const stats = await getAccuracyStats();
  console.log(`照合レース数: ${stats.totalEvaluated}`);
  console.log(`単勝的中率: ${stats.winHitRate}%`);
  console.log(`複勝的中率: ${stats.placeHitRate}%`);
  console.log(`平均Top3カバー率: ${stats.avgTop3Coverage}%`);

  if (stats.confidenceCalibration.length > 0) {
    console.log('\n--- 信頼度帯別 ---');
    for (const c of stats.confidenceCalibration) {
      console.log(`  ${c.range}%: ${c.count}件, 単勝${c.winHitRate}%, 複勝${c.placeHitRate}%`);
    }
  }

  console.log('\n=== ウェイト校正（全データ） ===');
  const cal = await calibrateWeights();
  if (cal) {
    console.log(`分析レース数: ${cal.evaluatedRaces}`);
    console.log(cal.expectedImprovement);
    console.log('\n--- ファクター別識別力 (上位5) ---');
    for (const fc of cal.factorContributions.slice(0, 5)) {
      const diff = fc.suggestedWeight - fc.weight;
      console.log(`  ${fc.factor}: ${(fc.weight*100).toFixed(1)}% → ${(fc.suggestedWeight*100).toFixed(1)}% (${diff > 0 ? '+' : ''}${(diff*100).toFixed(1)}%) 識別力=${fc.discriminationPower}`);
    }
  }

  console.log('\n[完了]');
}

main().catch(e => { console.error(e); process.exit(1); });
