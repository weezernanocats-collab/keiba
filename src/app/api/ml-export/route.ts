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
  'marginCompetitiveness',
  // コンテキスト特徴量
  'fieldSize', 'popularity', 'age', 'sex_encoded',
  'handicapWeight', 'postPosition', 'grade_encoded',
  'distance', 'trackCondition_encoded', 'oddsLogTransform', 'popularityRatio',
  // 統計特徴量
  'weather_encoded',
  'trainerWinRate', 'trainerPlaceRate',
  'sireTrackWinRate', 'jockeyDistanceWinRate', 'jockeyCourseWinRate',
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
  jockey_name: string | null;
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
    if (e.result_position <= 3) s.places++;
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

interface PastPerfRow {
  horse_id: string;
  date: string;
  position: number;
  jockey_name: string | null;
  margin: string | null;
  corner_positions: string | null;
}

function marginToSeconds(margin: string | null): number {
  if (!margin) return 0;
  const m = margin.trim();
  if (m === '' || m === '同着') return 0;
  if (m === 'クビ') return 0.1;
  if (m === 'ハナ') return 0.05;
  if (m === 'アタマ') return 0.15;
  if (m.includes('1/2')) return 0.3;
  if (m.includes('3/4')) return 0.45;
  if (m === '大差') return 5.0;
  const num = parseFloat(m);
  return isNaN(num) ? 0 : num * 0.6;
}

