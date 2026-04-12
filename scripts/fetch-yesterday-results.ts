/**
 * 昨日のレース結果を取得し、予想を生成して評価する
 */
import { readFileSync, existsSync } from 'fs';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

import { ensureInitialized, dbAll } from '../src/lib/database';
import { scrapeRaceResultWithLaps } from '../src/lib/scraper';
import {
  upsertRace,
  upsertRaceEntry,
  upsertOdds,
  upsertRaceEntryOdds,
  upsertRaceLapTimes,
  classifyPaceType,
} from '../src/lib/queries';
import { evaluateAllPendingRaces } from '../src/lib/accuracy-tracker';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --results-only: 結果取得のみ (予想生成・照合をスキップ)。
// paddock-watcher 等の日中呼び出し用。発走済みレースのみ対象にする。
const resultsOnly = process.argv.includes('--results-only');

async function main() {
  await ensureInitialized();

  // JST で昨日の日付を動的に計算
  const now = new Date();
  const jstOffset = 9 * 60 * 60_000;
  const jstYesterday = new Date(now.getTime() + jstOffset - 86400000).toISOString().split('T')[0];
  const yesterday = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || jstYesterday;

  // --results-only 時: 発走済みレースのみ対象 (発走時刻 + 20分 < 現在JST)
  let races: { id: string; name: string }[];
  if (resultsOnly) {
    const jstNow = new Date(now.getTime() + jstOffset);
    const cutoffHHMM = `${String(jstNow.getHours()).padStart(2, '0')}:${String(jstNow.getMinutes()).padStart(2, '0')}`;
    // 発走時刻 + 20分 のバッファを考慮して、20分前の cutoff を使う
    const cutoffMin = jstNow.getHours() * 60 + jstNow.getMinutes() - 20;
    const cutoffH = String(Math.floor(cutoffMin / 60)).padStart(2, '0');
    const cutoffM = String(cutoffMin % 60).padStart(2, '0');
    const cutoff = `${cutoffH}:${cutoffM}`;
    races = await dbAll<{ id: string; name: string }>(
      "SELECT id, name FROM races WHERE date = ? AND status != '結果確定' AND time IS NOT NULL AND time <= ?",
      [yesterday, cutoff]
    );
    console.log(`[results-only] ${yesterday} 発走済み未確定: ${races.length}件 (cutoff ${cutoff})`);
  } else {
    races = await dbAll<{ id: string; name: string }>(
      "SELECT id, name FROM races WHERE date = ? AND status != '結果確定'",
      [yesterday]
    );
    console.log(`[1/3] ${yesterday}の未確定レース: ${races.length}件`);
  }

  let resultCount = 0;
  for (const race of races) {
    try {
      const { results, lapTimes } = await scrapeRaceResultWithLaps(race.id);
      for (const r of results) {
        await upsertRaceEntry(race.id, {
          horseNumber: r.horseNumber,
          horseName: r.horseName,
          result: {
            position: r.position,
            time: r.time,
            margin: r.margin,
            lastThreeFurlongs: r.lastThreeFurlongs,
            cornerPositions: r.cornerPositions,
          },
        });
        if (r.odds > 0) {
          await upsertOdds(race.id, '単勝', [r.horseNumber], r.odds);
          await upsertRaceEntryOdds(race.id, r.horseNumber, r.odds, r.popularity);
        }
      }
      if (lapTimes.length > 0) {
        const paceType = classifyPaceType(lapTimes);
        await upsertRaceLapTimes(race.id, lapTimes, paceType);
      }
      if (results.length > 0) {
        await upsertRace({ id: race.id, status: '結果確定' });
        resultCount++;
        process.stdout.write('.');
      }
      await sleep(500);
    } catch (e) {
      console.error(`\n結果取得失敗 (${race.id}):`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`\n結果確定: ${resultCount}/${races.length}件`);

  if (resultsOnly) {
    console.log('--results-only: 予想生成・照合をスキップ');
    return;
  }

  // 予想生成（昨日分）
  console.log('\n[2/3] 昨日の予想を生成中...');
  const { execSync } = await import('child_process');
  try {
    const out = execSync(
      `npx tsx -r tsconfig-paths/register scripts/gen-predictions-optimized.ts --date ${yesterday}`,
      { encoding: 'utf-8', timeout: 300000 }
    );
    const lastLines = out.split('\n').slice(-5).join('\n');
    console.log(lastLines);
  } catch (e) {
    console.error('予想生成失敗:', e instanceof Error ? e.message : e);
  }

  // 評価
  console.log('\n[3/3] 予想照合中...');
  const evalResults = await evaluateAllPendingRaces();
  if (evalResults.length > 0) {
    const wins = evalResults.filter(r => r.winHit).length;
    const places = evalResults.filter(r => r.placeHit).length;
    console.log(`照合完了: ${evalResults.length}件 (単勝${wins}的中, 複勝${places}的中)`);
  } else {
    console.log('照合対象なし');
  }
}

main().catch(e => console.error(e));
