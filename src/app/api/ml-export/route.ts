import { NextRequest, NextResponse } from 'next/server';
import { dbAll, dbGet } from '@/lib/database';

export const maxDuration = 60;

// 特徴量名の順序定義（Python側と一致させる）
const FEATURE_NAMES = [
  // 16ファクタースコア
  'recentForm', 'courseAptitude', 'distanceAptitude', 'trackConditionAptitude',
  'jockeyAbility', 'speedRating', 'classPerformance', 'runningStyle',
  'postPositionBias', 'rotation', 'lastThreeFurlongs', 'consistency',
  'sireAptitude', 'jockeyTrainerCombo', 'historicalPostBias', 'seasonalPattern',
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

function isAuthorized(request: NextRequest): boolean {
  const syncKey = process.env.SYNC_KEY;
  if (!syncKey) return true;
  const provided = request.headers.get('x-sync-key');
  return provided === syncKey;
}

interface PredictionWithRace {
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

// 統計キャッシュ（同一リクエスト内で再利用）
const trainerCache = new Map<string, { winRate: number; placeRate: number }>();
const sireTrackCache = new Map<string, number>();
const jockeyDistCache = new Map<string, number>();
const jockeyCourseCache = new Map<string, number>();

async function getTrainerStatsForExport(trainerName: string): Promise<{ winRate: number; placeRate: number }> {
  if (!trainerName) return { winRate: 0.08, placeRate: 0.20 };
  const cached = trainerCache.get(trainerName);
  if (cached) return cached;

  const stats = await dbGet<{ total: number; wins: number; places: number }>(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN e.result_position <= 2 THEN 1 ELSE 0 END) as places
    FROM race_entries e JOIN races r ON e.race_id = r.id
    WHERE e.trainer_name = ? AND r.status = '結果確定' AND e.result_position IS NOT NULL
  `, [trainerName]);

  const result = stats && stats.total >= 10
    ? { winRate: stats.wins / stats.total, placeRate: stats.places / stats.total }
    : { winRate: 0.08, placeRate: 0.20 };
  trainerCache.set(trainerName, result);
  return result;
}

async function getSireTrackWinRateForExport(horseId: string, trackType: string): Promise<number> {
  const key = `${horseId}__${trackType}`;
  const cached = sireTrackCache.get(key);
  if (cached !== undefined) return cached;

  const stats = await dbGet<{ total: number; wins: number }>(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN pp.position = 1 THEN 1 ELSE 0 END) as wins
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    JOIN horses target ON target.id = ? AND h.father_name = target.father_name
    WHERE pp.track_type = ? AND pp.position IS NOT NULL
  `, [horseId, trackType]);

  const rate = stats && stats.total >= 10 ? stats.wins / stats.total : 0.07;
  sireTrackCache.set(key, rate);
  return rate;
}

async function getJockeyDistWinRateForExport(jockeyId: string, distance: number): Promise<number> {
  const key = `${jockeyId}__${distance}`;
  const cached = jockeyDistCache.get(key);
  if (cached !== undefined) return cached;

  const stats = await dbGet<{ total: number; wins: number }>(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins
    FROM race_entries e JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id = ? AND r.status = '結果確定' AND e.result_position IS NOT NULL
      AND ABS(r.distance - ?) <= 200
  `, [jockeyId, distance]);

  const rate = stats && stats.total >= 10 ? stats.wins / stats.total : 0.08;
  jockeyDistCache.set(key, rate);
  return rate;
}

async function getJockeyCourseWinRateForExport(jockeyId: string, racecourseName: string): Promise<number> {
  const key = `${jockeyId}__${racecourseName}`;
  const cached = jockeyCourseCache.get(key);
  if (cached !== undefined) return cached;

  const stats = await dbGet<{ total: number; wins: number }>(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins
    FROM race_entries e JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id = ? AND r.racecourse_name = ? AND r.status = '結果確定' AND e.result_position IS NOT NULL
  `, [jockeyId, racecourseName]);

  const rate = stats && stats.total >= 10 ? stats.wins / stats.total : 0.08;
  jockeyCourseCache.set(key, rate);
  return rate;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from') || '2020-01-01';
  const to = searchParams.get('to') || '2099-12-31';

  // キャッシュクリア
  trainerCache.clear();
  sireTrackCache.clear();
  jockeyDistCache.clear();
  jockeyCourseCache.clear();

  const [predictions, allEntries] = await Promise.all([
    dbAll<PredictionWithRace>(`
      SELECT p.race_id, p.analysis_json,
             r.grade, r.track_type, r.distance, r.track_condition, r.weather, r.racecourse_name
      FROM predictions p
      JOIN races r ON r.id = p.race_id
      WHERE r.status = '結果確定'
        AND r.date BETWEEN ? AND ?
        AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = r.id)
    `, [from, to]),
    dbAll<EntryRow>(`
      SELECT re.race_id, re.horse_number, re.post_position, re.age, re.sex,
             re.handicap_weight, re.result_position, re.odds, re.popularity,
             re.result_weight_change, re.trainer_name, re.jockey_id, re.horse_id
      FROM race_entries re
      JOIN races r ON r.id = re.race_id
      WHERE r.status = '結果確定'
        AND r.date BETWEEN ? AND ?
        AND re.result_position IS NOT NULL
    `, [from, to]),
  ]);

  if (predictions.length === 0) {
    return NextResponse.json({
      feature_names: FEATURE_NAMES,
      rows: [],
      message: '学習データがありません。予想生成＋結果確定済みのレースが必要です。',
    });
  }

  const entriesByRace = new Map<string, EntryRow[]>();
  for (const e of allEntries) {
    const arr = entriesByRace.get(e.race_id) || [];
    arr.push(e);
    entriesByRace.set(e.race_id, arr);
  }

  const rows: Array<{
    race_id: string;
    horse_number: number;
    features: number[];
    label_win: number;
    label_place: number;
  }> = [];

  for (const pred of predictions) {
    let horseScores: Record<string, Record<string, number>>;
    try {
      const analysis = JSON.parse(pred.analysis_json || '{}');
      horseScores = analysis.horseScores || {};
    } catch {
      continue;
    }

    if (Object.keys(horseScores).length === 0) continue;

    const entries = entriesByRace.get(pred.race_id) || [];
    if (entries.length === 0) continue;

    const fieldSize = entries.length;

    for (const entry of entries) {
      const scores = horseScores[String(entry.horse_number)];
      if (!scores) continue;

      const odds = entry.odds ?? 10;
      const popularity = entry.popularity ?? Math.ceil(fieldSize / 2);

      // 新特徴量の統計取得
      const trainerStats = await getTrainerStatsForExport(entry.trainer_name ?? '');
      const sireTrackWR = entry.horse_id
        ? await getSireTrackWinRateForExport(entry.horse_id, pred.track_type)
        : 0.07;
      const jockeyDistWR = entry.jockey_id
        ? await getJockeyDistWinRateForExport(entry.jockey_id, pred.distance)
        : 0.08;
      const jockeyCourseWR = entry.jockey_id
        ? await getJockeyCourseWinRateForExport(entry.jockey_id, pred.racecourse_name)
        : 0.08;

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
          // v4.2 新特徴量
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

  return NextResponse.json({
    feature_names: FEATURE_NAMES,
    rows,
    stats: {
      totalRows: rows.length,
      races: predictions.length,
      winCount: rows.filter(r => r.label_win === 1).length,
      placeCount: rows.filter(r => r.label_place === 1).length,
    },
  });
}
