/**
 * ML学習用データをローカルエクスポート v8.0
 *
 * v8.0 改善:
 *   - 新特徴量8個追加: 前走着順、直近3走勝率/複勝率、クラス変動、
 *     芝ダ替わり、通算勝率、相対オッズ、連勝数
 *   - past_performances に grade, track_type を追加取得
 * v6.0:
 *   - historicalPostBias 削除（postPositionBias に統合）
 *   - オッズ関連特徴量を訓練から除外（バリューフィルター化）
 *   - 新特徴量: 騎手乗替シグナル、コーナー加速、着差定量化、休養日数連続値
 *   - 交互作用特徴量6個追加
 *   - データリーケージ修正: 統計量を時間順で累積計算
 *
 * npx tsx -r tsconfig-paths/register scripts/export-training-data.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

// 特徴量名の順序定義（v7.0 SHAP分析後クリーニング）
// 除去済み: courseAptitude, classPerformance, jockeyTrainerCombo,
//          historicalPostBias, trackType_encoded, weightChange, odds (raw)
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
  'jockeySwitchQuality',     // 騎手乗替の質（WR差）
  'cornerDelta',              // コーナー通過順位差（加速指標）
  'avgMarginWhenWinning',     // 勝ち時平均着差（圧勝力）
  'avgMarginWhenLosing',      // 負け時平均着差（接戦力）
  'daysSinceLastRace',        // 休養日数（連続値）
  // v6.1: 開催週 + 調教師パターン
  'meetDay',                    // 開催何日目（トラック劣化）
  'trainerDistCatWinRate',      // 調教師×距離カテゴリ勝率
  'trainerCondWinRate',         // 調教師×馬場状態勝率
  'trainerGradeWinRate',        // 調教師×重賞勝率
  // v6.0: 交互作用特徴量
  'weightXspeed',             // 斤量×スピード指数
  'ageXdistance',             // 馬齢×距離
  'jockeyXform',              // 騎手力×直近成績
  'fieldSizeXpost',           // 頭数×枠順
  'rotationXform',            // ローテーション×直近成績
  'conditionXsire',           // 馬場状態×血統適性
  // v7.0: ラップタイム基盤特徴量
  'horsePacePreference',      // 馬のペース適性 (ハイ=1, ミドル=0.5, スロー=0)
  'horseHaiPaceRate',         // ハイペース経験率
  'courseDistPaceAvg',        // コース×距離の典型ペース
  'paceStyleMatch',           // 脚質×ペース相性 (追込×ハイ=高, 逃げ×スロー=高)
  // v8.0: 直近フォーム + キャリア特徴量
  'lastRacePosition',        // 前走着順 (1-18, デフォルト9)
  'last3WinRate',             // 直近3走の勝率 (0-1)
  'last3PlaceRate',           // 直近3走の複勝率 (0-1)
  'classChange',              // クラス変動 (今走グレード - 前走グレード)
  'trackTypeChange',          // 芝↔ダート替わり (0 or 1)
  'careerWinRate',            // 通算勝率 (0-1)
  'relativeOdds',             // レース内相対オッズ (log(odds/中央値))
  'winStreak',                // 連勝数 (0-N)
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

// 着差テキスト → 秒数の変換
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
  return isNaN(num) ? 0 : num * 0.6; // N馬身 → 概算秒数
}

// コーナー通過順から加速度を算出
function parseCornerDelta(cornerStr: string | null): number {
  if (!cornerStr) return 0;
  const parts = cornerStr.split('-').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  if (parts.length < 2) return 0;
  // 最終コーナー - 第3コーナー（正値=加速）
  return parts[parts.length - 2] - parts[parts.length - 1];
}

interface PredRow {
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

interface PastPerfRow {
  horse_id: string;
  race_id: string | null;
  date: string;
  position: number;
  jockey_name: string | null;
  margin: string | null;
  corner_positions: string | null;
  grade: string | null;
  track_type: string | null;
}

async function main() {
  console.log('=== ML学習データエクスポート v6.0 ===\n');

  // 1. 予測データ取得（2クエリでTurso負荷を最小化）
  const [predResult, entryResult] = await Promise.all([
    db.execute(`
      SELECT p.race_id, p.analysis_json,
             r.grade, r.track_type, r.distance, r.track_condition,
             r.weather, r.racecourse_name, r.date
      FROM predictions p
      JOIN races r ON r.id = p.race_id
      WHERE r.status = '結果確定'
        AND p.id = (SELECT MAX(p2.id) FROM predictions p2 WHERE p2.race_id = r.id)
    `),
    db.execute(`
      SELECT re.race_id, re.horse_number, re.post_position, re.age, re.sex,
             re.handicap_weight, re.result_position, re.odds, re.popularity,
             re.result_weight_change, re.trainer_name, re.jockey_id, re.jockey_name, re.horse_id
      FROM race_entries re
      JOIN races r ON r.id = re.race_id
      WHERE r.status = '結果確定'
        AND re.result_position IS NOT NULL
    `),
  ]);
  console.log(`予測データ: ${predResult.rows.length}件`);
  console.log(`出走データ: ${entryResult.rows.length}件`);

  // 過去成績データ取得（騎手乗替、コーナー、着差、休養日数、ペース特徴量用）
  const [ppResult, racePaceResult, horseResult] = await Promise.all([
    db.execute(`
      SELECT pp.horse_id, pp.race_id, pp.date, pp.position, pp.jockey_name, pp.margin, pp.corner_positions,
             r.grade, r.track_type
      FROM past_performances pp
      LEFT JOIN races r ON r.id = pp.race_id
      ORDER BY pp.horse_id, pp.date DESC
    `),
    // ラップタイム基盤: レースのペースタイプ取得（v7.0）
    db.execute(`
      SELECT id, pace_type, racecourse_name, distance
      FROM races
      WHERE pace_type IS NOT NULL
    `),
    db.execute(
      `SELECT id, father_name FROM horses WHERE father_name IS NOT NULL`
    ),
  ]);
  console.log(`過去成績: ${ppResult.rows.length}件`);
  console.log(`ペースタイプ付きレース: ${racePaceResult.rows.length}件`);

  // ペースタイプマップ: race_id → 数値 (ハイ=1.0, ミドル=0.5, スロー=0.0)
  const PACE_ENCODE: Record<string, number> = { 'ハイ': 1.0, 'ミドル': 0.5, 'スロー': 0.0 };
  const racePaceMap = new Map<string, number>();
  // コース×距離バケットの累積ペースデータ
  const coursePaceAccum = new Map<string, { total: number; sum: number }>();
  for (const row of racePaceResult.rows) {
    const raceId = row.id as string;
    const paceType = row.pace_type as string;
    racePaceMap.set(raceId, PACE_ENCODE[paceType] ?? 0.5);
  }

  const horseFatherMap = new Map<string, string>();
  for (const row of horseResult.rows) {
    horseFatherMap.set(row.id as string, row.father_name as string);
  }

  const entries = entryResult.rows as unknown as EntryRow[];
  const predictions = predResult.rows as unknown as PredRow[];
  const pastPerfs = ppResult.rows as unknown as PastPerfRow[];

  // レース日付順でソート（リーケージ修正: 累積統計用）
  predictions.sort((a, b) => a.date.localeCompare(b.date));

  // 過去成績を馬IDでグループ化
  const ppByHorse = new Map<string, PastPerfRow[]>();
  for (const pp of pastPerfs) {
    const arr = ppByHorse.get(pp.horse_id) || [];
    arr.push(pp);
    ppByHorse.set(pp.horse_id, arr);
  }

  // レースメタマップ
  const raceDateMap = new Map<string, string>();
  const raceDistMap = new Map<string, number>();
  const raceCourseMap = new Map<string, string>();
  const raceTrackTypeMap = new Map<string, string>();
  for (const p of predictions) {
    raceDateMap.set(p.race_id, p.date);
    raceDistMap.set(p.race_id, p.distance);
    raceCourseMap.set(p.race_id, p.racecourse_name);
    raceTrackTypeMap.set(p.race_id, p.track_type);
  }

  // エントリーをレースIDでグループ化
  const entriesByRace = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const arr = entriesByRace.get(e.race_id) || [];
    arr.push(e);
    entriesByRace.set(e.race_id, arr);
  }

  // リーケージ修正: 統計を日付順に累積計算
  // 各レースの時点で「そのレース以前のデータのみ」から統計を算出
  console.log('\n統計量の累積計算（リーケージ対応）...');

  // 累積統計アキュムレータ
  const trainerAccum = new Map<string, { total: number; wins: number; places: number }>();
  const trainerDistCatAccum = new Map<string, { total: number; wins: number }>();
  const trainerCondAccum = new Map<string, { total: number; wins: number }>();
  const trainerGradeAccum = new Map<string, { total: number; wins: number }>();
  const jockeyDistAccum = new Map<string, { total: number; wins: number }>();
  const jockeyCourseAccum = new Map<string, { total: number; wins: number }>();
  const sireTrackAccum = new Map<string, { total: number; wins: number }>();

  // レースごとの「その時点の」統計スナップショット
  const trainerSnap = new Map<string, Map<string, { winRate: number; placeRate: number }>>();
  const trainerDistCatSnap = new Map<string, Map<string, number>>();
  const trainerCondSnap = new Map<string, Map<string, number>>();
  const trainerGradeSnap = new Map<string, Map<string, number>>();
  const jockeyDistSnap = new Map<string, Map<string, number>>();
  const jockeyCourseSnap = new Map<string, Map<string, number>>();
  const sireTrackSnap = new Map<string, Map<string, number>>();
  // v7.0: コース×距離ペース累積スナップショット
  const coursePaceSnap = new Map<string, Map<string, number>>();

  // 日付順にスナップショットを構築
  const processedDates = new Set<string>();
  for (const pred of predictions) {
    if (processedDates.has(pred.date)) continue;
    processedDates.add(pred.date);

    // この日付の時点のスナップショットを保存
    const tSnap = new Map<string, { winRate: number; placeRate: number }>();
    for (const [name, s] of trainerAccum) {
      if (s.total >= 10) tSnap.set(name, { winRate: s.wins / s.total, placeRate: s.places / s.total });
    }
    trainerSnap.set(pred.date, tSnap);

    const tdcSnap = new Map<string, number>();
    for (const [key, s] of trainerDistCatAccum) {
      if (s.total >= 5) tdcSnap.set(key, s.wins / s.total);
    }
    trainerDistCatSnap.set(pred.date, tdcSnap);

    const tcSnap = new Map<string, number>();
    for (const [key, s] of trainerCondAccum) {
      if (s.total >= 5) tcSnap.set(key, s.wins / s.total);
    }
    trainerCondSnap.set(pred.date, tcSnap);

    const tgSnap = new Map<string, number>();
    for (const [key, s] of trainerGradeAccum) {
      if (s.total >= 5) tgSnap.set(key, s.wins / s.total);
    }
    trainerGradeSnap.set(pred.date, tgSnap);

    const jdSnap = new Map<string, number>();
    for (const [key, s] of jockeyDistAccum) {
      if (s.total >= 10) jdSnap.set(key, s.wins / s.total);
    }
    jockeyDistSnap.set(pred.date, jdSnap);

    const jcSnap = new Map<string, number>();
    for (const [key, s] of jockeyCourseAccum) {
      if (s.total >= 10) jcSnap.set(key, s.wins / s.total);
    }
    jockeyCourseSnap.set(pred.date, jcSnap);

    const stSnap = new Map<string, number>();
    for (const [key, s] of sireTrackAccum) {
      if (s.total >= 10) stSnap.set(key, s.wins / s.total);
    }
    sireTrackSnap.set(pred.date, stSnap);

    // v7.0: コース×距離ペーススナップショット
    const cpSnap = new Map<string, number>();
    for (const [key, s] of coursePaceAccum) {
      if (s.total >= 5) cpSnap.set(key, s.sum / s.total);
    }
    coursePaceSnap.set(pred.date, cpSnap);

    // この日付のレース結果で累積統計を更新
    for (const p of predictions.filter(pp => pp.date === pred.date)) {
      const raceEntries = entriesByRace.get(p.race_id) || [];
      for (const e of raceEntries) {
        // 調教師
        if (e.trainer_name) {
          const s = trainerAccum.get(e.trainer_name) || { total: 0, wins: 0, places: 0 };
          s.total++; if (e.result_position === 1) s.wins++; if (e.result_position <= 3) s.places++;
          trainerAccum.set(e.trainer_name, s);

          // 距離カテゴリ別
          const rDist = raceDistMap.get(e.race_id);
          if (rDist !== undefined) {
            const dCat = rDist <= 1400 ? 'sprint' : rDist <= 1800 ? 'mile' : 'long';
            const dcKey = `${e.trainer_name}__${dCat}`;
            const dc = trainerDistCatAccum.get(dcKey) || { total: 0, wins: 0 };
            dc.total++; if (e.result_position === 1) dc.wins++;
            trainerDistCatAccum.set(dcKey, dc);
          }

          // 馬場状態別 (重/不良)
          const rCond = p.track_condition;
          const isHeavy = rCond === '重' || rCond === '不良';
          const condKey = `${e.trainer_name}__${isHeavy ? 'heavy' : 'good'}`;
          const cc = trainerCondAccum.get(condKey) || { total: 0, wins: 0 };
          cc.total++; if (e.result_position === 1) cc.wins++;
          trainerCondAccum.set(condKey, cc);

          // 重賞
          const rGrade = p.grade;
          const isGraded = rGrade === 'G3' || rGrade === 'G2' || rGrade === 'G1';
          if (isGraded) {
            const gKey = `${e.trainer_name}__grade`;
            const gc = trainerGradeAccum.get(gKey) || { total: 0, wins: 0 };
            gc.total++; if (e.result_position === 1) gc.wins++;
            trainerGradeAccum.set(gKey, gc);
          }
        }
        // 騎手距離別
        if (e.jockey_id) {
          const dist = raceDistMap.get(e.race_id);
          if (dist !== undefined) {
            const bucket = Math.round(dist / 200) * 200;
            const key = `${e.jockey_id}__${bucket}`;
            const s = jockeyDistAccum.get(key) || { total: 0, wins: 0 };
            s.total++; if (e.result_position === 1) s.wins++;
            jockeyDistAccum.set(key, s);
          }
        }
        // 騎手コース別
        if (e.jockey_id) {
          const course = raceCourseMap.get(e.race_id);
          if (course) {
            const key = `${e.jockey_id}__${course}`;
            const s = jockeyCourseAccum.get(key) || { total: 0, wins: 0 };
            s.total++; if (e.result_position === 1) s.wins++;
            jockeyCourseAccum.set(key, s);
          }
        }
        // 種牡馬トラック別
        if (e.horse_id) {
          const father = horseFatherMap.get(e.horse_id);
          const trackType = raceTrackTypeMap.get(e.race_id);
          if (father && trackType) {
            const key = `${father}__${trackType}`;
            const s = sireTrackAccum.get(key) || { total: 0, wins: 0 };
            s.total++; if (e.result_position === 1) s.wins++;
            sireTrackAccum.set(key, s);
          }
        }
      }

      // v7.0: コース×距離ペース累積更新（1レースにつき1回）
      const racePaceVal = racePaceMap.get(p.race_id);
      if (racePaceVal !== undefined) {
        const course = raceCourseMap.get(p.race_id) ?? '';
        const dist = raceDistMap.get(p.race_id) ?? 0;
        const distBucket = Math.round(dist / 200) * 200;
        const cpKey = `${course}__${distBucket}`;
        const cp = coursePaceAccum.get(cpKey) || { total: 0, sum: 0 };
        cp.total++;
        cp.sum += racePaceVal;
        coursePaceAccum.set(cpKey, cp);
      }
    }
  }

  console.log(`累積スナップショット: ${processedDates.size}日分`);

  // 6. 特徴量ベクトル構築
  const rows: Array<{
    race_id: string;
    horse_number: number;
    features: number[];
    label_win: number;
    label_place: number;
    position: number;
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

    // この日付時点の統計スナップショット
    const tStats = trainerSnap.get(pred.date) || new Map();
    const tdcStats = trainerDistCatSnap.get(pred.date) || new Map();
    const tcStats = trainerCondSnap.get(pred.date) || new Map();
    const tgStats = trainerGradeSnap.get(pred.date) || new Map();
    const jdStats = jockeyDistSnap.get(pred.date) || new Map();
    const jcStats = jockeyCourseSnap.get(pred.date) || new Map();
    const stStats = sireTrackSnap.get(pred.date) || new Map();
    const cpStats = coursePaceSnap.get(pred.date) || new Map();

    // meetDay extraction from raceId
    const meetDay = pred.race_id.length >= 10 ? parseInt(pred.race_id.substring(8, 10)) || 1 : 1;

    for (const entry of raceEntries) {
      const scores = horseScores[String(entry.horse_number)];
      if (!scores) continue;

      const popularity = entry.popularity ?? Math.ceil(fieldSize / 2);

      // リーケージフリーの統計値
      const trainerStat = tStats.get(entry.trainer_name ?? '') ?? { winRate: 0.08, placeRate: 0.20 };
      const fatherName = entry.horse_id ? horseFatherMap.get(entry.horse_id) : undefined;
      const distBucket = Math.round(pred.distance / 200) * 200;
      const jockeyDistWR = entry.jockey_id ? (jdStats.get(`${entry.jockey_id}__${distBucket}`) ?? 0.08) : 0.08;
      const jockeyCourseWR = entry.jockey_id ? (jcStats.get(`${entry.jockey_id}__${pred.racecourse_name}`) ?? 0.08) : 0.08;
      const sireTrackWR = fatherName ? (stStats.get(`${fatherName}__${pred.track_type}`) ?? 0.07) : 0.07;

      // === v6.0 新特徴量 ===
      const horsePerfs = entry.horse_id
        ? (ppByHorse.get(entry.horse_id) || []).filter(pp => pp.date < pred.date)
        : [];

      // 騎手乗替シグナル
      let jockeySwitchQuality = 0;
      if (horsePerfs.length > 0 && entry.jockey_name) {
        const lastJockey = horsePerfs[0].jockey_name;
        if (lastJockey && lastJockey !== entry.jockey_name) {
          // 乗り替わりあり → 騎手力スコア差で品質を近似
          jockeySwitchQuality = (scores.jockeyAbility ?? 50) - 50; // 正値=格上乗替
        }
      }

      // コーナー加速（直近5走平均）
      let cornerDelta = 0;
      const cornerPerfs = horsePerfs.slice(0, 5).filter(pp => pp.corner_positions);
      if (cornerPerfs.length > 0) {
        const deltas = cornerPerfs.map(pp => parseCornerDelta(pp.corner_positions));
        cornerDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
      }

      // 着差定量化
      let avgMarginWin = 0;
      let avgMarginLose = 0;
      const winPerfs = horsePerfs.filter(pp => pp.position === 1 && pp.margin);
      const losePerfs = horsePerfs.filter(pp => pp.position > 1 && pp.margin);
      if (winPerfs.length > 0) {
        avgMarginWin = winPerfs.reduce((s, pp) => s + marginToSeconds(pp.margin), 0) / winPerfs.length;
      }
      if (losePerfs.length > 0) {
        avgMarginLose = losePerfs.reduce((s, pp) => s + marginToSeconds(pp.margin), 0) / losePerfs.length;
      }

      // 休養日数（連続値）
      let daysSinceLastRace = 30; // デフォルト
      if (horsePerfs.length > 0) {
        const lastDate = new Date(horsePerfs[0].date);
        const raceDate = new Date(pred.date);
        daysSinceLastRace = Math.max(0, Math.round((raceDate.getTime() - lastDate.getTime()) / 86400000));
      }

      // 調教師パターン特徴量
      const distCat = pred.distance <= 1400 ? 'sprint' : pred.distance <= 1800 ? 'mile' : 'long';
      const isHeavy = pred.track_condition === '重' || pred.track_condition === '不良';
      const isGrade = pred.grade === 'G3' || pred.grade === 'G2' || pred.grade === 'G1';
      const trainerDistCatWR = entry.trainer_name
        ? (tdcStats.get(`${entry.trainer_name}__${distCat}`) ?? 0.08) : 0.08;
      const trainerCondWR = entry.trainer_name
        ? (tcStats.get(`${entry.trainer_name}__${isHeavy ? 'heavy' : 'good'}`) ?? 0.08) : 0.08;
      const trainerGradeWR = (entry.trainer_name && isGrade)
        ? (tgStats.get(`${entry.trainer_name}__grade`) ?? 0.08) : 0.08;

      // === v7.0 ラップタイム基盤特徴量 ===
      // 馬の過去レースのペース傾向
      let horsePacePreference = 0.5; // デフォルト: ミドル
      let horseHaiPaceRate = 0.0;
      const perfRaceIds = horsePerfs
        .filter(pp => pp.race_id)
        .map(pp => ({ raceId: pp.race_id!, pace: racePaceMap.get(pp.race_id!) }))
        .filter(x => x.pace !== undefined);
      if (perfRaceIds.length > 0) {
        horsePacePreference = perfRaceIds.reduce((s, x) => s + x.pace!, 0) / perfRaceIds.length;
        horseHaiPaceRate = perfRaceIds.filter(x => x.pace! >= 0.9).length / perfRaceIds.length;
      }

      // コース×距離の典型ペース
      const cpKey = `${pred.racecourse_name}__${distBucket}`;
      const courseDistPaceAvg = cpStats.get(cpKey) ?? 0.5;

      // 脚質×ペース相性
      // 追込馬(runningStyle高)はハイペースで有利、逃げ馬(低)はスローで有利
      const runStyleNorm = (scores.runningStyle ?? 50) / 100;
      const paceStyleMatch = runStyleNorm * courseDistPaceAvg + (1 - runStyleNorm) * (1 - courseDistPaceAvg);

      // === v8.0 直近フォーム + キャリア特徴量 ===
      // 前走着順
      const lastRacePosition = horsePerfs.length > 0 ? horsePerfs[0].position : 9;

      // 直近3走の勝率・複勝率
      const last3 = horsePerfs.slice(0, 3);
      const last3WinRate = last3.length > 0
        ? last3.filter(pp => pp.position === 1).length / last3.length : 0;
      const last3PlaceRate = last3.length > 0
        ? last3.filter(pp => pp.position <= 3).length / last3.length : 0;

      // クラス変動 (今走グレード - 前走グレード)
      let classChange = 0;
      if (horsePerfs.length > 0 && horsePerfs[0].grade) {
        const prevGrade = GRADE_ENCODE[horsePerfs[0].grade] ?? 3;
        const curGrade = GRADE_ENCODE[pred.grade ?? ''] ?? 3;
        classChange = curGrade - prevGrade;
      }

      // 芝↔ダート替わり
      let trackTypeChange = 0;
      if (horsePerfs.length > 0 && horsePerfs[0].track_type) {
        const prevTrackType = horsePerfs[0].track_type;
        // 前走と今走のトラックタイプが異なる場合
        if ((prevTrackType === '芝' && pred.track_type !== '芝') ||
            (prevTrackType !== '芝' && pred.track_type === '芝')) {
          trackTypeChange = 1;
        }
      }

      // 通算勝率
      const careerWinRate = horsePerfs.length > 0
        ? horsePerfs.filter(pp => pp.position === 1).length / horsePerfs.length : 0;

      // レース内相対オッズ (log(odds / レース中央値オッズ))
      const raceOdds = raceEntries
        .map(e2 => e2.odds)
        .filter((o): o is number => o !== null && o > 0)
        .sort((a, b) => a - b);
      const medianOdds = raceOdds.length > 0
        ? raceOdds[Math.floor(raceOdds.length / 2)] : 10;
      const relativeOdds = entry.odds && entry.odds > 0
        ? Math.log(entry.odds / medianOdds) : 0;

      // 連勝数
      let winStreak = 0;
      for (const pp of horsePerfs) {
        if (pp.position === 1) winStreak++;
        else break;
      }

      // 交互作用特徴量
      const weightXspeed = (entry.handicap_weight ?? 54) * ((scores.speedRating ?? 50) / 100);
      const ageXdistance = (entry.age ?? 3) * (pred.distance / 1000);
      const jockeyXform = ((scores.jockeyAbility ?? 50) / 100) * ((scores.recentForm ?? 50) / 100);
      const fieldSizeXpost = fieldSize * ((entry.post_position ?? 1) / fieldSize);
      const rotationXform = ((scores.rotation ?? 50) / 100) * ((scores.recentForm ?? 50) / 100);
      const conditionXsire = (TRACK_CONDITION_ENCODE[pred.track_condition ?? '良'] ?? 0) * ((scores.sireAptitude ?? 50) / 100);

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
          case 'weather_encoded': return WEATHER_ENCODE[pred.weather ?? ''] ?? 0;
          case 'weightChange': return entry.result_weight_change ?? 0;
          case 'trainerWinRate': return trainerStat.winRate;
          case 'trainerPlaceRate': return trainerStat.placeRate;
          case 'sireTrackWinRate': return sireTrackWR;
          case 'jockeyDistanceWinRate': return jockeyDistWR;
          case 'jockeyCourseWinRate': return jockeyCourseWR;
          // v6.0 新特徴量
          case 'jockeySwitchQuality': return jockeySwitchQuality;
          case 'cornerDelta': return cornerDelta;
          case 'avgMarginWhenWinning': return avgMarginWin;
          case 'avgMarginWhenLosing': return avgMarginLose;
          case 'daysSinceLastRace': return daysSinceLastRace;
          // v6.1 開催週 + 調教師パターン
          case 'meetDay': return meetDay;
          case 'trainerDistCatWinRate': return trainerDistCatWR;
          case 'trainerCondWinRate': return trainerCondWR;
          case 'trainerGradeWinRate': return trainerGradeWR;
          // 交互作用
          case 'weightXspeed': return weightXspeed;
          case 'ageXdistance': return ageXdistance;
          case 'jockeyXform': return jockeyXform;
          case 'fieldSizeXpost': return fieldSizeXpost;
          case 'rotationXform': return rotationXform;
          case 'conditionXsire': return conditionXsire;
          // v7.0 ラップタイム基盤
          case 'horsePacePreference': return horsePacePreference;
          case 'horseHaiPaceRate': return horseHaiPaceRate;
          case 'courseDistPaceAvg': return courseDistPaceAvg;
          case 'paceStyleMatch': return paceStyleMatch;
          // v8.0 直近フォーム + キャリア特徴量
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
        features,
        label_win: entry.result_position === 1 ? 1 : 0,
        label_place: entry.result_position <= 3 ? 1 : 0,
        position: entry.result_position,
        odds: entry.odds ?? null,
        track_type_encoded: TRACK_TYPE_ENCODE[pred.track_type] ?? 0,
        distance_val: pred.distance,
      });
    }
  }

  console.log(`\nスキップ(horseScoresなし): ${skippedNoScores}件`);
  console.log(`学習サンプル数: ${rows.length}件`);
  console.log(`特徴量数: ${FEATURE_NAMES.length}`);
  console.log(`勝利ラベル: ${rows.filter(r => r.label_win === 1).length}件`);
  console.log(`複勝ラベル: ${rows.filter(r => r.label_place === 1).length}件`);

  // JSON出力
  const outputPath = join(process.cwd(), 'model', 'training_data.json');
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