function parseCornerDelta(cornerStr: string | null): number {
  if (!cornerStr) return 0;
  const parts = cornerStr.split('-').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  if (parts.length < 2) return 0;
  return parts[parts.length - 2] - parts[parts.length - 1];
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
             re.result_weight_change, re.trainer_name, re.jockey_id, re.jockey_name, re.horse_id
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
  for (const p of predictions) {
    raceDistanceMap.set(p.race_id, p.distance);
    raceCourseMap.set(p.race_id, p.racecourse_name);
    raceTrackTypeMap.set(p.race_id, p.track_type);
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

  // 過去成績データ取得（騎手乗替、コーナー、着差、休養日数用）
  const pastPerfs = await dbAll<PastPerfRow>(`
    SELECT horse_id, date, position, jockey_name, margin, corner_positions
    FROM past_performances
    WHERE horse_id IN (${horseIds.map(() => '?').join(',')})
    ORDER BY horse_id, date DESC
  `, horseIds);

  const ppByHorse = new Map<string, PastPerfRow[]>();
  for (const pp of pastPerfs) {
    const arr = ppByHorse.get(pp.horse_id) || [];
    arr.push(pp);
    ppByHorse.set(pp.horse_id, arr);
  }

  // 調教師パターン統計
  const trainerDistCatMap = new Map<string, { total: number; wins: number }>();
  for (const e of allEntries) {
    if (!e.trainer_name) continue;
    const dist = raceDistanceMap.get(e.race_id);
    if (dist !== undefined) {
      const dCat = dist <= 1400 ? 'sprint' : dist <= 1800 ? 'mile' : 'long';
      const dcKey = `${e.trainer_name}__${dCat}`;
      const dc = trainerDistCatMap.get(dcKey) || { total: 0, wins: 0 };
      dc.total++; if (e.result_position === 1) dc.wins++;
      trainerDistCatMap.set(dcKey, dc);
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

      // v6.0 新特徴量
      const horsePerfs = entry.horse_id
        ? (ppByHorse.get(entry.horse_id) || [])
        : [];

      let jockeySwitchQuality = 0;
      if (horsePerfs.length > 0) {
        const lastJockey = horsePerfs[0].jockey_name;
        if (lastJockey && lastJockey !== entry.jockey_name) {
          jockeySwitchQuality = (scores.jockeyAbility ?? 50) - 50;
        }
      }

      let cornerDelta = 0;
      const cornerPerfs = horsePerfs.slice(0, 5).filter(pp => pp.corner_positions);
      if (cornerPerfs.length > 0) {
        const deltas = cornerPerfs.map(pp => parseCornerDelta(pp.corner_positions));
        cornerDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
      }

      let avgMarginWin = 0;
      let avgMarginLose = 0;
      const winPerfs = horsePerfs.filter(pp => pp.position === 1 && pp.margin);
      const losePerfs = horsePerfs.filter(pp => pp.position > 1 && pp.margin);
      if (winPerfs.length > 0) avgMarginWin = winPerfs.reduce((s, pp) => s + marginToSeconds(pp.margin), 0) / winPerfs.length;
      if (losePerfs.length > 0) avgMarginLose = losePerfs.reduce((s, pp) => s + marginToSeconds(pp.margin), 0) / losePerfs.length;

      let daysSinceLastRace = 30;
      if (horsePerfs.length > 0) {
        const lastDate = new Date(horsePerfs[0].date);
        const now = new Date();
        daysSinceLastRace = Math.max(0, Math.round((now.getTime() - lastDate.getTime()) / 86400000));
      }

      const meetDay = pred.race_id.length >= 10 ? parseInt(pred.race_id.substring(8, 10)) || 1 : 1;

      const features = FEATURE_NAMES.map(name => {
        switch (name) {
          case 'fieldSize': return fieldSize;
          case 'popularity': return popularity;
          case 'age': return entry.age ?? 3;
          case 'sex_encoded': return SEX_ENCODE[entry.sex] ?? 0;
          case 'handicapWeight': return entry.handicap_weight ?? 54;
          case 'postPosition': return entry.post_position ?? 1;
          case 'grade_encoded': return GRADE_ENCODE[pred.grade ?? ''] ?? 3;
          case 'trackType_encoded': return TRACK_TYPE_ENCODE[pred.track_type] ?? 0;
          case 'distance': return pred.distance;
          case 'trackCondition_encoded': return TRACK_CONDITION_ENCODE[pred.track_condition ?? '良'] ?? 0;
          case 'oddsLogTransform': return entry.odds && entry.odds > 0 ? Math.log(entry.odds) : Math.log(10);
          case 'popularityRatio': return fieldSize > 0 ? popularity / fieldSize : 0.5;
          // 統計特徴量
          case 'weather_encoded': return WEATHER_ENCODE[pred.weather ?? ''] ?? 0;
          case 'weightChange': return entry.result_weight_change ?? 0;
          case 'trainerWinRate': return trainerStats.winRate;
          case 'trainerPlaceRate': return trainerStats.placeRate;
          case 'sireTrackWinRate': return sireTrackWR;
          case 'jockeyDistanceWinRate': return jockeyDistWR;
          case 'jockeyCourseWinRate': return jockeyCourseWR;
          // v5.1: 馬体重トレンド
          case 'weightStability': return 50; // TODO: compute from weight history
          case 'weightTrendSlope': return 0;
          case 'weightOptimalDelta': return 0;
          // v6.0: 新特徴量
          case 'jockeySwitchQuality': return jockeySwitchQuality;
          case 'cornerDelta': return cornerDelta;
          case 'avgMarginWhenWinning': return avgMarginWin;
          case 'avgMarginWhenLosing': return avgMarginLose;
          case 'daysSinceLastRace': return daysSinceLastRace;
          // v6.1: 開催週 + 調教師パターン
          case 'meetDay': return meetDay;
          case 'trainerDistCatWinRate': {
            if (!entry.trainer_name) return 0.08;
            const dCat = pred.distance <= 1400 ? 'sprint' : pred.distance <= 1800 ? 'mile' : 'long';
            const dc = trainerDistCatMap.get(`${entry.trainer_name}__${dCat}`);
            return dc && dc.total >= 5 ? dc.wins / dc.total : 0.08;
          }
          case 'trainerCondWinRate': return 0.08; // simplified for API route
          case 'trainerGradeWinRate': return 0.08; // simplified for API route
          // v6.0: 交互作用特徴量
          case 'weightXspeed': return (entry.handicap_weight ?? 54) * ((scores.speedRating ?? 50) / 100);
          case 'ageXdistance': return (entry.age ?? 3) * (pred.distance / 1000);
          case 'jockeyXform': return ((scores.jockeyAbility ?? 50) / 100) * ((scores.recentForm ?? 50) / 100);
          case 'fieldSizeXpost': return fieldSize * ((entry.post_position ?? 1) / fieldSize);
          case 'rotationXform': return ((scores.rotation ?? 50) / 100) * ((scores.recentForm ?? 50) / 100);
          case 'conditionXsire': return (TRACK_CONDITION_ENCODE[pred.track_condition ?? '良'] ?? 0) * ((scores.sireAptitude ?? 50) / 100);
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
