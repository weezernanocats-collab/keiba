/**
 * EVフィルタ バックテスト
 *
 * no-oddsモデルの校正済み確率を「真の確率」として、
 * 市場オッズとの乖離でバリューベットを検出する戦略のバックテスト。
 *
 * 使い方:
 *   npx tsx scripts/backtest-ev-filter.ts
 */
import { readFileSync, existsSync } from 'fs';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

interface RaceData {
  raceId: string;
  date: string;
  trackType: string;
  distance: number;
  grade: string;
  horses: HorseData[];
}

interface HorseData {
  horseNumber: number;
  aiProb: number;        // no-oddsモデル校正済み確率
  fullModelProb: number;  // fullモデル確率
  odds: number;
  resultPosition: number;
}

function categorize(trackType: string, distance: number): string {
  if (trackType === '芝') {
    if (distance <= 1400) return 'turf_sprint';
    if (distance <= 1800) return 'turf_mile';
    return 'turf_long';
  }
  if (distance <= 1600) return 'dirt_short';
  return 'dirt_long';
}

async function loadRaces(): Promise<RaceData[]> {
  // aiOnlyRankingがあり、かつ結果確定済みのレースを取得
  const rows = await db.execute({
    sql: `SELECT p.race_id, p.analysis_json, r.date, r.track_type, r.distance, r.grade
          FROM predictions p
          JOIN races r ON p.race_id = r.id
          WHERE p.analysis_json LIKE '%aiOnlyRanking%'
            AND EXISTS (SELECT 1 FROM prediction_results pr WHERE pr.race_id = p.race_id)
          ORDER BY r.date`,
    args: [],
  });

  const races: RaceData[] = [];

  for (const row of rows.rows) {
    const raceId = String(row.race_id);
    let analysis: any;
    try { analysis = JSON.parse(String(row.analysis_json)); } catch { continue; }

    const aiRanking = analysis?.aiOnlyRanking?.entries;
    const winProbs = analysis?.winProbabilities;
    if (!aiRanking || !winProbs) continue;

    // オッズと着順を取得
    const entries = await db.execute({
      sql: `SELECT horse_number, odds, result_position FROM race_entries
            WHERE race_id = ? AND odds > 0 AND result_position IS NOT NULL`,
      args: [raceId],
    });

    const oddsMap = new Map<number, { odds: number; pos: number }>();
    for (const e of entries.rows) {
      oddsMap.set(Number(e.horse_number), {
        odds: Number(e.odds),
        pos: Number(e.result_position),
      });
    }

    const horses: HorseData[] = [];
    for (const entry of aiRanking) {
      const hn = Number(entry.horseNumber);
      const od = oddsMap.get(hn);
      if (!od || od.odds <= 0) continue;

      horses.push({
        horseNumber: hn,
        aiProb: Number(entry.aiProb) || 0,
        fullModelProb: Number(winProbs[String(hn)]) || 0,
        odds: od.odds,
        resultPosition: od.pos,
      });
    }

    if (horses.length < 3) continue;

    races.push({
      raceId,
      date: String(row.date),
      trackType: String(row.track_type),
      distance: Number(row.distance),
      grade: String(row.grade || ''),
      horses,
    });
  }

  return races;
}

interface BetResult {
  bets: number;
  hits: number;
  invested: number;
  returned: number;
  roi: number;
  hitRate: number;
  avgOdds: number;
}

