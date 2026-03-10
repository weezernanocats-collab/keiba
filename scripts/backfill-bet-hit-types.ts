/**
 * bet_hit_types カラム追加 + バックフィルスクリプト
 *
 * prediction_results に bet_hit_types TEXT カラムを追加し、
 * 既存データの馬券的中タイプを計算して格納する。
 *
 * npx tsx -r tsconfig-paths/register scripts/backfill-bet-hit-types.ts
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

function isBetHit(betType: string, selections: number[], top3: number[]): boolean {
  if (selections.length === 0 || top3.length === 0) return false;
  const winner = top3[0];
  const top2 = top3.slice(0, 2);
  switch (betType) {
    case '単勝': return selections[0] === winner;
    case '複勝': return top3.includes(selections[0]);
    case '馬連': return selections.length >= 2 && top2.length >= 2 && selections.every(s => top2.includes(s));
    case 'ワイド': return selections.length >= 2 && selections.every(s => top3.includes(s));
    case '馬単': return selections.length >= 2 && top3.length >= 2 && selections[0] === top3[0] && selections[1] === top3[1];
    case '三連複': return selections.length >= 3 && top3.length >= 3 && selections.every(s => top3.includes(s));
    case '三連単': return selections.length >= 3 && top3.length >= 3 && selections[0] === top3[0] && selections[1] === top3[1] && selections[2] === top3[2];
    default: return false;
  }
}

async function main() {
  console.log('1. Adding bet_hit_types column...');
  try {
    await db.execute('ALTER TABLE prediction_results ADD COLUMN bet_hit_types TEXT DEFAULT NULL');
    console.log('   Column added.');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('duplicate column') || msg.includes('already exists')) {
      console.log('   Column already exists, skipping.');
    } else {
      throw e;
    }
  }

  console.log('2. Fetching predictions with bets_json...');
  const preds = await db.execute(
    `SELECT pr.race_id, p.bets_json
     FROM prediction_results pr
     JOIN predictions p ON pr.prediction_id = p.id`
  );
  console.log(`   ${preds.rows.length} predictions found.`);

  console.log('3. Fetching top3 finishers for all races...');
  const entries = await db.execute(
    `SELECT race_id, horse_number, result_position
     FROM race_entries
     WHERE result_position IS NOT NULL AND result_position <= 3
     ORDER BY result_position`
  );

  const top3Map = new Map<string, number[]>();
  for (const e of entries.rows) {
    const raceId = String(e.race_id);
    if (!top3Map.has(raceId)) top3Map.set(raceId, []);
    top3Map.get(raceId)!.push(Number(e.horse_number));
  }
  console.log(`   ${top3Map.size} races with top3 data.`);

  console.log('4. Computing bet hit types...');
  const BATCH_SIZE = 200;
  let updated = 0;

  for (let i = 0; i < preds.rows.length; i += BATCH_SIZE) {
    const batch = preds.rows.slice(i, i + BATCH_SIZE);
    const stmts = batch.map(row => {
      const raceId = String(row.race_id);
      const top3 = top3Map.get(raceId) || [];

      let bets: { type: string; selections: number[] }[] = [];
      try {
        bets = JSON.parse(String(row.bets_json || '[]'));
      } catch { /* skip */ }

      const hitTypes = bets
        .filter(bet => isBetHit(bet.type, bet.selections, top3))
        .map(bet => bet.type)
        .filter(t => !['単勝', '複勝'].includes(t));

      const hitTypesStr = hitTypes.length > 0 ? hitTypes.join(',') : '';

      return {
        sql: 'UPDATE prediction_results SET bet_hit_types = ? WHERE race_id = ?',
        args: [hitTypesStr, raceId] as InValue[],
      };
    });

    await db.batch(stmts);
    updated += batch.length;
    if (updated % 1000 === 0 || updated === preds.rows.length) {
      console.log(`   ${updated}/${preds.rows.length} done`);
    }
  }

  console.log(`Done. Updated ${updated} rows.`);
}

main().catch(console.error);
