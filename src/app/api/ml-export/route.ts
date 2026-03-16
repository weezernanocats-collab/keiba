import { NextRequest, NextResponse } from 'next/server';
import { dbAll } from '@/lib/database';

export const maxDuration = 60;

// 特徴量名の順序定義（export-training-data.ts / feature_names.json と一致）
// v7.1: SHAP重要度0のファクター除去 + odds統合
const FEATURE_NAMES = [
  // ファクタースコア (SHAP分析で有効確認済み)
  'recentForm', 'distanceAptitude', 'trackConditionAptitude',
  'jockeyAbility', 'speedRating', 'runningStyle',
  'postPositionBias', 'rotation', 'lastThreeFurlongs', 'consistency',
  'sireAptitude', 'trainerAbility',
  'seasonalPattern', 'handicapAdvantage',
  'marginCompetitiveness', 'weatherAptitude',
  // コンテキスト特徴量
  'fieldSize', 'popularity', 'age', 'sex_encoded',
  'handicapWeight', 'postPosition', 'grade_encoded',
  'distance', 'trackCondition_encoded', 'oddsLogTransform', 'popularityRatio',
  // 統計特徴量
  'weather_encoded',
  'trainerWinRate', 'trainerPlaceRate',
  'sireTrackWinRate', 'jockeyDistanceWinRate', 'jockeyCourseWinRate',
  // v5.1: 馬体重トレンド
  'weightStability', 'weightTrendSlope', 'weightOptimalDelta',
  // v6.0: 新特徴量
  'jockeySwitchQuality', 'cornerDelta',
  'avgMarginWhenWinning', 'avgMarginWhenLosing',
  'daysSinceLastRace',
  // v6.1: 開催週 + 調教師パターン
  'meetDay', 'trainerDistCatWinRate', 'trainerCondWinRate', 'trainerGradeWinRate',
  // v6.0: 交互作用特徴量
  'weightXspeed', 'ageXdistance', 'jockeyXform',
  'fieldSizeXpost', 'rotationXform', 'conditionXsire',
  // v7.0: ラップタイム基盤特徴量
  'horsePacePreference', 'horseHaiPaceRate', 'courseDistPaceAvg', 'paceStyleMatch',
  // v8.0: 直近フォーム + キャリア特徴量
  'lastRacePosition', 'last3WinRate', 'last3PlaceRate',
  'classChange', 'trackTypeChange',
  'careerWinRate', 'relativeOdds', 'winStreak',
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
  date: string;
}

