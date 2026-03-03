/**
 * ROI一括修復スクリプト
 *
 * prediction_resultsを全件削除→再評価してROIを正しく計算する。
 * 本命馬に単勝100円を仮定し、race_entries.oddsから実オッズで計算。
 *
 * npx tsx -r tsconfig-paths/register scripts/repair-roi.ts
 */
import { readFileSync } from 'fs';
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import { createClient, type InValue } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const BET_AMOUNT = 100;

interface PredRow {
  id: number;
  race_id: string;
  confidence: number;
  picks_json: string;
}

interface EntryRow {
  race_id: string;
  horse_id: string;
  horse_number: number;
  result_position: number;
  odds: number | null;
}

async function main() {
  console.log('=== ROI一括修復 ===\n');

  // 1. 既存のprediction_resultsを全削除
  const existing = await db.execute('SELECT COUNT(*) as c FROM prediction_results');
  console.log(`既存prediction_results: ${existing.rows[0].c}件 → 全削除`);
  await db.execute('DELETE FROM prediction_results');

  // 2. 全予想を取得（1クエリ）
  const preds = await db.execute(`
    SELECT p.id, p.race_id, p.confidence, p.picks_json
    FROM predictions p
    JOIN races r ON r.id = p.race_id
    WHERE r.status = '結果確定'
      AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = r.id)
  `);
  console.log(`対象予想: ${preds.rows.length}件`);

  // 3. 全出走馬結果+オッズを取得（1クエリ）
  const entries = await db.execute(`
    SELECT re.race_id, re.horse_id, re.horse_number, re.result_position, re.odds
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE r.status = '結果確定'
      AND re.result_position IS NOT NULL
  `);
  console.log(`出走データ: ${entries.rows.length}件`);

  // インデックス構築
  const entriesByRace = new Map<string, EntryRow[]>();
  for (const row of entries.rows) {
    const raceId = row.race_id as string;
    const arr = entriesByRace.get(raceId) || [];
    arr.push({
      race_id: raceId,
      horse_id: row.horse_id as string,
      horse_number: row.horse_number as number,
      result_position: row.result_position as number,
      odds: row.odds as number | null,
    });
    entriesByRace.set(raceId, arr);
  }

  // 4. 一括計算 + バッチINSERT
  let evaluated = 0;
  let winHits = 0;
  let placeHits = 0;
  let totalInvestment = 0;
  let totalReturn = 0;

  const BATCH_SIZE = 50;
  let batch: { sql: string; args: InValue[] }[] = [];

  for (const row of preds.rows) {
    const pred: PredRow = {
      id: row.id as number,
      race_id: row.race_id as string,
      confidence: row.confidence as number,
      picks_json: row.picks_json as string,
    };

    const raceEntries = entriesByRace.get(pred.race_id);
    if (!raceEntries || raceEntries.length === 0) continue;

    let picks: { horseId: string; horseNumber: number; rank: number }[];
    try {
      const raw = JSON.parse(pred.picks_json || '[]');
      picks = raw.map((p: Record<string, unknown>, i: number) => ({
        horseId: (p.horseId as string) || '',
        horseNumber: (p.horseNumber as number) || 0,
        rank: (p.rank as number) || i + 1,
      }));
    } catch { continue; }

    if (picks.length === 0) continue;

    const topPick = picks[0];
    const topPickResult = raceEntries.find(
      e => e.horse_id === topPick.horseId || e.horse_number === topPick.horseNumber
    );
    const actualPos = topPickResult?.result_position ?? 99;
    const winHit = actualPos === 1;
    const placeHit = actualPos <= 3;

    // Top3
    const top3Picks = picks.slice(0, 3);
    let top3Hit = 0;
    for (const pick of top3Picks) {
      const result = raceEntries.find(
        e => e.horse_id === pick.horseId || e.horse_number === pick.horseNumber
      );
      if (result && result.result_position <= 3) top3Hit++;
    }

    // ROI: 本命に単勝100円
    const betInvestment = BET_AMOUNT;
    let betReturn = 0;
    if (winHit && topPickResult) {
      betReturn = BET_AMOUNT * (topPickResult.odds ?? 0);
    }
    const betRoi = betReturn / betInvestment;

    totalInvestment += betInvestment;
    totalReturn += betReturn;
    if (winHit) winHits++;
    if (placeHit) placeHits++;
    evaluated++;

    batch.push({
      sql: `INSERT INTO prediction_results
        (race_id, prediction_id, top_pick_horse_id, top_pick_actual_position,
         win_hit, place_hit, top3_picks_hit, predicted_confidence,
         bet_investment, bet_return, bet_roi)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        pred.race_id, pred.id, topPick.horseId, actualPos,
        winHit ? 1 : 0, placeHit ? 1 : 0, top3Hit, pred.confidence,
        betInvestment, betReturn, betRoi,
      ],
    });

    if (batch.length >= BATCH_SIZE) {
      await db.batch(batch, 'write');
      batch = [];
      if (evaluated % 500 === 0) {
        console.log(`  ${evaluated}件処理...`);
      }
    }
  }

  // 残りのバッチ
  if (batch.length > 0) {
    await db.batch(batch, 'write');
  }

  // 結果表示
  const overallRoi = totalInvestment > 0 ? (totalReturn / totalInvestment * 100) : 0;

  console.log(`\n=== 結果 ===`);
  console.log(`  評価レース数: ${evaluated}`);
  console.log(`  単勝的中率: ${(winHits / evaluated * 100).toFixed(1)}% (${winHits}/${evaluated})`);
  console.log(`  複勝的中率: ${(placeHits / evaluated * 100).toFixed(1)}% (${placeHits}/${evaluated})`);
  console.log(`  総投資額: ${totalInvestment.toLocaleString()}円 (${evaluated}R × ${BET_AMOUNT}円)`);
  console.log(`  総払戻額: ${totalReturn.toLocaleString()}円`);
  console.log(`  回収率(ROI): ${overallRoi.toFixed(1)}%`);
  console.log(`  収支: ${(totalReturn - totalInvestment).toLocaleString()}円`);

  db.close();
  console.log('\n[完了]');
}

main().catch(e => { console.error(e); process.exit(1); });
