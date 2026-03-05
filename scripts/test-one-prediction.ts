/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 1レース分の予想をテスト生成（DBリード数をカウント）
 *
 * npx tsx -r tsconfig-paths/register scripts/test-one-prediction.ts
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

let queryCount = 0;
let totalRowsRead = 0;

import { ensureInitialized, dbAll } from '../src/lib/database';
import { getRaceById, getHorsePastPerformances, getHorseById, getJockeyStats } from '../src/lib/queries';
import { generatePrediction } from '../src/lib/prediction-engine';
import type { TrackType, TrackCondition } from '../src/types';

async function patchClient() {
  const client = await ensureInitialized();
  const origExec = client.execute.bind(client);
  (client as any).execute = async function (stmt: any) {
    queryCount++;
    const result = await origExec(stmt);
    totalRowsRead += result.rows.length;
    return result;
  };
  const origBatch = client.batch.bind(client);
  (client as any).batch = async function (stmts: any, mode?: any) {
    queryCount += Array.isArray(stmts) ? stmts.length : 1;
    const results = await origBatch(stmts, mode);
    for (const r of results) {
      totalRowsRead += r.rows.length;
    }
    return results;
  };
}

async function main() {
  await patchClient();

  // カウンターリセット（schema初期化分を除外）
  queryCount = 0;
  totalRowsRead = 0;

  // 予想未生成の過去レースを1件取得
  const races = await dbAll<any>(
    `SELECT r.id, r.name, r.date, r.track_type, r.distance, r.track_condition, r.racecourse_name, r.grade
     FROM races r
     WHERE r.status = '結果確定'
       AND r.id NOT IN (SELECT race_id FROM predictions)
     ORDER BY r.date DESC
     LIMIT 1`
  );

  if (races.length === 0) {
    console.log('予想未生成の過去レースがありません');
    return;
  }

  const race = races[0];
  console.log(`テスト対象: ${race.name} (${race.id}) ${race.date}`);
  console.log(`  コース: ${race.racecourse_name} ${race.track_type}${race.distance}m ${race.track_condition || '不明'}`);

  // カウンターリセット
  queryCount = 0;
  totalRowsRead = 0;
  const startTime = Date.now();

  // Step 1: getRaceById
  const raceData = await getRaceById(race.id);
  if (!raceData || !raceData.entries || raceData.entries.length === 0) {
    console.log('出走馬データなし');
    return;
  }

  console.log(`  出走頭数: ${raceData.entries.length}`);
  console.log(`\n--- Step 1: getRaceById ---`);
  console.log(`  クエリ: ${queryCount}, 行: ${totalRowsRead}`);

  const q1 = queryCount, r1 = totalRowsRead;

  // Step 2: 各馬データ取得
  const horseInputs = [];
  for (const re of raceData.entries) {
    const pastPerfs = await getHorsePastPerformances(re.horseId, 100);
    const horseData = await getHorseById(re.horseId) as { father_name?: string } | null;
    const jockeyStats = await getJockeyStats(re.jockeyId);
    horseInputs.push({
      entry: re,
      pastPerformances: pastPerfs,
      jockeyWinRate: jockeyStats.winRate,
      jockeyPlaceRate: jockeyStats.placeRate,
      fatherName: horseData?.father_name || '',
    });
  }

  console.log(`\n--- Step 2: 馬データ（${raceData.entries.length}頭） ---`);
  console.log(`  クエリ: ${queryCount - q1}, 行: ${totalRowsRead - r1}`);

  const q2 = queryCount, r2 = totalRowsRead;

  // Step 3: generatePrediction（内部でDB追加アクセス）
  const prediction = await generatePrediction(
    race.id, race.name, race.date,
    race.track_type as TrackType,
    race.distance,
    race.track_condition as TrackCondition | undefined,
    race.racecourse_name, race.grade,
    horseInputs,
  );

  console.log(`\n--- Step 3: generatePrediction ---`);
  console.log(`  クエリ: ${queryCount - q2}, 行: ${totalRowsRead - r2}`);

  const elapsed = Date.now() - startTime;
  console.log(`\n=== 合計 ===`);
  console.log(`  クエリ: ${queryCount}, 行: ${totalRowsRead}`);
  console.log(`  時間: ${elapsed}ms`);
  console.log(`\n=== 822レース推定 ===`);
  console.log(`  推定クエリ: ${queryCount * 822}`);
  console.log(`  推定行: ${totalRowsRead * 822}`);

  // 予想プレビュー
  console.log(`\n--- 予想結果 ---`);
  console.log(`  信頼度: ${prediction.confidence}%`);
  if (prediction.topPicks) {
    for (const pick of prediction.topPicks.slice(0, 3)) {
      console.log(`  ${pick.rank}位: ${pick.horseName} (${pick.score})`);
    }
  }

  console.log(`\n[テスト完了 - 保存なし]`);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
