/**
 * 明日の予想再生成スクリプト
 * 新エンジン (競馬場補正 + XGBoostログ強化) で予想を更新する
 *
 * 使い方: npx tsx -r tsconfig-paths/register scripts/regen-tomorrow.ts
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

// Gemini無効化（タイムアウト回避）
delete process.env.GEMINI_API_KEY;

import { ensureInitialized, dbAll, dbRun } from '../src/lib/database';
import { generatePrediction } from '../src/lib/prediction-engine';
import {
  savePrediction,
  getRaceById,
  getHorseById,
  getHorsePastPerformances,
  getJockeyStats,
  getTrainerStats,
  getSireTrackWinRate,
  getJockeyDistanceWinRate,
  getJockeyCourseWinRate,
} from '../src/lib/queries';
import { ensureCalibrationLoaded } from '../src/lib/accuracy-tracker';
import type { RaceEntry, TrackType, TrackCondition } from '../src/types';

async function main() {
  await ensureInitialized();
  await ensureCalibrationLoaded();

  // 明日の日付
  const now = new Date();
  const jstOffset = 9 * 60 * 60_000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const tomorrow = new Date(jstNow.getTime() + 86400000);
  const date = tomorrow.toISOString().split('T')[0];
  console.log('対象日:', date);

  // 明日のレース取得
  const races = await dbAll<{
    id: string; name: string; track_type: string; distance: number;
    track_condition: string; racecourse_name: string; grade: string; weather: string; status: string;
  }>(
    "SELECT id, name, track_type, distance, track_condition, racecourse_name, grade, weather, status FROM races WHERE date = ? ORDER BY id",
    [date],
  );

  console.log(`レース数: ${races.length}`);
  if (races.length === 0) {
    console.log('対象レースなし。終了。');
    process.exit(0);
  }

  // 既存予想を削除
  const raceIds = races.map(r => r.id);
  const ph = raceIds.map(() => '?').join(',');
  const delResult = await dbRun(`DELETE FROM predictions WHERE race_id IN (${ph})`, raceIds);
  console.log(`既存予想削除: ${delResult.rowsAffected}件`);

  let count = 0;
  let errors = 0;
  let mlActiveCount = 0;

  for (const race of races) {
    try {
      const raceData = await getRaceById(race.id);
      if (!raceData?.entries?.length) {
        errors++;
        continue;
      }

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
        }),
      );

      const prediction = await generatePrediction(
        race.id,
        race.name,
        date,
        race.track_type as TrackType,
        race.distance,
        race.track_condition as TrackCondition | undefined,
        race.racecourse_name,
        race.grade,
        horseInputs,
        race.weather as '晴' | '曇' | '小雨' | '雨' | '小雪' | '雪' | undefined,
      );

      await savePrediction(prediction);
      count++;

      // ML推論の確認
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const analysis = prediction.analysis as any;
      const firstHorse = prediction.topPicks[0];
      const mlCheck = analysis?.horseScores?.[firstHorse?.horseNumber]?.mlWinProb;
      if (mlCheck !== undefined) mlActiveCount++;

      console.log(
        `[${count}/${races.length}] ${race.name} (${race.racecourse_name}) → ` +
        `信頼度:${prediction.confidence}% 本命:${firstHorse?.horseName || '?'}(${firstHorse?.score || 0}pt) ` +
        `ML:${mlCheck !== undefined ? mlCheck.toFixed(4) : 'なし'}`,
      );
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`エラー (${race.name}): ${msg}`);
    }
  }

  console.log(`\n=== 完了 ===`);
  console.log(`生成: ${count}/${races.length}レース (エラー: ${errors})`);
  console.log(`ML推論有効: ${mlActiveCount}/${count}レース`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
