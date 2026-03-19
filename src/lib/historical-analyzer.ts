/**
 * 過去データ統計分析モジュール
 *
 * past_performances テーブルの集計データからパターンを抽出し、
 * 予測エンジンに統計ベースのスコアリング情報を提供する。
 *
 * 分析観点:
 *   1. コース×距離×馬場 統計（枠順勝率、平均タイム、脚質別勝率）
 *   2. 種牡馬統計（芝/ダート適性、距離適性、道悪適性）
 *   3. 騎手×調教師コンボ統計（相性）
 *   4. 季節パターン（馬ごとの月別成績）
 *   5. 叩き良化パターン（休み明け→2走目の成績変化）
 */

import { dbAll } from './database';
import { computePaceProfile, type HistoricalPaceProfile } from './pace-analyzer';

// ==================== インメモリキャッシュ (Task 1-6) ====================

const courseStatsCache = new Map<string, { data: unknown; expires: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCached<T>(key: string): T | undefined {
  const entry = courseStatsCache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data as T;
  if (entry) courseStatsCache.delete(key);
  return undefined;
}

function setCache(key: string, data: unknown): void {
  courseStatsCache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

// ==================== 型定義 ====================

export interface CourseDistanceStats {
  totalRaces: number;
  postPositionWinRate: Record<number, { races: number; wins: number; rate: number }>;
  innerFrameWinRate: number;   // 枠1-4の勝率
  outerFrameWinRate: number;   // 枠5-8の勝率
  avgWinLast3F: number;
  frontRunnerRate: number; // 4角3番手以内が勝つ割合
}

export interface SireStats {
  sireName: string;
  totalRaces: number;
  wins: number;
  winRate: number;
  placeRate: number;
  turfStats: { races: number; wins: number; winRate: number };
  dirtStats: { races: number; wins: number; winRate: number };
  sprintStats: { races: number; wins: number; winRate: number };   // <=1400
  mileStats: { races: number; wins: number; winRate: number };     // 1500-1800
  middleStats: { races: number; wins: number; winRate: number };   // 1900-2200
  stayerStats: { races: number; wins: number; winRate: number };   // >=2300
  heavyStats: { races: number; wins: number; winRate: number };    // 重・不良
}

export interface JockeyTrainerCombo {
  totalRaces: number;
  wins: number;
  places: number;
  winRate: number;
  placeRate: number;
}

export interface TrainerStats {
  trainerName: string;
  totalRaces: number;
  wins: number;
  places: number;
  winRate: number;
  placeRate: number;
  turfWinRate: number;
  dirtWinRate: number;
  recentWinRate: number;  // 直近1年の勝率
  recentRaces: number;
}

export interface SeasonalStats {
  month: number;
  races: number;
  wins: number;
  places: number;
  winRate: number;
  placeRate: number;
}

export interface SecondStartBonus {
  firstStartAvgPos: number;
  secondStartAvgPos: number;
  improvement: number;  // positive = 良化
  sampleSize: number;
}

/** レース単位でまとめて計算する統計コンテキスト */
export interface RaceHistoricalContext {
  courseDistStats: CourseDistanceStats | null;
  sireStatsMap: Map<string, SireStats>;
  jockeyTrainerMap: Map<string, JockeyTrainerCombo>;
  trainerStatsMap: Map<string, TrainerStats>;
  seasonalMap: Map<string, SeasonalStats[]>;
  secondStartMap: Map<string, SecondStartBonus | null>;
  dynamicStdTime: DynamicStandardTime | null;
  jockeyFormMap: Map<string, JockeyRecentForm>;
  paceProfile: HistoricalPaceProfile | null;
  // v7.0: ラップタイム基盤
  courseDistPaceAvg: number;
  horsePaceMap: Map<string, { preference: number; haiRate: number }>;
}

// ==================== メイン関数 ====================

/**
 * レース条件に基づいて統計コンテキストを一括構築する。
 * 予測エンジンから1レースにつき1回だけ呼ぶ。
 */
export async function buildRaceContext(
  racecourseName: string,
  trackType: string,
  distance: number,
  month: number,
  horses: { horseId: string; fatherName: string; jockeyId: string; trainerName: string }[],
  raceDate?: string,
): Promise<RaceHistoricalContext> {
  const uniqueSires = [...new Set(horses.map(h => h.fatherName).filter(Boolean))];
  const uniqueTrainers = [...new Set(horses.map(h => h.trainerName).filter(Boolean))];
  const uniqueJockeys = [...new Set(horses.map(h => h.jockeyId).filter(Boolean))];
  const uniqueJTKeys = [...new Set(
    horses.filter(h => h.jockeyId && h.trainerName).map(h => `${h.jockeyId}__${h.trainerName}`)
  )];

  const uniqueHorseIds = [...new Set(horses.map(h => h.horseId).filter(Boolean))];

  // JTペアを構築
  const jtPairs = horses
    .filter(h => h.jockeyId && h.trainerName)
    .map(h => ({ jockeyId: h.jockeyId, trainerName: h.trainerName }));
  const uniqueJTPairs = jtPairs.filter((p, i, arr) =>
    arr.findIndex(q => q.jockeyId === p.jockeyId && q.trainerName === p.trainerName) === i
  );

  // 独立したクエリを全て並列実行（バッチ版で N+1 を排除）
  const [
    courseDistStats,
    sireStatsMap,
    jockeyTrainerMap,
    trainerStatsMap,
    seasonalMap,
    secondStartMap,
    dynamicStdTime,
    jockeyFormMap,
    paceProfile,
    coursePaceRows,
    horsePaceRows,
  ] = await Promise.all([
    getCourseDistanceStats(racecourseName, trackType, distance, raceDate),
    getSireStatsBatch(uniqueSires, raceDate),
    getJockeyTrainerComboBatch(uniqueJTPairs, raceDate),
    getTrainerStatsBatch(uniqueTrainers, raceDate),
    getHorseSeasonalStatsBatch(uniqueHorseIds, raceDate),
    getSecondStartBonusBatch(uniqueHorseIds, raceDate),
    getDynamicStandardTimes(racecourseName, trackType, distance, '良', raceDate),
    getJockeyRecentFormBatch(uniqueJockeys, raceDate),
    getPaceProfile(racecourseName, trackType, distance, raceDate),
    // v7.0: コース×距離のペース分布
    getCoursePaceAvg(racecourseName, distance, raceDate),
    // v7.0: 各馬の過去レースペース履歴
    getHorsePaceHistory(uniqueHorseIds, raceDate),
  ]);

  return { courseDistStats, sireStatsMap, jockeyTrainerMap, trainerStatsMap, seasonalMap, secondStartMap, dynamicStdTime, jockeyFormMap, paceProfile, courseDistPaceAvg: coursePaceRows, horsePaceMap: horsePaceRows };
}

// ==================== 個別統計関数 ====================

async function getCourseDistanceStats(
  racecourseName: string,
  trackType: string,
  distance: number,
  raceDate?: string,
): Promise<CourseDistanceStats | null> {
  // キャッシュチェック
  const cacheKey = `getCourseDistanceStats_${racecourseName}_${trackType}_${distance}_${raceDate || 'now'}`;
  const cached = getCached<CourseDistanceStats | null>(cacheKey);
  if (cached !== undefined) return cached;

  const tolerance = 100;

  const dateFilter = raceDate ? ' AND date < ?' : '';
  const args = [racecourseName, trackType, distance - tolerance, distance + tolerance, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT post_position, position, entries, last_three_furlongs, corner_positions
    FROM past_performances
    WHERE racecourse_name = ?
    AND track_type = ?
    AND distance BETWEEN ? AND ?
    AND entries > 0${dateFilter}
  `, args);

  // v4: 閾値を10→3に緩和（少ないデータでも部分的に活用、重み調整はエンジン側で行う）
  if (rows.length < 3) { setCache(cacheKey, null); return null; }

  // 枠番別勝率
  const postMap: Record<number, { races: number; wins: number }> = {};
  let innerWins = 0, innerTotal = 0, outerWins = 0, outerTotal = 0;
  let frontRunnerWins = 0, totalWins = 0;
  const winLast3Fs: number[] = [];

  for (const r of rows) {
    const post = r.post_position as number;
    if (!post || post <= 0) continue;

    if (!postMap[post]) postMap[post] = { races: 0, wins: 0 };
    postMap[post].races++;

    const isWin = r.position === 1;
    if (isWin) {
      postMap[post].wins++;
      totalWins++;

      // 上がり3F
      const l3f = parseFloat(r.last_three_furlongs);
      if (l3f > 0 && l3f < 50) winLast3Fs.push(l3f);

      // 4角位置
      const corners = (r.corner_positions || '').split('-').map(Number).filter((n: number) => !isNaN(n));
      if (corners.length > 0) {
        const lastCorner = corners[corners.length - 1];
        const entries = r.entries || 16;
        if (lastCorner <= Math.ceil(entries * 0.25)) frontRunnerWins++;
      }
    }

    if (post <= 4) { innerTotal++; if (isWin) innerWins++; }
    else { outerTotal++; if (isWin) outerWins++; }
  }

  const postPositionWinRate: CourseDistanceStats['postPositionWinRate'] = {};
  for (const [p, data] of Object.entries(postMap)) {
    const rate = data.races > 0 ? data.wins / data.races : 0;
    postPositionWinRate[Number(p)] = { races: data.races, wins: data.wins, rate };
  }

  const statsResult: CourseDistanceStats = {
    totalRaces: rows.length,
    postPositionWinRate,
    innerFrameWinRate: innerTotal > 0 ? innerWins / innerTotal : 0,
    outerFrameWinRate: outerTotal > 0 ? outerWins / outerTotal : 0,
    avgWinLast3F: winLast3Fs.length > 0 ? winLast3Fs.reduce((a, b) => a + b, 0) / winLast3Fs.length : 0,
    frontRunnerRate: totalWins > 0 ? frontRunnerWins / totalWins : 0.5,
  };
  setCache(cacheKey, statsResult);
  return statsResult;
}

async function getSireStats(sireName: string, raceDate?: string): Promise<SireStats | null> {
  const dateFilter = raceDate ? ' AND pp.date < ?' : '';
  const args = [sireName, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT pp.track_type, pp.distance, pp.track_condition, pp.position, pp.entries
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE h.father_name = ?
    AND pp.entries > 0${dateFilter}
  `, args);

  // v4: 閾値を5→2に緩和（少ないデータでも部分的に活用）
  if (rows.length < 2) return null;

  let wins = 0, places = 0;
  const turfR = { races: 0, wins: 0 };
  const dirtR = { races: 0, wins: 0 };
  const sprintR = { races: 0, wins: 0 };
  const mileR = { races: 0, wins: 0 };
  const middleR = { races: 0, wins: 0 };
  const stayerR = { races: 0, wins: 0 };
  const heavyR = { races: 0, wins: 0 };

  for (const r of rows) {
    const isWin = r.position === 1;
    const isPlace = r.position <= 3;
    if (isWin) wins++;
    if (isPlace) places++;

    // 芝/ダート
    if (r.track_type === '芝') { turfR.races++; if (isWin) turfR.wins++; }
    if (r.track_type === 'ダート') { dirtR.races++; if (isWin) dirtR.wins++; }

    // 距離帯
    const d = r.distance as number;
    if (d <= 1400) { sprintR.races++; if (isWin) sprintR.wins++; }
    else if (d <= 1800) { mileR.races++; if (isWin) mileR.wins++; }
    else if (d <= 2200) { middleR.races++; if (isWin) middleR.wins++; }
    else { stayerR.races++; if (isWin) stayerR.wins++; }

    // 道悪
    if (r.track_condition === '重' || r.track_condition === '不良') {
      heavyR.races++; if (isWin) heavyR.wins++;
    }
  }

  const rate = (s: { races: number; wins: number }) => ({
    ...s, winRate: s.races > 0 ? s.wins / s.races : 0,
  });

  return {
    sireName,
    totalRaces: rows.length,
    wins,
    winRate: rows.length > 0 ? wins / rows.length : 0,
    placeRate: rows.length > 0 ? places / rows.length : 0,
    turfStats: rate(turfR),
    dirtStats: rate(dirtR),
    sprintStats: rate(sprintR),
    mileStats: rate(mileR),
    middleStats: rate(middleR),
    stayerStats: rate(stayerR),
    heavyStats: rate(heavyR),
  };
}

async function getJockeyTrainerCombo(jockeyId: string, trainerName: string, raceDate?: string): Promise<JockeyTrainerCombo | null> {
  const dateFilter = raceDate ? ' AND pp.date < ?' : '';
  const args = [jockeyId, trainerName, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT pp.position, pp.entries
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE pp.jockey_name = (SELECT name FROM jockeys WHERE id = ?)
    AND h.trainer_name = ?
    AND pp.entries > 0${dateFilter}
  `, args);

  // v4: 閾値を3→1に緩和
  if (rows.length < 1) return null;

  let wins = 0, places = 0;
  for (const r of rows) {
    if (r.position === 1) wins++;
    if (r.position <= 3) places++;
  }

  return {
    totalRaces: rows.length,
    wins,
    places,
    winRate: wins / rows.length,
    placeRate: places / rows.length,
  };
}

async function getTrainerStats(trainerName: string, raceDate?: string): Promise<TrainerStats | null> {
  const dateFilter = raceDate ? ' AND r.date < ?' : '';
  const args = [trainerName, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT re.result_position, r.track_type, r.date
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE r.status = '結果確定'
      AND re.trainer_name = ?
      AND re.result_position IS NOT NULL${dateFilter}
  `, args);

  if (rows.length < 5) return null;

  let wins = 0, places = 0;
  let turfWins = 0, turfRaces = 0;
  let dirtWins = 0, dirtRaces = 0;
  let recentWins = 0, recentRaces = 0;

  // 直近1年の閾値（raceDate基準）
  const baseDate = raceDate ? new Date(raceDate) : new Date();
  const oneYearAgo = new Date(baseDate);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);

  for (const r of rows) {
    const isWin = r.result_position === 1;
    const isPlace = r.result_position <= 3;
    if (isWin) wins++;
    if (isPlace) places++;

    if (r.track_type === '芝') { turfRaces++; if (isWin) turfWins++; }
    if (r.track_type === 'ダート') { dirtRaces++; if (isWin) dirtWins++; }

    if (r.date >= oneYearAgoStr) {
      recentRaces++;
      if (isWin) recentWins++;
    }
  }

  return {
    trainerName,
    totalRaces: rows.length,
    wins,
    places,
    winRate: wins / rows.length,
    placeRate: places / rows.length,
    turfWinRate: turfRaces > 0 ? turfWins / turfRaces : 0,
    dirtWinRate: dirtRaces > 0 ? dirtWins / dirtRaces : 0,
    recentWinRate: recentRaces > 0 ? recentWins / recentRaces : 0,
    recentRaces,
  };
}

async function getHorseSeasonalStats(horseId: string, raceDate?: string): Promise<SeasonalStats[]> {
  const dateFilter = raceDate ? ' AND date < ?' : '';
  const args = [horseId, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT
      CAST(substr(date, 6, 2) AS INTEGER) as month,
      position, entries
    FROM past_performances
    WHERE horse_id = ?
    AND date IS NOT NULL
    AND entries > 0${dateFilter}
  `, args);

  // v4: 閾値を3→1に緩和
  if (rows.length < 1) return [];

  const monthMap: Record<number, { races: number; wins: number; places: number }> = {};
  for (const r of rows) {
    const m = r.month as number;
    if (m < 1 || m > 12) continue;
    if (!monthMap[m]) monthMap[m] = { races: 0, wins: 0, places: 0 };
    monthMap[m].races++;
    if (r.position === 1) monthMap[m].wins++;
    if (r.position <= 3) monthMap[m].places++;
  }

  return Object.entries(monthMap).map(([m, d]) => ({
    month: Number(m),
    races: d.races,
    wins: d.wins,
    places: d.places,
    winRate: d.races > 0 ? d.wins / d.races : 0,
    placeRate: d.races > 0 ? d.places / d.races : 0,
  }));
}

/**
 * 叩き良化パターン分析
 * 60日以上の休み明け初戦 vs 2戦目の成績差を計算
 */
async function getSecondStartBonus(horseId: string, raceDate?: string): Promise<SecondStartBonus | null> {
  const dateFilter = raceDate ? ' AND date < ?' : '';
  const args = [horseId, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT date, position, entries
    FROM past_performances
    WHERE horse_id = ?
    AND entries > 0${dateFilter}
    ORDER BY date ASC
  `, args);

  if (rows.length < 4) return null;

  const firstStarts: number[] = [];
  const secondStarts: number[] = [];

  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1].date);
    const curr = new Date(rows[i].date);
    const daysBetween = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);

    if (daysBetween >= 60) {
      // この行は休み明け初戦
      const entries = rows[i].entries || 16;
      firstStarts.push(rows[i].position / entries);
      // 次の行が2戦目
      if (i + 1 < rows.length) {
        const nextEntries = rows[i + 1].entries || 16;
        secondStarts.push(rows[i + 1].position / nextEntries);
      }
    }
  }

  if (firstStarts.length < 2 || secondStarts.length < 2) return null;

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const firstAvg = avg(firstStarts);
  const secondAvg = avg(secondStarts);

  return {
    firstStartAvgPos: firstAvg,
    secondStartAvgPos: secondAvg,
    improvement: firstAvg - secondAvg, // positive = 2走目の方が良い
    sampleSize: Math.min(firstStarts.length, secondStarts.length),
  };
}

