/**
 * 16ファクター vs XGBoost 的中率比較
 *
 * npx tsx -r tsconfig-paths/register scripts/compare-accuracy.ts
 */
import { readFileSync } from 'fs';

// Load .env.local
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

import { ensureInitialized, dbAll } from '../src/lib/database';
import { callMLPredict, buildMLFeatures } from '../src/lib/ml-client';
import type { MLHorseInput } from '../src/lib/ml-client';

interface PredRow {
  race_id: string;
  race_name: string;
  race_date: string;
  grade: string | null;
  track_type: string;
  distance: number;
  track_condition: string | null;
  picks_json: string;
  analysis_json: string;
  confidence: number;
}

interface EntryRow {
  race_id: string;
  horse_id: string;
  horse_number: number;
  horse_name: string;
  age: number;
  sex: string;
  handicap_weight: number;
  post_position: number;
  odds: number | null;
  popularity: number | null;
  result_position: number;
}

async function main() {
  await ensureInitialized();

  // 全予想+レース情報+出走馬を取得
  const [predictions, allEntries] = await Promise.all([
    dbAll<PredRow>(`
      SELECT p.race_id, r.name as race_name, r.date as race_date, r.grade,
             r.track_type, r.distance, r.track_condition,
             p.picks_json, p.analysis_json, p.confidence
      FROM predictions p
      JOIN races r ON r.id = p.race_id
      WHERE r.status = '結果確定'
        AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = r.id)
      ORDER BY r.date DESC
    `),
    dbAll<EntryRow>(`
      SELECT re.race_id, re.horse_id, re.horse_number, re.horse_name,
             re.age, re.sex, re.handicap_weight, re.post_position,
             re.odds, re.popularity, re.result_position
      FROM race_entries re
      JOIN races r ON r.id = re.race_id
      WHERE r.status = '結果確定'
        AND re.result_position IS NOT NULL
      ORDER BY re.race_id, re.result_position
    `),
  ]);

  const entriesByRace = new Map<string, EntryRow[]>();
  for (const e of allEntries) {
    const arr = entriesByRace.get(e.race_id) || [];
    arr.push(e);
    entriesByRace.set(e.race_id, arr);
  }

  console.log(`\n=== 16ファクター vs XGBoost 的中率比較 ===`);
  console.log(`対象レース数: ${predictions.length}`);

  // XGBoostモデルの存在確認
  const testML = await callMLPredict([{ horseNumber: 1, features: {} }]);
  const mlAvailable = testML !== null;
  console.log(`XGBoostモデル: ${mlAvailable ? '利用可能' : '未配置'}`);

  // 集計変数
  let totalRaces = 0;

  // 16ファクター（picks_json ベース）
  let factor16Win = 0;
  let factor16Place = 0;

  // XGBoost Win確率トップ選択
  let xgbWinPick_Win = 0;
  let xgbWinPick_Place = 0;

  // XGBoost Place確率トップ選択
  let xgbPlacePick_Win = 0;
  let xgbPlacePick_Place = 0;

  // XGBoostブレンド（16ファクタースコア × 0.6 + XGBoost winProb × 0.4）
  let blendWin = 0;
  let blendPlace = 0;

  let mlProcessed = 0;

  for (const pred of predictions) {
    const entries = entriesByRace.get(pred.race_id);
    if (!entries || entries.length === 0) continue;

    // 16ファクターの本命
    let topPickNumber = 0;
    try {
      const raw = JSON.parse(pred.picks_json || '[]');
      if (raw.length > 0) {
        topPickNumber = raw[0].horseNumber || 0;
      }
    } catch { continue; }

    if (topPickNumber === 0) continue;

    // horseScores（16ファクターの個別スコア）
    let horseScores: Record<string, Record<string, number>> = {};
    try {
      const analysis = JSON.parse(pred.analysis_json || '{}');
      horseScores = analysis.horseScores || {};
    } catch { continue; }

    totalRaces++;

    // 16ファクター的中判定
    const topPickResult = entries.find(e => e.horse_number === topPickNumber);
    const topPickPos = topPickResult?.result_position ?? 99;
    if (topPickPos === 1) factor16Win++;
    if (topPickPos <= 3) factor16Place++;

    // XGBoost推論
    if (mlAvailable && Object.keys(horseScores).length > 0) {
      const fieldSize = entries.length;
      const mlInputs: MLHorseInput[] = [];

      for (const entry of entries) {
        const scores = horseScores[String(entry.horse_number)];
        if (!scores) continue;

        const features = buildMLFeatures(scores, {
          fieldSize,
          odds: entry.odds ?? undefined,
          popularity: entry.popularity ?? undefined,
          age: entry.age,
          sex: entry.sex,
          handicapWeight: entry.handicap_weight,
          postPosition: entry.post_position,
          grade: pred.grade ?? undefined,
          trackType: pred.track_type,
          distance: pred.distance,
          trackCondition: pred.track_condition || '良',
        });

        mlInputs.push({ horseNumber: entry.horse_number, features });
      }

      const mlResult = await callMLPredict(mlInputs, { trackType: pred.track_type, distance: pred.distance });
      if (mlResult) {
        mlProcessed++;

        // XGBoost winProbトップ
        let bestWinNum = 0;
        let bestWinProb = -1;
        let bestPlaceNum = 0;
        let bestPlaceProb = -1;
        let bestBlendNum = 0;
        let bestBlendScore = -1;

        for (const entry of entries) {
          const ml = mlResult[entry.horse_number];
          if (!ml) continue;

          // winProbトップ
          if (ml.winProb > bestWinProb) {
            bestWinProb = ml.winProb;
            bestWinNum = entry.horse_number;
          }

          // placeProbトップ
          if (ml.placeProb > bestPlaceProb) {
            bestPlaceProb = ml.placeProb;
            bestPlaceNum = entry.horse_number;
          }

          // ブレンドスコア（16ファクター正規化 + XGBoost winProb）
          const scores = horseScores[String(entry.horse_number)];
          if (scores) {
            const factorAvg = Object.values(scores).reduce((s, v) => s + v, 0) / Object.keys(scores).length;
            const normalized = factorAvg / 100; // 0-1に正規化
            const blendScore = normalized * 0.6 + ml.winProb * 0.4;
            if (blendScore > bestBlendScore) {
              bestBlendScore = blendScore;
              bestBlendNum = entry.horse_number;
            }
          }
        }

        // XGBoost winPickの的中判定
        const xgbWinResult = entries.find(e => e.horse_number === bestWinNum);
        const xgbWinPos = xgbWinResult?.result_position ?? 99;
        if (xgbWinPos === 1) xgbWinPick_Win++;
        if (xgbWinPos <= 3) xgbWinPick_Place++;

        // XGBoost placePickの的中判定
        const xgbPlaceResult = entries.find(e => e.horse_number === bestPlaceNum);
        const xgbPlacePos = xgbPlaceResult?.result_position ?? 99;
        if (xgbPlacePos === 1) xgbPlacePick_Win++;
        if (xgbPlacePos <= 3) xgbPlacePick_Place++;

        // ブレンドの的中判定
        const blendResult = entries.find(e => e.horse_number === bestBlendNum);
        const blendPos = blendResult?.result_position ?? 99;
        if (blendPos === 1) blendWin++;
        if (blendPos <= 3) blendPlace++;
      }
    }
  }

  // ランダム基準
  let totalField = 0;
  let fieldCount = 0;
  for (const [, entries] of entriesByRace) {
    totalField += entries.length;
    fieldCount++;
  }
  const avgField = fieldCount > 0 ? totalField / fieldCount : 14;
  const randomWin = 1 / avgField * 100;
  const randomPlace = 3 / avgField * 100;

  // 結果表示
  const pct = (n: number, d: number) => d > 0 ? (n / d * 100).toFixed(1) : '0.0';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  手法              | 単勝的中率      | 複勝的中率`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  ランダム基準       | ${randomWin.toFixed(1).padStart(5)}%           | ${randomPlace.toFixed(1).padStart(5)}%`);
  console.log(`  16ファクター       | ${pct(factor16Win, totalRaces).padStart(5)}% (${factor16Win}/${totalRaces}) | ${pct(factor16Place, totalRaces).padStart(5)}% (${factor16Place}/${totalRaces})`);

  if (mlProcessed > 0) {
    console.log(`  XGB(Win確率)      | ${pct(xgbWinPick_Win, mlProcessed).padStart(5)}% (${xgbWinPick_Win}/${mlProcessed}) | ${pct(xgbWinPick_Place, mlProcessed).padStart(5)}% (${xgbWinPick_Place}/${mlProcessed})`);
    console.log(`  XGB(Place確率)    | ${pct(xgbPlacePick_Win, mlProcessed).padStart(5)}% (${xgbPlacePick_Win}/${mlProcessed}) | ${pct(xgbPlacePick_Place, mlProcessed).padStart(5)}% (${xgbPlacePick_Place}/${mlProcessed})`);
    console.log(`  ブレンド(60/40)   | ${pct(blendWin, mlProcessed).padStart(5)}% (${blendWin}/${mlProcessed}) | ${pct(blendPlace, mlProcessed).padStart(5)}% (${blendPlace}/${mlProcessed})`);
  }
  console.log(`${'='.repeat(60)}`);

  // リフト倍率
  console.log(`\n--- リフト倍率 (vs ランダム) ---`);
  console.log(`  16ファクター:  単勝 ${(parseFloat(pct(factor16Win, totalRaces)) / randomWin).toFixed(2)}x  複勝 ${(parseFloat(pct(factor16Place, totalRaces)) / randomPlace).toFixed(2)}x`);
  if (mlProcessed > 0) {
    console.log(`  XGB(Win):     単勝 ${(parseFloat(pct(xgbWinPick_Win, mlProcessed)) / randomWin).toFixed(2)}x  複勝 ${(parseFloat(pct(xgbWinPick_Place, mlProcessed)) / randomPlace).toFixed(2)}x`);
    console.log(`  ブレンド:     単勝 ${(parseFloat(pct(blendWin, mlProcessed)) / randomWin).toFixed(2)}x  複勝 ${(parseFloat(pct(blendPlace, mlProcessed)) / randomPlace).toFixed(2)}x`);
  }

  // モデルメタ情報
  try {
    const meta = JSON.parse(readFileSync('model/meta.json', 'utf-8'));
    console.log(`\n--- XGBoostモデル情報 ---`);
    console.log(`  学習サンプル: ${meta.train_samples}, 検証: ${meta.val_samples}`);
    console.log(`  Win AUC: ${meta.win_auc}, Place AUC: ${meta.place_auc}`);
    console.log(`  Win Accuracy: ${meta.win_accuracy}, Place Accuracy: ${meta.place_accuracy}`);
  } catch { /* no meta */ }

  console.log(`\n[完了]`);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
