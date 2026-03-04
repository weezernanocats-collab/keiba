/**
 * ML学習用データをローカルエクスポート
 *
 * Tursoから直接データを読み、predictions.analysis_json内のhorseScoresから
 * 特徴量ベクトルを構築してJSONファイルに出力する。
 *
 * npx tsx -r tsconfig-paths/register scripts/export-training-data.ts
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import { createClient, type InValue } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

// 特徴量名の順序定義（ml-client.ts の buildMLFeatures と一致）
const FEATURE_NAMES = [
  // 18ファクタースコア (v4.2)
  'recentForm', 'courseAptitude', 'distanceAptitude', 'trackConditionAptitude',
  'jockeyAbility', 'speedRating', 'classPerformance', 'runningStyle',
  'postPositionBias', 'rotation', 'lastThreeFurlongs', 'consistency',
  'sireAptitude', 'trainerAbility', 'jockeyTrainerCombo', 'historicalPostBias',
  'seasonalPattern', 'handicapAdvantage',
  // コンテキスト特徴量
  'fieldSize', 'odds', 'popularity', 'age', 'sex_encoded',
  'handicapWeight', 'postPosition', 'grade_encoded', 'trackType_encoded',
  'distance', 'trackCondition_encoded', 'oddsLogTransform', 'popularityRatio',
  // v4.2 新特徴量
  'weather_encoded', 'weightChange',
  'trainerWinRate', 'trainerPlaceRate',
  'sireTrackWinRate', 'jockeyDistanceWinRate', 'jockeyCourseWinRate',
];

const SEX_ENCODE: Record<string, number> = { '牡': 0, '牝': 1, 'セ': 2 };
const TRACK_TYPE_ENCODE: Record<string, number> = { '芝': 0, 'ダート': 1, '障害': 2 };
const TRACK_CONDITION_ENCODE: Record<string, number> = { '良': 0, '稍重': 1, '重': 2, '不良': 3 };
const WEATHER_ENCODE: Record<string, number> = { '晴': 0, '曇': 1, '小雨': 2, '雨': 3, '小雪': 4, '雪': 5 };
const GRADE_ENCODE: Record<string, number> = {
  '新馬': 0, '未勝利': 1, '1勝クラス': 2, '2勝クラス': 3,
  '3勝クラス': 4, 'リステッド': 5, 'オープン': 5,
  'G3': 6, 'G2': 7, 'G1': 8,
};

interface PredRow {
  race_id: string;
  analysis_json: string;
  grade: string | null;
  track_type: string;
  distance: number;
  track_condition: string | null;
  weather: string | null;
  racecourse_name: string;
}

interface EntryRow {
  race_id: string;
  horse_number: number;
  post_position: number;
  age: number;
  sex: string;
  handicap_weight: number;
  result_position: number;
  odds: number | null;
  popularity: number | null;
  result_weight_change: number | null;
  trainer_name: string | null;
  jockey_id: string | null;
  horse_id: string | null;
}

async function main() {
  console.log('=== ML学習データエクスポート ===\n');

  // 1. 予測データ取得
  const predResult = await db.execute(`
    SELECT p.race_id, p.analysis_json,
           r.grade, r.track_type, r.distance, r.track_condition, r.weather, r.racecourse_name
    FROM predictions p
    JOIN races r ON r.id = p.race_id
    WHERE r.status = '結果確定'
      AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = r.id)
  `);
  console.log(`予測データ: ${predResult.rows.length}件`);

  // 2. 出走馬データ取得
  const entryResult = await db.execute(`
    SELECT re.race_id, re.horse_number, re.post_position, re.age, re.sex,
           re.handicap_weight, re.result_position, re.odds, re.popularity,
           re.result_weight_change, re.trainer_name, re.jockey_id, re.horse_id
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE r.status = '結果確定'
      AND re.result_position IS NOT NULL
  `);
  console.log(`出走データ: ${entryResult.rows.length}件`);

  // 3. 馬の父名マップ
  const horseResult = await db.execute(
    `SELECT id, father_name FROM horses WHERE father_name IS NOT NULL`
  );
  const horseFatherMap = new Map<string, string>();
  for (const row of horseResult.rows) {
    horseFatherMap.set(row.id as string, row.father_name as string);
  }

  // 4. インメモリ統計計算
  const entries = entryResult.rows as unknown as EntryRow[];
  const predictions = predResult.rows as unknown as PredRow[];

  // 調教師統計
  const trainerAgg = new Map<string, { total: number; wins: number; places: number }>();
  for (const e of entries) {
    if (!e.trainer_name) continue;
    const s = trainerAgg.get(e.trainer_name) || { total: 0, wins: 0, places: 0 };
    s.total++;
    if (e.result_position === 1) s.wins++;
    if (e.result_position <= 3) s.places++;
    trainerAgg.set(e.trainer_name, s);
  }
  const trainerMap = new Map<string, { winRate: number; placeRate: number }>();
  for (const [name, s] of trainerAgg) {
    if (s.total >= 10) {
      trainerMap.set(name, { winRate: s.wins / s.total, placeRate: s.places / s.total });
    }
  }

  // レースメタマップ
  const raceDistMap = new Map<string, number>();
  const raceCourseMap = new Map<string, string>();
  const raceTrackTypeMap = new Map<string, string>();
  for (const p of predictions) {
    raceDistMap.set(p.race_id, p.distance);
    raceCourseMap.set(p.race_id, p.racecourse_name);
    raceTrackTypeMap.set(p.race_id, p.track_type);
  }

  // 騎手距離別統計
  const jockeyDistAgg = new Map<string, { total: number; wins: number }>();
  for (const e of entries) {
    if (!e.jockey_id) continue;
    const dist = raceDistMap.get(e.race_id);
    if (dist === undefined) continue;
    const bucket = Math.round(dist / 200) * 200;
    const key = `${e.jockey_id}__${bucket}`;
    const s = jockeyDistAgg.get(key) || { total: 0, wins: 0 };
    s.total++;
    if (e.result_position === 1) s.wins++;
    jockeyDistAgg.set(key, s);
  }

  // 騎手コース別統計
  const jockeyCourseAgg = new Map<string, { total: number; wins: number }>();
  for (const e of entries) {
    if (!e.jockey_id) continue;
    const course = raceCourseMap.get(e.race_id);
    if (!course) continue;
    const key = `${e.jockey_id}__${course}`;
    const s = jockeyCourseAgg.get(key) || { total: 0, wins: 0 };
    s.total++;
    if (e.result_position === 1) s.wins++;
    jockeyCourseAgg.set(key, s);
  }

  // 種牡馬トラック別統計
  const sireTrackAgg = new Map<string, { total: number; wins: number }>();
  for (const e of entries) {
    if (!e.horse_id) continue;
    const father = horseFatherMap.get(e.horse_id);
    if (!father) continue;
    const trackType = raceTrackTypeMap.get(e.race_id);
    if (!trackType) continue;
    const key = `${father}__${trackType}`;
    const s = sireTrackAgg.get(key) || { total: 0, wins: 0 };
    s.total++;
    if (e.result_position === 1) s.wins++;
    sireTrackAgg.set(key, s);
  }

  // 5. エントリーをレースIDでグループ化
  const entriesByRace = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const arr = entriesByRace.get(e.race_id) || [];
    arr.push(e);
    entriesByRace.set(e.race_id, arr);
  }

  // 6. 特徴量ベクトル構築
  const rows: Array<{
    race_id: string;
    horse_number: number;
    features: number[];
    label_win: number;
    label_place: number;
  }> = [];

  let skippedNoScores = 0;

  for (const pred of predictions) {
    let horseScores: Record<string, Record<string, number>>;
    try {
      const analysis = JSON.parse(pred.analysis_json || '{}');
      horseScores = analysis.horseScores || {};
    } catch { continue; }

    if (Object.keys(horseScores).length === 0) { skippedNoScores++; continue; }

    const raceEntries = entriesByRace.get(pred.race_id) || [];
    if (raceEntries.length === 0) continue;

    const fieldSize = raceEntries.length;

    for (const entry of raceEntries) {
      const scores = horseScores[String(entry.horse_number)];
      if (!scores) continue;

      const odds = entry.odds ?? 10;
      const popularity = entry.popularity ?? Math.ceil(fieldSize / 2);

      const trainerStats = trainerMap.get(entry.trainer_name ?? '') ?? { winRate: 0.08, placeRate: 0.20 };
      const fatherName = entry.horse_id ? horseFatherMap.get(entry.horse_id) : undefined;
      const sireTrackEntry = fatherName ? sireTrackAgg.get(`${fatherName}__${pred.track_type}`) : undefined;
      const sireTrackWR = sireTrackEntry && sireTrackEntry.total >= 10
        ? sireTrackEntry.wins / sireTrackEntry.total : 0.07;
      const distBucket = Math.round(pred.distance / 200) * 200;
      const jdEntry = entry.jockey_id ? jockeyDistAgg.get(`${entry.jockey_id}__${distBucket}`) : undefined;
      const jockeyDistWR = jdEntry && jdEntry.total >= 10 ? jdEntry.wins / jdEntry.total : 0.08;
      const jcEntry = entry.jockey_id ? jockeyCourseAgg.get(`${entry.jockey_id}__${pred.racecourse_name}`) : undefined;
      const jockeyCourseWR = jcEntry && jcEntry.total >= 10 ? jcEntry.wins / jcEntry.total : 0.08;

      const features = FEATURE_NAMES.map(name => {
        switch (name) {
          case 'fieldSize': return fieldSize;
          case 'odds': return odds;
          case 'popularity': return popularity;
          case 'age': return entry.age ?? 3;
          case 'sex_encoded': return SEX_ENCODE[entry.sex] ?? 0;
          case 'handicapWeight': return entry.handicap_weight ?? 54;
          case 'postPosition': return entry.post_position ?? 1;
          case 'grade_encoded': return GRADE_ENCODE[pred.grade ?? ''] ?? 3;
          case 'trackType_encoded': return TRACK_TYPE_ENCODE[pred.track_type] ?? 0;
          case 'distance': return pred.distance;
          case 'trackCondition_encoded': return TRACK_CONDITION_ENCODE[pred.track_condition ?? '良'] ?? 0;
          case 'oddsLogTransform': return Math.log1p(odds);
          case 'popularityRatio': return fieldSize > 0 ? popularity / fieldSize : 0.5;
          case 'weather_encoded': return WEATHER_ENCODE[pred.weather ?? ''] ?? 0;
          case 'weightChange': return entry.result_weight_change ?? 0;
          case 'trainerWinRate': return trainerStats.winRate;
          case 'trainerPlaceRate': return trainerStats.placeRate;
          case 'sireTrackWinRate': return sireTrackWR;
          case 'jockeyDistanceWinRate': return jockeyDistWR;
          case 'jockeyCourseWinRate': return jockeyCourseWR;
          default: return scores[name] ?? 50;
        }
      });

      rows.push({
        race_id: pred.race_id,
        horse_number: entry.horse_number,
        features,
        label_win: entry.result_position === 1 ? 1 : 0,
        label_place: entry.result_position <= 3 ? 1 : 0,
      });
    }
  }

  console.log(`\nスキップ(horseScoresなし): ${skippedNoScores}件`);
  console.log(`学習サンプル数: ${rows.length}件`);
  console.log(`特徴量数: ${FEATURE_NAMES.length}`);
  console.log(`勝利ラベル: ${rows.filter(r => r.label_win === 1).length}件`);
  console.log(`複勝ラベル: ${rows.filter(r => r.label_place === 1).length}件`);

  // 7. JSON出力
  const outputPath = join(process.cwd(), 'model', 'training_data.json');
  const { mkdirSync } = await import('fs');
  mkdirSync(join(process.cwd(), 'model'), { recursive: true });

  writeFileSync(outputPath, JSON.stringify({
    feature_names: FEATURE_NAMES,
    rows,
  }));

  const sizeMB = (Buffer.byteLength(JSON.stringify({ feature_names: FEATURE_NAMES, rows })) / 1024 / 1024).toFixed(1);
  console.log(`\n出力: ${outputPath} (${sizeMB}MB)`);

  db.close();
  console.log('[完了]');
}

main().catch(e => { console.error(e); process.exit(1); });