function simulateBets(
  races: RaceData[],
  evThreshold: number,
  probSource: 'ai' | 'full',
  categoryFilter: string | null,
  oddsMin: number,
  oddsMax: number,
  minProb: number,
): BetResult {
  let bets = 0, hits = 0, invested = 0, returned = 0;
  let totalOdds = 0;

  for (const race of races) {
    if (categoryFilter) {
      const cat = categorize(race.trackType, race.distance);
      if (categoryFilter === 'niche') {
        if (cat !== 'turf_mile' && cat !== 'dirt_long') continue;
      } else if (cat !== categoryFilter) continue;
    }

    for (const h of race.horses) {
      const prob = probSource === 'ai' ? h.aiProb : h.fullModelProb;
      if (prob < minProb) continue;
      if (h.odds < oddsMin || h.odds > oddsMax) continue;

      const ev = prob * h.odds;
      if (ev < evThreshold) continue;

      // 単勝100円ベット
      bets++;
      invested += 100;
      totalOdds += h.odds;
      if (h.resultPosition === 1) {
        hits++;
        returned += Math.floor(100 * h.odds);
      }
    }
  }

  return {
    bets,
    hits,
    invested,
    returned,
    roi: invested > 0 ? returned / invested * 100 : 0,
    hitRate: bets > 0 ? hits / bets * 100 : 0,
    avgOdds: bets > 0 ? totalOdds / bets : 0,
  };
}

// 複勝ベット（3着以内）
function simulatePlaceBets(
  races: RaceData[],
  evThreshold: number,
  categoryFilter: string | null,
  oddsMin: number,
  oddsMax: number,
  minProb: number,
): BetResult {
  let bets = 0, hits = 0, invested = 0, returned = 0;
  let totalOdds = 0;

  for (const race of races) {
    if (categoryFilter) {
      const cat = categorize(race.trackType, race.distance);
      if (categoryFilter === 'niche') {
        if (cat !== 'turf_mile' && cat !== 'dirt_long') continue;
      } else if (cat !== categoryFilter) continue;
    }

    for (const h of race.horses) {
      if (h.aiProb < minProb) continue;
      if (h.odds < oddsMin || h.odds > oddsMax) continue;

      // 複勝確率の近似: 単勝確率 × 2.5（経験的な変換係数）
      const placeProb = Math.min(0.95, h.aiProb * 2.5);
      // 複勝オッズの近似: 単勝オッズの約1/3
      const placeOdds = Math.max(1.1, h.odds / 3);

      const ev = placeProb * placeOdds;
      if (ev < evThreshold) continue;

      bets++;
      invested += 100;
      totalOdds += h.odds;
      if (h.resultPosition <= 3) {
        hits++;
        returned += Math.floor(100 * placeOdds);
      }
    }
  }

  return {
    bets,
    hits,
    invested,
    returned,
    roi: invested > 0 ? returned / invested * 100 : 0,
    hitRate: bets > 0 ? hits / bets * 100 : 0,
    avgOdds: bets > 0 ? totalOdds / bets : 0,
  };
}