// ==================== バッチ版統計関数 (Task 1-1) ====================

/**
 * 種牡馬統計を一括取得（N+1排除）
 */
async function getSireStatsBatch(sireNames: string[], raceDate?: string): Promise<Map<string, SireStats>> {
  const result = new Map<string, SireStats>();
  if (sireNames.length === 0) return result;

  const dateFilter = raceDate ? ' AND pp.date < ?' : '';
  const placeholders = sireNames.map(() => '?').join(',');
  const args = [...sireNames, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT h.father_name, pp.track_type, pp.distance, pp.track_condition, pp.position, pp.entries
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE h.father_name IN (${placeholders})
    AND pp.entries > 0${dateFilter}
  `, args);

  // 種牡馬ごとに集計
  const bySire = new Map<string, typeof rows>();
  for (const r of rows) {
    const name = r.father_name as string;
    const arr = bySire.get(name) || [];
    arr.push(r);
    bySire.set(name, arr);
  }

  for (const [sireName, sireRows] of bySire) {
    if (sireRows.length < 2) continue;

    let wins = 0, places = 0;
    const turfR = { races: 0, wins: 0 };
    const dirtR = { races: 0, wins: 0 };
    const sprintR = { races: 0, wins: 0 };
    const mileR = { races: 0, wins: 0 };
    const middleR = { races: 0, wins: 0 };
    const stayerR = { races: 0, wins: 0 };
    const heavyR = { races: 0, wins: 0 };

    for (const r of sireRows) {
      const isWin = r.position === 1;
      const isPlace = r.position <= 3;
      if (isWin) wins++;
      if (isPlace) places++;

      if (r.track_type === '芝') { turfR.races++; if (isWin) turfR.wins++; }
      if (r.track_type === 'ダート') { dirtR.races++; if (isWin) dirtR.wins++; }

      const d = r.distance as number;
      if (d <= 1400) { sprintR.races++; if (isWin) sprintR.wins++; }
      else if (d <= 1800) { mileR.races++; if (isWin) mileR.wins++; }
      else if (d <= 2200) { middleR.races++; if (isWin) middleR.wins++; }
      else { stayerR.races++; if (isWin) stayerR.wins++; }

      if (r.track_condition === '重' || r.track_condition === '不良') {
        heavyR.races++; if (isWin) heavyR.wins++;
      }
    }

    const rate = (s: { races: number; wins: number }) => ({
      ...s, winRate: s.races > 0 ? s.wins / s.races : 0,
    });

    result.set(sireName, {
      sireName,
      totalRaces: sireRows.length,
      wins,
      winRate: sireRows.length > 0 ? wins / sireRows.length : 0,
      placeRate: sireRows.length > 0 ? places / sireRows.length : 0,
      turfStats: rate(turfR),
      dirtStats: rate(dirtR),
      sprintStats: rate(sprintR),
      mileStats: rate(mileR),
      middleStats: rate(middleR),
      stayerStats: rate(stayerR),
      heavyStats: rate(heavyR),
    });
  }

  return result;
}

/**
 * 調教師統計を一括取得（N+1排除）
 */
async function getTrainerStatsBatch(trainerNames: string[], raceDate?: string): Promise<Map<string, TrainerStats>> {
  const result = new Map<string, TrainerStats>();
  if (trainerNames.length === 0) return result;

  const dateFilter = raceDate ? ' AND r.date < ?' : '';
  const placeholders = trainerNames.map(() => '?').join(',');
  const args = [...trainerNames, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT re.trainer_name, re.result_position, r.track_type, r.date
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE r.status = '結果確定'
      AND re.trainer_name IN (${placeholders})
      AND re.result_position IS NOT NULL${dateFilter}
  `, args);

  // 調教師ごとに集計
  const byTrainer = new Map<string, typeof rows>();
  for (const r of rows) {
    const name = r.trainer_name as string;
    const arr = byTrainer.get(name) || [];
    arr.push(r);
    byTrainer.set(name, arr);
  }

  for (const [trainerName, trainerRows] of byTrainer) {
    if (trainerRows.length < 5) continue;

    let wins = 0, places = 0;
    let turfWins = 0, turfRaces = 0;
    let dirtWins = 0, dirtRaces = 0;
    let recentWins = 0, recentRaces = 0;

    const baseDate = raceDate ? new Date(raceDate) : new Date();
    const oneYearAgo = new Date(baseDate);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);

    for (const r of trainerRows) {
      const isWin = r.result_position === 1;
      const isPlace = r.result_position <= 3;
      if (isWin) wins++;
      if (isPlace) places++;

      if (r.track_type === '芝') { turfRaces++; if (isWin) turfWins++; }
      if (r.track_type === 'ダート') { dirtRaces++; if (isWin) dirtWins++; }

      if (r.date >= oneYearAgoStr) {
        recentRaces++;
        if (isWin) recentWins++;
      }
    }

    result.set(trainerName, {
      trainerName,
      totalRaces: trainerRows.length,
      wins,
      places,
      winRate: wins / trainerRows.length,
      placeRate: places / trainerRows.length,
      turfWinRate: turfRaces > 0 ? turfWins / turfRaces : 0,
      dirtWinRate: dirtRaces > 0 ? dirtWins / dirtRaces : 0,
      recentWinRate: recentRaces > 0 ? recentWins / recentRaces : 0,
      recentRaces,
    });
  }

  return result;
}

