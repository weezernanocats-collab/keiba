/**
 * 収益性分析スクリプト
 *
 * 「どうすれば利益が出るか」を多角的に分析する:
 *   1. 信頼度別ROI — 高信頼度レースに絞ると?
 *   2. EV+フィルタ — モデル確率×オッズ > 1 の馬だけに賭けると?
 *   3. 人気薄狙い — 市場が過小評価している馬だけ賭けると?
 *   4. 複勝ROI — 単勝ではなく複勝なら?
 *   5. 組合せ戦略 — 上記フィルタの複合
 *
 * Usage: npx tsx -r tsconfig-paths/register scripts/profitability-analysis.ts
 */
import { readFileSync } from 'fs';

const env = readFileSync('.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

import { dbAll, closeDatabase } from '@/lib/database';

interface RaceResult {
  raceId: string;
  confidence: number;
  horses: {
    horseNumber: number;
    rank: number;         // 予想順位
    totalScore: number;
    modelProb: number;    // モデル推定勝率
    odds: number;         // 単勝オッズ
    actualPosition: number;
    placeOdds: number;    // 複勝オッズ (概算)
  }[];
}

async function loadData(): Promise<RaceResult[]> {
  console.log('データ読み込み中...');

  const predictions = await dbAll<{
    race_id: string;
    picks_json: string;
    analysis_json: string;
    confidence: number;
  }>(`
    SELECT p.race_id, p.picks_json, p.analysis_json, p.confidence
    FROM predictions p
    JOIN prediction_results pr ON pr.prediction_id = p.id
    WHERE p.analysis_json IS NOT NULL AND p.confidence IS NOT NULL
  `);

  const entries = await dbAll<{
    race_id: string;
    horse_number: number;
    result_position: number;
    odds: number | null;
  }>(`
    SELECT race_id, horse_number, result_position, odds
    FROM race_entries
    WHERE result_position IS NOT NULL AND result_position > 0
  `);

  const entryMap = new Map<string, Map<number, { pos: number; odds: number }>>();
  for (const e of entries) {
    if (!entryMap.has(e.race_id)) entryMap.set(e.race_id, new Map());
    entryMap.get(e.race_id)!.set(e.horse_number, {
      pos: e.result_position,
      odds: e.odds ?? 0,
    });
  }

  const results: RaceResult[] = [];

  for (const pred of predictions) {
    try {
      const analysis = JSON.parse(pred.analysis_json);
      const picks = JSON.parse(pred.picks_json || '[]');
      const horseScores = analysis.horseScores as Record<string, Record<string, number>> | undefined;
      const winProbs = analysis.winProbabilities as Record<string, number> | undefined;
      const raceEntries = entryMap.get(pred.race_id);

      if (!horseScores || !raceEntries || !winProbs) continue;

      const horses: RaceResult['horses'] = [];

      // picks から予想順位を取得
      const rankMap = new Map<number, number>();
      for (const pick of picks) {
        rankMap.set(pick.horseNumber, pick.rank);
      }

      for (const [numStr, prob] of Object.entries(winProbs)) {
        const horseNumber = parseInt(numStr);
        const entry = raceEntries.get(horseNumber);
        if (!entry || entry.pos <= 0) continue;

        const scores = horseScores[numStr];
        const totalScore = scores
          ? Object.entries(scores)
              .filter(([k]) => !k.startsWith('_') && k !== 'paceBonus' && k !== 'mlWinProb' && k !== 'mlPlaceProb')
              .reduce((s, [, v]) => s + v, 0) / 17 // rough average
          : 50;

        horses.push({
          horseNumber,
          rank: rankMap.get(horseNumber) ?? 99,
          totalScore,
          modelProb: prob,
          odds: entry.odds,
          actualPosition: entry.pos,
          // 複勝概算: 単勝オッズの1/3〜1/4 (3着まで)
          placeOdds: entry.odds > 0 ? Math.max(1.1, entry.odds * 0.28) : 0,
        });
      }

      if (horses.length < 3) continue;
      horses.sort((a, b) => a.rank - b.rank);

      results.push({
        raceId: pred.race_id,
        confidence: pred.confidence,
        horses,
      });
    } catch {
      continue;
    }
  }

  console.log(`  対象レース: ${results.length}\n`);
  return results;
}

interface Strategy {
  name: string;
  bets: number;
  wins: number;
  places: number;
  invest: number;
  returnWin: number;
  returnPlace: number;
  evPlusBets: number;
}

function newStrategy(name: string): Strategy {
  return { name, bets: 0, wins: 0, places: 0, invest: 0, returnWin: 0, returnPlace: 0, evPlusBets: 0 };
}

function printStrategy(s: Strategy) {
  const winRate = s.bets > 0 ? (s.wins / s.bets * 100).toFixed(1) : '0.0';
  const placeRate = s.bets > 0 ? (s.places / s.bets * 100).toFixed(1) : '0.0';
  const roiWin = s.invest > 0 ? (s.returnWin / s.invest * 100).toFixed(1) : '0.0';
  const roiPlace = s.invest > 0 ? (s.returnPlace / s.invest * 100).toFixed(1) : '0.0';
  const profitWin = s.returnWin - s.invest;
  const profitPlace = s.returnPlace - s.invest;
  console.log(`  ${s.name}`);
  console.log(`    賭け数: ${s.bets}  (EV+: ${s.evPlusBets})`);
  console.log(`    単勝: 的中${winRate}% | ROI ${roiWin}% | 収支 ${profitWin >= 0 ? '+' : ''}${Math.round(profitWin)}円`);
  console.log(`    複勝: 的中${placeRate}% | ROI ${roiPlace}% | 収支 ${profitPlace >= 0 ? '+' : ''}${Math.round(profitPlace)}円`);
  console.log();
}

function addBet(s: Strategy, horse: RaceResult['horses'][0], stake: number = 100) {
  s.bets++;
  s.invest += stake;
  const ev = horse.modelProb * horse.odds;
  if (ev > 1) s.evPlusBets++;
  if (horse.actualPosition === 1) {
    s.wins++;
    s.returnWin += stake * horse.odds;
  }
  if (horse.actualPosition <= 3) {
    s.places++;
    s.returnPlace += stake * horse.placeOdds;
  }
}

async function main() {
  const races = await loadData();

  // === 1. 信頼度別ROI ===
  console.log('='.repeat(70));
  console.log('1. 信頼度別ROI（本命馬のみ賭け）');
  console.log('='.repeat(70));

  const confBands = [
    { label: '全レース', min: 0, max: 100 },
    { label: '信頼度 90-100%', min: 90, max: 100 },
    { label: '信頼度 80-100%', min: 80, max: 100 },
    { label: '信頼度 70-100%', min: 70, max: 100 },
    { label: '信頼度 60-100%', min: 60, max: 100 },
    { label: '信頼度 50-60%', min: 50, max: 60 },
    { label: '信頼度 40-50%', min: 40, max: 50 },
    { label: '信頼度 0-40%', min: 0, max: 40 },
  ];

  for (const band of confBands) {
    const s = newStrategy(band.label);
    for (const race of races) {
      if (race.confidence < band.min || race.confidence >= band.max) continue;
      const top = race.horses[0];
      if (!top || top.odds <= 0) continue;
      addBet(s, top);
    }
    if (s.bets > 0) printStrategy(s);
  }

  // === 2. EV+フィルタ ===
  console.log('='.repeat(70));
  console.log('2. EV+フィルタ（モデル確率×オッズ > 1 の馬だけに賭ける）');
  console.log('='.repeat(70));

  const evThresholds = [1.0, 1.1, 1.2, 1.3, 1.5, 2.0];
  for (const threshold of evThresholds) {
    const s = newStrategy(`EV > ${threshold.toFixed(1)}`);
    for (const race of races) {
      for (const h of race.horses) {
        if (h.odds <= 0) continue;
        const ev = h.modelProb * h.odds;
        if (ev >= threshold) {
          addBet(s, h);
        }
      }
    }
    if (s.bets > 0) printStrategy(s);
  }

  // === 3. Value Horse（モデル > 市場 の馬だけ） ===
  console.log('='.repeat(70));
  console.log('3. バリュー馬（モデル確率 > 市場暗示確率 の馬だけ）');
  console.log('='.repeat(70));

  const valueMargins = [0.0, 0.02, 0.05, 0.10, 0.15];
  for (const margin of valueMargins) {
    const s = newStrategy(`乖離 > ${(margin * 100).toFixed(0)}%`);
    for (const race of races) {
      // 市場暗示確率を計算
      let totalRawProb = 0;
      for (const h of race.horses) {
        if (h.odds > 0) totalRawProb += 1 / h.odds;
      }
      if (totalRawProb <= 0) continue;

      for (const h of race.horses) {
        if (h.odds <= 0) continue;
        const marketProb = (1 / h.odds) / totalRawProb;
        const diff = h.modelProb - marketProb;
        if (diff >= margin) {
          addBet(s, h);
        }
      }
    }
    if (s.bets > 0) printStrategy(s);
  }

  // === 4. 信頼度 × EV+ 複合 ===
  console.log('='.repeat(70));
  console.log('4. 複合フィルタ（信頼度 + EV+ or Value）');
  console.log('='.repeat(70));

  const combos = [
    { label: '信頼度80+ & EV>1.0', confMin: 80, evMin: 1.0, valueDiff: -1 },
    { label: '信頼度80+ & EV>1.2', confMin: 80, evMin: 1.2, valueDiff: -1 },
    { label: '信頼度80+ & EV>1.5', confMin: 80, evMin: 1.5, valueDiff: -1 },
    { label: '信頼度70+ & EV>1.0', confMin: 70, evMin: 1.0, valueDiff: -1 },
    { label: '信頼度70+ & EV>1.2', confMin: 70, evMin: 1.2, valueDiff: -1 },
    { label: '信頼度70+ & EV>1.5', confMin: 70, evMin: 1.5, valueDiff: -1 },
    { label: '信頼度60+ & EV>1.2', confMin: 60, evMin: 1.2, valueDiff: -1 },
    { label: '信頼度60+ & EV>1.5', confMin: 60, evMin: 1.5, valueDiff: -1 },
    { label: '信頼度80+ & 乖離>5%', confMin: 80, evMin: 0, valueDiff: 0.05 },
    { label: '信頼度80+ & 乖離>10%', confMin: 80, evMin: 0, valueDiff: 0.10 },
    { label: '信頼度70+ & 乖離>5%', confMin: 70, evMin: 0, valueDiff: 0.05 },
    { label: '信頼度70+ & 乖離>10%', confMin: 70, evMin: 0, valueDiff: 0.10 },
    { label: '信頼度80+ & EV>1.2 & 乖離>5%', confMin: 80, evMin: 1.2, valueDiff: 0.05 },
    { label: '信頼度70+ & EV>1.2 & 乖離>5%', confMin: 70, evMin: 1.2, valueDiff: 0.05 },
    { label: '信頼度60+ & EV>1.2 & 乖離>5%', confMin: 60, evMin: 1.2, valueDiff: 0.05 },
  ];

  for (const combo of combos) {
    const s = newStrategy(combo.label);
    for (const race of races) {
      if (race.confidence < combo.confMin) continue;

      let totalRawProb = 0;
      for (const h of race.horses) {
        if (h.odds > 0) totalRawProb += 1 / h.odds;
      }

      for (const h of race.horses) {
        if (h.odds <= 0) continue;
        const ev = h.modelProb * h.odds;
        if (combo.evMin > 0 && ev < combo.evMin) continue;

        if (combo.valueDiff >= 0 && totalRawProb > 0) {
          const marketProb = (1 / h.odds) / totalRawProb;
          if (h.modelProb - marketProb < combo.valueDiff) continue;
        }

        addBet(s, h);
      }
    }
    if (s.bets > 0) printStrategy(s);
  }

  // === 5. 本命のみ vs 全推奨馬 ===
  console.log('='.repeat(70));
  console.log('5. ベット対象（本命のみ vs Top3 vs EV+馬）');
  console.log('='.repeat(70));

  {
    const sTop1 = newStrategy('本命（1位推奨）のみ');
    const sTop3 = newStrategy('Top3推奨馬');
    const sEvPlus = newStrategy('EV+馬のみ（全レース）');

    for (const race of races) {
      for (const h of race.horses) {
        if (h.odds <= 0) continue;
        if (h.rank === 1) addBet(sTop1, h);
        if (h.rank <= 3) addBet(sTop3, h);
        if (h.modelProb * h.odds > 1.0) addBet(sEvPlus, h);
      }
    }
    printStrategy(sTop1);
    printStrategy(sTop3);
    printStrategy(sEvPlus);
  }

  // === 6. オッズ帯別ROI ===
  console.log('='.repeat(70));
  console.log('6. オッズ帯別ROI（本命馬）');
  console.log('='.repeat(70));

  const oddsBands = [
    { label: '1.0-3.0倍 (大本命)', min: 1.0, max: 3.0 },
    { label: '3.0-5.0倍 (人気)', min: 3.0, max: 5.0 },
    { label: '5.0-10.0倍 (中穴)', min: 5.0, max: 10.0 },
    { label: '10.0-20.0倍 (穴)', min: 10.0, max: 20.0 },
    { label: '20.0倍+ (大穴)', min: 20.0, max: 9999 },
  ];

  for (const band of oddsBands) {
    const s = newStrategy(band.label);
    for (const race of races) {
      const top = race.horses[0];
      if (!top || top.odds < band.min || top.odds >= band.max) continue;
      addBet(s, top);
    }
    if (s.bets > 0) printStrategy(s);
  }

  await closeDatabase();
}

main().catch(console.error);
