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
import { calcTimeFeatures, calcPaceFeatures, calcL3fRelative, parseTimeToSeconds, parseLastThreeFurlongs } from '../src/lib/time-features';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

// 特徴量名の順序定義（v7.0 SHAP分析後クリーニング）
// 除去済み: courseAptitude, classPerformance, jockeyTrainerCombo,
//          historicalPostBias, trackType_encoded, weightChange, odds (raw)
// v11.0: ablation studyでノイズ特徴量22個を削除（フルモデル=オッズあり で実施）
// 注意: jockeyAbility, trainerDistCatWinRate はno-oddsモデルでは唯一のnon-zero permutation importance
//       → v13.0でno-odds用に復活
// 削除済み（オッズありモデルで冗長確認済み）: trainerAbility, trainerWinRate, trainerPlaceRate,
//           trainerCondWinRate, trainerGradeWinRate,
//           jockeyDistanceWinRate, jockeyCourseWinRate, jockeySwitchQuality,
//           weightXspeed, ageXdistance, jockeyXform, fieldSizeXpost, rotationXform, formXclassChange,
//           gradeXtrainer, earlyPositionRatio, positionGainAvg, l3fRelativeAvg, courseDistPaceAvg, paceStyleMatch
const FEATURE_NAMES = [
  // ファクタースコア (SHAP分析で有効確認済み)
  'recentForm', 'distanceAptitude', 'trackConditionAptitude',
  'speedRating', 'runningStyle',
  'postPositionBias', 'rotation', 'lastThreeFurlongs', 'consistency',
  'sireAptitude',
  'seasonalPattern', 'handicapAdvantage',
  'marginCompetitiveness',
  // v13.0: no-oddsモデルで唯一permutation importance > 0 だった特徴量を復活
  'jockeyAbility',           // perm_importance=0.20, Cohen's d=0.77
  'trainerDistCatWinRate',   // perm_importance=0.089, Cohen's d=0.35
  // コンテキスト特徴量
  'fieldSize', 'popularity', 'age', 'sex_encoded',
  'handicapWeight', 'postPosition', 'grade_encoded',
  'distance', 'trackCondition_encoded', 'oddsLogTransform', 'popularityRatio',
  // 統計特徴量
  'weather_encoded',
  'sireTrackWinRate',
  // v6.0: 新特徴量
  'cornerDelta',              // コーナー通過順位差（加速指標）
  'avgMarginWhenWinning',     // 勝ち時平均着差（圧勝力）
  'avgMarginWhenLosing',      // 負け時平均着差（接戦力）
  'daysSinceLastRace',        // 休養日数（連続値）
  // v6.1: 開催週
  'meetDay',                    // 開催何日目（トラック劣化）
  // v6.0: 交互作用特徴量 (残留)
  'conditionXsire',           // 馬場状態×血統適性
  // v8.0: 直近フォーム + キャリア特徴量
  'lastRacePosition',        // 前走着順 (1-18, デフォルト9)
  'last3WinRate',             // 直近3走の勝率 (0-1)
  'last3PlaceRate',           // 直近3走の複勝率 (0-1)
  'careerWinRate',            // 通算勝率 (0-1)
  'relativeOdds',             // レース内相対オッズ (log(odds/中央値))
  'winStreak',                // 連勝数 (0-N)
  // v9.0: 新特徴量
  'relativePosition',         // 相対着順 (前走着順/前走出走頭数)
  'upsetRate',                // 穴馬力 (人気5番以下好走率)
  'avgPastOdds',              // 好走時平均オッズ (log変換)
  // v10.0: 走破タイム標準化 + weight復活
  'standardTimeDev',          // 走破タイム標準化偏差（直近5走加重平均）
  'bestTimeDev',              // 過去最高標準化タイム偏差
  'timeConsistency',          // タイム偏差の標準偏差（安定性の逆数）
  'weightStability',          // 馬体重安定性
  'weightTrendSlope',         // 馬体重トレンド傾き
  'weightOptimalDelta',       // 最適体重との差
  // Phase 3: 新特徴量 (#12-#16)
  'bodyWeightTrend',          // #12: 馬体重トレンド（3-5走移動平均傾き）
  'distanceChange',           // #13: 前走比距離変化（連続値）
  'jockeyTrainerWinRate',     // #14: 騎手×調教師コンボ勝率
  'horseCourseWinRate',       // #15: 競走馬×競馬場勝率
  'escaperCount',             // #16: 逃げ・先行馬数（先頭3番手以内）
  'jockeyXdistance',          // #17: 騎手距離別WR×距離
  // v12.0: タイム指数特徴量（netkeiba外部データ）
  'avgTimeIndex',             // 直近5走加重平均タイム指数
  'bestTimeIndex',            // 過去最高タイム指数
  'timeIndexTrend',           // タイム指数の傾き（上昇/下降）
  // v13.0: コース形状特徴量（静的テーブル、DB不要）
  'straightLength',           // 最終直線の長さ（正規化 0-1）
  'isWesternGrass',           // 洋芝フラグ（札幌/函館）
  'styleXstraight',           // 脚質×直線長交互作用（差し馬は長直線で有利）
  // v14.0: データ駆動枠順バイアス
  'drawBiasZScore',           // (競馬場,距離バケット,トラック)別の枠勝率Z-Score
  // v14.1: 種牡馬バリエーション
  'sireDistWinRate',          // 種牡馬×距離カテゴリ別勝率
  'sireCondWinRate',          // 種牡馬×馬場状態別勝率
  // v14.1: PCI (ペースチェンジ指数)
  'pciAvg',                   // 直近5走のPCI加重平均（高い=前傾ラップ傾向）
  // v15.0: 直近フォーム（30日窓）
  'jockeyRecentWinRate',      // 騎手の直近30日勝率
  'trainerRecentWinRate',     // 調教師の直近30日勝率
  // v15.0: 馬場×脚質交互作用
  'conditionXstyle',          // 馬場状態×脚質（重馬場での逃げ馬有利度など）
  // v15.0: 追い切り評価
  'oikiriRank',               // 追い切り評価 (A=3, B=2, C=1, D=0, 不明=1.5)
  // v16.0: ドメイン知識復活（オッズ支配を減らした削減モデルで有効性を再検証）
  'jockeyChanged',            // 乗り替わりフラグ (0=同騎手, 1=乗替)
  'earlyPositionRatio',       // 一角確保率（直近5走の1角位置/出走頭数 加重平均、低い=前方）
];