/**
 * 馬の季節別成績を一括取得（N+1排除）
 */
async function getHorseSeasonalStatsBatch(horseIds: string[], raceDate?: string): Promise<Map<string, SeasonalStats[]>> {
  const result = new Map<string, SeasonalStats[]>();
  if (horseIds.length === 0) return result;

  const dateFilter = raceDate ? ' AND date < ?' : '';
  const placeholders = horseIds.map(() => '?').join(',');
  const args = [...horseIds, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT
      horse_id,
      CAST(substr(date, 6, 2) AS INTEGER) as month,
      position, entries
    FROM past_performances
    WHERE horse_id IN (${placeholders})
    AND date IS NOT NULL
    AND entries > 0${dateFilter}
  `, args);

  if (rows.length < 1) return result;

  // 馬×月ごとに集計
  const byHorse = new Map<string, Map<number, { races: number; wins: number; places: number }>>();
  for (const r of rows) {
    const hid = r.horse_id as string;
    const m = r.month as number;
    if (m < 1 || m > 12) continue;

    if (!byHorse.has(hid)) byHorse.set(hid, new Map());
    const monthMap = byHorse.get(hid)!;
    if (!monthMap.has(m)) monthMap.set(m, { races: 0, wins: 0, places: 0 });
    const data = monthMap.get(m)!;
    data.races++;
    if (r.position === 1) data.wins++;
    if (r.position <= 3) data.places++;
  }

  for (const [hid, monthMap] of byHorse) {
    const stats: SeasonalStats[] = [];
    for (const [m, d] of monthMap) {
      stats.push({
        month: m,
        races: d.races,
        wins: d.wins,
        places: d.places,
        winRate: d.races > 0 ? d.wins / d.races : 0,
        placeRate: d.races > 0 ? d.places / d.races : 0,
      });
    }
    if (stats.length > 0) result.set(hid, stats);
  }

  return result;
}

/**
 * 叩き良化パターンを一括取得（N+1排除）
 */
async function getSecondStartBonusBatch(horseIds: string[], raceDate?: string): Promise<Map<string, SecondStartBonus | null>> {
  const result = new Map<string, SecondStartBonus | null>();
  if (horseIds.length === 0) return result;

  const dateFilter = raceDate ? ' AND date < ?' : '';
  const placeholders = horseIds.map(() => '?').join(',');
  const args = [...horseIds, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT horse_id, date, position, entries
    FROM past_performances
    WHERE horse_id IN (${placeholders})
    AND entries > 0${dateFilter}
    ORDER BY horse_id, date ASC
  `, args);

  // 馬ごとにグループ化
  const byHorse = new Map<string, typeof rows>();
  for (const r of rows) {
    const hid = r.horse_id as string;
    const arr = byHorse.get(hid) || [];
    arr.push(r);
    byHorse.set(hid, arr);
  }

  // 各馬のIDを結果マップに初期化
  for (const hid of horseIds) {
    result.set(hid, null);
  }

  for (const [hid, horseRows] of byHorse) {
    if (horseRows.length < 4) continue;

    const firstStarts: number[] = [];
    const secondStarts: number[] = [];

    for (let i = 1; i < horseRows.length; i++) {
      const prev = new Date(horseRows[i - 1].date);
      const curr = new Date(horseRows[i].date);
      const daysBetween = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);

      if (daysBetween >= 60) {
        const entries = horseRows[i].entries || 16;
        firstStarts.push(horseRows[i].position / entries);
        if (i + 1 < horseRows.length) {
          const nextEntries = horseRows[i + 1].entries || 16;
          secondStarts.push(horseRows[i + 1].position / nextEntries);
        }
      }
    }

    if (firstStarts.length < 2 || secondStarts.length < 2) continue;

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const firstAvg = avg(firstStarts);
    const secondAvg = avg(secondStarts);

    result.set(hid, {
      firstStartAvgPos: firstAvg,
      secondStartAvgPos: secondAvg,
      improvement: firstAvg - secondAvg,
      sampleSize: Math.min(firstStarts.length, secondStarts.length),
    });
  }

  return result;
}