async function main() {
  console.log('=== EVフィルタ バックテスト ===\n');

  const races = await loadRaces();
  console.log(`対象: ${races.length}レース`);

  // カテゴリ別の内訳
  const catCount: Record<string, number> = {};
  for (const r of races) {
    const cat = categorize(r.trackType, r.distance);
    catCount[cat] = (catCount[cat] || 0) + 1;
  }
  console.log('カテゴリ内訳:', catCount);
  console.log(`日付範囲: ${races[0]?.date} ~ ${races[races.length - 1]?.date}\n`);

  // ===== Part 1: no-oddsモデル vs fullモデル EV比較 =====
  console.log('═══════════════════════════════════════════');
  console.log('Part 1: no-odds vs full モデルのEVフィルタ比較');
  console.log('═══════════════════════════════════════════\n');

  const evThresholds = [1.0, 1.1, 1.2, 1.3, 1.5, 2.0];

  console.log('[単勝] 全カテゴリ / オッズ2-50 / minProb=0.05\n');
  console.log('EVしきい値 | no-odds Bets | no-odds ROI | full Bets | full ROI');
  console.log('-----------|-------------|-------------|-----------|----------');
  for (const ev of evThresholds) {
    const ai = simulateBets(races, ev, 'ai', null, 2, 50, 0.05);
    const full = simulateBets(races, ev, 'full', null, 2, 50, 0.05);
    console.log(`  EV≥${ev.toFixed(1)}   | ${String(ai.bets).padStart(11)} | ${(ai.roi.toFixed(1) + '%').padStart(11)} | ${String(full.bets).padStart(9)} | ${(full.roi.toFixed(1) + '%').padStart(8)}`);
  }

  // ===== Part 2: カテゴリ別グリッドサーチ =====
  console.log('\n═══════════════════════════════════════════');
  console.log('Part 2: カテゴリ × EVしきい値 グリッドサーチ (no-oddsモデル)');
  console.log('═══════════════════════════════════════════\n');

  const categories = [null, 'turf_sprint', 'turf_mile', 'turf_long', 'dirt_short', 'dirt_long', 'niche'];
  const catNames: Record<string, string> = {
    'null': '全体', 'turf_sprint': '芝短', 'turf_mile': '芝マイル',
    'turf_long': '芝長', 'dirt_short': 'ダ短', 'dirt_long': 'ダ長', 'niche': '芝M+ダ長',
  };
  const oddsRanges = [[2, 50], [3, 30], [5, 20]];

  // まず主要な組み合わせを表示
  console.log('[単勝] minProb=0.05\n');

  for (const [oMin, oMax] of oddsRanges) {
    console.log(`--- オッズ ${oMin}-${oMax} ---`);
    console.log('カテゴリ   | EV≥1.0          | EV≥1.2          | EV≥1.5          | EV≥2.0');
    console.log('----------|-----------------|-----------------|-----------------|----------------');
    for (const cat of categories) {
      const results = [1.0, 1.2, 1.5, 2.0].map(ev => simulateBets(races, ev, 'ai', cat, oMin, oMax, 0.05));
      const catName = catNames[String(cat)].padEnd(10);
      const cells = results.map(r =>
        r.bets > 0 ? `${r.bets}点 ${r.roi.toFixed(0)}%` : '-'
      );
      console.log(`${catName}| ${cells[0].padEnd(16)}| ${cells[1].padEnd(16)}| ${cells[2].padEnd(16)}| ${cells[3]}`);
    }
    console.log('');
  }

  // ===== Part 3: ROI > 100%の組み合わせを全列挙 =====
  console.log('═══════════════════════════════════════════');
  console.log('Part 3: ROI > 100% の組み合わせ（勝てる戦略候補）');
  console.log('═══════════════════════════════════════════\n');

  const winners: Array<{
    cat: string; ev: number; oMin: number; oMax: number; minP: number;
    bets: number; hits: number; roi: number; hitRate: number; avgOdds: number;
  }> = [];

  const minProbs = [0.03, 0.05, 0.08, 0.10, 0.15];

  for (const cat of categories) {
    for (const ev of [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 2.0]) {
      for (const [oMin, oMax] of [[2, 50], [3, 30], [3, 50], [5, 20], [5, 50], [8, 50]]) {
        for (const minP of minProbs) {
          const r = simulateBets(races, ev, 'ai', cat, oMin, oMax, minP);
          if (r.roi > 100 && r.bets >= 5) {
            winners.push({
              cat: catNames[String(cat)],
              ev, oMin, oMax, minP,
              bets: r.bets, hits: r.hits, roi: r.roi,
              hitRate: r.hitRate, avgOdds: r.avgOdds,
            });
          }
        }
      }
    }
  }

  // ROI降順でソート
  winners.sort((a, b) => b.roi - a.roi);

  if (winners.length === 0) {
    console.log('ROI > 100% かつ 5ベット以上の組み合わせなし');
    console.log('\n→ no-oddsモデルの現状では単勝EVフィルタでプラスROIは困難');
    console.log('→ Phase 2（モデル再学習 + 損失関数変更）を先行する必要あり');
  } else {
    console.log(`${winners.length}個の勝ち組み合わせを発見:\n`);
    console.log('カテゴリ  | EVしきい | オッズ幅  | minP  | ベット | 的中 | 的中率 | 平均odds | ROI');
    console.log('---------|---------|---------|-------|-------|------|--------|---------|------');
    for (const w of winners.slice(0, 30)) {
      console.log(
        `${w.cat.padEnd(9)}| ≥${w.ev.toFixed(2).padEnd(5)} | ${w.oMin}-${String(w.oMax).padEnd(4)} | ${w.minP.toFixed(2).padEnd(5)} | ${String(w.bets).padStart(5)} | ${String(w.hits).padStart(4)} | ${(w.hitRate.toFixed(1) + '%').padStart(6)} | ${w.avgOdds.toFixed(1).padStart(7)} | ${(w.roi.toFixed(1) + '%').padStart(6)}`
      );
    }
    if (winners.length > 30) console.log(`  ... 他 ${winners.length - 30}件`);
  }

  // ===== Part 4: 参考 - 複勝EVフィルタ =====
  console.log('\n═══════════════════════════════════════════');
  console.log('Part 4: 参考 - 複勝EVフィルタ (近似計算)');
  console.log('═══════════════════════════════════════════\n');

  for (const cat of [null, 'turf_mile', 'dirt_long', 'niche']) {
    const catName = catNames[String(cat)];
    for (const ev of [1.0, 1.2]) {
      const r = simulatePlaceBets(races, ev, cat, 2, 50, 0.05);
      if (r.bets > 0) {
        console.log(`[${catName}] EV≥${ev}: ${r.bets}点 的中${r.hits} (${r.hitRate.toFixed(1)}%) ROI=${r.roi.toFixed(1)}%`);
      }
    }
  }

  // ===== Part 5: 診断サマリー =====
  console.log('\n═══════════════════════════════════════════');
  console.log('診断サマリー');
  console.log('═══════════════════════════════════════════\n');

  // 基本統計
  const baseAi = simulateBets(races, 0, 'ai', null, 0, 9999, 0);
  console.log(`全馬の平均aiProb: ${(races.reduce((s, r) => s + r.horses.reduce((s2, h) => s2 + h.aiProb, 0), 0) / races.reduce((s, r) => s + r.horses.length, 0) * 100).toFixed(2)}%`);
  console.log(`全レースTOP1（aiProb最大馬）の単勝ROI: ${(() => {
    let inv = 0, ret = 0;
    for (const r of races) {
      const top = r.horses.reduce((a, b) => a.aiProb > b.aiProb ? a : b);
      inv += 100;
      if (top.resultPosition === 1) ret += Math.floor(100 * top.odds);
    }
    return (ret / inv * 100).toFixed(1);
  })()}%`);

  // EV分布
  const evValues: number[] = [];
  for (const r of races) {
    for (const h of r.horses) {
      if (h.odds > 0 && h.aiProb > 0) {
        evValues.push(h.aiProb * h.odds);
      }
    }
  }
  evValues.sort((a, b) => a - b);
  console.log(`\nEV分布 (全${evValues.length}馬):`);
  console.log(`  中央値: ${evValues[Math.floor(evValues.length / 2)].toFixed(3)}`);
  console.log(`  75%ile: ${evValues[Math.floor(evValues.length * 0.75)].toFixed(3)}`);
  console.log(`  90%ile: ${evValues[Math.floor(evValues.length * 0.90)].toFixed(3)}`);
  console.log(`  95%ile: ${evValues[Math.floor(evValues.length * 0.95)].toFixed(3)}`);
  console.log(`  99%ile: ${evValues[Math.floor(evValues.length * 0.99)].toFixed(3)}`);
  console.log(`  max: ${evValues[evValues.length - 1].toFixed(3)}`);
  console.log(`  EV > 1.0: ${evValues.filter(v => v > 1.0).length}馬 (${(evValues.filter(v => v > 1.0).length / evValues.length * 100).toFixed(1)}%)`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
