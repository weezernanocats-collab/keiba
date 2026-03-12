/**
 * ラップタイム修正 + pace_type再計算スクリプト
 *
 * 問題: スクレイパーが累積タイム + ハロンタイムの両方を取得していた
 * 修正: distance / 200 = 期待ラップ数として、配列の後半N個だけを正しいハロンタイムとして抽出
 *
 * npx tsx scripts/recalc-pace-types.ts
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

/**
 * 生のスクレイプデータから正しいハロンタイムだけを抽出
 * 累積タイムが混在 → 後半N個（N = distance/200）を取る
 * 値の範囲チェック: 9.0-15.0秒のもののみ
 */
function extractActualLapTimes(rawLaps: number[], distance: number): number[] {
  const expectedCount = Math.round(distance / 200);

  // まず9.0-15.0の範囲のみフィルタ（累積タイムは20+なので除外される）
  // ただし、分をまたぐ累積(e.g. 9.7 = 1:09.7)は通過する可能性あり
  const filtered = rawLaps.filter(v => v >= 9.0 && v <= 15.0);

  if (filtered.length === expectedCount) {
    return filtered;
  }

  // フィルタ結果が期待数より多い場合、後半N個を取る
  if (filtered.length > expectedCount) {
    return filtered.slice(-expectedCount);
  }

  // フィルタ結果が期待数より少ない場合、rawの後半N個を使う
  if (rawLaps.length >= expectedCount) {
    const candidate = rawLaps.slice(-expectedCount);
    // 妥当性チェック: 全て9-16の範囲内ならOK
    if (candidate.every(v => v >= 9.0 && v <= 16.0)) {
      return candidate;
    }
  }

  // どれも合わない場合はフィルタ結果をそのまま返す
  return filtered.length >= 3 ? filtered : [];
}

function classifyPaceType(lapTimes: number[]): string {
  // 最初の1ラップはスタート加速区間のため除外
  const laps = lapTimes.length > 4 ? lapTimes.slice(1) : lapTimes;
  if (laps.length < 4) return 'ミドル';
  const halfIdx = Math.floor(laps.length / 2);
  const firstHalf = laps.slice(0, halfIdx);
  const secondHalf = laps.slice(halfIdx);
  const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
  const diff = secondAvg - firstAvg;
  if (diff > 0.3) return 'ハイ';
  if (diff < -0.3) return 'スロー';
  return 'ミドル';
}

async function main() {
  console.log('=== ラップタイム修正 + Pace Type 再計算 ===\n');

  const result = await db.execute(
    "SELECT id, distance, lap_times_json FROM races WHERE lap_times_json IS NOT NULL AND lap_times_json != '[]'"
  );

  const counts: Record<string, number> = { 'ハイ': 0, 'ミドル': 0, 'スロー': 0 };
  const updates: { sql: string; args: (string | number | null)[] }[] = [];
  let fixed = 0;
  let removed = 0;

  for (const row of result.rows) {
    const raceId = row.id as string;
    const distance = row.distance as number;
    const rawLaps: number[] = JSON.parse(row.lap_times_json as string);

    if (!distance || distance < 800) continue;

    const actualLaps = extractActualLapTimes(rawLaps, distance);

    if (actualLaps.length < 3) {
      // 有効なラップが取れなかった
      removed++;
      updates.push({
        sql: 'UPDATE races SET lap_times_json = NULL, pace_type = NULL WHERE id = ?',
        args: [raceId],
      });
      continue;
    }

    const paceType = classifyPaceType(actualLaps);
    counts[paceType]++;

    // ラップデータが変わった場合のみ更新
    if (JSON.stringify(actualLaps) !== JSON.stringify(rawLaps)) {
      fixed++;
    }

    updates.push({
      sql: 'UPDATE races SET lap_times_json = ?, pace_type = ? WHERE id = ?',
      args: [JSON.stringify(actualLaps), paceType, raceId],
    });
  }

  console.log(`対象レース: ${result.rows.length}件`);
  console.log(`ラップ修正: ${fixed}件`);
  console.log(`除去（データ不良）: ${removed}件`);
  console.log(`ペース分布: ハイ=${counts['ハイ']}, ミドル=${counts['ミドル']}, スロー=${counts['スロー']}`);

  // サンプル表示
  let shown = 0;
  for (const row of result.rows) {
    if (shown >= 3) break;
    const distance = row.distance as number;
    const rawLaps: number[] = JSON.parse(row.lap_times_json as string);
    const actual = extractActualLapTimes(rawLaps, distance);
    if (actual.length > 0 && actual.length !== rawLaps.length) {
      console.log(`\n  ${row.id} (${distance}m): ${rawLaps.length}→${actual.length} laps`);
      console.log(`    Before: ${JSON.stringify(rawLaps.slice(0, 6))}...`);
      console.log(`    After:  ${JSON.stringify(actual)}`);
      console.log(`    Pace: ${classifyPaceType(actual)}`);
      shown++;
    }
  }

  // バッチ更新
  console.log('\n更新中...');
  const BATCH = 50;
  for (let i = 0; i < updates.length; i += BATCH) {
    await db.batch(updates.slice(i, i + BATCH));
  }

  console.log(`更新完了: ${updates.length}件`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