/**
 * 騎手直近フォームを一括取得（N+1排除）
 */
async function getJockeyRecentFormBatch(jockeyIds: string[], raceDate?: string): Promise<Map<string, JockeyRecentForm>> {
  const result = new Map<string, JockeyRecentForm>();
  if (jockeyIds.length === 0) return result;

  const baseDate = raceDate ? new Date(raceDate) : new Date();
  const d30 = new Date(baseDate);
  d30.setDate(d30.getDate() - 30);
  const d30Str = d30.toISOString().slice(0, 10);
  const d365 = new Date(baseDate);
  d365.setFullYear(d365.getFullYear() - 1);
  const d365Str = d365.toISOString().slice(0, 10);

  const dateFilter = raceDate ? ' AND r.date < ?' : '';
  const placeholders = jockeyIds.map(() => '?').join(',');
  const args = [...jockeyIds, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT re.jockey_id, re.result_position, r.date
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE re.jockey_id IN (${placeholders})
    AND r.status = '結果確定'
    AND re.result_position IS NOT NULL${dateFilter}
  `, args);

  // 騎手ごとに集計
  const byJockey = new Map<string, typeof rows>();
  for (const r of rows) {
    const jid = r.jockey_id as string;
    const arr = byJockey.get(jid) || [];
    arr.push(r);
    byJockey.set(jid, arr);
  }

  for (const [jockeyId, jockeyRows] of byJockey) {
    if (jockeyRows.length < 5) continue;

    let r30 = 0, w30 = 0, rYear = 0, wYear = 0;
    for (const r of jockeyRows) {
      if (r.date >= d30Str) { r30++; if (r.result_position === 1) w30++; }
      if (r.date >= d365Str) { rYear++; if (r.result_position === 1) wYear++; }
    }

    const careerWinRate = jockeyRows.filter(r => r.result_position === 1).length / jockeyRows.length;
    const yearWinRate = rYear > 0 ? wYear / rYear : careerWinRate;
    const recent30DayWinRate = r30 >= 3 ? w30 / r30 : yearWinRate;

    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    if (r30 >= 5) {
      if (recent30DayWinRate > yearWinRate * 1.3) trend = 'improving';
      else if (recent30DayWinRate < yearWinRate * 0.7) trend = 'declining';
    }

    result.set(jockeyId, {
      jockeyId,
      recent30DayWinRate,
      recent30DayRaces: r30,
      yearWinRate,
      yearRaces: rYear,
      careerWinRate,
      trend,
    });
  }

  return result;
}

/**
 * 騎手×調教師コンボを一括取得（N+1排除）
 * ペアごとにクエリするのではなく、全騎手の結果を一括取得しJSでフィルタ
 */
async function getJockeyTrainerComboBatch(
  pairs: { jockeyId: string; trainerName: string }[],
  raceDate?: string,
): Promise<Map<string, JockeyTrainerCombo>> {
  const result = new Map<string, JockeyTrainerCombo>();
  if (pairs.length === 0) return result;

  const uniqueJockeyIds = [...new Set(pairs.map(p => p.jockeyId))];
  const dateFilter = raceDate ? ' AND r.date < ?' : '';
  const placeholders = uniqueJockeyIds.map(() => '?').join(',');
  const args = [...uniqueJockeyIds, ...(raceDate ? [raceDate] : [])];

  // 全騎手の結果を一括取得（trainer_nameも含む）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT re.jockey_id, h.trainer_name, re.result_position
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    JOIN horses h ON re.horse_id = h.id
    WHERE re.jockey_id IN (${placeholders})
    AND r.status = '結果確定'
    AND re.result_position IS NOT NULL${dateFilter}
  `, args);

  // 騎手×調教師ペアごとに集計
  const pairData = new Map<string, { total: number; wins: number; places: number }>();
  for (const r of rows) {
    const key = `${r.jockey_id}__${r.trainer_name}`;
    if (!pairData.has(key)) pairData.set(key, { total: 0, wins: 0, places: 0 });
    const data = pairData.get(key)!;
    data.total++;
    if (r.result_position === 1) data.wins++;
    if (r.result_position <= 3) data.places++;
  }

  // 対象ペアの結果を構築
  for (const pair of pairs) {
    const key = `${pair.jockeyId}__${pair.trainerName}`;
    const data = pairData.get(key);
    if (!data || data.total < 1) continue;

    result.set(key, {
      totalRaces: data.total,
      wins: data.wins,
      places: data.places,
      winRate: data.wins / data.total,
      placeRate: data.places / data.total,
    });
  }

  return result;
}

