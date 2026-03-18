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
    'SELECT race_id, confidence, picks_json, bets_json FROM predictions WHERE race_id = ?',
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
  const confidence = pred.confidence / 100;

  // スコアの合計（確率近似用）
  const totalScore = picks.reduce((s, p) => s + p.score, 0);

  let updated = false;
  const newBets = bets.map(bet => {
    const primaryHorse = bet.selections[0];
    const odds = oddsMap.get(primaryHorse);
    if (!odds) return bet;

    // 推定的中率: そのピックのスコア占有率 × confidence
    const pick = picks.find(p => p.horseNumber === primaryHorse);
    const scoreShare = pick && totalScore > 0 ? pick.score / totalScore : 0.1;

    let estimatedHitRate: number;
    if (bet.type === '単勝') {
      estimatedHitRate = confidence * scoreShare;
    } else if (bet.type === '複勝') {
      estimatedHitRate = Math.min(0.95, confidence * scoreShare * 3);
    } else if (bet.type === 'ワイド' || bet.type === '馬連') {
      estimatedHitRate = confidence * scoreShare * 0.5;
    } else {
      // 三連複・三連単・馬単
      estimatedHitRate = confidence * scoreShare * 0.2;
    }

    const ev = estimatedHitRate * odds;
    updated = true;
    return { ...bet, expectedValue: Math.round(ev * 100) / 100, odds };
  });

  if (!updated) return false;

  await dbRun(
    'UPDATE predictions SET bets_json = ? WHERE race_id = ?',
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
