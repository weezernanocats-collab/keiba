/**
 * 市場ブレンド重みのバックテスト
 *
 * 異なるMARKET_BLEND_WEIGHTで的中率・ROIを比較し、最適値を探る。
 *
 * npx tsx -r tsconfig-paths/register scripts/backtest-blend-weight.ts
 */
import { readFileSync, existsSync } from 'fs';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

import { ensureInitialized, dbAll } from '../src/lib/database';
import { oddsToImpliedProbabilities, blendProbabilities } from '../src/lib/market-blend';

interface PredRow {
  race_id: string;
  picks_json: string;
  analysis_json: string;
}

interface EntryRow {
  race_id: string;
  horse_number: number;
  result_position: number;
  odds: number | null;
}

interface OddsRow {
  race_id: string;
  horse_number1: number;
  odds: number;
}

async function main() {
  await ensureInitialized();

  // 結果確定済みレースの予想 + 出走馬 + オッズを取得
  const [predictions, allEntries, allOdds] = await Promise.all([
    dbAll<PredRow>(`
      SELECT p.race_id, p.picks_json, p.analysis_json
      FROM predictions p
      JOIN races r ON r.id = p.race_id
      WHERE r.status = '結果確定'
        AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = r.id)
    `),
    dbAll<EntryRow>(`
      SELECT re.race_id, re.horse_number, re.result_position, re.odds
      FROM race_entries re
      JOIN races r ON r.id = re.race_id
      WHERE r.status = '結果確定' AND re.result_position IS NOT NULL
    `),
    dbAll<OddsRow>(`
      SELECT race_id, horse_number1, odds
      FROM odds
      WHERE bet_type = '単勝' AND odds > 0
    `),
  ]);

  // レース別にグループ化
  const entriesByRace = new Map<string, EntryRow[]>();
  for (const e of allEntries) {
    const arr = entriesByRace.get(e.race_id) || [];
    arr.push(e);
    entriesByRace.set(e.race_id, arr);
  }

  const oddsByRace = new Map<string, Map<number, number>>();
  for (const o of allOdds) {
    if (!oddsByRace.has(o.race_id)) oddsByRace.set(o.race_id, new Map());
    oddsByRace.get(o.race_id)!.set(o.horse_number1, o.odds);
  }

  // テストする重み
  const weights = [0.0, 0.10, 0.20, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.80, 1.0];

  // 結果格納
  const results: Record<number, { win: number; place: number; roi: number; count: number }> = {};
  for (const w of weights) {
    results[w] = { win: 0, place: 0, roi: 0, count: 0 };
  }

  let skipped = 0;

  for (const pred of predictions) {
    const entries = entriesByRace.get(pred.race_id);
    if (!entries || entries.length < 3) { skipped++; continue; }

    // モデル確率を analysis_json の horseScores から構築
    let horseScores: Record<string, Record<string, number>> = {};
    try {
      const analysis = JSON.parse(pred.analysis_json || '{}');
      horseScores = analysis.horseScores || {};
    } catch { skipped++; continue; }

    if (Object.keys(horseScores).length < 3) { skipped++; continue; }

    // モデル確率: softmax(totalScore)
    const modelProbs = new Map<number, number>();
    let sumExp = 0;
    const scoreEntries: [number, number][] = [];
    for (const [numStr, scores] of Object.entries(horseScores)) {
      const num = parseInt(numStr);
      const total = Object.values(scores).reduce((s, v) => s + v, 0) / Object.keys(scores).length;
      scoreEntries.push([num, total]);
    }
    const maxScore = Math.max(...scoreEntries.map(([, s]) => s));
    for (const [num, score] of scoreEntries) {
      const exp = Math.exp((score - maxScore) / 10);
      modelProbs.set(num, exp);
      sumExp += exp;
    }
    if (sumExp <= 0) { skipped++; continue; }
    for (const [num, exp] of modelProbs) {
      modelProbs.set(num, exp / sumExp);
    }

    // 市場確率: odds table → race_entries fallback
    const raceOdds = oddsByRace.get(pred.race_id);
    const oddsMap = new Map<number, number>();
    for (const entry of entries) {
      const o = raceOdds?.get(entry.horse_number) || entry.odds;
      if (o && o > 0) oddsMap.set(entry.horse_number, o);
    }

    if (oddsMap.size < 3) { skipped++; continue; }

    const { probs: marketProbs } = oddsToImpliedProbabilities(oddsMap);

    // 着順マップ
    const posMap = new Map<number, number>();
    for (const e of entries) {
      posMap.set(e.horse_number, e.result_position);
    }

    // 各ブレンド重みでトップピックの的中率・ROIを計算
    for (const w of weights) {
      const blended = w === 0
        ? modelProbs
        : w === 1.0
          ? marketProbs
          : blendProbabilities(modelProbs, marketProbs, w);

      // トップピック = ブレンド確率最大の馬
      let topNum = 0;
      let topProb = -1;
      for (const [num, prob] of blended) {
        if (prob > topProb) {
          topProb = prob;
          topNum = num;
        }
      }

      if (topNum === 0) continue;

      const pos = posMap.get(topNum) ?? 99;
      results[w].count++;
      if (pos === 1) {
        results[w].win++;
        const odds = oddsMap.get(topNum) || 0;
        results[w].roi += odds * 100; // 100円賭けた場合の払戻
      }
      if (pos <= 3) results[w].place++;
    }
  }

  // 結果表示
  console.log(`\n=== 市場ブレンド重みバックテスト ===`);
  console.log(`対象レース: ${results[0.5]?.count || 0}件 (スキップ: ${skipped}件)\n`);

  const pct = (n: number, d: number) => d > 0 ? (n / d * 100).toFixed(1) : '0.0';

  console.log(`  市場重み | 単勝的中率    | 複勝的中率    | ROI`);
  console.log(`  ${'─'.repeat(58)}`);

  for (const w of weights) {
    const r = results[w];
    if (r.count === 0) continue;
    const totalInvest = r.count * 100;
    const roi = (r.roi / totalInvest * 100).toFixed(1);
    const label = w === 0.65 ? `  ${w.toFixed(2)}  ← 旧デフォルト` :
                  w === 0.50 ? `  ${w.toFixed(2)}  ← 新デフォルト` :
                  `  ${w.toFixed(2)}`;
    console.log(`${label.padEnd(18)}| ${pct(r.win, r.count).padStart(5)}% (${String(r.win).padStart(4)}/${r.count}) | ${pct(r.place, r.count).padStart(5)}% (${String(r.place).padStart(4)}/${r.count}) | ${roi.padStart(6)}%`);
  }

  // 最適値の推奨
  let bestWeight = 0.5;
  let bestScore = -Infinity;
  for (const w of weights) {
    const r = results[w];
    if (r.count === 0) continue;
    // 単勝的中率とROIの複合スコア
    const winRate = r.win / r.count;
    const roi = r.roi / (r.count * 100);
    const score = winRate * 0.4 + roi * 0.6; // ROI重視
    if (score > bestScore) {
      bestScore = score;
      bestWeight = w;
    }
  }

  console.log(`\n推奨: MARKET_BLEND_WEIGHT=${bestWeight.toFixed(2)} (ROI重視の複合スコアで最適)`);
  console.log(`\n環境変数で設定: MARKET_BLEND_WEIGHT=${bestWeight.toFixed(2)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