// ==================== ペースプロファイル ====================

/**
 * コース×トラック×距離帯の過去データからペースプロファイルを算出
 */
async function getPaceProfile(
  racecourseName: string,
  trackType: string,
  distance: number,
  raceDate?: string,
): Promise<HistoricalPaceProfile | null> {
  const tolerance = 200;
  const dateFilter = raceDate ? ' AND date < ?' : '';
  const args = [racecourseName, trackType, distance - tolerance, distance + tolerance, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT corner_positions, position, entries
    FROM past_performances
    WHERE racecourse_name = ? AND track_type = ?
      AND distance BETWEEN ? AND ?
      AND entries > 0 AND position > 0${dateFilter}
    ORDER BY date DESC LIMIT 500
  `, args);

  if (rows.length < 20) return null;

  const perfRows = rows
    .filter((r: { corner_positions: string }) => r.corner_positions && r.corner_positions.includes('-'))
    .map((r: { corner_positions: string; position: number; entries: number }) => ({
      cornerPositions: r.corner_positions as string,
      position: r.position as number,
      entries: r.entries as number,
    }));

  return computePaceProfile(perfRows);
}

// ==================== スコア変換ヘルパー ====================

/**
 * 種牡馬統計から今回の条件への適性スコア (0-100) を算出
 */
export function calcSireAptitudeScore(
  sireStats: SireStats | undefined,
  trackType: string,
  distance: number,
  trackCondition: string | undefined,
): number {
  if (!sireStats) return 50;

  let score = 50;

  // 全体勝率ベース
  score += (sireStats.winRate - 0.10) * 200; // 10%で基準、20%なら+20

  // トラック適性
  const trackStats = trackType === '芝' ? sireStats.turfStats : sireStats.dirtStats;
  if (trackStats.races >= 3) {
    score += (trackStats.winRate - sireStats.winRate) * 150;
  }

  // 距離帯適性
  let distStats;
  if (distance <= 1400) distStats = sireStats.sprintStats;
  else if (distance <= 1800) distStats = sireStats.mileStats;
  else if (distance <= 2200) distStats = sireStats.middleStats;
  else distStats = sireStats.stayerStats;

  if (distStats.races >= 3) {
    score += (distStats.winRate - sireStats.winRate) * 150;
  }

  // 道悪適性
  if ((trackCondition === '重' || trackCondition === '不良') && sireStats.heavyStats.races >= 3) {
    score += (sireStats.heavyStats.winRate - sireStats.winRate) * 100;
  }

  return Math.min(100, Math.max(10, score));
}

/**
 * 調教師能力スコア (0-100)
 * 全体勝率 + トラック別勝率 + 直近成績を総合評価
 */
export function calcTrainerAbilityScore(
  stats: TrainerStats | undefined,
  trackType: string,
): number {
  if (!stats || stats.totalRaces < 10) return 50;

  // 基準: 平均勝率 ~8%、トップ調教師 ~15-20%
  let score = 30;

  // 全体勝率ベース (8%=+20, 15%=+55)
  score += stats.winRate * 400;

  // トラック別適性ボーナス
  const trackWinRate = trackType === '芝' ? stats.turfWinRate : stats.dirtWinRate;
  if (trackWinRate > stats.winRate) {
    score += (trackWinRate - stats.winRate) * 200;
  } else if (trackWinRate < stats.winRate) {
    score += (trackWinRate - stats.winRate) * 100;
  }

  // 直近成績による補正 (好調/不調)
  if (stats.recentRaces >= 10) {
    const recentDiff = stats.recentWinRate - stats.winRate;
    score += recentDiff * 100;
  }

  return Math.min(100, Math.max(10, score));
}

/**
 * 騎手×調教師コンボスコア (0-100)
 */
export function calcJockeyTrainerScore(combo: JockeyTrainerCombo | undefined): number {
  if (!combo || combo.totalRaces < 3) return 50;

  // 勝率ベース + 複勝率ボーナス
  const score = 30 + combo.winRate * 200 + combo.placeRate * 80;
  return Math.min(100, Math.max(10, score));
}

/**
 * コース×距離の統計から枠順バイアススコア (0-100)
 */
export function calcHistoricalPostBias(
  stats: CourseDistanceStats | null,
  postPosition: number,
): number {
  // v4: 閾値を20→5に緩和（重み調整はエンジン側で行う）
  if (!stats || stats.totalRaces < 5) return 50;

  const postData = stats.postPositionWinRate[postPosition];
  if (!postData || postData.races < 3) {
    // データ不足の場合、内外で判定
    if (postPosition <= 4) {
      return 50 + (stats.innerFrameWinRate - 0.07) * 300;
    }
    return 50 + (stats.outerFrameWinRate - 0.07) * 300;
  }

  // 平均勝率との比較
  const avgRate = 1 / 8; // 8枠均等
  const diff = postData.rate - avgRate;
  return Math.min(100, Math.max(10, 50 + diff * 400));
}

/**
 * 季節パターンスコア (0-100)
 */
export function calcSeasonalScore(
  seasonalStats: SeasonalStats[] | undefined,
  targetMonth: number,
): number {
  if (!seasonalStats || seasonalStats.length < 3) return 50;

  const thisMonth = seasonalStats.find(s => s.month === targetMonth);
  if (!thisMonth || thisMonth.races < 1) return 50;

  // 全月平均との比較
  const totalRaces = seasonalStats.reduce((s, m) => s + m.races, 0);
  const totalWins = seasonalStats.reduce((s, m) => s + m.wins, 0);
  const avgWinRate = totalRaces > 0 ? totalWins / totalRaces : 0.10;

  const diff = thisMonth.winRate - avgWinRate;
  return Math.min(100, Math.max(10, 50 + diff * 300));
}

/**
 * 叩き2走目ボーナススコア (0-100)
 * 前走が休み明けで、今回が叩き2走目かどうかを判定
 */
export function calcSecondStartScore(
  bonus: SecondStartBonus | null,
  daysSinceLastRace: number,
  isSecondStart: boolean,
): number {
  if (!bonus || bonus.sampleSize < 2) return 50;
  if (!isSecondStart) return 50;

  // 叩き2走目で改善するパターンがあるか
  if (bonus.improvement > 0.05) {
    return Math.min(85, 55 + bonus.improvement * 200);
  }
  if (bonus.improvement < -0.05) {
    return Math.max(30, 50 + bonus.improvement * 150);
  }
  return 50;
}

// ==================== コース別動的基準タイム ====================

export interface DynamicStandardTime {
  racecourseName: string;
  trackType: string;
  distance: number;
  trackCondition: string;
  avgTimeSeconds: number;
  medianTimeSeconds: number;
  sampleSize: number;
}

/**
 * コース×距離×馬場状態別の動的基準タイムを算出する。
 * past_performances の実データから中央値を計算し、ハードコードの基準タイムを置き換える。
 */
export async function getDynamicStandardTimes(
  racecourseName: string,
  trackType: string,
  distance: number,
  trackCondition: string,
  raceDate?: string,
): Promise<DynamicStandardTime | null> {
  // キャッシュチェック
  const cacheKey = `getDynamicStandardTimes_${racecourseName}_${trackType}_${distance}_${raceDate || 'now'}`;
  const cached = getCached<DynamicStandardTime | null>(cacheKey);
  if (cached !== undefined) return cached;

  const tolerance = 50; // ±50m（より厳密にマッチ）
  const condGroup = (trackCondition === '重' || trackCondition === '不良')
    ? ['重', '不良']
    : (trackCondition === '稍重' ? ['稍重'] : ['良']);

  const placeholders = condGroup.map(() => '?').join(',');
  const dateFilter = raceDate ? ' AND date < ?' : '';
  const dateArgs = raceDate ? [raceDate] : [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT time
    FROM past_performances
    WHERE racecourse_name = ?
    AND track_type = ?
    AND distance BETWEEN ? AND ?
    AND track_condition IN (${placeholders})
    AND time IS NOT NULL AND time != ''
    AND position <= 5${dateFilter}
    ORDER BY date DESC
    LIMIT 200
  `, [racecourseName, trackType, distance - tolerance, distance + tolerance, ...condGroup, ...dateArgs]);

  if (rows.length < 5) {
    // コース限定でデータ不足 → 全場の同条件にフォールバック
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fallbackRows: any[] = await dbAll(`
      SELECT time
      FROM past_performances
      WHERE track_type = ?
      AND distance BETWEEN ? AND ?
      AND track_condition IN (${placeholders})
      AND time IS NOT NULL AND time != ''
      AND position <= 5${dateFilter}
      ORDER BY date DESC
      LIMIT 300
    `, [trackType, distance - tolerance, distance + tolerance, ...condGroup, ...dateArgs]);

    if (fallbackRows.length < 5) { setCache(cacheKey, null); return null; }

    const fallbackResult = buildTimeStats(fallbackRows, '', trackType, distance, trackCondition);
    setCache(cacheKey, fallbackResult);
    return fallbackResult;
  }

  const stdTimeResult = buildTimeStats(rows, racecourseName, trackType, distance, trackCondition);
  setCache(cacheKey, stdTimeResult);
  return stdTimeResult;
}

