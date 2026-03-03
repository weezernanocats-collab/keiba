/**
 * 予想精度チェック（単勝率・複勝率）
 *
 * npx tsx -r tsconfig-paths/register scripts/check-accuracy.ts
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

interface PredRow {
  race_id: string;
  race_name: string;
  race_date: string;
  grade: string | null;
  picks_json: string;
  confidence: number;
}

interface EntryRow {
  race_id: string;
  horse_id: string;
  horse_number: number;
  result_position: number;
}

async function main() {
  await ensureInitialized();

  // 結果確定済み + 予想あり のレースを全取得
  const predictions = await dbAll<PredRow>(`
    SELECT p.race_id, r.name as race_name, r.date as race_date, r.grade,
           p.picks_json, p.confidence
    FROM predictions p
    JOIN races r ON r.id = p.race_id
    WHERE r.status = '結果確定'
      AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = r.id)
    ORDER BY r.date DESC
  `);

  console.log(`\n=== 予想精度分析 ===`);
  console.log(`対象レース数: ${predictions.length}`);

  if (predictions.length === 0) {
    console.log('評価対象のレースがありません');
    return;
  }

  // 全出走馬の結果を取得
  const allEntries = await dbAll<EntryRow>(`
    SELECT re.race_id, re.horse_id, re.horse_number, re.result_position
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE r.status = '結果確定'
      AND re.result_position IS NOT NULL
    ORDER BY re.race_id, re.result_position
  `);

  const entriesByRace = new Map<string, EntryRow[]>();
  for (const e of allEntries) {
    const arr = entriesByRace.get(e.race_id) || [];
    arr.push(e);
    entriesByRace.set(e.race_id, arr);
  }

  // 集計
  let totalRaces = 0;
  let winHits = 0;    // 本命（1位指名）が1着
  let placeHits = 0;  // 本命（1位指名）が3着以内
  let top3InTop3 = 0; // 上位3指名中、3着以内に入った馬の合計数
  let top3Possible = 0;

  // グレード別
  const gradeStats: Record<string, { total: number; win: number; place: number }> = {};

  // 最近のレース詳細
  const details: string[] = [];

  for (const pred of predictions) {
    const entries = entriesByRace.get(pred.race_id);
    if (!entries || entries.length === 0) continue;

    let picks: { horseId: string; horseNumber: number; horseName: string; rank: number }[];
    try {
      const raw = JSON.parse(pred.picks_json || '[]');
      picks = raw.map((p: Record<string, unknown>, i: number) => ({
        horseId: (p.horseId as string) || '',
        horseNumber: (p.horseNumber as number) || 0,
        horseName: (p.horseName as string) || '',
        rank: (p.rank as number) || i + 1,
      }));
    } catch {
      continue;
    }

    if (picks.length === 0) continue;

    totalRaces++;
    const topPick = picks[0];

    // 本命の実着順を探す
    const topResult = entries.find(
      e => e.horse_id === topPick.horseId || e.horse_number === topPick.horseNumber
    );
    const actualPos = topResult?.result_position ?? 99;

    const isWin = actualPos === 1;
    const isPlace = actualPos <= 3;

    if (isWin) winHits++;
    if (isPlace) placeHits++;

    // Top3指名のうち3着以内に入った数
    const top3Picks = picks.slice(0, 3);
    let hitCount = 0;
    for (const pick of top3Picks) {
      const result = entries.find(
        e => e.horse_id === pick.horseId || e.horse_number === pick.horseNumber
      );
      if (result && result.result_position <= 3) hitCount++;
    }
    top3InTop3 += hitCount;
    top3Possible += Math.min(3, top3Picks.length);

    // グレード別集計
    const grade = pred.grade || '一般';
    if (!gradeStats[grade]) gradeStats[grade] = { total: 0, win: 0, place: 0 };
    gradeStats[grade].total++;
    if (isWin) gradeStats[grade].win++;
    if (isPlace) gradeStats[grade].place++;

    // 最近20件のみ詳細表示
    if (details.length < 20) {
      const fieldSize = entries.length;
      const winnerEntry = entries.find(e => e.result_position === 1);
      details.push(
        `  ${pred.race_date} ${pred.race_name} (${fieldSize}頭) ` +
        `本命: ${topPick.horseName}(${topPick.horseNumber}番) → ${actualPos}着 ` +
        `${isWin ? '◎的中' : isPlace ? '○複勝' : '×'} ` +
        `[1着: ${winnerEntry?.horse_number ?? '?'}番]`
      );
    }
  }

  // 結果表示
  const winRate = totalRaces > 0 ? (winHits / totalRaces * 100).toFixed(1) : '0.0';
  const placeRate = totalRaces > 0 ? (placeHits / totalRaces * 100).toFixed(1) : '0.0';
  const top3Coverage = top3Possible > 0 ? (top3InTop3 / top3Possible * 100).toFixed(1) : '0.0';

  console.log(`\n--- 全体成績 ---`);
  console.log(`  評価レース数: ${totalRaces}`);
  console.log(`  単勝的中率: ${winRate}% (${winHits}/${totalRaces})`);
  console.log(`  複勝的中率: ${placeRate}% (${placeHits}/${totalRaces})`);
  console.log(`  Top3カバー率: ${top3Coverage}% (${top3InTop3}/${top3Possible})`);

  // ランダム基準との比較
  console.log(`\n--- ランダム基準比較 ---`);
  // 平均出走頭数を算出
  let totalFieldSize = 0;
  let fieldCount = 0;
  for (const [, entries] of entriesByRace) {
    totalFieldSize += entries.length;
    fieldCount++;
  }
  const avgField = fieldCount > 0 ? totalFieldSize / fieldCount : 12;
  const randomWin = (1 / avgField * 100).toFixed(1);
  const randomPlace = (3 / avgField * 100).toFixed(1);
  console.log(`  平均出走頭数: ${avgField.toFixed(1)}頭`);
  console.log(`  ランダム単勝率: ${randomWin}%`);
  console.log(`  ランダム複勝率: ${randomPlace}%`);
  console.log(`  単勝リフト: ${(parseFloat(winRate) / parseFloat(randomWin)).toFixed(2)}x`);
  console.log(`  複勝リフト: ${(parseFloat(placeRate) / parseFloat(randomPlace)).toFixed(2)}x`);

  // グレード別
  console.log(`\n--- グレード別成績 ---`);
  const gradeOrder = ['G1', 'G2', 'G3', 'リステッド', 'オープン', '3勝クラス', '2勝クラス', '1勝クラス', '未勝利', '新馬', '一般'];
  for (const g of gradeOrder) {
    const s = gradeStats[g];
    if (!s) continue;
    const gWin = (s.win / s.total * 100).toFixed(1);
    const gPlace = (s.place / s.total * 100).toFixed(1);
    console.log(`  ${g.padEnd(8)}: 単勝${gWin}% 複勝${gPlace}% (${s.total}R)`);
  }
  // gradeOrderにないグレードも表示
  for (const [g, s] of Object.entries(gradeStats)) {
    if (gradeOrder.includes(g)) continue;
    const gWin = (s.win / s.total * 100).toFixed(1);
    const gPlace = (s.place / s.total * 100).toFixed(1);
    console.log(`  ${g.padEnd(8)}: 単勝${gWin}% 複勝${gPlace}% (${s.total}R)`);
  }

  // 最近のレース詳細
  console.log(`\n--- 最近のレース (新→旧) ---`);
  for (const d of details) {
    console.log(d);
  }

  console.log(`\n[完了]`);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
