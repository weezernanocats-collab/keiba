/**
 * 信頼度×馬券種別クロスROI分析スクリプト
 *
 * 高信頼度レースで各馬券種別を購入した場合の回収率を算出する。
 * 信頼度帯（80+, 60-79, 40-59, 15-39）× 馬券種別（単勝〜三連単）の
 * マトリックスでROI・的中率・期待値を分析。
 *
 * npx tsx -r tsconfig-paths/register scripts/analyze-confidence-roi.ts
 */
import { readFileSync, existsSync } from 'fs';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

import { createClient, type Client } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error('TURSO_DATABASE_URL / TURSO_AUTH_TOKEN が未設定です');
  process.exit(1);
}
const db = createClient({ url, authToken });

// 馬券的中判定
function isBetHit(betType: string, selections: number[], top3: number[]): boolean {
  if (selections.length === 0 || top3.length === 0) return false;
  const winner = top3[0];
  const top2 = top3.slice(0, 2);
  switch (betType) {
    case '単勝': return selections[0] === winner;
    case '複勝': return top3.includes(selections[0]);
    case '馬連': return selections.length >= 2 && top2.length >= 2 && selections.every(s => top2.includes(s));
    case 'ワイド': return selections.length >= 2 && selections.every(s => top3.includes(s));
    case '馬単': return selections.length >= 2 && selections[0] === top3[0] && selections[1] === top3[1];
    case '三連複': return selections.length >= 3 && top3.length >= 3 && selections.every(s => top3.includes(s));
    case '三連単': return selections.length >= 3 && top3.length >= 3 &&
      selections[0] === top3[0] && selections[1] === top3[1] && selections[2] === top3[2];
    default: return false;
  }
}

interface ConfBetBucket {
  total: number;
  hits: number;
  invested: number;
  returned: number;
  oddsSum: number;
  oddsCount: number;
}