function buildTimeStats(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  racecourseName: string,
  trackType: string,
  distance: number,
  trackCondition: string,
): DynamicStandardTime | null {
  const times: number[] = [];
  for (const r of rows) {
    const t = timeStrToSeconds(r.time as string);
    if (t > 0) times.push(t);
  }
  if (times.length < 3) return null;

  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const avg = times.reduce((s, t) => s + t, 0) / times.length;

  return {
    racecourseName,
    trackType,
    distance,
    trackCondition,
    avgTimeSeconds: avg,
    medianTimeSeconds: median,
    sampleSize: times.length,
  };
}

function timeStrToSeconds(timeStr: string): number {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  const num = parseFloat(timeStr);
  return isNaN(num) ? 0 : num;
}

// ==================== 騎手直近フォーム ====================

export interface JockeyRecentForm {
  jockeyId: string;
  recent30DayWinRate: number;
  recent30DayRaces: number;
  yearWinRate: number;
  yearRaces: number;
  careerWinRate: number;
  trend: 'improving' | 'stable' | 'declining';
}

/**
 * 騎手の直近30日と年間の勝率トレンドを算出
 */
export async function getJockeyRecentForm(jockeyId: string, raceDate?: string): Promise<JockeyRecentForm | null> {
  if (!jockeyId) return null;

  const baseDate = raceDate ? new Date(raceDate) : new Date();
  const d30 = new Date(baseDate);
  d30.setDate(d30.getDate() - 30);
  const d30Str = d30.toISOString().slice(0, 10);

  const d365 = new Date(baseDate);
  d365.setFullYear(d365.getFullYear() - 1);
  const d365Str = d365.toISOString().slice(0, 10);

  const dateFilter = raceDate ? ' AND r.date < ?' : '';
  const args = [jockeyId, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT re.result_position, r.date
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE re.jockey_id = ?
    AND r.status = '結果確定'
    AND re.result_position IS NOT NULL${dateFilter}
  `, args);

  if (rows.length < 5) return null;

  let r30 = 0, w30 = 0, rYear = 0, wYear = 0;
  for (const r of rows) {
    if (r.date >= d30Str) { r30++; if (r.result_position === 1) w30++; }
    if (r.date >= d365Str) { rYear++; if (r.result_position === 1) wYear++; }
  }

  const careerWinRate = rows.filter(r => r.result_position === 1).length / rows.length;
  const yearWinRate = rYear > 0 ? wYear / rYear : careerWinRate;
  const recent30DayWinRate = r30 >= 3 ? w30 / r30 : yearWinRate;

  let trend: 'improving' | 'stable' | 'declining' = 'stable';
  if (r30 >= 5) {
    if (recent30DayWinRate > yearWinRate * 1.3) trend = 'improving';
    else if (recent30DayWinRate < yearWinRate * 0.7) trend = 'declining';
  }

  return {
    jockeyId,
    recent30DayWinRate,
    recent30DayRaces: r30,
    yearWinRate,
    yearRaces: rYear,
    careerWinRate,
    trend,
  };
}

// ==================== v7.0: ラップタイム基盤 ====================

const PACE_ENCODE: Record<string, number> = { 'ハイ': 1.0, 'ミドル': 0.5, 'スロー': 0.0 };

/**
 * コース×距離帯の平均ペースタイプ (0=スロー ~ 1=ハイ)
 */
async function getCoursePaceAvg(
  racecourseName: string,
  distance: number,
  raceDate?: string,
): Promise<number> {
  // キャッシュチェック
  const cacheKey = `getCoursePaceAvg_${racecourseName}_${distance}_${raceDate || 'now'}`;
  const cached = getCached<number>(cacheKey);
  if (cached !== undefined) return cached;

  const tolerance = 200;
  const dateFilter = raceDate ? ' AND date < ?' : '';
  const args = [racecourseName, distance - tolerance, distance + tolerance, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT pace_type, COUNT(*) as cnt
    FROM races
    WHERE racecourse_name = ?
      AND distance BETWEEN ? AND ?
      AND pace_type IS NOT NULL${dateFilter}
    GROUP BY pace_type
  `, args);

  if (rows.length === 0) { setCache(cacheKey, 0.5); return 0.5; }

  let total = 0;
  let sum = 0;
  for (const r of rows) {
    const cnt = Number(r.cnt);
    const val = PACE_ENCODE[r.pace_type as string] ?? 0.5;
    total += cnt;
    sum += val * cnt;
  }

  const paceAvg = total > 0 ? sum / total : 0.5;
  setCache(cacheKey, paceAvg);
  return paceAvg;
}