const SEX_ENCODE: Record<string, number> = { '牡': 0, '牝': 1, 'セ': 2 };
const TRACK_TYPE_ENCODE: Record<string, number> = { '芝': 0, 'ダート': 1, '障害': 2 };
const TRACK_CONDITION_ENCODE: Record<string, number> = { '良': 0, '稍重': 1, '重': 2, '不良': 3 };
const WEATHER_ENCODE: Record<string, number> = { '晴': 0, '曇': 1, '小雨': 2, '雨': 3, '小雪': 4, '雪': 5 };
// v13.0: コース形状（静的データ、直線長はメートル）
const COURSE_GEOMETRY: Record<string, { straight: number; western: boolean }> = {
  '東京': { straight: 525, western: false },
  '中山': { straight: 310, western: false },
  '阪神': { straight: 474, western: false },
  '京都': { straight: 404, western: false },
  '中京': { straight: 413, western: false },
  '小倉': { straight: 293, western: false },
  '新潟': { straight: 659, western: false },
  '札幌': { straight: 266, western: true },
  '函館': { straight: 262, western: true },
  '福島': { straight: 292, western: false },
};
const MAX_STRAIGHT = 659; // 新潟外回り

const GRADE_ENCODE: Record<string, number> = {
  '新馬': 0, '未勝利': 1, '1勝クラス': 2, '2勝クラス': 3,
  '3勝クラス': 4, 'リステッド': 5, 'オープン': 5,
  'G3': 6, 'G2': 7, 'G1': 8,
};

/**
 * レース名からグレードを推定（past_performances.race_id がNULLでJOINできない場合のフォールバック）
 */
