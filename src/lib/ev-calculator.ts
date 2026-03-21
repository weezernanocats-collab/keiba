/**
 * EV (期待値) 再計算モジュール
 *
 * オッズ取得後に、予想の推奨馬券の expectedValue を実オッズベースで更新する。
 * EV = 推定的中率 × オッズ
 *   推定的中率 = confidence / 100 × (1 / rank) の簡易近似
 */

import { dbAll, dbRun } from './database';

interface PredictionRow {
  race_id: string;
  confidence: number;
  picks_json: string;
  bets_json: string;
  analysis_json: string | null;
}

interface OddsRow {
  horse_number: number;
  odds: number;
}

interface RecommendedBet {
  type: string;
  selections: number[];
  reasoning: string;
  expectedValue: number;
  odds?: number;
}

interface PredictionPick {
  rank: number;
  horseNumber: number;
  score: number;
}

/**
 * 単一レースの予想 EV を実オッズで再計算
 */
export async function recalculateExpectedValues(raceId: string): Promise<boolean> {
  const prediction = await dbAll<PredictionRow>(
    'SELECT race_id, confidence, picks_json, bets_json, analysis_json FROM predictions WHERE race_id = ?',
    [raceId],
  );
  if (prediction.length === 0) return false;

  const pred = prediction[0];
  const bets: RecommendedBet[] = JSON.parse(pred.bets_json || '[]');
  if (bets.length === 0) return false;

  // 実オッズを取得（単勝）
  const oddsRows = await dbAll<OddsRow>(
    "SELECT CAST(json_extract(horse_numbers, '$[0]') AS INTEGER) as horse_number, odds FROM odds WHERE race_id = ? AND bet_type = '単勝'",
    [raceId],
  );

  // race_entries テーブルのオッズも確認（結果ページから取得したオッズ）
  const entryOddsRows = await dbAll<OddsRow>(
    'SELECT horse_number, odds FROM race_entries WHERE race_id = ? AND odds IS NOT NULL AND odds > 0',
    [raceId],
  );

  const oddsMap = new Map<number, number>();
  for (const row of oddsRows) {
    if (row.odds > 0) oddsMap.set(row.horse_number, row.odds);
  }
  // entry oddsで上書き（より新しい可能性）
  for (const row of entryOddsRows) {
    if (row.odds > 0) oddsMap.set(row.horse_number, row.odds);
  }

  if (oddsMap.size === 0) return false;

  const picks: PredictionPick[] = JSON.parse(pred.picks_json || '[]');

  // ML較正済み確率をanalysis_jsonから取得（v10: score share推定を廃止）
  let winProbabilities: Record<string, number> = {};
  try {
    const analysis = JSON.parse(pred.analysis_json || '{}');
    winProbabilities = analysis.winProbabilities || {};
  } catch { /* analysis_jsonがない場合は空dictでフォールバック */ }

  let updated = false;
  const newBets = bets.map(bet => {
    const primaryHorse = bet.selections[0];
    const odds = oddsMap.get(primaryHorse);
    if (!odds) return bet;

    // ML較正済みの勝率を使用（旧: score share × confidence の粗雑な推定）
    const mlWinProb = winProbabilities[String(primaryHorse)] ?? 0;

    let estimatedHitRate: number;
    if (mlWinProb > 0) {
      // ML確率ベース: 券種に応じて調整
      if (bet.type === '単勝') {
        estimatedHitRate = mlWinProb;
      } else if (bet.type === '複勝') {
        // 複勝 ≈ 3着以内確率。ML winProbから簡易推定: min(0.95, winProb * 3)
        // ただし上位馬ほど3着以内率はwinProb×3より高い傾向
        estimatedHitRate = Math.min(0.95, mlWinProb * 3.2);
      } else if (bet.type === 'ワイド' || bet.type === '馬連') {
        // 2頭組合せ: 各馬の複勝圏入り確率の積に近似
        const secondHorse = bet.selections[1];
        const secondProb = winProbabilities[String(secondHorse)] ?? 0.05;
        const p1Place = Math.min(0.95, mlWinProb * 3.2);
        const p2Place = Math.min(0.95, secondProb * 3.2);
        estimatedHitRate = bet.type === '馬連'
          ? mlWinProb * secondProb * 2  // 順不同の2頭1着-2着
          : p1Place * p2Place * 0.8;    // ワイド: 3着以内に両方
      } else {
        // 三連複・三連単・馬単
        const probs = bet.selections.map(s => winProbabilities[String(s)] ?? 0.03);
        estimatedHitRate = probs.reduce((acc, p) => acc * Math.min(0.95, p * 3.2), 1) * 0.5;
      }
    } else {
      // フォールバック: ML確率がない場合はスコアベース推定
      const totalScore = picks.reduce((s, p) => s + p.score, 0);
      const pick = picks.find(p => p.horseNumber === primaryHorse);
      const scoreShare = pick && totalScore > 0 ? pick.score / totalScore : 0.1;
      const confidence = pred.confidence / 100;
      estimatedHitRate = bet.type === '単勝'
        ? confidence * scoreShare
        : Math.min(0.95, confidence * scoreShare * 3);
    }

    const ev = estimatedHitRate * odds;
    updated = true;
    return { ...bet, expectedValue: Math.round(ev * 100) / 100, odds };
  });

  if (!updated) return false;

  await dbRun(
    'UPDATE predictions SET bets_json = ? WHERE id = (SELECT id FROM predictions WHERE race_id = ? ORDER BY generated_at DESC LIMIT 1)',
    [JSON.stringify(newBets), raceId],
  );

  return true;
}

/**
 * 指定日付の全レースの EV を再計算
 */
export async function recalculateEVForDate(date: string): Promise<number> {
  const races = await dbAll<{ id: string }>(
    'SELECT id FROM races WHERE date = ?',
    [date],
  );

  let count = 0;
  for (const race of races) {
    const updated = await recalculateExpectedValues(race.id);
    if (updated) count++;
  }

  return count;
}
