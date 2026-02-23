/**
 * シードデータ投入 + 的中率検証 + ウェイト校正を実行するスクリプト
 */
import { ensureInitialized, dbGet } from '../src/lib/database';
import { seedAllData } from '../src/lib/seed-data';
import { getAccuracyStats, calibrateWeights, evaluateAllPendingRaces } from '../src/lib/accuracy-tracker';

async function main() {
  // DB初期化 + シード
  console.log('=== DB初期化 + シードデータ投入 ===');
  await ensureInitialized();
  await seedAllData();

  // 照合結果を確認
  console.log('\n=== 照合実行 ===');
  const evalResults = await evaluateAllPendingRaces();
  console.log(`追加照合: ${evalResults.length}件`);

  // 的中率統計
  console.log('\n=== 的中率統計 ===');
  const stats = await getAccuracyStats();
  console.log(`照合レース数: ${stats.totalEvaluated}`);
  console.log(`単勝的中率: ${stats.winHitRate}%`);
  console.log(`複勝的中率: ${stats.placeHitRate}%`);
  console.log(`平均Top3カバー率: ${stats.avgTop3Coverage}%`);
  console.log(`回収率(ROI): ${stats.overallRoi}%`);

  if (stats.confidenceCalibration.length > 0) {
    console.log('\n--- 信頼度帯別 ---');
    for (const c of stats.confidenceCalibration) {
      console.log(`  ${c.range}%: ${c.count}件, 単勝${c.winHitRate}%, 複勝${c.placeHitRate}%, ROI ${c.avgRoi}%`);
    }
  }

  if (stats.recentTrend.length > 0) {
    console.log('\n--- トレンド ---');
    for (const t of stats.recentTrend) {
      console.log(`  ${t.period}: ${t.count}件, 単勝${t.winHitRate}%, 複勝${t.placeHitRate}%, ROI ${t.roi}%`);
    }
  }

  // ウェイト校正
  console.log('\n=== ウェイト自動校正 ===');
  const cal = await calibrateWeights();
  if (cal) {
    console.log(`分析レース数: ${cal.evaluatedRaces}`);
    console.log(cal.expectedImprovement);
    console.log('\n--- ファクター別識別力 (上位5) ---');
    for (const fc of cal.factorContributions.slice(0, 5)) {
      const diff = fc.suggestedWeight - fc.weight;
      console.log(`  ${fc.factor}: 現在${(fc.weight*100).toFixed(1)}% → 推奨${(fc.suggestedWeight*100).toFixed(1)}% (${diff > 0 ? '+' : ''}${(diff*100).toFixed(1)}%) 識別力=${fc.discriminationPower}`);
    }
  } else {
    console.log('校正に必要なデータが不足しています');
  }

  // DB情報
  const horseCount = ((await dbGet<{c:number}>('SELECT COUNT(*) as c FROM horses'))!).c;
  const raceCount = ((await dbGet<{c:number}>('SELECT COUNT(*) as c FROM races'))!).c;
  const ppCount = ((await dbGet<{c:number}>('SELECT COUNT(*) as c FROM past_performances'))!).c;
  const predCount = ((await dbGet<{c:number}>('SELECT COUNT(*) as c FROM predictions'))!).c;
  const resultCount = ((await dbGet<{c:number}>("SELECT COUNT(*) as c FROM races WHERE status = '結果確定'"))!).c;

  console.log('\n=== データ量 ===');
  console.log(`馬: ${horseCount}頭`);
  console.log(`レース: ${raceCount}件 (うち結果確定: ${resultCount}件)`);
  console.log(`過去成績: ${ppCount}件`);
  console.log(`AI予想: ${predCount}件`);
  console.log(`照合済み: ${stats.totalEvaluated}件`);
}

main().catch(console.error);
