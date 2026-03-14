/**
 * 既存predictions のanalysis_json に winProbabilities をバックフィルする。
 * horseScores の各ファクタースコアから totalScore を再計算し、
 * softmax で各馬の推定勝率を算出して保存する。
 *
 * また、prediction_results の brier_score / log_loss も再計算する。
 *
 * Usage: npx tsx -r tsconfig-paths/register scripts/backfill-win-probabilities.ts
 */
import { readFileSync } from 'fs';

const env = readFileSync('.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^(\w+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { dbAll, dbRun, closeDatabase } from '@/lib/database';

// デフォルト重み（prediction-engine.ts v7.1 と同一）
const WEIGHTS: Record<string, number> = {
  recentForm: 0.17, distanceAptitude: 0.11,
  trackConditionAptitude: 0.05, jockeyAbility: 0.08, speedRating: 0.11,
  runningStyle: 0.06, postPositionBias: 0.05,
  rotation: 0.04, lastThreeFurlongs: 0.08, consistency: 0.05,
  sireAptitude: 0.06, trainerAbility: 0.05,
  seasonalPattern: 0.02, handicapAdvantage: 0.01,
  marketOdds: 0.03, marginCompetitiveness: 0.01, weatherAptitude: 0.02,
};

function computeTotalScore(factorScores: Record<string, number>): number {
  let score = 0;
  for (const [factor, weight] of Object.entries(WEIGHTS)) {
    const val = factorScores[factor];
    if (val !== undefined) score += val * weight;
  }
  return score;
}

function softmaxProbs(horses: { num: number; score: number }[], temperature = 8): Record<number, number> {
  const maxScore = Math.max(...horses.map(h => h.score));
  const exps = horses.map(h => Math.exp((h.score - maxScore) / temperature));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const probs: Record<number, number> = {};
  for (let i = 0; i < horses.length; i++) {
    probs[horses[i].num] = Math.round((exps[i] / sumExp) * 10000) / 10000;
  }
  return probs;
}

async function main() {
  const startTime = Date.now();

  // Phase 1: predictions に winProbabilities をバックフィル
  process.stdout.write('Phase 1: winProbabilities バックフィル開始...\n');

  const predictions = await dbAll<{ id: number; analysis_json: string }>(
    "SELECT id, analysis_json FROM predictions WHERE analysis_json LIKE '%horseScores%' AND analysis_json NOT LIKE '%winProbabilities%'"
  );

  process.stdout.write(`  対象: ${predictions.length}件\n`);

  let updated = 0;
  const BATCH = 50;
  for (let i = 0; i < predictions.length; i += BATCH) {
    const batch = predictions.slice(i, i + BATCH);
    for (const pred of batch) {
      try {
        const analysis = JSON.parse(pred.analysis_json);
        const horseScores: Record<string, Record<string, number>> = analysis.horseScores;
        if (!horseScores) continue;

        // 各馬のtotalScoreを再計算
        const horses = Object.entries(horseScores).map(([numStr, scores]) => ({
          num: Number(numStr),
          score: computeTotalScore(scores),
        }));

        // MLブレンド済みスコアがある場合はそちらを使用
        const horsesWithML = horses.map(h => {
          const mlProb = horseScores[String(h.num)]?.mlWinProb;
          if (mlProb !== undefined && mlProb > 0) {
            // MLブレンド: 60% rule + 40% ML
            return { ...h, score: h.score * 0.60 + mlProb * 100 * 0.40 };
          }
          return h;
        });

        const winProbabilities = softmaxProbs(horsesWithML);
        analysis.winProbabilities = winProbabilities;

        await dbRun(
          'UPDATE predictions SET analysis_json = ? WHERE id = ?',
          [JSON.stringify(analysis), pred.id]
        );
        updated++;
      } catch {
        // skip
      }
    }
    if ((i + BATCH) % 500 === 0 || i + BATCH >= predictions.length) {
      process.stdout.write(`  進捗: ${Math.min(i + BATCH, predictions.length)}/${predictions.length}\n`);
    }
  }
  process.stdout.write(`  完了: ${updated}件更新\n`);

  // Phase 2: prediction_results の brier_score / log_loss を再計算
  process.stdout.write('\nPhase 2: Brier Score / Log Loss 再計算開始...\n');

  const results = await dbAll<{
    id: number; race_id: string;
  }>('SELECT id, race_id FROM prediction_results');

  process.stdout.write(`  対象: ${results.length}件\n`);

  let scored = 0;
  const EPS = 1e-15;

  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    const raceIds = batch.map(r => r.race_id);
    const placeholders = raceIds.map(() => '?').join(',');

    // 予想からwinProbabilitiesを取得
    const preds = await dbAll<{ race_id: string; analysis_json: string }>(
      `SELECT race_id, analysis_json FROM predictions WHERE race_id IN (${placeholders})`,
      raceIds
    );
    const predMap = new Map<string, string>();
    for (const p of preds) {
      if (!predMap.has(p.race_id)) predMap.set(p.race_id, p.analysis_json);
    }

    // レース結果を取得
    const entries = await dbAll<{ race_id: string; horse_number: number; result_position: number }>(
      `SELECT race_id, horse_number, result_position FROM race_entries WHERE race_id IN (${placeholders}) AND result_position IS NOT NULL`,
      raceIds
    );
    const entriesByRace = new Map<string, { horse_number: number; result_position: number }[]>();
    for (const e of entries) {
      const arr = entriesByRace.get(e.race_id) || [];
      arr.push(e);
      entriesByRace.set(e.race_id, arr);
    }

    for (const result of batch) {
      const analysisJson = predMap.get(result.race_id);
      if (!analysisJson) continue;

      let winProbs: Record<string, number> | null = null;
      try {
        const analysis = JSON.parse(analysisJson);
        winProbs = analysis.winProbabilities || null;
      } catch { continue; }
      if (!winProbs) continue;

      const raceEntries = entriesByRace.get(result.race_id) || [];
      if (raceEntries.length === 0) continue;

      let brierSum = 0;
      let logLossSum = 0;
      let count = 0;

      for (const entry of raceEntries) {
        const prob = winProbs[String(entry.horse_number)];
        if (prob === undefined) continue;
        const actual = entry.result_position === 1 ? 1 : 0;
        const clampedProb = Math.max(EPS, Math.min(1 - EPS, prob));
        brierSum += (clampedProb - actual) ** 2;
        logLossSum += -(actual * Math.log(clampedProb) + (1 - actual) * Math.log(1 - clampedProb));
        count++;
      }

      if (count > 0) {
        const brier = Math.round((brierSum / count) * 100000) / 100000;
        const logLoss = Math.round((logLossSum / count) * 100000) / 100000;
        await dbRun(
          'UPDATE prediction_results SET brier_score = ?, log_loss = ? WHERE id = ?',
          [brier, logLoss, result.id]
        );
        scored++;
      }
    }

    if ((i + BATCH) % 500 === 0 || i + BATCH >= results.length) {
      process.stdout.write(`  進捗: ${Math.min(i + BATCH, results.length)}/${results.length}\n`);
    }
  }

  process.stdout.write(`  完了: ${scored}件にBrier Score計算\n`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\n合計時間: ${elapsed}秒\n`);
  await closeDatabase();
}

main().catch(e => { process.stderr.write(String(e) + '\n'); process.exit(1); });