function inferGradeFromRaceName(raceName: string | null): string | null {
  if (!raceName) return null;
  if (raceName.includes('新馬')) return '新馬';
  if (raceName.includes('未勝利')) return '未勝利';
  if (raceName.includes('1勝')) return '1勝クラス';
  if (raceName.includes('2勝')) return '2勝クラス';
  if (raceName.includes('3勝')) return '3勝クラス';
  // GI/GII/GIII はレース名自体からは判別しにくいが、重賞名はDBにある
  return null;
}

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
  race_name: string | null;
  prize: number;
  // v9.0: 新特徴量用
  entries: number | null;
  odds: number | null;
  popularity: number | null;
  weight: number | null;
  racecourse_name: string | null;
  distance: number | null;
  // v10.0: 走破タイム + L3F + 馬場
  time: string | null;
  last_three_furlongs: string | null;
  track_condition: string | null;
  // v12.0: タイム指数
  time_index: number | null;
  track_index: number | null;
  // v14.0: 枠順
  post_position: number | null;
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

  // 過去成績データ取得（騎手乗替、コーナー、着差、休養日数、ペース特徴量、馬体重、コース用）
  const [ppResult, racePaceResult, horseResult] = await Promise.all([
    db.execute(`
      SELECT pp.horse_id, pp.race_id, pp.date, pp.position, pp.jockey_name, pp.margin, pp.corner_positions,
             pp.entries, pp.odds, pp.popularity, pp.race_name, pp.prize,
             pp.weight, pp.racecourse_name, pp.distance, pp.post_position,
             pp.time, pp.last_three_furlongs, pp.track_condition,
             pp.time_index, pp.track_index,
             r.grade, COALESCE(r.track_type, pp.track_type) as track_type
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

  // v15.0: 追い切り評価データ読み込み
  const OIKIRI_FILE = join(process.cwd(), 'model', 'oikiri_data.json');
  const OIKIRI_RANK_ENCODE: Record<string, number> = { 'A': 3, 'B': 2, 'C': 1, 'D': 0 };
  const oikiriMap = new Map<string, number>(); // key: raceId__horseNumber -> rank score
  try {
    const oikiriRaw = JSON.parse(readFileSync(OIKIRI_FILE, 'utf-8'));
    let oikiriCount = 0;
    for (const [raceId, race] of Object.entries(oikiriRaw) as any) {
      for (const entry of race.entries || []) {
        const key = `${raceId}__${entry.horseNumber}`;
        oikiriMap.set(key, OIKIRI_RANK_ENCODE[entry.rank] ?? 1.5);
        oikiriCount++;
      }
    }
    console.log(`追い切りデータ: ${oikiriCount}件 (${Object.keys(oikiriRaw).length}レース)`);
  } catch {
    console.log('追い切りデータなし（oikiri_data.json未生成）');
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
  // v14.1: 種牡馬バリエーション
  const sireDistAccum = new Map<string, { total: number; wins: number }>();  // sire__distBucket
  const sireCondAccum = new Map<string, { total: number; wins: number }>();  // sire__condition(heavy/good)
  // v14.0: drawBiasZScore — (racecourse, distBucket, trackType, postPosition) 別勝率
  const drawBiasAccum = new Map<string, { total: number; wins: number }>();
  // v15.0: 直近30日フォーム（スライディングウィンドウ）
  const jockeyRecentEvents = new Map<string, Array<{ date: string; won: boolean }>>();
  const trainerRecentEvents = new Map<string, Array<{ date: string; won: boolean }>>();

  // レースごとの「その時点の」統計スナップショット
  const trainerSnap = new Map<string, Map<string, { winRate: number; placeRate: number }>>();
  const trainerDistCatSnap = new Map<string, Map<string, number>>();
  const trainerCondSnap = new Map<string, Map<string, number>>();
  const trainerGradeSnap = new Map<string, Map<string, number>>();
  const jockeyDistSnap = new Map<string, Map<string, number>>();
  const jockeyCourseSnap = new Map<string, Map<string, number>>();
  const sireTrackSnap = new Map<string, Map<string, number>>();
  // v14.1: 種牡馬バリエーションスナップショット
  const sireDistSnap = new Map<string, Map<string, number>>();
  const sireCondSnap = new Map<string, Map<string, number>>();
  // v7.0: コース×距離ペース累積スナップショット
  const coursePaceSnap = new Map<string, Map<string, number>>();
  // v14.0: drawBiasZScoreスナップショット — key=(course__distBucket__trackType__postPos) → winRate
  const drawBiasSnap = new Map<string, Map<string, number>>();
  // v15.0: 直近30日フォームスナップショット
  const jockeyRecentSnap = new Map<string, Map<string, number>>();
  const trainerRecentSnap = new Map<string, Map<string, number>>();

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

    // v14.1: 種牡馬バリエーションスナップショット
    const sdSnap = new Map<string, number>();
    for (const [key, s] of sireDistAccum) {
      if (s.total >= 10) sdSnap.set(key, s.wins / s.total);
    }
    sireDistSnap.set(pred.date, sdSnap);

    const scSnap = new Map<string, number>();
    for (const [key, s] of sireCondAccum) {
      if (s.total >= 10) scSnap.set(key, s.wins / s.total);
    }
    sireCondSnap.set(pred.date, scSnap);

    // v7.0: コース×距離ペーススナップショット
    const cpSnap = new Map<string, number>();
    for (const [key, s] of coursePaceAccum) {
      if (s.total >= 5) cpSnap.set(key, s.sum / s.total);
    }
    coursePaceSnap.set(pred.date, cpSnap);

    // v14.0: drawBiasスナップショット
    const dbSnap = new Map<string, number>();
    for (const [key, s] of drawBiasAccum) {
      if (s.total >= 5) dbSnap.set(key, s.wins / s.total);
    }
    drawBiasSnap.set(pred.date, dbSnap);

    // v15.0: 騎手直近30日勝率スナップショット
    const jrSnap = new Map<string, number>();
    const cutoff30 = new Date(new Date(pred.date).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const [jid, events] of jockeyRecentEvents) {
      const recent = events.filter(e => e.date >= cutoff30 && e.date < pred.date);
      if (recent.length >= 5) {
        jrSnap.set(jid, recent.filter(e => e.won).length / recent.length);
      }
    }
    jockeyRecentSnap.set(pred.date, jrSnap);

    // v15.0: 調教師直近30日勝率スナップショット
    const trSnap = new Map<string, number>();
    for (const [name, events] of trainerRecentEvents) {
      const recent = events.filter(e => e.date >= cutoff30 && e.date < pred.date);
      if (recent.length >= 5) {
        trSnap.set(name, recent.filter(e => e.won).length / recent.length);
      }
    }
    trainerRecentSnap.set(pred.date, trSnap);

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

            // v14.1: 種牡馬距離別
            const rDist = raceDistMap.get(e.race_id) ?? 0;
            const dCat = rDist <= 1400 ? 'sprint' : rDist <= 1800 ? 'mile' : 'long';
            const sdKey = `${father}__${dCat}`;
            const sd = sireDistAccum.get(sdKey) || { total: 0, wins: 0 };
            sd.total++; if (e.result_position === 1) sd.wins++;
            sireDistAccum.set(sdKey, sd);

            // v14.1: 種牡馬馬場状態別
            const cond = p.track_condition ?? '良';
            const isHeavy = cond === '重' || cond === '不良';
            const scKey = `${father}__${isHeavy ? 'heavy' : 'good'}`;
            const sc = sireCondAccum.get(scKey) || { total: 0, wins: 0 };
            sc.total++; if (e.result_position === 1) sc.wins++;
            sireCondAccum.set(scKey, sc);
          }
        }
        // v14.0: drawBias — (course, distBucket, trackType, postPosition) 別勝率
        if (e.post_position) {
          const course = raceCourseMap.get(e.race_id) ?? '';
          const dist = raceDistMap.get(e.race_id) ?? 0;
          const distBucket = dist <= 1400 ? 'sprint' : dist <= 1800 ? 'mile' : 'long';
          const trackType = raceTrackTypeMap.get(e.race_id) ?? '';
          const dbKey = `${course}__${distBucket}__${trackType}__${e.post_position}`;
          const db2 = drawBiasAccum.get(dbKey) || { total: 0, wins: 0 };
          db2.total++; if (e.result_position === 1) db2.wins++;
          drawBiasAccum.set(dbKey, db2);
        }
        // v15.0: 騎手・調教師の直近イベント記録（30日窓用）
        if (e.jockey_id) {
          const events = jockeyRecentEvents.get(e.jockey_id) || [];
          events.push({ date: p.date, won: e.result_position === 1 });
          jockeyRecentEvents.set(e.jockey_id, events);
        }
        if (e.trainer_name) {
          const events = trainerRecentEvents.get(e.trainer_name) || [];
          events.push({ date: p.date, won: e.result_position === 1 });
          trainerRecentEvents.set(e.trainer_name, events);
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
    odds: number | null;
    track_type_encoded: number;
    distance_val: number;
    recency_weight: number;
  }> = [];

  // 最新レース日付（predictions は既に日付順ソート済み）
  const maxDate = new Date(predictions[predictions.length - 1].date);

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
    const sdStats = sireDistSnap.get(pred.date) || new Map();
    const scStats = sireCondSnap.get(pred.date) || new Map();
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
      // v14.1: 種牡馬バリエーション
      const sireDistCat = pred.distance <= 1400 ? 'sprint' : pred.distance <= 1800 ? 'mile' : 'long';
      const sireDistWR = fatherName ? (sdStats.get(`${fatherName}__${sireDistCat}`) ?? 0.07) : 0.07;
      const sireCondHeavy = (pred.track_condition === '重' || pred.track_condition === '不良');
      const sireCondWR = fatherName ? (scStats.get(`${fatherName}__${sireCondHeavy ? 'heavy' : 'good'}`) ?? 0.07) : 0.07;

      // === v6.0 新特徴量 ===
      const horsePerfs = entry.horse_id
        ? (ppByHorse.get(entry.horse_id) || []).filter(pp => pp.date < pred.date)
        : [];

      // 騎手乗替シグナル
      let jockeySwitchQuality = 0;
      let jockeyChanged = 0;
      if (horsePerfs.length > 0 && entry.jockey_name) {
        const lastJockey = horsePerfs[0].jockey_name;
        if (lastJockey && lastJockey !== entry.jockey_name) {
          jockeyChanged = 1;
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

      // === Phase 3 新特徴量 ===

      // #12: 馬体重トレンド（直近5走）
      const recentWeights = horsePerfs.slice(0, 5).map(pp => pp.weight ?? 0).filter(w => w > 0);
      const bodyWeightTrend = recentWeights.length >= 3
        ? (recentWeights[0] - recentWeights[recentWeights.length - 1]) / recentWeights.length
        : 0;

      // #13: 前走比距離変化
      const distanceChange = horsePerfs.length > 0 && (horsePerfs[0].distance ?? 0) > 0
        ? pred.distance - (horsePerfs[0].distance ?? pred.distance)
        : 0;

      // #14: 騎手×調教師コンボ勝率（過去成績で同騎手かつ同調教師のケースを近似）
      // 訓練データでは正確なコンボが難しいため、積で近似し調整
      const jockeyTrainerWinRate = jockeyDistWR * trainerStat.winRate * 10;

      // #15: 競走馬×競馬場勝率
      const coursePerfs = horsePerfs.filter(pp => pp.racecourse_name === pred.racecourse_name);
      const horseCourseWinRate = coursePerfs.length >= 3
        ? coursePerfs.filter(pp => pp.position === 1).length / coursePerfs.length
        : 0.05;

      // #16: 逃げ・先行馬数（同レース内で最初のコーナーを3番手以内通過する馬）
      let escaperCount = 0;
      for (const e of raceEntries) {
        const ePerfs = e.horse_id
          ? (ppByHorse.get(e.horse_id) || []).filter(pp => pp.date < pred.date)
          : [];
        if (ePerfs.length > 0) {
          // Use weighted average of last 3 races (more recent = higher weight)
          const last3 = ePerfs.slice(0, 3);
          const weights = [0.5, 0.3, 0.2];
          let weightedEscaperScore = 0;
          let totalWeight = 0;
          for (let i = 0; i < last3.length; i++) {
            const corners = last3[i].corner_positions;
            if (corners) {
              const firstCorner = parseInt(corners.split('-')[0]);
              if (!isNaN(firstCorner)) {
                const w = weights[i] ?? 0.1;
                weightedEscaperScore += (firstCorner <= 3 ? 1 : 0) * w;
                totalWeight += w;
              }
            }
          }
          if (totalWeight > 0 && weightedEscaperScore / totalWeight > 0.5) {
            escaperCount++;
          }
        }
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

      // === v9.0 新特徴量 ===
      // 相対着順 (前走着順 / 前走出走頭数)
      const relativePosition = horsePerfs.length > 0 && (horsePerfs[0].entries ?? 0) > 0
        ? horsePerfs[0].position / horsePerfs[0].entries! : 0.5;

      // 穴馬力 (人気5番以下かつ3着以内の率)
      const longshotPerfs = horsePerfs.filter(pp => (pp.popularity ?? 0) >= 5);
      const upsetRate = longshotPerfs.length > 0
        ? longshotPerfs.filter(pp => pp.position <= 3).length / longshotPerfs.length : 0.1;

      // 好走時平均オッズ (log変換)
      const placedPerfsWithOdds = horsePerfs.filter(pp => pp.position <= 3 && (pp.odds ?? 0) > 0);
      const avgPastOdds = placedPerfsWithOdds.length > 0
        ? Math.log(placedPerfsWithOdds.reduce((s, pp) => s + pp.odds!, 0) / placedPerfsWithOdds.length)
        : Math.log(10);

      // === v10.0 走破タイム標準化 + ペース再設計 + L3F ===
      const ppForTimeFeatures = horsePerfs.map(pp => ({
        time: pp.time,
        trackType: pp.track_type || 'ダート',
        distance: pp.distance || 0,
        trackCondition: pp.track_condition || '良',
        position: pp.position,
      }));
      const timeFeats = calcTimeFeatures(ppForTimeFeatures);

      // v14.1: PCI (ペースチェンジ指数) = front_time / l3f_time
      let pciAvg = 1.0; // デフォルト: ニュートラルペース
      {
        const pciValues: number[] = [];
        for (const pp of horsePerfs.slice(0, 5)) {
          const totalSec = parseTimeToSeconds(pp.time);
          const l3fSec = parseLastThreeFurlongs(pp.last_three_furlongs);
          if (totalSec > 0 && l3fSec > 0 && totalSec > l3fSec) {
            const frontSec = totalSec - l3fSec;
            pciValues.push(frontSec / l3fSec);
          }
        }
        if (pciValues.length > 0) {
          const weights = pciValues.map((_, i) => Math.exp(-i * 0.3));
          const wSum = weights.reduce((a, b) => a + b, 0);
          pciAvg = pciValues.reduce((s, v, i) => s + v * weights[i], 0) / wSum;
        }
      }

      const ppForPaceFeatures = horsePerfs.map(pp => ({
        cornerPositions: pp.corner_positions,
        entries: pp.entries || 0,
        position: pp.position,
      }));
      const paceFeats = calcPaceFeatures(ppForPaceFeatures);

      const l3fRelativeAvg = calcL3fRelative(horsePerfs.map(pp => ({
        lastThreeFurlongs: pp.last_three_furlongs,
        distance: pp.distance || 0,
        trackType: pp.track_type || 'ダート',
        position: pp.position,
      })));

      // weight特徴量（weight-trend.tsのロジック簡易版）
      const weightsArr = horsePerfs.slice(0, 10).map(pp => pp.weight).filter((w): w is number => w != null && w > 0);
      let weightStability = 50;
      let weightTrendSlope = 0;
      let weightOptimalDelta = 0;
      if (weightsArr.length >= 2) {
        const mean = weightsArr.reduce((s, w) => s + w, 0) / weightsArr.length;
        const variance = weightsArr.reduce((s, w) => s + (w - mean) ** 2, 0) / weightsArr.length;
        const stdDev = Math.sqrt(variance);
        weightStability = Math.max(0, Math.min(100, 100 - stdDev * 10));
        // 傾き: 直近 - 最古
        weightTrendSlope = (weightsArr[0] - weightsArr[weightsArr.length - 1]) / weightsArr.length;
        // 最適体重との差: ベストレース時体重 vs 現在
        const bestPerf = horsePerfs.slice(0, 10).filter(pp => pp.position <= 3 && pp.weight != null && pp.weight > 0);
        if (bestPerf.length > 0) {
          const optWeight = bestPerf.reduce((s, pp) => s + pp.weight!, 0) / bestPerf.length;
          weightOptimalDelta = weightsArr[0] - optWeight;
        }
      }

      // === v12.0 タイム指数特徴量 ===
      const tiPerfs = horsePerfs.slice(0, 10).map(pp => pp.time_index).filter((ti): ti is number => ti != null);
      let avgTimeIndex = 0;
      let bestTimeIndex = 0;
      let timeIndexTrend = 0;
      if (tiPerfs.length > 0) {
        // 加重平均（直近重視）
        const weights = tiPerfs.map((_, i) => Math.exp(-i * 0.3));
        const wSum = weights.reduce((s, w) => s + w, 0);
        avgTimeIndex = tiPerfs.reduce((s, ti, i) => s + ti * weights[i], 0) / wSum;
        bestTimeIndex = Math.max(...tiPerfs);
        // トレンド（直近 - 古い方の平均）
        if (tiPerfs.length >= 3) {
          const recent = tiPerfs.slice(0, Math.ceil(tiPerfs.length / 2));
          const older = tiPerfs.slice(Math.ceil(tiPerfs.length / 2));
          const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
          const olderAvg = older.reduce((s, v) => s + v, 0) / older.length;
          timeIndexTrend = recentAvg - olderAvg;
        }
      }

      // 交互作用特徴量
      const weightXspeed = (entry.handicap_weight ?? 54) * ((scores.speedRating ?? 50) / 100);
      const ageXdistance = (entry.age ?? 3) * (pred.distance / 1000);
      const jockeyXform = ((scores.jockeyAbility ?? 50) / 100) * ((scores.recentForm ?? 50) / 100);
      const fieldSizeXpost = fieldSize * ((entry.post_position ?? 1) / fieldSize);
      const rotationXform = ((scores.rotation ?? 50) / 100) * ((scores.recentForm ?? 50) / 100);
      const conditionXsire = (TRACK_CONDITION_ENCODE[pred.track_condition ?? '良'] ?? 0) * ((scores.sireAptitude ?? 50) / 100);

      // #17: Phase 3 追加交互作用特徴量
      const gradeXtrainer = (GRADE_ENCODE[pred.grade ?? ''] ?? 3) * trainerStat.winRate;
      const jockeyXdistance = jockeyDistWR * (pred.distance / 1000);
      const formXclassChange = ((scores.recentForm ?? 50) / 100) * ((scores.classPerformance ?? 50) / 100);

      // v15.0: 騎手・調教師直近30日フォーム
      const jrS = jockeyRecentSnap.get(pred.date);
      const jockeyRecentWinRate = (jrS && entry.jockey_id) ? (jrS.get(entry.jockey_id) ?? 0) : 0;
      const trS = trainerRecentSnap.get(pred.date);
      const trainerRecentWinRate = (trS && entry.trainer_name) ? (trS.get(entry.trainer_name) ?? 0) : 0;

      // v15.0: 馬場×脚質交互作用
      const conditionXstyle = (TRACK_CONDITION_ENCODE[pred.track_condition ?? '良'] ?? 0) * ((scores.runningStyle ?? 50) / 100);

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
          case 'sireDistWinRate': return sireDistWR;
          case 'sireCondWinRate': return sireCondWR;
          case 'pciAvg': return pciAvg;
          case 'jockeyRecentWinRate': return jockeyRecentWinRate;
          case 'trainerRecentWinRate': return trainerRecentWinRate;
          case 'conditionXstyle': return conditionXstyle;
          case 'oikiriRank': {
            const oKey = `${pred.race_id}__${entry.horse_number}`;
            return oikiriMap.get(oKey) ?? 1.5; // 不明時は中間値
          }
          case 'jockeyDistanceWinRate': return jockeyDistWR;
          case 'jockeyCourseWinRate': return jockeyCourseWR;
          // v6.0 新特徴量
          case 'jockeySwitchQuality': return jockeySwitchQuality;
          case 'jockeyChanged': return jockeyChanged;
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
          case 'courseDistPaceAvg': return courseDistPaceAvg;
          case 'paceStyleMatch': return paceStyleMatch;
          // v8.0 直近フォーム + キャリア特徴量
          case 'lastRacePosition': return lastRacePosition;
          case 'last3WinRate': return last3WinRate;
          case 'last3PlaceRate': return last3PlaceRate;
          case 'careerWinRate': return careerWinRate;
          case 'relativeOdds': return relativeOdds;
          case 'winStreak': return winStreak;
          // v9.0 新特徴量
          case 'relativePosition': return relativePosition;
          case 'upsetRate': return upsetRate;
          case 'avgPastOdds': return avgPastOdds;
          // v10.0 走破タイム + ペース + L3F + weight
          case 'standardTimeDev': return timeFeats.standardTimeDev;
          case 'bestTimeDev': return timeFeats.bestTimeDev;
          case 'timeConsistency': return timeFeats.timeConsistency;
          case 'earlyPositionRatio': return paceFeats.earlyPositionRatio;
          case 'positionGainAvg': return paceFeats.positionGainAvg;
          case 'l3fRelativeAvg': return l3fRelativeAvg;
          case 'weightStability': return weightStability;
          case 'weightTrendSlope': return weightTrendSlope;
          case 'weightOptimalDelta': return weightOptimalDelta;
          // Phase 3 新特徴量 (#12-#17)
          case 'bodyWeightTrend': return bodyWeightTrend;
          case 'distanceChange': return distanceChange;
          case 'jockeyTrainerWinRate': return jockeyTrainerWinRate;
          case 'horseCourseWinRate': return horseCourseWinRate;
          case 'escaperCount': return escaperCount;
          case 'gradeXtrainer': return gradeXtrainer;
          case 'jockeyXdistance': return jockeyXdistance;
          case 'formXclassChange': return formXclassChange;
          // v12.0 タイム指数
          case 'avgTimeIndex': return avgTimeIndex;
          case 'bestTimeIndex': return bestTimeIndex;
          case 'timeIndexTrend': return timeIndexTrend;
          // v13.0 コース形状
          case 'straightLength': {
            const geo = COURSE_GEOMETRY[pred.racecourse_name ?? ''];
            return geo ? geo.straight / MAX_STRAIGHT : 0.5;
          }
          case 'isWesternGrass': {
            const geo = COURSE_GEOMETRY[pred.racecourse_name ?? ''];
            return geo?.western ? 1 : 0;
          }
          case 'styleXstraight': {
            const geo = COURSE_GEOMETRY[pred.racecourse_name ?? ''];
            const straightNorm = geo ? geo.straight / MAX_STRAIGHT : 0.5;
            const style = scores.runningStyle ?? 50;
            return (style / 100) * straightNorm;
          }
          // v14.0: データ駆動枠順バイアスZ-Score
          case 'drawBiasZScore': {
            const dbS = drawBiasSnap.get(pred.date);
            if (!dbS) return 0;
            const course = pred.racecourse_name ?? '';
            const distBucket2 = pred.distance <= 1400 ? 'sprint' : pred.distance <= 1800 ? 'mile' : 'long';
            const tt = pred.track_type ?? '';
            const prefix = `${course}__${distBucket2}__${tt}__`;
            // Collect win rates for all post positions in this (course, distBucket, trackType)
            const winRates: number[] = [];
            let thisWR = 0;
            for (const [k, wr] of dbS) {
              if (k.startsWith(prefix)) {
                winRates.push(wr);
                const pos = parseInt(k.split('__')[3]);
                if (pos === entry.post_position) thisWR = wr;
              }
            }
            if (winRates.length < 3) return 0;
            const mean = winRates.reduce((a, b) => a + b, 0) / winRates.length;
            const std = Math.sqrt(winRates.reduce((a, b) => a + (b - mean) ** 2, 0) / winRates.length);
            return std > 0.001 ? (thisWR - mean) / std : 0;
          }
          default: return scores[name] ?? 50;
        }
      });

      const raceDate = new Date(pred.date);
      const daysAgo = Math.max(0, (maxDate.getTime() - raceDate.getTime()) / 86400000);
      const recencyWeight = Math.exp(-daysAgo / 365);

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
        recency_weight: recencyWeight,
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
