/**
 * 当日レースの再スクレイピング + 予想再生成
 * npx tsx -r tsconfig-paths/register scripts/rescrape-today.ts
 */
import { readFileSync } from 'fs';

const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

import { ensureInitialized } from '../src/lib/database';
import { dbAll, dbRun } from '../src/lib/database';
import {
  scrapeRaceList,
  scrapeRaceCard,
  scrapeHorseDetail,
} from '../src/lib/scraper';
import {
  upsertRace,
  upsertRaceEntry,
  upsertHorse,
  insertPastPerformance,
  getRaceById,
  savePrediction,
} from '../src/lib/queries';
import { buildAndPredict } from '../src/lib/prediction-builder';
import { ensureCalibrationLoaded } from '../src/lib/accuracy-tracker';
import type { RaceEntry, Race, PastPerformance } from '../src/types';

const RATE_LIMIT_MS = 1200;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await ensureInitialized();

  const jstNow = new Date(Date.now() + 9 * 60 * 60_000);
  const today = jstNow.toISOString().split('T')[0];
  console.log(`再スクレイピング開始: ${today}`);

  // 1. レース一覧
  const races = await scrapeRaceList(today);
  console.log(`レース一覧: ${races.length}件`);

  for (const race of races) {
    await upsertRace({
      id: race.id, name: race.name, date: race.date,
      racecourseName: race.racecourseName, raceNumber: race.raceNumber,
      status: '予定',
    });
  }

  // 2. 出馬表の再スクレイピング
  let totalEntries = 0;
  const raceDetails: Awaited<ReturnType<typeof scrapeRaceCard>>[] = [];

  for (const race of races) {
    try {
      const detail = await scrapeRaceCard(race.id);
      raceDetails.push(detail);
      totalEntries += detail.entries.length;

      await upsertRace({
        id: detail.id, name: detail.name, racecourseName: detail.racecourseName,
        racecourseId: detail.racecourseId, trackType: detail.trackType,
        distance: detail.distance, trackCondition: detail.trackCondition,
        weather: detail.weather, time: detail.time,
        grade: detail.grade as Race['grade'],
        status: '出走確定',
      });

      // 既存エントリを削除して再挿入
      await dbRun('DELETE FROM race_entries WHERE race_id = ? AND result_position IS NULL', [race.id]);

      for (const e of detail.entries) {
        await upsertRaceEntry(race.id, {
          postPosition: e.postPosition, horseNumber: e.horseNumber,
          horseId: e.horseId, horseName: e.horseName,
          age: e.age, sex: e.sex, jockeyId: e.jockeyId,
          jockeyName: e.jockeyName, trainerName: e.trainerName,
          handicapWeight: e.handicapWeight,
        });
      }

      console.log(`  ${race.id} ${detail.name}: ${detail.entries.length}頭`);
    } catch (error) {
      console.error(`  ${race.id} 出馬表取得失敗:`, error instanceof Error ? error.message : error);
    }
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`出馬表: ${raceDetails.length}レース, ${totalEntries}頭`);

  // 3. 馬詳細
  const horseIds = new Set<string>();
  for (const d of raceDetails) {
    for (const e of d.entries) horseIds.add(e.horseId);
  }

  // 既存戦績キー一括取得
  const allHorseIds = [...horseIds];
  const existingKeysMap = new Map<string, Set<string>>();
  if (allHorseIds.length > 0) {
    const placeholders = allHorseIds.map(() => '?').join(',');
    const existingRows = await dbAll<{ horse_id: string; date: string; race_name: string }>(
      `SELECT horse_id, date, race_name FROM past_performances WHERE horse_id IN (${placeholders})`,
      allHorseIds,
    );
    for (const row of existingRows) {
      const key = `${row.date}_${row.race_name}`;
      if (!existingKeysMap.has(row.horse_id)) existingKeysMap.set(row.horse_id, new Set());
      existingKeysMap.get(row.horse_id)!.add(key);
    }
  }

  let horseCount = 0;
  let newPerfCount = 0;
  for (const hid of horseIds) {
    try {
      const horse = await scrapeHorseDetail(hid);
      if (horse) {
        horseCount++;
        await upsertHorse({
          id: horse.id, name: horse.name, birthDate: horse.birthDate,
          fatherName: horse.fatherName, motherName: horse.motherName,
          trainerName: horse.trainerName, ownerName: horse.ownerName,
        });
        const existingKeys = existingKeysMap.get(horse.id) || new Set<string>();
        for (const perf of horse.pastPerformances.slice(0, 50)) {
          const key = `${perf.date}_${perf.raceName}`;
          if (existingKeys.has(key)) continue;
          newPerfCount++;
          await insertPastPerformance(horse.id, perf as PastPerformance);
        }
      }
    } catch (error) {
      console.error(`  馬 ${hid} 取得失敗:`, error instanceof Error ? error.message : error);
    }
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`馬詳細: ${horseCount}/${horseIds.size}頭, 新規戦績${newPerfCount}件`);

  // 4. 予想生成
  await ensureCalibrationLoaded();
  let predictionCount = 0;
  for (const detail of raceDetails) {
    try {
      const raceData = await getRaceById(detail.id);
      if (!raceData?.entries?.length || raceData.entries.length < 2) continue;
      const prediction = await buildAndPredict(
        detail.id, detail.name, today, detail.trackType, detail.distance,
        detail.trackCondition, detail.racecourseName, detail.grade,
        raceData.entries as RaceEntry[],
        detail.weather, { includeTrainerStats: true },
      );
      await savePrediction(prediction);
      predictionCount++;
    } catch (error) {
      console.error(`  予想失敗 ${detail.id}:`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`予想生成: ${predictionCount}/${raceDetails.length}レース`);
  console.log('完了!');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
