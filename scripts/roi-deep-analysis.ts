/**
 * ROI深掘り分析スクリプト
 *
 * 有望戦略のカテゴリ別・月別安定性を検証し、
 * 実運用に耐えるフィルタリング条件を特定する。
 *
 * npx tsx -r tsconfig-paths/register scripts/roi-deep-analysis.ts
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
  date: string;
  trackType: string;
  distance: number;
  grade: string | null;
  trackCondition: string | null;
  racecourse: string;
  confidence: number;
  horses: {
    horseNumber: number;
    rank: number;
    modelProb: number;
    odds: number;
    actualPosition: number;
  }[];
}

function getCategory(trackType: string, distance: number): string {
  if (trackType === '障害') return '障害';
  const isturf = trackType === '芝';
  if (distance <= 1400) return isturf ? '芝sprint' : 'ダsprint';
  if (distance <= 1800) return isturf ? '芝mile' : 'ダmile';
  return isturf ? '芝long' : 'ダlong';
}

function getMonth(date: string): string {
  return date.slice(0, 7); // YYYY-MM
}

async function loadData(): Promise<RaceResult[]> {
  console.log('データ読み込み中...');

  const [predictions, entries] = await Promise.all([
    dbAll<{
      race_id: string;
      date: string;
      track_type: string;
      distance: number;
      grade: string | null;
      track_condition: string | null;
      racecourse_name: string;
      picks_json: string;
      analysis_json: string;
      confidence: number;
    }>(`
      SELECT p.race_id, r.date, r.track_type, r.distance, r.grade,
             r.track_condition, r.racecourse_name,
             p.picks_json, p.analysis_json, p.confidence
      FROM predictions p
      JOIN races r ON r.id = p.race_id
      WHERE r.status = '結果確定'
        AND p.analysis_json IS NOT NULL
        AND p.confidence IS NOT NULL
        AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = r.id)
      ORDER BY r.date
    `),
    dbAll<{
      race_id: string;
      horse_number: number;
      result_position: number;
      odds: number | null;
    }>(`
      SELECT race_id, horse_number, result_position, odds
      FROM race_entries
      WHERE result_position IS NOT NULL AND result_position > 0
    `),
  ]);

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
      const winProbs = analysis.winProbabilities as Record<string, number> | undefined;
      const raceEntries = entryMap.get(pred.race_id);

      if (!winProbs || !raceEntries) continue;

      const rankMap = new Map<number, number>();
      for (const pick of picks) {
        rankMap.set(pick.horseNumber, pick.rank);
      }

      const horses: RaceResult['horses'] = [];
      for (const [numStr, prob] of Object.entries(winProbs)) {
        const horseNumber = parseInt(numStr);
        const entry = raceEntries.get(horseNumber);
        if (!entry || entry.pos <= 0) continue;

        horses.push({
          horseNumber,
          rank: rankMap.get(horseNumber) ?? 99,
          modelProb: prob,
          odds: entry.odds,
          actualPosition: entry.pos,
        });
      }

      if (horses.length < 3) continue;
      horses.sort((a, b) => a.rank - b.rank);

      results.push({
        raceId: pred.race_id,
        date: pred.date,
        trackType: pred.track_type,
        distance: pred.distance,
        grade: pred.grade,
        trackCondition: pred.track_condition,
        racecourse: pred.racecourse_name,
        confidence: pred.confidence,
        horses,
      });
    } catch { continue; }
  }

  console.log(`  対象レース: ${results.length}\n`);
  return results;
}

interface Bucket {
  label: string;
  bets: number;
  wins: number;
  invest: number;
  returnAmt: number;
}

function newBucket(label: string): Bucket {
  return { label, bets: 0, wins: 0, invest: 0, returnAmt: 0 };
}

function addToBucket(b: Bucket, odds: number, won: boolean, stake: number = 100) {
  b.bets++;
  b.invest += stake;
  if (won) {
    b.wins++;
    b.returnAmt += stake * odds;
  }
}

function printBucket(b: Bucket) {
  if (b.bets === 0) return;
  const winRate = (b.wins / b.bets * 100).toFixed(1);
  const roi = (b.returnAmt / b.invest * 100).toFixed(1);
  const profit = b.returnAmt - b.invest;
  const marker = parseFloat(roi) >= 100 ? ' ★' : '';
  console.log(
    `  ${b.label.padEnd(20)} | ${String(b.bets).padStart(6)}件 | ` +
    `的中${winRate.padStart(5)}% | ROI ${roi.padStart(6)}% | ` +
    `${profit >= 0 ? '+' : ''}${Math.round(profit).toLocaleString().padStart(10)}円${marker}`
  );
}

function getMarketProb(horse: RaceResult['horses'][0], allHorses: RaceResult['horses']): number {
  let totalRaw = 0;
  for (const h of allHorses) {
    if (h.odds > 0) totalRaw += 1 / h.odds;
  }
  if (totalRaw <= 0 || horse.odds <= 0) return 0;
  return (1 / horse.odds) / totalRaw;
}

// 乖離フィルタで該当馬を抽出
function getValueBets(
  race: RaceResult,
  minDiff: number,
  minConf: number = 0,
  minEv: number = 0,
): RaceResult['horses'][] {
  if (race.confidence < minConf) return [];

  const results: RaceResult['horses'][] = [];
  for (const h of race.horses) {
    if (h.odds <= 0) continue;
    const marketProb = getMarketProb(h, race.horses);
    const diff = h.modelProb - marketProb;
    const ev = h.modelProb * h.odds;
    if (diff >= minDiff && ev >= minEv) {
      results.push(h);
    }
  }
  return results;
}

async function main() {
  const races = await loadData();

  // ===================================================
  // 1. 乖離>2% 戦略のカテゴリ別ROI
  // ===================================================
  console.log('='.repeat(80));
  console.log('1. 乖離>2% 戦略 — カテゴリ別 (芝/ダ × 距離)');
  console.log('='.repeat(80));

  const categories = ['芝sprint', '芝mile', '芝long', 'ダsprint', 'ダmile', 'ダlong'];
  for (const minDiff of [0.02, 0.05]) {
    console.log(`\n--- 乖離 > ${(minDiff * 100).toFixed(0)}% ---`);
    const allBucket = newBucket('全体');

    for (const cat of categories) {
      const bucket = newBucket(cat);
      for (const race of races) {
        if (getCategory(race.trackType, race.distance) !== cat) continue;
        const valueBets = getValueBets(race, minDiff);
        for (const h of valueBets) {
          addToBucket(bucket, h.odds, h.actualPosition === 1);
          addToBucket(allBucket, h.odds, h.actualPosition === 1);
        }
      }
      printBucket(bucket);
    }
    printBucket(allBucket);
  }

  // ===================================================
  // 2. 乖離>2% 戦略の月別ROI (時系列安定性)
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('2. 乖離>2% 戦略 — 月別ROI (時系列安定性)');
  console.log('='.repeat(80));

  const monthBuckets = new Map<string, Bucket>();
  for (const race of races) {
    const month = getMonth(race.date);
    const valueBets = getValueBets(race, 0.02);
    for (const h of valueBets) {
      if (!monthBuckets.has(month)) monthBuckets.set(month, newBucket(month));
      addToBucket(monthBuckets.get(month)!, h.odds, h.actualPosition === 1);
    }
  }

  const sortedMonths = [...monthBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let profitableMonths = 0;
  for (const [, bucket] of sortedMonths) {
    printBucket(bucket);
    if (bucket.returnAmt >= bucket.invest) profitableMonths++;
  }
  console.log(`\n  黒字月: ${profitableMonths}/${sortedMonths.length} (${(profitableMonths / sortedMonths.length * 100).toFixed(0)}%)`);

  // ===================================================
  // 3. グレード別ROI (乖離>2%)
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('3. 乖離>2% 戦略 — グレード別ROI');
  console.log('='.repeat(80));

  const gradeGroups: Record<string, string[]> = {
    '重賞(G1-G3)': ['G1', 'G2', 'G3'],
    'リステッド': ['リステッド', '(L)'],
    'オープン': ['オープン', 'OP'],
    '3勝': ['3勝クラス', '3勝'],
    '2勝': ['2勝クラス', '2勝'],
    '1勝': ['1勝クラス', '1勝'],
    '未勝利': ['未勝利'],
    '新馬': ['新馬'],
  };

  for (const [groupName, patterns] of Object.entries(gradeGroups)) {
    const bucket = newBucket(groupName);
    for (const race of races) {
      const grade = race.grade ?? '';
      const match = patterns.some(p => grade.includes(p));
      if (!match) continue;
      const valueBets = getValueBets(race, 0.02);
      for (const h of valueBets) {
        addToBucket(bucket, h.odds, h.actualPosition === 1);
      }
    }
    printBucket(bucket);
  }

  // ===================================================
  // 4. 馬場状態別ROI (乖離>2%)
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('4. 乖離>2% 戦略 — 馬場状態別ROI');
  console.log('='.repeat(80));

  const conditions = ['良', '稍重', '稍', '重', '不良'];
  for (const cond of conditions) {
    const bucket = newBucket(cond);
    for (const race of races) {
      const rc = race.trackCondition ?? '';
      if (!rc.includes(cond)) continue;
      const valueBets = getValueBets(race, 0.02);
      for (const h of valueBets) {
        addToBucket(bucket, h.odds, h.actualPosition === 1);
      }
    }
    printBucket(bucket);
  }

  // ===================================================
  // 5. オッズ帯別ROI (乖離>2%)
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('5. 乖離>2% 戦略 — オッズ帯別ROI');
  console.log('='.repeat(80));

  const oddsBands = [
    { label: '1.0-2.0倍', min: 1.0, max: 2.0 },
    { label: '2.0-3.0倍', min: 2.0, max: 3.0 },
    { label: '3.0-5.0倍', min: 3.0, max: 5.0 },
    { label: '5.0-10.0倍', min: 5.0, max: 10.0 },
    { label: '10.0-20.0倍', min: 10.0, max: 20.0 },
    { label: '20.0-50.0倍', min: 20.0, max: 50.0 },
    { label: '50.0倍+', min: 50.0, max: 9999 },
  ];

  for (const band of oddsBands) {
    const bucket = newBucket(band.label);
    for (const race of races) {
      const valueBets = getValueBets(race, 0.02);
      for (const h of valueBets) {
        if (h.odds >= band.min && h.odds < band.max) {
          addToBucket(bucket, h.odds, h.actualPosition === 1);
        }
      }
    }
    printBucket(bucket);
  }

  // ===================================================
  // 6. 乖離閾値のグリッドサーチ
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('6. 乖離閾値グリッドサーチ (最適閾値の探索)');
  console.log('='.repeat(80));

  for (let diff = 0.01; diff <= 0.20; diff += 0.01) {
    const bucket = newBucket(`乖離>${(diff * 100).toFixed(0)}%`);
    for (const race of races) {
      const valueBets = getValueBets(race, diff);
      for (const h of valueBets) {
        addToBucket(bucket, h.odds, h.actualPosition === 1);
      }
    }
    printBucket(bucket);
  }

  // ===================================================
  // 7. 複合戦略: 乖離 × オッズ帯 × 信頼度
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('7. 最強複合戦略の探索');
  console.log('='.repeat(80));

  const bestStrategies: { label: string; roi: number; bets: number; profit: number }[] = [];

  for (const minDiff of [0.02, 0.03, 0.05]) {
    for (const minConf of [0, 50, 60, 70]) {
      for (const oddsBand of [
        { label: '全オッズ', min: 0, max: 9999 },
        { label: '3倍+', min: 3, max: 9999 },
        { label: '5倍+', min: 5, max: 9999 },
        { label: '3-20倍', min: 3, max: 20 },
        { label: '5-50倍', min: 5, max: 50 },
      ]) {
        const label = `乖離>${(minDiff*100).toFixed(0)}% 信頼度${minConf}+ ${oddsBand.label}`;
        const bucket = newBucket(label);

        for (const race of races) {
          if (race.confidence < minConf) continue;
          const valueBets = getValueBets(race, minDiff);
          for (const h of valueBets) {
            if (h.odds >= oddsBand.min && h.odds < oddsBand.max) {
              addToBucket(bucket, h.odds, h.actualPosition === 1);
            }
          }
        }

        if (bucket.bets >= 50) { // 最低50件以上
          const roi = bucket.returnAmt / bucket.invest * 100;
          const profit = bucket.returnAmt - bucket.invest;
          bestStrategies.push({ label, roi, bets: bucket.bets, profit });
        }
      }
    }
  }

  // ROI順にソート、上位20件
  bestStrategies.sort((a, b) => b.roi - a.roi);
  console.log('\n  上位20戦略 (最低50件以上):');
  for (const s of bestStrategies.slice(0, 20)) {
    const marker = s.roi >= 100 ? ' ★' : '';
    console.log(
      `  ${s.label.padEnd(40)} | ${String(s.bets).padStart(6)}件 | ` +
      `ROI ${s.roi.toFixed(1).padStart(6)}% | ` +
      `${s.profit >= 0 ? '+' : ''}${Math.round(s.profit).toLocaleString().padStart(10)}円${marker}`
    );
  }

  // ===================================================
  // 8. Kelly加重ベッティングシミュレーション
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('8. Kelly加重シミュレーション (乖離>2%)');
  console.log('='.repeat(80));

  const kellyFractions = [0.25, 0.125, 0.0625]; // フルKelly/4, /8, /16
  for (const fraction of kellyFractions) {
    let bankroll = 100000; // 10万円スタート
    let totalBets = 0;
    let totalWins = 0;
    let maxDrawdown = 0;
    let peak = bankroll;

    // 日付順にソート済みのデータを使用
    for (const race of races) {
      const valueBets = getValueBets(race, 0.02);
      for (const h of valueBets) {
        if (h.odds <= 0) continue;

        // Kelly: f* = (b*p - q) / b
        const b = h.odds - 1;
        const p = h.modelProb;
        const q = 1 - p;
        const kelly = (b * p - q) / b;

        if (kelly <= 0) continue; // エッジなし → 賭けない

        const stake = Math.min(
          bankroll * kelly * fraction,
          bankroll * 0.25, // 最大25%
        );
        if (stake < 100) continue; // 最低100円

        totalBets++;
        bankroll -= stake;

        if (h.actualPosition === 1) {
          totalWins++;
          bankroll += stake * h.odds;
        }

        if (bankroll > peak) peak = bankroll;
        const dd = (peak - bankroll) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    const roi = bankroll / 100000 * 100;
    console.log(`  Kelly×${fraction} | 賭け数: ${totalBets} | 的中: ${totalWins} (${(totalWins/totalBets*100).toFixed(1)}%)`);
    console.log(`    開始: 100,000円 → 終了: ${Math.round(bankroll).toLocaleString()}円 (${roi.toFixed(1)}%)`);
    console.log(`    最大DD: ${(maxDrawdown * 100).toFixed(1)}%`);
    console.log();
  }

  // ===================================================
  // 9. 乖離>5% + 信頼度60+ + EV>1.2 のカテゴリ別
  // ===================================================
  console.log('='.repeat(80));
  console.log('9. 最強戦略 (乖離>5% & 信頼度60+ & EV>1.2) — カテゴリ別');
  console.log('='.repeat(80));

  for (const cat of [...categories, '全体']) {
    const bucket = newBucket(cat);
    for (const race of races) {
      if (cat !== '全体' && getCategory(race.trackType, race.distance) !== cat) continue;
      const valueBets = getValueBets(race, 0.05, 60, 1.2);
      for (const h of valueBets) {
        addToBucket(bucket, h.odds, h.actualPosition === 1);
      }
    }
    printBucket(bucket);
  }

  // ===================================================
  // 10. ウォークフォワード検証 (前半で学習、後半で検証)
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('10. ウォークフォワード検証 (前半→後半で安定性確認)');
  console.log('='.repeat(80));

  const sortedDates = races.map(r => r.date).sort();
  const midDate = sortedDates[Math.floor(sortedDates.length / 2)];
  console.log(`  分割日: ${midDate}\n`);

  for (const minDiff of [0.02, 0.03, 0.05]) {
    const label = `乖離>${(minDiff * 100).toFixed(0)}%`;
    const firstHalf = newBucket(`${label} 前半`);
    const secondHalf = newBucket(`${label} 後半`);

    for (const race of races) {
      const valueBets = getValueBets(race, minDiff);
      const bucket = race.date <= midDate ? firstHalf : secondHalf;
      for (const h of valueBets) {
        addToBucket(bucket, h.odds, h.actualPosition === 1);
      }
    }

    printBucket(firstHalf);
    printBucket(secondHalf);
    console.log();
  }

  // ===================================================
  // 11. 競馬場別ROI (乖離>2%)
  // ===================================================
  console.log('='.repeat(80));
  console.log('11. 乖離>2% 戦略 — 競馬場別ROI');
  console.log('='.repeat(80));

  const venueBuckets = new Map<string, Bucket>();
  for (const race of races) {
    const valueBets = getValueBets(race, 0.02);
    for (const h of valueBets) {
      if (!venueBuckets.has(race.racecourse)) {
        venueBuckets.set(race.racecourse, newBucket(race.racecourse));
      }
      addToBucket(venueBuckets.get(race.racecourse)!, h.odds, h.actualPosition === 1);
    }
  }

  const sortedVenues = [...venueBuckets.entries()]
    .sort((a, b) => {
      const roiA = a[1].invest > 0 ? a[1].returnAmt / a[1].invest : 0;
      const roiB = b[1].invest > 0 ? b[1].returnAmt / b[1].invest : 0;
      return roiB - roiA;
    });
  for (const [, bucket] of sortedVenues) {
    printBucket(bucket);
  }

  await closeDatabase();
  console.log('\n[完了]');
}

main().catch(console.error);
