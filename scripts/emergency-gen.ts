/**
 * 緊急予想生成: 指定日のレースだけを対象に軽量に予想生成
 * プリロードなし、1レースずつ逐次処理
 */
import { readFileSync } from 'fs';

const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

import { ensureInitialized, dbAll } from '../src/lib/database';
import { getRaceById, savePrediction } from '../src/lib/queries';
import { buildAndPredict } from '../src/lib/prediction-builder';
import { ensureCalibrationLoaded } from '../src/lib/accuracy-tracker';
import type { TrackType, TrackCondition, RaceEntry } from '../src/types';

const DATE = process.argv[2] || '2026-03-28';

async function main() {
  console.log(`緊急予想生成: ${DATE}`);
  await ensureInitialized();
  console.log('DB接続OK');

  await ensureCalibrationLoaded();
  console.log('キャリブレーション読み込みOK');

  const races = await dbAll<{
    id: string; name: string; track_type: string; distance: number;
    track_condition: string; racecourse_name: string; grade: string; weather: string;
    race_number: number;
  }>(
    `SELECT r.id, r.name, r.track_type, r.distance, r.track_condition,
            r.racecourse_name, r.grade, r.weather, r.race_number
     FROM races r
     WHERE r.date = ?
       AND r.status IN ('出走確定', '結果確定')
       AND (SELECT COUNT(*) FROM race_entries re WHERE re.race_id = r.id) >= 2
     ORDER BY r.racecourse_name, r.race_number`,
    [DATE]
  );

  console.log(`対象レース: ${races.length}件`);

  if (races.length === 0) {
    console.log('対象レースなし。終了。');
    return;
  }

  let generated = 0;
  let errors = 0;

  for (const race of races) {
    try {
      const raceData = await getRaceById(race.id);
      if (!raceData?.entries?.length || raceData.entries.length < 2) {
        console.log(`  SKIP ${race.racecourse_name} ${race.race_number}R ${race.name} (出走馬不足)`);
        continue;
      }

      console.log(`  生成中: ${race.racecourse_name} ${race.race_number}R ${race.name} (${raceData.entries.length}頭)...`);

      const prediction = await buildAndPredict(
        race.id, race.name, DATE,
        race.track_type as TrackType, race.distance,
        race.track_condition as TrackCondition | undefined,
        race.racecourse_name, race.grade,
        raceData.entries as RaceEntry[],
        race.weather as string | undefined,
        { includeTrainerStats: true },
      );
      await savePrediction(prediction);
      generated++;
      console.log(`  OK: 信頼度=${prediction.confidence}%`);
    } catch (error) {
      errors++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ERROR: ${race.id} - ${msg}`);
    }
  }

  console.log(`\n完了: ${generated}/${races.length}件生成, ${errors}件エラー`);
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
