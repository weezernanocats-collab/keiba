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
];

const SEX_ENCODE: Record<string, number> = { '牡': 0, '牝': 1, 'セ': 2 };
const TRACK_TYPE_ENCODE: Record<string, number> = { '芝': 0, 'ダート': 1, '障害': 2 };
const TRACK_CONDITION_ENCODE: Record<string, number> = { '良': 0, '稍重': 1, '重': 2, '不良': 3 };
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

interface PredictionRow {
  race_id: string;
  analysis_json: string;
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
}

interface RaceRow {
  id: string;
  grade: string | null;
  track_type: string;
  distance: number;
  track_condition: string | null;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from') || '2020-01-01';
  const to = searchParams.get('to') || '2099-12-31';

  // 結果確定済み + 予想生成済みのレースを取得
  const predictions = await dbAll<PredictionRow>(`
    SELECT p.race_id, p.analysis_json
    FROM predictions p
    JOIN races r ON r.id = p.race_id
    WHERE r.status = '結果確定'
      AND r.date BETWEEN ? AND ?
      AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = r.id)
  `, [from, to]);

  if (predictions.length === 0) {
    return NextResponse.json({
      feature_names: FEATURE_NAMES,
      rows: [],
      message: '学習データがありません。予想生成＋結果確定済みのレースが必要です。',
    });
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

    // レース情報
    const race = await dbGet<RaceRow>(
      'SELECT id, grade, track_type, distance, track_condition FROM races WHERE id = ?',
      [pred.race_id],
    );
    if (!race) continue;

    // 出走馬（結果あり）
    const entries = await dbAll<EntryRow>(`
      SELECT race_id, horse_number, post_position, age, sex,
             handicap_weight, result_position, odds, popularity
      FROM race_entries
      WHERE race_id = ? AND result_position IS NOT NULL
    `, [pred.race_id]);

    if (entries.length === 0) continue;

    const fieldSize = entries.length;

    for (const entry of entries) {
      const scores = horseScores[String(entry.horse_number)];
      if (!scores) continue;

      const odds = entry.odds ?? 10;
      const popularity = entry.popularity ?? Math.ceil(fieldSize / 2);

      const features = FEATURE_NAMES.map(name => {
        switch (name) {
          case 'fieldSize': return fieldSize;
          case 'odds': return odds;
          case 'popularity': return popularity;
          case 'age': return entry.age ?? 3;
          case 'sex_encoded': return SEX_ENCODE[entry.sex] ?? 0;
          case 'handicapWeight': return entry.handicap_weight ?? 54;
          case 'postPosition': return entry.post_position ?? 1;
          case 'grade_encoded': return GRADE_ENCODE[race.grade ?? ''] ?? 3;
          case 'trackType_encoded': return TRACK_TYPE_ENCODE[race.track_type] ?? 0;
          case 'distance': return race.distance;
          case 'trackCondition_encoded': return TRACK_CONDITION_ENCODE[race.track_condition ?? '良'] ?? 0;
          case 'oddsLogTransform': return Math.log1p(odds);
          case 'popularityRatio': return fieldSize > 0 ? popularity / fieldSize : 0.5;
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