async function main() {
  console.log('=========================================================');
  console.log('  信頼度 × 馬券種別 クロスROI分析');
  console.log('=========================================================\n');

  // 1. prediction_results + predictions + races を取得
  const rows = await db.execute(`
    SELECT pr.race_id, pr.predicted_confidence, pr.win_hit, pr.place_hit,
           pr.bet_investment, pr.bet_return,
           p.bets_json, p.picks_json,
           r.date as race_date, r.name as race_name, r.grade,
           r.track_type, r.distance
    FROM prediction_results pr
    JOIN predictions p ON pr.prediction_id = p.id
    JOIN races r ON pr.race_id = r.id
    WHERE r.status = '結果確定'
    ORDER BY r.date ASC
  `);

  console.log(`対象レース数: ${rows.rows.length}\n`);
  if (rows.rows.length === 0) {
    console.log('データがありません');
    db.close();
    return;
  }

  // 2. 着順マップを一括取得
  const raceIds = [...new Set(rows.rows.map(r => r.race_id as string))];
  const entryResultMap = new Map<string, Map<number, number>>();
  const BATCH = 200;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const batch = raceIds.slice(i, i + BATCH);
    const ph = batch.map(() => '?').join(',');
    const entries = await db.execute({
      sql: `SELECT race_id, horse_number, result_position FROM race_entries
            WHERE race_id IN (${ph}) AND result_position IS NOT NULL`,
      args: batch,
    });
    for (const e of entries.rows) {
      const rid = e.race_id as string;
      if (!entryResultMap.has(rid)) entryResultMap.set(rid, new Map());
      entryResultMap.get(rid)!.set(e.horse_number as number, e.result_position as number);
    }
  }

  // 3. 信頼度帯の定義
  const confBands = [
    { label: '80-100 (高信頼)', min: 80, max: 100 },
    { label: '60-79  (中高)', min: 60, max: 79 },
    { label: '40-59  (中)', min: 40, max: 59 },
    { label: '15-39  (低)', min: 15, max: 39 },
    { label: '全体', min: 0, max: 100 },
  ];

  const betTypes = ['単勝', '複勝', '馬連', 'ワイド', '馬単', '三連複', '三連単'];

  // 4. クロス集計: confidence band × bet type
  const matrix: Record<string, Record<string, ConfBetBucket>> = {};
  // 信頼度帯別の基本統計（単勝ROI/複勝ROI）
  const confBasic: Record<string, { total: number; winHit: number; placeHit: number; winInvested: number; winReturned: number }> = {};

  for (const band of confBands) {
    matrix[band.label] = {};
    for (const bt of betTypes) {
      matrix[band.label][bt] = { total: 0, hits: 0, invested: 0, returned: 0, oddsSum: 0, oddsCount: 0 };
    }
    confBasic[band.label] = { total: 0, winHit: 0, placeHit: 0, winInvested: 0, winReturned: 0 };
  }

  for (const row of rows.rows) {
    const conf = (row.predicted_confidence as number) ?? 50;
    const raceId = row.race_id as string;

    // この行がどの信頼度帯に属するか
    const matchingBands = confBands.filter(b => conf >= b.min && conf <= b.max);

    // 基本統計
    for (const band of matchingBands) {
      confBasic[band.label].total++;
      if (row.win_hit) confBasic[band.label].winHit++;
      if (row.place_hit) confBasic[band.label].placeHit++;
      confBasic[band.label].winInvested += (row.bet_investment as number) || 100;
      confBasic[band.label].winReturned += (row.bet_return as number) || 0;
    }

    // bets_json をパースして馬券種別ごとの的中/ROI
    const betsJson = row.bets_json as string | null;
    if (!betsJson || betsJson === '[]') continue;

    let bets: { type: string; selections: number[]; odds?: number }[];
    try {
      bets = JSON.parse(betsJson);
    } catch { continue; }
    if (!Array.isArray(bets)) continue;

    const posMap = entryResultMap.get(raceId);
    if (!posMap) continue;

    const top3 = [...posMap.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3)
      .map(([num]) => num);

    for (const bet of bets) {
      const { type, selections, odds } = bet;
      if (!type || !Array.isArray(selections)) continue;
      if (!betTypes.includes(type)) continue;

      const isHit = isBetHit(type, selections, top3);

      for (const band of matchingBands) {
        const bucket = matrix[band.label][type];
        bucket.total++;
        bucket.invested += 100;
        if (odds && odds > 0) {
          bucket.oddsSum += odds;
          bucket.oddsCount++;
        }
        if (isHit) {
          bucket.hits++;
          bucket.returned += 100 * (odds || 0);
        }
      }
    }
  }

  // ==================== 結果表示 ====================

  // A. 信頼度帯別の基本的中率
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  A. 信頼度帯別 基本的中率（本命馬に単勝100円）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('  信頼度帯        | レース数 | 単勝的中 | 複勝的中 | 単勝ROI');
  console.log('  ----------------|----------|---------|---------|--------');

  for (const band of confBands) {
    const s = confBasic[band.label];
    if (s.total === 0) continue;
    const winRate = (s.winHit / s.total * 100).toFixed(1);
    const placeRate = (s.placeHit / s.total * 100).toFixed(1);
    const roi = s.winInvested > 0 ? (s.winReturned / s.winInvested * 100).toFixed(1) : '0.0';
    console.log(
      `  ${band.label.padEnd(16)}| ${String(s.total).padStart(6)}件 | ${winRate.padStart(6)}% | ${placeRate.padStart(6)}% | ${roi.padStart(6)}%`
    );
  }

  // B. 信頼度×馬券種別クロスROI
  console.log('\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  B. 信頼度 × 馬券種別 的中率マトリックス');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  for (const band of confBands) {
    const basic = confBasic[band.label];
    if (basic.total === 0) continue;

    console.log(`\n  ▼ ${band.label}（${basic.total}レース）`);
    console.log('  馬券種別 | 推奨数 | 的中数 | 的中率   | 投資額     | 回収額     | ROI      | 平均オッズ');
    console.log('  --------|--------|--------|---------|-----------|-----------|---------|----------');

    for (const bt of betTypes) {
      const b = matrix[band.label][bt];
      if (b.total === 0) continue;

      const hitRate = (b.hits / b.total * 100).toFixed(1);
      const roi = b.invested > 0 ? (b.returned / b.invested * 100).toFixed(1) : '0.0';
      const avgOdds = b.oddsCount > 0 ? (b.oddsSum / b.oddsCount).toFixed(1) : '-';

      const roiNum = parseFloat(roi);
      const roiStr = roiNum >= 100 ? `★${roi}%` : `  ${roi}%`;

      console.log(
        `  ${bt.padEnd(7)} | ${String(b.total).padStart(5)}件 | ${String(b.hits).padStart(5)}件 | ${hitRate.padStart(6)}% | ${String(b.invested.toLocaleString()).padStart(9)}円 | ${String(Math.round(b.returned).toLocaleString()).padStart(9)}円 | ${roiStr.padStart(8)} | ${String(avgOdds).padStart(8)}`
      );
    }
  }

  // C. ★プラス収支の組み合わせハイライト
  console.log('\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  C. ★ プラス収支（ROI > 100%）の組み合わせ');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  let foundPositive = false;
  for (const band of confBands) {
    for (const bt of betTypes) {
      const b = matrix[band.label][bt];
      if (b.total < 5) continue; // サンプル少なすぎは除外
      const roi = b.invested > 0 ? b.returned / b.invested * 100 : 0;
      if (roi >= 100) {
        foundPositive = true;
        const profit = Math.round(b.returned - b.invested);
        console.log(
          `  ★ ${band.label} × ${bt}: ROI ${roi.toFixed(1)}% (${b.hits}/${b.total}的中, 収支+${profit.toLocaleString()}円)`
        );
      }
    }
  }

  if (!foundPositive) {
    console.log('  （ROI 100%超えの組み合わせはありませんでした）');

    // ROI上位5件を代わりに表示
    console.log('\n  参考: ROI上位5件（5件以上推奨のある組み合わせ）');
    const candidates: { label: string; bt: string; roi: number; b: ConfBetBucket }[] = [];
    for (const band of confBands) {
      if (band.label === '全体') continue;
      for (const bt of betTypes) {
        const b = matrix[band.label][bt];
        if (b.total < 5) continue;
        const roi = b.invested > 0 ? b.returned / b.invested * 100 : 0;
        candidates.push({ label: band.label, bt, roi, b });
      }
    }
    candidates.sort((a, b) => b.roi - a.roi);
    for (const c of candidates.slice(0, 5)) {
      const profit = Math.round(c.b.returned - c.b.invested);
      const profitStr = profit >= 0 ? `+${profit.toLocaleString()}` : profit.toLocaleString();
      console.log(
        `  ${c.label} × ${c.bt}: ROI ${c.roi.toFixed(1)}% (${c.b.hits}/${c.b.total}的中, 収支${profitStr}円)`
      );
    }
  }

  // D. 戦略提案
  console.log('\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  D. 最適戦略提案');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // 信頼度80+の複勝は安定収益源か？
  const highConf = confBasic['80-100 (高信頼)'];
  if (highConf && highConf.total > 0) {
    const winRate = (highConf.winHit / highConf.total * 100).toFixed(1);
    const placeRate = (highConf.placeHit / highConf.total * 100).toFixed(1);
    const winRoi = highConf.winInvested > 0 ? (highConf.winReturned / highConf.winInvested * 100).toFixed(1) : '0.0';
    console.log(`  高信頼度（80+）のレース数: ${highConf.total}`);
    console.log(`    → 単勝的中率: ${winRate}%, 単勝ROI: ${winRoi}%`);
    console.log(`    → 複勝的中率: ${placeRate}%`);
  }

  // 各信頼度帯で最もROIが高い馬券種別
  for (const band of confBands) {
    if (band.label === '全体') continue;
    let bestBt = '';
    let bestRoi = 0;
    let bestBucket: ConfBetBucket | null = null;
    for (const bt of betTypes) {
      const b = matrix[band.label][bt];
      if (b.total < 5) continue;
      const roi = b.invested > 0 ? b.returned / b.invested * 100 : 0;
      if (roi > bestRoi) {
        bestRoi = roi;
        bestBt = bt;
        bestBucket = b;
      }
    }
    if (bestBt && bestBucket) {
      const hitRate = (bestBucket.hits / bestBucket.total * 100).toFixed(1);
      console.log(
        `  ${band.label}: 最適馬券 = ${bestBt} (ROI ${bestRoi.toFixed(1)}%, 的中率${hitRate}%, ${bestBucket.total}件)`
      );
    }
  }

  console.log('\n=========================================================');
  console.log('  分析完了');
  console.log('=========================================================');

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