/**
 * 各馬の過去レースにおけるペース履歴 → preference + ハイペース率
 */
async function getHorsePaceHistory(
  horseIds: string[],
  raceDate?: string,
): Promise<Map<string, { preference: number; haiRate: number }>> {
  const result = new Map<string, { preference: number; haiRate: number }>();
  if (horseIds.length === 0) return result;

  const dateFilter = raceDate ? ' AND r.date < ?' : '';
  const placeholders = horseIds.map(() => '?').join(',');
  const args = [...horseIds, ...(raceDate ? [raceDate] : [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT pp.horse_id, r.pace_type
    FROM past_performances pp
    JOIN races r ON r.id = pp.race_id
    WHERE pp.horse_id IN (${placeholders})
      AND r.pace_type IS NOT NULL${dateFilter}
  `, args);

  // 馬別に集計
  const byHorse = new Map<string, string[]>();
  for (const r of rows) {
    const hid = r.horse_id as string;
    const arr = byHorse.get(hid) || [];
    arr.push(r.pace_type as string);
    byHorse.set(hid, arr);
  }

  for (const [hid, paces] of byHorse) {
    const sum = paces.reduce((s, p) => s + (PACE_ENCODE[p] ?? 0.5), 0);
    const preference = sum / paces.length;
    const haiRate = paces.filter(p => p === 'ハイ').length / paces.length;
    result.set(hid, { preference, haiRate });
  }

  return result;
}
