/**
 * 1番人気（市場ベースライン）の的中率を計測
 *
 * npx tsx -r tsconfig-paths/register scripts/market-baseline.ts
 */
import { readFileSync } from 'fs';

// Load .env.local
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

import { ensureInitialized, dbAll } from '../src/lib/database';

interface FavoriteRow {
  race_id: string;
  race_date: string;
  race_name: string;
  grade: string | null;
  horse_number: number;
  result_position: number;
  odds: number | null;
  field_size: number;
}

async function main() {
  await ensureInitialized();

  // 結果確定済み + 予想ありのレース（check-accuracyと同じスコープ）で1番人気の成績を取得
  const rows = await dbAll<FavoriteRow>(`
    SELECT
      re.race_id,
      r.date as race_date,
      r.name as race_name,
      r.grade,
      re.horse_number,
      re.result_position,
      re.odds,
      (SELECT COUNT(*) FROM race_entries re2 WHERE re2.race_id = r.id AND re2.result_position IS NOT NULL) as field_size
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE re.popularity = 1
      AND re.result_position IS NOT NULL
      AND r.status = '結果確定'
      AND EXISTS (SELECT 1 FROM predictions p WHERE p.race_id = r.id)
    ORDER BY r.date DESC
  `);

  console.log(`\n=== 1番人気（市場ベースライン）分析 ===`);
  console.log(`対象レース数: ${rows.length}`);

  if (rows.length === 0) {
    console.log('対象レースがありません');
    return;
  }

  let winCount = 0;
  let placeCount = 0;  // 3着以内
  let totalOdds = 0;
  let oddsCount = 0;

  // グレード別
  const gradeStats: Record<string, { total: number; win: number; place: number }> = {};

  for (const row of rows) {
    const isWin = row.result_position === 1;
    const isPlace = row.result_position <= 3;

    if (isWin) winCount++;
    if (isPlace) placeCount++;

    if (row.odds != null) {
      totalOdds += row.odds;
      oddsCount++;
    }

    const grade = row.grade || '一般';
    if (!gradeStats[grade]) gradeStats[grade] = { total: 0, win: 0, place: 0 };
    gradeStats[grade].total++;
    if (isWin) gradeStats[grade].win++;
    if (isPlace) gradeStats[grade].place++;
  }

  const winRate = (winCount / rows.length * 100).toFixed(1);
  const placeRate = (placeCount / rows.length * 100).toFixed(1);
  const avgOdds = oddsCount > 0 ? (totalOdds / oddsCount).toFixed(1) : 'N/A';

  // 単勝ROI = (1番人気が勝った時のオッズの合計) / 総レース数
  let winPayoffSum = 0;
  for (const row of rows) {
    if (row.result_position === 1 && row.odds != null) {
      winPayoffSum += row.odds;  // odds = 払戻倍率
    }
  }
  const winROI = (winPayoffSum / rows.length * 100).toFixed(1);

  console.log(`\n--- 全体成績 ---`);
  console.log(`  レース数: ${rows.length}`);
  console.log(`  単勝的中率: ${winRate}% (${winCount}/${rows.length})`);
  console.log(`  複勝的中率（3着以内）: ${placeRate}% (${placeCount}/${rows.length})`);
  console.log(`  平均オッズ: ${avgOdds}`);
  console.log(`  単勝ROI: ${winROI}%`);

  // 平均出走頭数
  const avgField = rows.reduce((sum, r) => sum + r.field_size, 0) / rows.length;
  const randomWin = (1 / avgField * 100).toFixed(1);
  console.log(`\n--- ランダム基準比較 ---`);
  console.log(`  平均出走頭数: ${avgField.toFixed(1)}頭`);
  console.log(`  ランダム単勝率: ${randomWin}%`);
  console.log(`  1番人気リフト: ${(parseFloat(winRate) / parseFloat(randomWin)).toFixed(2)}x`);

  // グレード別
  console.log(`\n--- グレード別 1番人気成績 ---`);
  const gradeOrder = ['G1', 'G2', 'G3', 'リステッド', 'オープン', '3勝クラス', '2勝クラス', '1勝クラス', '未勝利', '新馬', '一般'];
  for (const g of gradeOrder) {
    const s = gradeStats[g];
    if (!s) continue;
    const gWin = (s.win / s.total * 100).toFixed(1);
    const gPlace = (s.place / s.total * 100).toFixed(1);
    console.log(`  ${g.padEnd(8)}: 単勝${gWin}% 複勝${gPlace}% (${s.total}R)`);
  }
  for (const [g, s] of Object.entries(gradeStats)) {
    if (gradeOrder.includes(g)) continue;
    const gWin = (s.win / s.total * 100).toFixed(1);
    const gPlace = (s.place / s.total * 100).toFixed(1);
    console.log(`  ${g.padEnd(8)}: 単勝${gWin}% 複勝${gPlace}% (${s.total}R)`);
  }

  // 着順分布
  const positionDist: Record<number, number> = {};
  for (const row of rows) {
    const pos = Math.min(row.result_position, 10); // 10以降はまとめる
    positionDist[pos] = (positionDist[pos] || 0) + 1;
  }
  console.log(`\n--- 1番人気の着順分布 ---`);
  for (let i = 1; i <= 10; i++) {
    const count = positionDist[i] || 0;
    const pct = (count / rows.length * 100).toFixed(1);
    const label = i === 10 ? '10+着' : `${i}着`;
    const bar = '█'.repeat(Math.round(count / rows.length * 50));
    console.log(`  ${label.padEnd(5)}: ${String(count).padStart(4)}回 (${pct.padStart(5)}%) ${bar}`);
  }

  console.log(`\n[完了]`);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
