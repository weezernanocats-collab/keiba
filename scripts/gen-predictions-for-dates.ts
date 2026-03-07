/**
 * 指定日付のレースの予想を生成する（高速版）
 * Usage: npx tsx -r tsconfig-paths/register scripts/gen-predictions-for-dates.ts 2026-03-07 2026-03-08
 *
 * --no-gemini  Gemini API をスキップして高速化（統計エンジンのみ）
 * --concurrency N  同時処理レース数（デフォルト: 3）
 */
import { readFileSync } from 'fs';

// .env.local 読み込み
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

// --no-gemini フラグ
if (process.argv.includes('--no-gemini')) {
  delete process.env.GEMINI_API_KEY;
}

// --afternoon フラグ（午前の傾向をサマリに含める + 未実施レースのみ対象）
const IS_AFTERNOON = process.argv.includes('--afternoon');

// --concurrency N
const concurrencyIdx = process.argv.indexOf('--concurrency');
const CONCURRENCY = concurrencyIdx >= 0 ? parseInt(process.argv[concurrencyIdx + 1]) || 3 : 3;

import { dbAll } from '@/lib/database';
import { getRaceById, getHorseById, getHorsePastPerformances, getJockeyStats, getTrainerStats, getSireTrackWinRate, getJockeyDistanceWinRate, getJockeyCourseWinRate, savePrediction } from '@/lib/queries';
import { generatePrediction } from '@/lib/prediction-engine';
import { ensureCalibrationLoaded } from '@/lib/accuracy-tracker';
import { closeDatabase } from '@/lib/database';
import type { RaceEntry, TrackType, TrackCondition } from '@/types';

async function processRace(race: {
  id: string; name: string; date: string; track_type: string; distance: number;
  track_condition: string; racecourse_name: string; grade: string; weather: string;
}): Promise<boolean> {
  const raceData = await getRaceById(race.id);
  if (!raceData?.entries?.length || raceData.entries.length < 2) {
    process.stdout.write(`  SKIP ${race.name}: エントリー不足 (${raceData?.entries?.length || 0}頭)\n`);
    return false;
  }

  // 全馬のデータを並列取得
  const horseInputs = await Promise.all(
    (raceData.entries as RaceEntry[]).map(async (re) => {
      const [pastPerfs, horseData, jockeyStats, trainerStats] = await Promise.all([
        getHorsePastPerformances(re.horseId, 100),
        getHorseById(re.horseId) as Promise<{ father_name?: string } | null>,
        getJockeyStats(re.jockeyId),
        getTrainerStats(re.trainerName),
      ]);
      const fatherName = horseData?.father_name || '';
      const [sireTrackWR, jockeyDistWR, jockeyCourseWR] = await Promise.all([
        getSireTrackWinRate(fatherName, race.track_type),
        getJockeyDistanceWinRate(re.jockeyId, race.distance),
        getJockeyCourseWinRate(re.jockeyId, race.racecourse_name),
      ]);
      return {
        entry: re,
        pastPerformances: pastPerfs,
        jockeyWinRate: jockeyStats.winRate,
        jockeyPlaceRate: jockeyStats.placeRate,
        fatherName,
        trainerWinRate: trainerStats.winRate,
        trainerPlaceRate: trainerStats.placeRate,
        sireTrackWinRate: sireTrackWR,
        jockeyDistanceWinRate: jockeyDistWR,
        jockeyCourseWinRate: jockeyCourseWR,
      };
    })
  );

  const prediction = await generatePrediction(
    race.id, race.name, race.date,
    race.track_type as TrackType, race.distance,
    race.track_condition as TrackCondition | undefined,
    race.racecourse_name, race.grade, horseInputs,
    race.weather as '晴' | '曇' | '小雨' | '雨' | '小雪' | '雪' | undefined,
    IS_AFTERNOON ? { isAfternoon: true } : undefined,
  );
  await savePrediction(prediction);
  return true;
}

async function main() {
  const dates = process.argv.slice(2).filter(d => d.match(/^\d{4}-\d{2}-\d{2}$/));
  if (dates.length === 0) {
    process.stderr.write('Usage: npx tsx -r tsconfig-paths/register scripts/gen-predictions-for-dates.ts 2026-03-07\n');
    process.exit(1);
  }

  const startTime = Date.now();
  const geminiEnabled = !!process.env.GEMINI_API_KEY;
  process.stdout.write(`設定: concurrency=${CONCURRENCY}, gemini=${geminiEnabled ? 'ON' : 'OFF'}\n`);

  await ensureCalibrationLoaded();

  for (const date of dates) {
    process.stdout.write(`\n=== ${date} の予想生成${IS_AFTERNOON ? '（午後更新）' : ''} ===\n`);

    // 対象レースを取得（--afternoon時は未実施レースのみ）
    const statusFilter = IS_AFTERNOON
      ? "status = '出走確定'"
      : "status IN ('出走確定', '予定')";
    const races = await dbAll<{
      id: string; name: string; track_type: string; distance: number;
      track_condition: string; racecourse_name: string; grade: string; weather: string;
    }>(
      `SELECT id, name, track_type, distance, track_condition, racecourse_name, grade, weather FROM races WHERE date = ? AND ${statusFilter} ORDER BY id`,
      [date]
    );

    // 対象レースの既存予想を削除
    if (races.length > 0) {
      const { dbRun } = await import('@/lib/database');
      const ids = races.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      await dbRun(`DELETE FROM predictions WHERE race_id IN (${placeholders})`, ids);
      process.stdout.write(`  既存予想削除: ${ids.length}件\n`);
    }

    process.stdout.write(`  対象レース: ${races.length}件\n`);
    let count = 0;

    // レースを CONCURRENCY 並列で処理
    const raceItems = races.map(r => ({ ...r, date }));
    for (let i = 0; i < raceItems.length; i += CONCURRENCY) {
      const batch = raceItems.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (race) => {
          const ok = await processRace(race);
          if (ok) {
            count++;
            process.stdout.write(`  ${race.racecourse_name} ${race.name}: 完了 (${count}/${races.length})\n`);
          }
        })
      );
      for (const r of results) {
        if (r.status === 'rejected') {
          process.stderr.write(`  ERROR: ${r.reason}\n`);
        }
      }
    }
    process.stdout.write(`  ${date}: ${count}/${races.length}件 予想生成完了\n`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\n合計時間: ${elapsed}秒\n`);
  await closeDatabase();
}

main().catch(e => { process.stderr.write(String(e) + '\n'); process.exit(1); });
