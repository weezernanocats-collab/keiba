/**
 * Brier Score / BSS / ECE / Log Loss の集計結果を表示する。
 * Usage: npx tsx -r tsconfig-paths/register scripts/check-scoring-rules.ts
 */
import { readFileSync } from 'fs';
const env = readFileSync('.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^(\w+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { dbAll, dbGet, closeDatabase } from '@/lib/database';

async function main() {
  // 1. 平均Brier Score / Log Loss（1クエリで済ませる）
  const agg = await dbGet<{
    cnt: number; avg_brier: number; avg_ll: number;
    win_rate: number; place_rate: number;
  }>(`
    SELECT
      COUNT(*) as cnt,
      ROUND(AVG(brier_score), 6) as avg_brier,
      ROUND(AVG(log_loss), 6) as avg_ll,
      ROUND(AVG(win_hit) * 100, 1) as win_rate,
      ROUND(AVG(place_hit) * 100, 1) as place_rate
    FROM prediction_results
    WHERE brier_score IS NOT NULL
  `);

  if (!agg || agg.cnt === 0) {
    process.stdout.write('Brier Scoreが記録されたデータがありません\n');
    process.exit(0);
  }

  process.stdout.write('=== Proper Scoring Rules ===\n');
  process.stdout.write(`評価レース数: ${agg.cnt}\n`);
  process.stdout.write(`単勝的中率: ${agg.win_rate}%\n`);
  process.stdout.write(`複勝的中率: ${agg.place_rate}%\n`);
  process.stdout.write(`\nBrier Score: ${agg.avg_brier} (低いほど良い、0=完璧)\n`);
  process.stdout.write(`Log Loss: ${agg.avg_ll} (低いほど良い)\n`);

  // 2. BSS算出: バッチで取得（Tursoメモリ制限対応）
  const raceIds = await dbAll<{ race_id: string }>(
    'SELECT DISTINCT race_id FROM prediction_results WHERE brier_score IS NOT NULL'
  );

  const raceMap = new Map<string, {
    entries: { horse_number: number; result_position: number; odds: number | null }[];
    analysisJson: string;
  }>();

  const BATCH = 100;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const batch = raceIds.slice(i, i + BATCH).map(r => r.race_id);
    const placeholders = batch.map(() => '?').join(',');

    const [preds, entries] = await Promise.all([
      dbAll<{ race_id: string; analysis_json: string }>(
        `SELECT race_id, analysis_json FROM predictions WHERE race_id IN (${placeholders}) ORDER BY generated_at DESC`,
        batch
      ),
      dbAll<{ race_id: string; horse_number: number; result_position: number; odds: number | null }>(
        `SELECT race_id, horse_number, result_position, odds FROM race_entries WHERE race_id IN (${placeholders}) AND result_position IS NOT NULL`,
        batch
      ),
    ]);

    const predMap = new Map<string, string>();
    for (const p of preds) {
      if (!predMap.has(p.race_id)) predMap.set(p.race_id, p.analysis_json);
    }

    for (const e of entries) {
      const analysisJson = predMap.get(e.race_id);
      if (!analysisJson) continue;
      if (!raceMap.has(e.race_id)) {
        raceMap.set(e.race_id, { entries: [], analysisJson });
      }
      raceMap.get(e.race_id)!.entries.push({
        horse_number: e.horse_number,
        result_position: e.result_position,
        odds: e.odds,
      });
    }
  }

  let modelBrierTotal = 0;
  let uniformBrierTotal = 0;
  let marketBrierTotal = 0;
  let totalHorses = 0;
  let marketHorses = 0;

  // ECE用ビン
  const bins: { predicted: number[]; actual: number[] }[] = Array.from(
    { length: 10 },
    () => ({ predicted: [], actual: [] })
  );

  for (const [, race] of raceMap) {
    let winProbs: Record<string, number> | null = null;
    try {
      const analysis = JSON.parse(race.analysisJson);
      winProbs = analysis.winProbabilities || null;
    } catch { continue; }
    if (!winProbs) continue;

    const fieldSize = race.entries.length;
    const uniformProb = 1 / fieldSize;

    // 市場確率計算
    let totalImplied = 0;
    const impliedProbs: Record<number, number> = {};
    for (const e of race.entries) {
      if (e.odds && e.odds > 0) {
        impliedProbs[e.horse_number] = 1 / e.odds;
        totalImplied += 1 / e.odds;
      }
    }
    if (totalImplied > 0) {
      for (const num of Object.keys(impliedProbs)) {
        impliedProbs[Number(num)] /= totalImplied;
      }
    }

    for (const entry of race.entries) {
      const prob = winProbs[String(entry.horse_number)];
      if (prob === undefined) continue;
      const actual = entry.result_position === 1 ? 1 : 0;

      modelBrierTotal += (prob - actual) ** 2;
      uniformBrierTotal += (uniformProb - actual) ** 2;
      totalHorses++;

      const mProb = impliedProbs[entry.horse_number];
      if (mProb !== undefined) {
        marketBrierTotal += (mProb - actual) ** 2;
        marketHorses++;
      }

      const binIdx = Math.min(9, Math.floor(prob * 10));
      bins[binIdx].predicted.push(prob);
      bins[binIdx].actual.push(actual);
    }
  }

  const modelBS = modelBrierTotal / totalHorses;
  const uniformBS = uniformBrierTotal / totalHorses;
  const marketBS = marketHorses > 0 ? marketBrierTotal / marketHorses : 0;

  const bss = 1 - modelBS / uniformBS;
  const marketBSS = marketBS > 0 ? 1 - modelBS / marketBS : 0;

  process.stdout.write(`\n=== Brier Skill Score ===\n`);
  process.stdout.write(`モデル BS (per-horse): ${modelBS.toFixed(6)}\n`);
  process.stdout.write(`均等確率 BS:          ${uniformBS.toFixed(6)}\n`);
  process.stdout.write(`市場確率 BS:          ${marketBS.toFixed(6)}\n`);
  process.stdout.write(`BSS (対均等):         ${bss.toFixed(4)} ${bss > 0 ? '✓ モデルに価値あり' : '✗ 均等確率以下'}\n`);
  process.stdout.write(`BSS (対市場):         ${marketBSS.toFixed(4)} ${marketBSS > 0 ? '✓ 市場を上回っている！' : '✗ 市場以下'}\n`);

  // ECE算出
  process.stdout.write(`\n=== ECE (Expected Calibration Error) ===\n`);
  let eceSum = 0;
  let eceSamples = 0;
  process.stdout.write(`${'ビン'.padEnd(12)}${'件数'.padStart(8)}${'予測平均'.padStart(10)}${'実績'.padStart(10)}${'乖離'.padStart(10)}\n`);
  for (let i = 0; i < 10; i++) {
    const p = bins[i].predicted;
    const a = bins[i].actual;
    const count = p.length;
    if (count === 0) {
      process.stdout.write(`${`${i * 10}-${(i + 1) * 10}%`.padEnd(12)}${String(0).padStart(8)}\n`);
      continue;
    }
    const avgP = p.reduce((s, v) => s + v, 0) / count;
    const avgA = a.reduce((s, v) => s + v, 0) / count;
    const gap = Math.abs(avgP - avgA);
    eceSum += count * gap;
    eceSamples += count;
    process.stdout.write(
      `${`${i * 10}-${(i + 1) * 10}%`.padEnd(12)}${String(count).padStart(8)}${(avgP * 100).toFixed(1).padStart(9)}%${(avgA * 100).toFixed(1).padStart(9)}%${(gap * 100).toFixed(2).padStart(9)}%\n`
    );
  }
  const ece = eceSamples > 0 ? eceSum / eceSamples : 0;
  process.stdout.write(`\nECE: ${(ece * 100).toFixed(3)}% (低いほど良い)\n`);

  await closeDatabase();
}

main().catch(e => { process.stderr.write(String(e) + '\n'); process.exit(1); });
