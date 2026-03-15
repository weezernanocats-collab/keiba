/**
 * フィルタ適用後のROI検証
 *
 * ダsprint除外 + オッズ帯フィルタ適用で
 * 2026年データでも黒字になるか検証する。
 *
 * npx tsx -r tsconfig-paths/register scripts/roi-filtered-validation.ts
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
  racecourse: string;
  confidence: number;
  horseNumber: number;
  modelProb: number;
  odds: number;
  actualPosition: number;
  marketProb: number;
  divergence: number;
}

function getCategory(trackType: string, distance: number): string {
  if (trackType === '障害') return '障害';
  const isturf = trackType === '芝';
  if (distance <= 1400) return isturf ? '芝sprint' : 'ダsprint';
  if (distance <= 1800) return isturf ? '芝mile' : 'ダmile';
  return isturf ? '芝long' : 'ダlong';
}

async function loadData(): Promise<HorseData[]> {
  console.log('データ読み込み中...');

  const [predictions, entries] = await Promise.all([
    dbAll<{
      race_id: string;
      date: string;
      track_type: string;
      distance: number;
      racecourse_name: string;
      picks_json: string;
      analysis_json: string;
      confidence: number;
    }>(`
      SELECT p.race_id, r.date, r.track_type, r.distance, r.racecourse_name,
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

  const allData: HorseData[] = [];

  for (const pred of predictions) {
    try {
      const analysis = JSON.parse(pred.analysis_json);
      const winProbs = analysis.winProbabilities as Record<string, number> | undefined;
      const raceEntries = entryMap.get(pred.race_id);
      if (!winProbs || !raceEntries) continue;

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
          racecourse: pred.racecourse_name,
          confidence: pred.confidence,
          horseNumber,
          modelProb: prob,
          odds: entry.odds,
          actualPosition: entry.pos,
          marketProb,
          divergence: prob - marketProb,
        });
      }
    } catch { continue; }
  }

  console.log(`  対象: ${allData.length}行\n`);
  return allData;
}

interface Bucket {
  label: string;
  bets: number;
  wins: number;
  invest: number;
  ret: number;
}

function calc(data: HorseData[], label: string): Bucket {
  const b: Bucket = { label, bets: 0, wins: 0, invest: 0, ret: 0 };
  for (const d of data) {
    b.bets++;
    b.invest += 100;
    if (d.actualPosition === 1) {
      b.wins++;
      b.ret += 100 * d.odds;
    }
  }
  return b;
}

function print(b: Bucket) {
  if (b.bets === 0) { console.log(`  ${b.label.padEnd(30)} | データなし`); return; }
  const wr = (b.wins / b.bets * 100).toFixed(1);
  const roi = (b.ret / b.invest * 100).toFixed(1);
  const profit = b.ret - b.invest;
  const m = parseFloat(roi) >= 100 ? ' ★' : '';
  console.log(
    `  ${b.label.padEnd(30)} | ${String(b.bets).padStart(5)}件 | ` +
    `的中${wr.padStart(5)}% | ROI ${roi.padStart(6)}% | ` +
    `${profit >= 0 ? '+' : ''}${Math.round(profit).toLocaleString().padStart(9)}円${m}`
  );
}

interface Filter {
  minDiv: number;
  minOdds: number;
  maxOdds: number;
  excludeCats: string[];
  excludeVenues: string[];
  minConf: number;
}

function applyFilter(data: HorseData[], f: Filter): HorseData[] {
  return data.filter(d => {
    if (d.divergence < f.minDiv) return false;
    if (d.odds < f.minOdds || d.odds > f.maxOdds) return false;
    if (f.excludeCats.includes(getCategory(d.trackType, d.distance))) return false;
    if (f.excludeVenues.includes(d.racecourse)) return false;
    if (d.confidence < f.minConf) return false;
    return true;
  });
}

async function main() {
  const allData = await loadData();

  const timePeriods = [
    { label: '全期間', start: '2024-01', end: '2099-01' },
    { label: '好調期 (2024-05~09)', start: '2024-05', end: '2024-10' },
    { label: '安定期 (2024-10~2025-03)', start: '2024-10', end: '2025-04' },
    { label: '中期 (2025-04~09)', start: '2025-04', end: '2025-10' },
    { label: '低下期前 (2025-10~12)', start: '2025-10', end: '2026-01' },
    { label: '低下期 (2026-01~03)', start: '2026-01', end: '2026-04' },
  ];

  function byPeriod(data: HorseData[], p: { start: string; end: string }): HorseData[] {
    return data.filter(d => {
      const ym = d.date.slice(0, 7);
      return ym >= p.start && ym < p.end;
    });
  }

  // ===================================================
  // フィルタ定義
  // ===================================================
  const filters: { name: string; filter: Filter }[] = [
    {
      name: 'ベースライン (乖離>2%, フィルタなし)',
      filter: { minDiv: 0.02, minOdds: 0, maxOdds: 99999, excludeCats: [], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'A: ダsprint除外',
      filter: { minDiv: 0.02, minOdds: 0, maxOdds: 99999, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'B: オッズ3-50倍',
      filter: { minDiv: 0.02, minOdds: 3, maxOdds: 50, excludeCats: [], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'C: A+B (ダsprint除外 & 3-50倍)',
      filter: { minDiv: 0.02, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'D: C + 阪神除外',
      filter: { minDiv: 0.02, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: ['阪神'], minConf: 0 },
    },
    {
      name: 'E: C + 乖離>3%',
      filter: { minDiv: 0.03, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'F: C + 乖離>5%',
      filter: { minDiv: 0.05, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'G: E + 阪神除外',
      filter: { minDiv: 0.03, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: ['阪神'], minConf: 0 },
    },
    {
      name: 'H: C + 信頼度60+',
      filter: { minDiv: 0.02, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 60 },
    },
    {
      name: 'I: E + 信頼度60+',
      filter: { minDiv: 0.03, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 60 },
    },
    {
      name: 'J: C + オッズ5-50倍',
      filter: { minDiv: 0.02, minOdds: 5, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'K: E + オッズ5-50倍',
      filter: { minDiv: 0.03, minOdds: 5, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'L: ダsprint+障害除外 & 3-50倍 & 乖離>3%',
      filter: { minDiv: 0.03, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint', '障害'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'M: L + 阪神除外',
      filter: { minDiv: 0.03, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint', '障害'], excludeVenues: ['阪神'], minConf: 0 },
    },
    {
      name: 'N: ダsprint除外 & 5-30倍 & 乖離>3%',
      filter: { minDiv: 0.03, minOdds: 5, maxOdds: 30, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'O: 芝のみ & 3-50倍 & 乖離>2%',
      filter: { minDiv: 0.02, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint', 'ダmile', 'ダlong'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'P: 芝のみ & 3-50倍 & 乖離>3%',
      filter: { minDiv: 0.03, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint', 'ダmile', 'ダlong'], excludeVenues: [], minConf: 0 },
    },
    {
      name: 'Q: ダmile+ダlong+芝全 & 3-50倍 & 乖離>2%',
      filter: { minDiv: 0.02, minOdds: 3, maxOdds: 50, excludeCats: ['ダsprint'], excludeVenues: [], minConf: 0 },
    },
  ];

  // ===================================================
  // 全期間 + 各期間で比較
  // ===================================================
  for (const period of timePeriods) {
    console.log('='.repeat(90));
    console.log(`  ${period.label}`);
    console.log('='.repeat(90));

    const periodData = byPeriod(allData, period);

    for (const { name, filter } of filters) {
      const filtered = applyFilter(periodData, filter);
      print(calc(filtered, name));
    }
    console.log();
  }

  // ===================================================
  // 最有望フィルタの月別推移
  // ===================================================
  console.log('='.repeat(90));
  console.log('  月別推移: フィルタE (ダsprint除外 & 3-50倍 & 乖離>3%)');
  console.log('='.repeat(90));

  const filterE = filters.find(f => f.name.startsWith('E'))!.filter;
  const months = [...new Set(allData.map(d => d.date.slice(0, 7)))].sort();

  let cumInvest = 0, cumRet = 0;
  for (const month of months) {
    const monthData = allData.filter(d => d.date.startsWith(month));
    const filtered = applyFilter(monthData, filterE);
    const b = calc(filtered, month);
    cumInvest += b.invest;
    cumRet += b.ret;
    const cumRoi = cumInvest > 0 ? (cumRet / cumInvest * 100).toFixed(1) : '0.0';
    const cumProfit = cumRet - cumInvest;
    if (b.bets > 0) {
      const roi = (b.ret / b.invest * 100).toFixed(1);
      const m = parseFloat(roi) >= 100 ? '★' : ' ';
      console.log(
        `  ${month} | ${String(b.bets).padStart(4)}件 | ` +
        `的中${(b.wins/b.bets*100).toFixed(1).padStart(5)}% | ` +
        `月ROI ${roi.padStart(6)}% ${m} | ` +
        `累計ROI ${cumRoi.padStart(6)}% | 累計収支 ${cumProfit >= 0 ? '+' : ''}${Math.round(cumProfit).toLocaleString().padStart(9)}円`
      );
    }
  }

  // ===================================================
  // 最有望フィルタのカテゴリ別 (全期間 + 低下期)
  // ===================================================
  console.log('\n' + '='.repeat(90));
  console.log('  フィルタE カテゴリ別 — 全期間 vs 低下期');
  console.log('='.repeat(90));

  const cats = ['芝sprint', '芝mile', '芝long', 'ダmile', 'ダlong'];
  for (const label of ['全期間', '低下期 (2026-01~03)']) {
    const pd = label === '全期間' ? allData : byPeriod(allData, { start: '2026-01', end: '2026-04' });
    console.log(`\n  --- ${label} ---`);
    for (const cat of cats) {
      const filtered = applyFilter(pd, filterE).filter(d => getCategory(d.trackType, d.distance) === cat);
      print(calc(filtered, cat));
    }
    print(calc(applyFilter(pd, filterE), '合計'));
  }

  // ===================================================
  // 結論: 2026年でも黒字のフィルタを特定
  // ===================================================
  console.log('\n' + '='.repeat(90));
  console.log('  結論: 低下期 (2026年) でROI 100%+を達成するフィルタ');
  console.log('='.repeat(90));

  const declineData = byPeriod(allData, { start: '2026-01', end: '2026-04' });
  const profitable: { name: string; bets: number; roi: number; profit: number }[] = [];

  for (const { name, filter } of filters) {
    const filtered = applyFilter(declineData, filter);
    const b = calc(filtered, name);
    if (b.bets >= 10) {
      const roi = b.ret / b.invest * 100;
      profitable.push({ name, bets: b.bets, roi, profit: b.ret - b.invest });
    }
  }

  profitable.sort((a, b) => b.roi - a.roi);
  for (const s of profitable) {
    const m = s.roi >= 100 ? ' ★ 黒字!' : '';
    console.log(
      `  ${s.name.padEnd(50)} | ${String(s.bets).padStart(4)}件 | ` +
      `ROI ${s.roi.toFixed(1).padStart(6)}% | ` +
      `${s.profit >= 0 ? '+' : ''}${Math.round(s.profit).toLocaleString().padStart(8)}円${m}`
    );
  }

  await closeDatabase();
  console.log('\n[完了]');
}

main().catch(console.error);