interface PastPerfRow {
  horse_id: string;
  date: string;
  position: number;
  grade: string | null;
  track_type: string | null;
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

// allEntries からインメモリで統計を計算（追加DBクエリ不要）

function computeTrainerStats(entries: EntryRow[]): Map<string, { winRate: number; placeRate: number }> {
  const agg = new Map<string, { total: number; wins: number; places: number }>();
  for (const e of entries) {
    if (!e.trainer_name) continue;
    const s = agg.get(e.trainer_name) || { total: 0, wins: 0, places: 0 };
    s.total++;
    if (e.result_position === 1) s.wins++;
    if (e.result_position <= 2) s.places++;
    agg.set(e.trainer_name, s);
  }
  const m = new Map<string, { winRate: number; placeRate: number }>();
  for (const [name, s] of agg) {
    if (s.total >= 10) {
      m.set(name, { winRate: s.wins / s.total, placeRate: s.places / s.total });
    }
  }
  return m;
}

function computeJockeyDistStats(
  entries: EntryRow[],
  raceDistanceMap: Map<string, number>,
): Map<string, { total: number; wins: number }> {
  const agg = new Map<string, { total: number; wins: number }>();
  for (const e of entries) {
    if (!e.jockey_id) continue;
    const dist = raceDistanceMap.get(e.race_id);
    if (dist === undefined) continue;
    const bucket = Math.round(dist / 200) * 200;
    const key = `${e.jockey_id}__${bucket}`;
    const s = agg.get(key) || { total: 0, wins: 0 };
    s.total++;
    if (e.result_position === 1) s.wins++;
    agg.set(key, s);
  }
  // 10件未満は除外
  for (const [key, s] of agg) {
    if (s.total < 10) agg.delete(key);
  }
  return agg;
}

function computeJockeyCourseStats(
  entries: EntryRow[],
  raceCourseMap: Map<string, string>,
): Map<string, { total: number; wins: number }> {
  const agg = new Map<string, { total: number; wins: number }>();
  for (const e of entries) {
    if (!e.jockey_id) continue;
    const course = raceCourseMap.get(e.race_id);
    if (!course) continue;
    const key = `${e.jockey_id}__${course}`;
    const s = agg.get(key) || { total: 0, wins: 0 };
    s.total++;
    if (e.result_position === 1) s.wins++;
    agg.set(key, s);
  }
  for (const [key, s] of agg) {
    if (s.total < 10) agg.delete(key);
  }
  return agg;
}

function computeSireTrackStats(
  entries: EntryRow[],
  horseFatherMap: Map<string, string>,
  raceTrackTypeMap: Map<string, string>,
): Map<string, { total: number; wins: number }> {
  const agg = new Map<string, { total: number; wins: number }>();
  for (const e of entries) {
    if (!e.horse_id) continue;
    const father = horseFatherMap.get(e.horse_id);
    if (!father) continue;
    const trackType = raceTrackTypeMap.get(e.race_id);
    if (!trackType) continue;
    const key = `${father}__${trackType}`;
    const s = agg.get(key) || { total: 0, wins: 0 };
    s.total++;
    if (e.result_position === 1) s.wins++;
    agg.set(key, s);
  }
  for (const [key, s] of agg) {
    if (s.total < 10) agg.delete(key);
  }
  return agg;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from') || '2020-01-01';
  const to = searchParams.get('to') || '2099-12-31';

  const [predictions, allEntries] = await Promise.all([
    dbAll<PredictionWithRace>(`
      SELECT p.race_id, p.analysis_json,
             r.grade, r.track_type, r.distance, r.track_condition, r.weather, r.racecourse_name, r.date
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

  // レースメタデータのマップを構築（インメモリ統計計算用）
  const raceDistanceMap = new Map<string, number>();
  const raceCourseMap = new Map<string, string>();
  const raceTrackTypeMap = new Map<string, string>();
  const raceDateMap = new Map<string, string>();
  for (const p of predictions) {
    raceDistanceMap.set(p.race_id, p.distance);
    raceCourseMap.set(p.race_id, p.racecourse_name);
    raceTrackTypeMap.set(p.race_id, p.track_type);
    raceDateMap.set(p.race_id, p.date);
  }

  // horse_id → father_name（唯一の追加DBクエリ）
  const horseIds = [...new Set(allEntries.map(e => e.horse_id).filter(Boolean))] as string[];
  const horseFatherMap = new Map<string, string>();
  if (horseIds.length > 0) {
    // IN句が大きすぎる場合はチャンク分割
    const chunkSize = 500;
    for (let i = 0; i < horseIds.length; i += chunkSize) {
      const chunk = horseIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const horses = await dbAll<{ id: string; father_name: string }>(`
        SELECT id, father_name FROM horses WHERE id IN (${placeholders}) AND father_name IS NOT NULL
      `, chunk);
      for (const h of horses) {
        horseFatherMap.set(h.id, h.father_name);
      }
    }
  }

  // v8.0: 過去成績データ取得（horse_id ごとの直近レース情報）
  const ppByHorse = new Map<string, PastPerfRow[]>();
  if (horseIds.length > 0) {
    const chunkSize = 500;
    for (let i = 0; i < horseIds.length; i += chunkSize) {
      const chunk = horseIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const ppRows = await dbAll<PastPerfRow>(`
        SELECT pp.horse_id, pp.date, pp.position, r.grade, r.track_type
        FROM past_performances pp
        LEFT JOIN races r ON r.id = pp.race_id
        WHERE pp.horse_id IN (${placeholders})
        ORDER BY pp.horse_id, pp.date DESC
      `, chunk);
      for (const pp of ppRows) {
        const arr = ppByHorse.get(pp.horse_id) || [];
        arr.push(pp);
        ppByHorse.set(pp.horse_id, arr);
      }
    }
  }

  // インメモリで統計を計算（追加DBクエリなし）
  const trainerMap = computeTrainerStats(allEntries);
  const jockeyDistMap = computeJockeyDistStats(allEntries, raceDistanceMap);
  const jockeyCourseMap = computeJockeyCourseStats(allEntries, raceCourseMap);
  const sireTrackMap = computeSireTrackStats(allEntries, horseFatherMap, raceTrackTypeMap);

  const entriesByRace = new Map<string, EntryRow[]>();
  for (const e of allEntries) {
    const arr = entriesByRace.get(e.race_id) || [];
    arr.push(e);
    entriesByRace.set(e.race_id, arr);
  }

  const rows: Array<{
    race_id: string;
    horse_number: number;
    position: number;
    odds: number;
    features: number[];
    label_win: number;
    label_place: number;
    track_type_encoded: number;
    distance_val: number;
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

    // v8.0: レース内オッズ中央値を計算
    const raceOdds = entries
      .map(e => e.odds)
      .filter((o): o is number => o !== null && o > 0)
      .sort((a, b) => a - b);
    const medianOdds = raceOdds.length > 0
      ? raceOdds[Math.floor(raceOdds.length / 2)] : 10;

    for (const entry of entries) {
      const scores = horseScores[String(entry.horse_number)];
      if (!scores) continue;

      const odds = entry.odds ?? 10;
      const popularity = entry.popularity ?? Math.ceil(fieldSize / 2);

      // 新特徴量の統計ルックアップ（インメモリ計算済み）
      const trainerStats = trainerMap.get(entry.trainer_name ?? '') ?? { winRate: 0.08, placeRate: 0.20 };
      const fatherName = entry.horse_id ? horseFatherMap.get(entry.horse_id) : undefined;
      const sireTrackEntry = fatherName ? sireTrackMap.get(`${fatherName}__${pred.track_type}`) : undefined;
      const sireTrackWR = sireTrackEntry ? sireTrackEntry.wins / sireTrackEntry.total : 0.07;
      const distBucket = Math.round(pred.distance / 200) * 200;
      const jdEntry = entry.jockey_id ? jockeyDistMap.get(`${entry.jockey_id}__${distBucket}`) : undefined;
      const jockeyDistWR = jdEntry ? jdEntry.wins / jdEntry.total : 0.08;
      const jcEntry = entry.jockey_id ? jockeyCourseMap.get(`${entry.jockey_id}__${pred.racecourse_name}`) : undefined;
      const jockeyCourseWR = jcEntry ? jcEntry.wins / jcEntry.total : 0.08;

      // v8.0: 過去成績ベースの特徴量
      const horsePerfs = entry.horse_id
        ? (ppByHorse.get(entry.horse_id) || []).filter(pp => pp.date < pred.date)
        : [];

      const lastRacePosition = horsePerfs.length > 0 ? horsePerfs[0].position : 9;
      const last3 = horsePerfs.slice(0, 3);
      const last3WinRate = last3.length > 0
        ? last3.filter(pp => pp.position === 1).length / last3.length : 0;
      const last3PlaceRate = last3.length > 0
        ? last3.filter(pp => pp.position <= 3).length / last3.length : 0;

      let classChange = 0;
      if (horsePerfs.length > 0 && horsePerfs[0].grade) {
        const prevGrade = GRADE_ENCODE[horsePerfs[0].grade] ?? 3;
        const curGrade = GRADE_ENCODE[pred.grade ?? ''] ?? 3;
        classChange = curGrade - prevGrade;
      }

      let trackTypeChange = 0;
      if (horsePerfs.length > 0 && horsePerfs[0].track_type) {
        const prevTT = horsePerfs[0].track_type;
        if ((prevTT === '芝' && pred.track_type !== '芝') ||
            (prevTT !== '芝' && pred.track_type === '芝')) {
          trackTypeChange = 1;
        }
      }

      const careerWinRate = horsePerfs.length > 0
        ? horsePerfs.filter(pp => pp.position === 1).length / horsePerfs.length : 0;

      const relativeOdds = entry.odds && entry.odds > 0
        ? Math.log(entry.odds / medianOdds) : 0;

      let winStreak = 0;
      for (const pp of horsePerfs) {
        if (pp.position === 1) winStreak++;
        else break;
      }

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
          case 'oddsLogTransform': return odds > 0 ? Math.log(odds) : Math.log(10);
          case 'popularityRatio': return fieldSize > 0 ? popularity / fieldSize : 0.5;
          // v4.2 新特徴量
          case 'weather_encoded': return WEATHER_ENCODE[pred.weather ?? ''] ?? 0;
          case 'weightChange': return entry.result_weight_change ?? 0;
          case 'trainerWinRate': return trainerStats.winRate;
          case 'trainerPlaceRate': return trainerStats.placeRate;
          case 'sireTrackWinRate': return sireTrackWR;
          case 'jockeyDistanceWinRate': return jockeyDistWR;
          case 'jockeyCourseWinRate': return jockeyCourseWR;
          // v8.0: 直近フォーム + キャリア特徴量
          case 'lastRacePosition': return lastRacePosition;
          case 'last3WinRate': return last3WinRate;
          case 'last3PlaceRate': return last3PlaceRate;
          case 'classChange': return classChange;
          case 'trackTypeChange': return trackTypeChange;
          case 'careerWinRate': return careerWinRate;
          case 'relativeOdds': return relativeOdds;
          case 'winStreak': return winStreak;
          default: return scores[name] ?? 50;
        }
      });

      rows.push({
        race_id: pred.race_id,
        horse_number: entry.horse_number,
        position: entry.result_position,
        odds: entry.odds ?? 0,
        features,
        label_win: entry.result_position === 1 ? 1 : 0,
        label_place: entry.result_position <= 3 ? 1 : 0,
        track_type_encoded: TRACK_TYPE_ENCODE[pred.track_type] ?? 0,
        distance_val: pred.distance,
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
