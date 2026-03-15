/**
 * 直近ROI低下の原因診断スクリプト
 *
 * 2026年1-3月のROI急落の原因を多角的に分析:
 *   1. モデル確率のキャリブレーション変化
 *   2. 乖離分布の変化
 *   3. オッズ・人気分布の変化
 *   4. カテゴリ構成の変化
 *   5. predictions生成日時の影響 (データリーケージ修正前後)
 *   6. 信頼度分布の変化
 *   7. 的中率 vs オッズの分解
 *
 * npx tsx -r tsconfig-paths/register scripts/roi-decline-diagnosis.ts
 */
import { readFileSync } from 'fs';

const env = readFileSync('.env.local', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

import { dbAll, closeDatabase } from '@/lib/database';

interface HorseData {
  raceId: string;
  date: string;
  trackType: string;
  distance: number;
  grade: string | null;
  racecourse: string;
  confidence: number;
  generatedAt: string;
  horseNumber: number;
  rank: number;
  modelProb: number;
  odds: number;
  actualPosition: number;
  marketProb: number; // 正規化後の市場暗示確率
  divergence: number; // modelProb - marketProb
}

async function loadData(): Promise<HorseData[]> {
  console.log('データ読み込み中...');

  const [predictions, entries] = await Promise.all([
    dbAll<{
      race_id: string;
      date: string;
      track_type: string;
      distance: number;
      grade: string | null;
      racecourse_name: string;
      picks_json: string;
      analysis_json: string;
      confidence: number;
      generated_at: string;
    }>(`
      SELECT p.race_id, r.date, r.track_type, r.distance, r.grade,
             r.racecourse_name, p.picks_json, p.analysis_json,
             p.confidence, p.generated_at
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

  const allData: HorseData[] = [];

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

      // 市場暗示確率の計算
      let totalRawProb = 0;
      for (const [numStr] of Object.entries(winProbs)) {
        const entry = raceEntries.get(parseInt(numStr));
        if (entry && entry.odds > 0) totalRawProb += 1 / entry.odds;
      }

      for (const [numStr, prob] of Object.entries(winProbs)) {
        const horseNumber = parseInt(numStr);
        const entry = raceEntries.get(horseNumber);
        if (!entry || entry.pos <= 0 || entry.odds <= 0) continue;

        const marketProb = totalRawProb > 0 ? (1 / entry.odds) / totalRawProb : 0;

        allData.push({
          raceId: pred.race_id,
          date: pred.date,
          trackType: pred.track_type,
          distance: pred.distance,
          grade: pred.grade,
          racecourse: pred.racecourse_name,
          confidence: pred.confidence,
          generatedAt: pred.generated_at,
          horseNumber,
          rank: rankMap.get(horseNumber) ?? 99,
          modelProb: prob,
          odds: entry.odds,
          actualPosition: entry.pos,
          marketProb,
          divergence: prob - marketProb,
        });
      }
    } catch { continue; }
  }

  console.log(`  対象データ: ${allData.length}行 (馬単位)\n`);
  return allData;
}

function getQuarter(date: string): string {
  const [year, monthStr] = date.split('-');
  const month = parseInt(monthStr);
  const q = Math.ceil(month / 3);
  return `${year}-Q${q}`;
}

function getCategory(trackType: string, distance: number): string {
  if (trackType === '障害') return '障害';
  const isturf = trackType === '芝';
  if (distance <= 1400) return isturf ? '芝sprint' : 'ダsprint';
  if (distance <= 1800) return isturf ? '芝mile' : 'ダmile';
  return isturf ? '芝long' : 'ダlong';
}

// 統計ヘルパー
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

async function main() {
  const allData = await loadData();

  // 期間定義
  const periods = [
    { label: '好調期 (2024-05〜2024-09)', start: '2024-05', end: '2024-10' },
    { label: '安定期 (2024-10〜2025-03)', start: '2024-10', end: '2025-04' },
    { label: '中期 (2025-04〜2025-09)', start: '2025-04', end: '2025-10' },
    { label: '低下期前 (2025-10〜2025-12)', start: '2025-10', end: '2026-01' },
    { label: '低下期 (2026-01〜2026-03)', start: '2026-01', end: '2026-04' },
  ];

  function inPeriod(date: string, p: { start: string; end: string }): boolean {
    const ym = date.slice(0, 7);
    return ym >= p.start && ym < p.end;
  }

  // ===================================================
  // 1. キャリブレーション分析: モデル確率 vs 実際の的中率
  // ===================================================
  console.log('='.repeat(80));
  console.log('1. キャリブレーション分析 (モデル確率 vs 実際の勝率)');
  console.log('   モデルが「20%で勝つ」と言った馬が実際に何%勝つか');
  console.log('='.repeat(80));

  const probBins = [
    { label: '0-5%', min: 0, max: 0.05 },
    { label: '5-10%', min: 0.05, max: 0.10 },
    { label: '10-20%', min: 0.10, max: 0.20 },
    { label: '20-30%', min: 0.20, max: 0.30 },
    { label: '30-50%', min: 0.30, max: 0.50 },
    { label: '50%+', min: 0.50, max: 1.0 },
  ];

  for (const period of periods) {
    console.log(`\n  --- ${period.label} ---`);
    const periodData = allData.filter(d => inPeriod(d.date, period));
    if (periodData.length === 0) { console.log('    データなし'); continue; }

    for (const bin of probBins) {
      const binData = periodData.filter(d => d.modelProb >= bin.min && d.modelProb < bin.max);
      if (binData.length < 10) continue;
      const wins = binData.filter(d => d.actualPosition === 1).length;
      const actual = wins / binData.length;
      const expected = (bin.min + bin.max) / 2;
      const diff = actual - expected;
      const marker = Math.abs(diff) > 0.05 ? (diff > 0 ? ' ↑過小評価' : ' ↓過大評価') : '';
      console.log(
        `    ${bin.label.padEnd(8)} | ${String(binData.length).padStart(6)}件 | ` +
        `予測${(expected * 100).toFixed(0).padStart(3)}% → 実際${(actual * 100).toFixed(1).padStart(5)}% | ` +
        `差${(diff >= 0 ? '+' : '')}${(diff * 100).toFixed(1)}%${marker}`
      );
    }
  }

  // ===================================================
  // 2. 乖離分布の変化: 乖離>2%の馬の割合と質
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('2. 乖離分布の変化 (モデル - 市場)');
  console.log('='.repeat(80));

  for (const period of periods) {
    const periodData = allData.filter(d => inPeriod(d.date, period));
    if (periodData.length === 0) continue;

    const divergences = periodData.map(d => d.divergence);
    const positiveDiv = periodData.filter(d => d.divergence > 0.02);
    const positiveDivValues = positiveDiv.map(d => d.divergence);

    // 乖離>2%の馬のROI
    let invest = 0, ret = 0, wins = 0;
    for (const d of positiveDiv) {
      invest += 100;
      if (d.actualPosition === 1) { wins++; ret += 100 * d.odds; }
    }

    console.log(`  ${period.label}`);
    console.log(`    全馬: ${periodData.length}件 | 乖離中央値: ${(median(divergences) * 100).toFixed(2)}%`);
    console.log(`    乖離>2%: ${positiveDiv.length}件 (${(positiveDiv.length / periodData.length * 100).toFixed(1)}%)` +
      ` | 乖離中央値: ${(median(positiveDivValues) * 100).toFixed(2)}%` +
      ` | 乖離P90: ${(percentile(positiveDivValues, 90) * 100).toFixed(2)}%`);
    console.log(`    乖離>2% ROI: 的中${invest > 0 ? (wins / (invest / 100) * 100).toFixed(1) : 0}%` +
      ` | ROI ${invest > 0 ? (ret / invest * 100).toFixed(1) : 0}%` +
      ` | 収支 ${ret - invest >= 0 ? '+' : ''}${Math.round(ret - invest)}円`);
    console.log();
  }

  // ===================================================
  // 3. 的中率 vs 平均オッズの分解
  // ===================================================
  console.log('='.repeat(80));
  console.log('3. 的中率 vs 平均オッズ分解 (乖離>2%の馬)');
  console.log('   ROI = 的中率 × 平均勝ちオッズ');
  console.log('='.repeat(80));

  for (const period of periods) {
    const periodData = allData.filter(d => inPeriod(d.date, period) && d.divergence > 0.02);
    if (periodData.length === 0) continue;

    const wins = periodData.filter(d => d.actualPosition === 1);
    const winRate = wins.length / periodData.length;
    const avgWinOdds = wins.length > 0
      ? wins.reduce((s, d) => s + d.odds, 0) / wins.length
      : 0;
    const avgAllOdds = periodData.reduce((s, d) => s + d.odds, 0) / periodData.length;
    const roi = winRate * avgWinOdds * 100;

    console.log(`  ${period.label}`);
    console.log(`    賭け数: ${periodData.length} | 的中: ${wins.length} (${(winRate * 100).toFixed(1)}%)`);
    console.log(`    平均オッズ(全): ${avgAllOdds.toFixed(1)}倍 | 平均オッズ(勝ち): ${avgWinOdds.toFixed(1)}倍`);
    console.log(`    ROI = ${(winRate * 100).toFixed(1)}% × ${avgWinOdds.toFixed(1)} = ${roi.toFixed(1)}%`);
    console.log();
  }

  // ===================================================
  // 4. カテゴリ構成の変化
  // ===================================================
  console.log('='.repeat(80));
  console.log('4. カテゴリ構成の変化 (乖離>2%の馬)');
  console.log('='.repeat(80));

  const cats = ['芝sprint', '芝mile', '芝long', 'ダsprint', 'ダmile', 'ダlong'];

  for (const period of periods) {
    const periodData = allData.filter(d => inPeriod(d.date, period) && d.divergence > 0.02);
    if (periodData.length === 0) continue;

    console.log(`\n  --- ${period.label} ---`);
    for (const cat of cats) {
      const catData = periodData.filter(d => getCategory(d.trackType, d.distance) === cat);
      if (catData.length === 0) continue;
      const pct = (catData.length / periodData.length * 100).toFixed(1);
      const wins = catData.filter(d => d.actualPosition === 1).length;
      const winRate = (wins / catData.length * 100).toFixed(1);
      let ret = 0;
      for (const d of catData) { if (d.actualPosition === 1) ret += 100 * d.odds; }
      const roi = (ret / (catData.length * 100) * 100).toFixed(1);
      const marker = parseFloat(roi) >= 100 ? ' ★' : '';
      console.log(`    ${cat.padEnd(10)} | ${String(catData.length).padStart(5)}件 (${pct.padStart(5)}%) | 的中${winRate.padStart(5)}% | ROI ${roi.padStart(6)}%${marker}`);
    }
  }

  // ===================================================
  // 5. predictions生成日時の分析
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('5. 予測生成タイミングの分析');
  console.log('   データリーケージ修正 (2026-03-08) 前後');
  console.log('='.repeat(80));

  // 2026年レースだけに注目
  const data2026 = allData.filter(d => d.date >= '2026-01-01');

  // 生成日でグループ
  const genDateGroups = new Map<string, HorseData[]>();
  for (const d of data2026) {
    const genDate = d.generatedAt ? d.generatedAt.slice(0, 10) : 'unknown';
    const arr = genDateGroups.get(genDate) || [];
    arr.push(d);
    genDateGroups.set(genDate, arr);
  }

  console.log(`\n  2026年データの生成日分布:`);
  const sortedGenDates = [...genDateGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [genDate, data] of sortedGenDates) {
    const races = new Set(data.map(d => d.raceId)).size;
    console.log(`    生成日: ${genDate} | ${races}レース (${data.length}馬)`);
  }

  // 2026-03-08以降に再生成されたかチェック
  const regenData = data2026.filter(d => d.generatedAt >= '2026-03-08');
  const origData = data2026.filter(d => d.generatedAt < '2026-03-08');
  console.log(`\n  修正前生成: ${new Set(origData.map(d => d.raceId)).size}レース (${origData.length}馬)`);
  console.log(`  修正後再生成: ${new Set(regenData.map(d => d.raceId)).size}レース (${regenData.length}馬)`);

  // 修正前後のROI比較 (2026年データのみ)
  for (const [label, subset] of [['修正前生成', origData], ['修正後再生成', regenData]] as const) {
    const divFiltered = subset.filter(d => d.divergence > 0.02);
    if (divFiltered.length === 0) { console.log(`  ${label}: 乖離>2%データなし`); continue; }
    let invest = 0, ret = 0, wins = 0;
    for (const d of divFiltered) {
      invest += 100;
      if (d.actualPosition === 1) { wins++; ret += 100 * d.odds; }
    }
    console.log(`  ${label} (乖離>2%): ${divFiltered.length}件 | 的中${(wins/(invest/100)*100).toFixed(1)}% | ROI ${(ret/invest*100).toFixed(1)}%`);
  }

  // ===================================================
  // 6. 信頼度分布の変化
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('6. 信頼度分布の変化');
  console.log('='.repeat(80));

  // レース単位で信頼度を集計
  for (const period of periods) {
    const periodData = allData.filter(d => inPeriod(d.date, period));
    const raceConfs = new Map<string, number>();
    for (const d of periodData) {
      raceConfs.set(d.raceId, d.confidence);
    }
    const confs = [...raceConfs.values()];
    if (confs.length === 0) continue;

    const avg = confs.reduce((s, v) => s + v, 0) / confs.length;
    const high = confs.filter(c => c >= 70).length;
    const mid = confs.filter(c => c >= 50 && c < 70).length;
    const low = confs.filter(c => c < 50).length;

    console.log(`  ${period.label}`);
    console.log(`    平均信頼度: ${avg.toFixed(1)} | 70+: ${high}件 (${(high/confs.length*100).toFixed(0)}%) | 50-70: ${mid}件 (${(mid/confs.length*100).toFixed(0)}%) | <50: ${low}件 (${(low/confs.length*100).toFixed(0)}%)`);
  }

  // ===================================================
  // 7. モデル確率の分散・集中度の変化
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('7. モデル確率の分散 (予測の自信度)');
  console.log('   最大確率が高い = モデルが自信を持って予測');
  console.log('='.repeat(80));

  for (const period of periods) {
    const periodData = allData.filter(d => inPeriod(d.date, period));
    // レースごとの最大確率
    const raceMaxProbs = new Map<string, number>();
    for (const d of periodData) {
      const current = raceMaxProbs.get(d.raceId) ?? 0;
      if (d.modelProb > current) raceMaxProbs.set(d.raceId, d.modelProb);
    }
    const maxProbs = [...raceMaxProbs.values()];
    if (maxProbs.length === 0) continue;

    const avgMax = maxProbs.reduce((s, v) => s + v, 0) / maxProbs.length;
    const highConf = maxProbs.filter(p => p >= 0.30).length;

    console.log(`  ${period.label}`);
    console.log(`    レース数: ${maxProbs.length} | 平均最大確率: ${(avgMax * 100).toFixed(1)}% | 30%+: ${highConf}件 (${(highConf/maxProbs.length*100).toFixed(0)}%)`);
  }

  // ===================================================
  // 8. 市場オッズ精度の変化
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('8. 市場オッズの精度変化 (市場も分析対象)');
  console.log('   1番人気の勝率変化 → 市場環境の変化を検出');
  console.log('='.repeat(80));

  for (const period of periods) {
    const periodData = allData.filter(d => inPeriod(d.date, period));
    // 各レースの1番人気 (最低オッズの馬)
    const raceMinOdds = new Map<string, HorseData>();
    for (const d of periodData) {
      const current = raceMinOdds.get(d.raceId);
      if (!current || d.odds < current.odds) raceMinOdds.set(d.raceId, d);
    }
    const favorites = [...raceMinOdds.values()];
    if (favorites.length === 0) continue;

    const favWins = favorites.filter(f => f.actualPosition === 1).length;
    const favWinRate = favWins / favorites.length;
    const avgFavOdds = favorites.reduce((s, f) => s + f.odds, 0) / favorites.length;
    const favRoi = favWinRate * avgFavOdds * 100;

    console.log(`  ${period.label}`);
    console.log(`    1番人気勝率: ${(favWinRate * 100).toFixed(1)}% | 平均オッズ: ${avgFavOdds.toFixed(2)} | ROI: ${favRoi.toFixed(1)}%`);
  }

  // ===================================================
  // 9. 乖離>2%の馬の「質」の変化
  // ===================================================
  console.log('\n' + '='.repeat(80));
  console.log('9. 乖離>2%馬の質の変化 (人気順位の分布)');
  console.log('   市場人気との関係 — 人気薄に偏っていないか');
  console.log('='.repeat(80));

  for (const period of periods) {
    const divData = allData.filter(d => inPeriod(d.date, period) && d.divergence > 0.02);
    if (divData.length === 0) continue;

    // オッズ帯別の内訳
    const bands = [
      { label: '1-5倍', min: 1, max: 5 },
      { label: '5-20倍', min: 5, max: 20 },
      { label: '20-50倍', min: 20, max: 50 },
      { label: '50倍+', min: 50, max: 99999 },
    ];

    console.log(`  ${period.label} (乖離>2%: ${divData.length}件)`);
    for (const band of bands) {
      const bandData = divData.filter(d => d.odds >= band.min && d.odds < band.max);
      if (bandData.length === 0) continue;
      const pct = (bandData.length / divData.length * 100).toFixed(1);
      const wins = bandData.filter(d => d.actualPosition === 1).length;
      const winRate = (wins / bandData.length * 100).toFixed(1);
      console.log(`    ${band.label.padEnd(8)} | ${String(bandData.length).padStart(5)}件 (${pct.padStart(5)}%) | 的中${winRate.padStart(5)}%`);
    }
    console.log();
  }

  // ===================================================
  // 10. 月別の詳細ブレークダウン (直近6ヶ月)
  // ===================================================
  console.log('='.repeat(80));
  console.log('10. 月別詳細 (直近8ヶ月)');
  console.log('='.repeat(80));

  const recentMonths = ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03'];
  for (const month of recentMonths) {
    const monthData = allData.filter(d => d.date.startsWith(month) && d.divergence > 0.02);
    if (monthData.length === 0) continue;

    const wins = monthData.filter(d => d.actualPosition === 1);
    const winRate = wins.length / monthData.length;
    const avgWinOdds = wins.length > 0 ? wins.reduce((s, d) => s + d.odds, 0) / wins.length : 0;
    const avgAllOdds = monthData.reduce((s, d) => s + d.odds, 0) / monthData.length;
    const avgDiv = monthData.reduce((s, d) => s + d.divergence, 0) / monthData.length;
    const invest = monthData.length * 100;
    const ret = wins.reduce((s, d) => s + 100 * d.odds, 0);
    const roi = ret / invest * 100;
    const marker = roi >= 100 ? ' ★' : '';

    // カテゴリ別
    const catBreakdown = cats.map(cat => {
      const catData = monthData.filter(d => getCategory(d.trackType, d.distance) === cat);
      return catData.length > 0 ? `${cat}:${catData.length}` : '';
    }).filter(Boolean).join(' ');

    console.log(`  ${month}`);
    console.log(`    賭け: ${monthData.length}件 | 的中: ${wins.length} (${(winRate*100).toFixed(1)}%) | 勝ちオッズ平均: ${avgWinOdds.toFixed(1)} | ROI: ${roi.toFixed(1)}%${marker}`);
    console.log(`    平均乖離: ${(avgDiv*100).toFixed(2)}% | 平均オッズ: ${avgAllOdds.toFixed(1)} | カテゴリ: ${catBreakdown}`);
    console.log();
  }

  await closeDatabase();
  console.log('[完了]');
}

main().catch(console.error);
