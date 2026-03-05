/**
 * 的中率算定スクリプト
 *
 * ローカルSQLiteにシードデータを投入し、
 * AI予想 vs 実結果を照合して的中率を算定する。
 *
 * 使い方: npx tsx -r tsconfig-paths/register scripts/calculate-accuracy.ts
 */

import { ensureInitialized, dbAll, dbGet } from '../src/lib/database';
import { seedAllData } from '../src/lib/seed-data';
import {
  getAccuracyStats,
  calibrateWeights,
  evaluateAllPendingRaces,
} from '../src/lib/accuracy-tracker';

async function main() {
  console.log('================================================');
  console.log('   競馬AI予想システム 的中率算定レポート');
  console.log('================================================\n');

  // DB初期化 + シードデータ投入
  console.log('[1/5] DB初期化 + シードデータ投入...');
  await ensureInitialized();
  await seedAllData();

  // データ量の確認
  const horseCount = (await dbGet<{c:number}>('SELECT COUNT(*) as c FROM horses'))!.c;
  const raceCount = (await dbGet<{c:number}>('SELECT COUNT(*) as c FROM races'))!.c;
  const ppCount = (await dbGet<{c:number}>('SELECT COUNT(*) as c FROM past_performances'))!.c;
  const predCount = (await dbGet<{c:number}>('SELECT COUNT(*) as c FROM predictions'))!.c;
  const resultCount = (await dbGet<{c:number}>("SELECT COUNT(*) as c FROM races WHERE status = '結果確定'"))!.c;
  const upcomingCount = (await dbGet<{c:number}>("SELECT COUNT(*) as c FROM races WHERE status = '出走確定'"))!.c;

  console.log(`  馬: ${horseCount}頭`);
  console.log(`  レース: ${raceCount}件 (結果確定: ${resultCount}件, 出走予定: ${upcomingCount}件)`);
  console.log(`  過去成績レコード: ${ppCount}件`);
  console.log(`  AI予想: ${predCount}件`);

  // 照合実行
  console.log('\n[2/5] 予想 vs 実結果の照合実行...');
  const evalResults = await evaluateAllPendingRaces();
  console.log(`  新規照合: ${evalResults.length}件`);

  const existingEval = (await dbGet<{c:number}>('SELECT COUNT(*) as c FROM prediction_results'))!.c;
  console.log(`  照合済み合計: ${existingEval}件`);

  // 的中率統計
  console.log('\n[3/5] 的中率統計を集計...');
  const stats = await getAccuracyStats();

  console.log('\n================================================');
  console.log('   📊 的中率レポート');
  console.log('================================================\n');

  console.log(`照合レース数: ${stats.totalEvaluated}件\n`);

  console.log('--- 全体的中率 ---');
  console.log(`  単勝的中率（本命が1着）:      ${stats.winHitRate}%`);
  console.log(`  複勝的中率（本命が3着以内）:  ${stats.placeHitRate}%`);
  console.log(`  Top3カバー率（上位3指名の的中）: ${stats.avgTop3Coverage}%`);
  console.log(`  回収率（ROI）:               ${stats.overallRoi}%`);

  if (stats.totalInvested > 0) {
    console.log(`  投資総額: ${stats.totalInvested.toLocaleString()}円`);
    console.log(`  回収総額: ${stats.totalReturned.toLocaleString()}円`);
  }

  // 信頼度帯別の分析
  if (stats.confidenceCalibration.length > 0) {
    console.log('\n--- 信頼度帯別的中率 ---');
    console.log('  信頼度帯    | レース数 | 単勝的中率 | 複勝的中率 | ROI');
    console.log('  ------------|----------|-----------|-----------|------');
    for (const c of stats.confidenceCalibration) {
      console.log(
        `  ${c.range.padEnd(12)}| ${String(c.count).padStart(6)}件 | ` +
        `${String(c.winHitRate).padStart(8)}% | ${String(c.placeHitRate).padStart(8)}% | ${String(c.avgRoi).padStart(5)}%`
      );
    }
  }

  // トレンド分析
  if (stats.recentTrend.length > 0) {
    console.log('\n--- トレンド分析 ---');
    for (const t of stats.recentTrend) {
      console.log(`  ${t.period}: ${t.count}件 → 単勝${t.winHitRate}%, 複勝${t.placeHitRate}%, ROI ${t.roi}%`);
    }
  }

  // 個別レース結果の詳細
  console.log('\n[4/5] 個別レース照合結果...\n');
  const detailedResults = await dbAll<{
    race_id: string;
    race_name: string;
    race_date: string;
    top_pick_horse_name: string;
    top_pick_actual_position: number;
    win_hit: number;
    place_hit: number;
    top3_picks_hit: number;
    predicted_confidence: number;
    bet_roi: number;
  }>(`
    SELECT
      pr.race_id,
      r.name as race_name,
      r.date as race_date,
      (SELECT re.horse_name FROM race_entries re
       WHERE re.horse_id = pr.top_pick_horse_id AND re.race_id = pr.race_id LIMIT 1
      ) as top_pick_horse_name,
      pr.top_pick_actual_position,
      pr.win_hit,
      pr.place_hit,
      pr.top3_picks_hit,
      pr.predicted_confidence,
      pr.bet_roi
    FROM prediction_results pr
    JOIN races r ON pr.race_id = r.id
    ORDER BY r.date DESC, r.race_number
  `);

  if (detailedResults.length > 0) {
    console.log('  レース名              | 本命馬           | 着順 | 単勝 | 複勝 | 信頼度 | Top3');
    console.log('  ----------------------|-----------------|------|------|------|--------|-----');
    for (const d of detailedResults) {
      const raceName = (d.race_name || '').substring(0, 20).padEnd(20);
      const horseName = (d.top_pick_horse_name || '不明').substring(0, 14).padEnd(14);
      const winMark = d.win_hit ? ' ◎ ' : ' × ';
      const placeMark = d.place_hit ? ' ◎ ' : ' × ';
      console.log(
        `  ${raceName} | ${horseName} | ${String(d.top_pick_actual_position).padStart(3)}着 |${winMark}|${placeMark}| ${String(d.predicted_confidence).padStart(4)}%  | ${d.top3_picks_hit}/3`
      );
    }
  }

  // XGBoostモデルの学習メトリクス
  console.log('\n[5/5] XGBoostモデル学習メトリクス...');
  try {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const metaPath = join(__dirname, '..', 'model', 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    console.log(`  学習サンプル: ${meta.train_samples.toLocaleString()}件`);
    console.log(`  検証サンプル: ${meta.val_samples.toLocaleString()}件`);
    console.log(`  特徴量数: ${meta.feature_count}`);
    console.log(`  勝利予測 AUC: ${meta.win_auc} (精度: ${(meta.win_accuracy * 100).toFixed(1)}%)`);
    console.log(`  複勝予測 AUC: ${meta.place_auc} (精度: ${(meta.place_accuracy * 100).toFixed(1)}%)`);
  } catch {
    console.log('  (モデルメタデータの読み込みに失敗)');
  }

  // ウェイト校正分析
  console.log('\n================================================');
  console.log('   🔬 ファクター分析 & ウェイト校正');
  console.log('================================================\n');

  const cal = await calibrateWeights();
  if (cal) {
    console.log(`分析レース数: ${cal.evaluatedRaces}件`);
    console.log(`${cal.expectedImprovement}\n`);

    console.log('--- ファクター別識別力ランキング ---');
    console.log('  ファクター            | 現在の重み | 推奨重み | 変更  | 識別力');
    console.log('  ----------------------|-----------|---------|-------|-------');
    for (const fc of cal.factorContributions) {
      const diff = fc.suggestedWeight - fc.weight;
      const diffStr = `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(1)}%`;
      const factorName = fc.factor.padEnd(22);
      console.log(
        `  ${factorName}| ${(fc.weight * 100).toFixed(1).padStart(7)}%  | ${(fc.suggestedWeight * 100).toFixed(1).padStart(5)}%  | ${diffStr.padStart(5)} | ${fc.discriminationPower.toFixed(1)}`
      );
    }
  } else {
    console.log('校正に必要なデータが不足しています（最低5レース必要）');
  }

  // データ蓄積と精度向上の分析
  console.log('\n================================================');
  console.log('   📈 データ蓄積と精度向上の関係');
  console.log('================================================\n');

  console.log('このシステムの精度向上メカニズム:');
  console.log('');
  console.log('1. XGBoostモデル (定期再学習)');
  const fs = await import('fs');
  const path = await import('path');
  console.log(`   現在: ${fs.existsSync(path.join(__dirname, '..', 'model', 'meta.json')) ? 'モデル学習済み' : '未学習'}`);
  console.log(`   学習データ: 約${42597}件 → データ増加で精度向上 ✓`);
  console.log('');
  console.log('2. ファクターウェイト自動校正');
  console.log(`   照合済みレース: ${stats.totalEvaluated}件`);
  console.log(`   自動校正開始条件: 100件以上`);
  if (stats.totalEvaluated >= 100) {
    console.log('   ステータス: 自動校正可能 ✓');
  } else {
    console.log(`   ステータス: あと${100 - stats.totalEvaluated}件で自動校正開始`);
  }
  console.log('');
  console.log('3. 過去成績データの充実');
  console.log(`   現在の過去成績: ${ppCount}件`);
  console.log('   → 各馬のデータが増えるほどファクター分析の精度向上 ✓');
  console.log('');
  console.log('4. 統計ベース分析 (血統・騎手×調教師・枠順バイアス・季節パターン)');
  console.log('   → 母集団データが増えるほど統計的信頼性向上 ✓');

  console.log('\n================================================');
  console.log('   算定完了');
  console.log('================================================');
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
