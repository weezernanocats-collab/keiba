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
): Promise<RaceHistoricalContext> {
  const uniqueSires = [...new Set(horses.map(h => h.fatherName).filter(Boolean))];
  const uniqueTrainers = [...new Set(horses.map(h => h.trainerName).filter(Boolean))];
  const uniqueJockeys = [...new Set(horses.map(h => h.jockeyId).filter(Boolean))];
  const uniqueJTKeys = [...new Set(
    horses.filter(h => h.jockeyId && h.trainerName).map(h => `${h.jockeyId}__${h.trainerName}`)
  )];

  // 独立したクエリを全て並列実行
  const [
    courseDistStats,
    sireResults,
    jtResults,
    trainerResults,
    seasonalResults,
    secondStartResults,
    dynamicStdTime,
    jockeyFormResults,
    paceProfile,
  ] = await Promise.all([
    getCourseDistanceStats(racecourseName, trackType, distance),
    Promise.all(uniqueSires.map(async s => [s, await getSireStats(s)] as const)),
    Promise.all(uniqueJTKeys.map(async key => {
      const [jid, tname] = key.split('__');
      return [key, await getJockeyTrainerCombo(jid, tname)] as const;
    })),
    Promise.all(uniqueTrainers.map(async t => [t, await getTrainerStats(t)] as const)),
    Promise.all(horses.map(async h => [h.horseId, await getHorseSeasonalStats(h.horseId)] as const)),
    Promise.all(horses.map(async h => [h.horseId, await getSecondStartBonus(h.horseId)] as const)),
    getDynamicStandardTimes(racecourseName, trackType, distance, '良'),
    Promise.all(uniqueJockeys.map(async jid => [jid, await getJockeyRecentForm(jid)] as const)),
    getPaceProfile(racecourseName, trackType, distance),
  ]);

  const sireStatsMap = new Map<string, SireStats>();
  for (const [name, stats] of sireResults) { if (stats) sireStatsMap.set(name, stats); }

  const jockeyTrainerMap = new Map<string, JockeyTrainerCombo>();
  for (const [key, combo] of jtResults) { if (combo) jockeyTrainerMap.set(key, combo); }

  const trainerStatsMap = new Map<string, TrainerStats>();
  for (const [name, stats] of trainerResults) { if (stats) trainerStatsMap.set(name, stats); }

  const seasonalMap = new Map<string, SeasonalStats[]>();
  for (const [id, stats] of seasonalResults) { if (stats.length > 0) seasonalMap.set(id, stats); }

  const secondStartMap = new Map<string, SecondStartBonus | null>();
  for (const [id, bonus] of secondStartResults) { secondStartMap.set(id, bonus); }

  const jockeyFormMap = new Map<string, JockeyRecentForm>();
  for (const [jid, form] of jockeyFormResults) { if (form) jockeyFormMap.set(jid, form); }

  return { courseDistStats, sireStatsMap, jockeyTrainerMap, trainerStatsMap, seasonalMap, secondStartMap, dynamicStdTime, jockeyFormMap, paceProfile };
}

// ==================== 個別統計関数 ====================

async function getCourseDistanceStats(
  racecourseName: string,
  trackType: string,
  distance: number,
): Promise<CourseDistanceStats | null> {
  const tolerance = 100;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT post_position, position, entries, last_three_furlongs, corner_positions
    FROM past_performances
    WHERE racecourse_name = ?
    AND track_type = ?
    AND distance BETWEEN ? AND ?
    AND entries > 0
  `, [racecourseName, trackType, distance - tolerance, distance + tolerance]);

  // v4: 閾値を10→3に緩和（少ないデータでも部分的に活用、重み調整はエンジン側で行う）
  if (rows.length < 3) return null;

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

  return {
    totalRaces: rows.length,
    postPositionWinRate,
    innerFrameWinRate: innerTotal > 0 ? innerWins / innerTotal : 0,
    outerFrameWinRate: outerTotal > 0 ? outerWins / outerTotal : 0,
    avgWinLast3F: winLast3Fs.length > 0 ? winLast3Fs.reduce((a, b) => a + b, 0) / winLast3Fs.length : 0,
    frontRunnerRate: totalWins > 0 ? frontRunnerWins / totalWins : 0.5,
  };
}

async function getSireStats(sireName: string): Promise<SireStats | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT pp.track_type, pp.distance, pp.track_condition, pp.position, pp.entries
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE h.father_name = ?
    AND pp.entries > 0
  `, [sireName]);

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

async function getJockeyTrainerCombo(jockeyId: string, trainerName: string): Promise<JockeyTrainerCombo | null> {
  // race_entries + races テーブルから結果確定レースのコンボ成績を集計
  // ただし、past_performances にも jockey_name と trainer_name (horsesから) があるので活用
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT pp.position, pp.entries
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE pp.jockey_name = (SELECT name FROM jockeys WHERE id = ?)
    AND h.trainer_name = ?
    AND pp.entries > 0
  `, [jockeyId, trainerName]);

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

async function getTrainerStats(trainerName: string): Promise<TrainerStats | null> {
  // race_entries + races から調教師の成績を集計
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT re.result_position, r.track_type, r.date
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE r.status = '結果確定'
      AND re.trainer_name = ?
      AND re.result_position IS NOT NULL
  `, [trainerName]);

  if (rows.length < 5) return null;

  let wins = 0, places = 0;
  let turfWins = 0, turfRaces = 0;
  let dirtWins = 0, dirtRaces = 0;
  let recentWins = 0, recentRaces = 0;

  // 直近1年の閾値
  const oneYearAgo = new Date();
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

async function getHorseSeasonalStats(horseId: string): Promise<SeasonalStats[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT
      CAST(substr(date, 6, 2) AS INTEGER) as month,
      position, entries
    FROM past_performances
    WHERE horse_id = ?
    AND date IS NOT NULL
    AND entries > 0
  `, [horseId]);

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
async function getSecondStartBonus(horseId: string): Promise<SecondStartBonus | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT date, position, entries
    FROM past_performances
    WHERE horse_id = ?
    AND entries > 0
    ORDER BY date ASC
  `, [horseId]);

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

// ==================== ペースプロファイル ====================

/**
 * コース×トラック×距離帯の過去データからペースプロファイルを算出
 */
async function getPaceProfile(
  racecourseName: string,
  trackType: string,
  distance: number,
): Promise<HistoricalPaceProfile | null> {
  const tolerance = 200;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT corner_positions, position, entries
    FROM past_performances
    WHERE racecourse_name = ? AND track_type = ?
      AND distance BETWEEN ? AND ?
      AND entries > 0 AND position > 0
    ORDER BY date DESC LIMIT 500
  `, [racecourseName, trackType, distance - tolerance, distance + tolerance]);

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
): Promise<DynamicStandardTime | null> {
  const tolerance = 50; // ±50m（より厳密にマッチ）
  const condGroup = (trackCondition === '重' || trackCondition === '不良')
    ? ['重', '不良']
    : (trackCondition === '稍重' ? ['稍重'] : ['良']);

  const placeholders = condGroup.map(() => '?').join(',');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT time
    FROM past_performances
    WHERE racecourse_name = ?
    AND track_type = ?
    AND distance BETWEEN ? AND ?
    AND track_condition IN (${placeholders})
    AND time IS NOT NULL AND time != ''
    AND position <= 5
    ORDER BY date DESC
    LIMIT 200
  `, [racecourseName, trackType, distance - tolerance, distance + tolerance, ...condGroup]);

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
      AND position <= 5
      ORDER BY date DESC
      LIMIT 300
    `, [trackType, distance - tolerance, distance + tolerance, ...condGroup]);

    if (fallbackRows.length < 5) return null;

    return buildTimeStats(fallbackRows, '', trackType, distance, trackCondition);
  }

  return buildTimeStats(rows, racecourseName, trackType, distance, trackCondition);
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
export async function getJockeyRecentForm(jockeyId: string): Promise<JockeyRecentForm | null> {
  if (!jockeyId) return null;

  const now = new Date();
  const d30 = new Date(now);
  d30.setDate(d30.getDate() - 30);
  const d30Str = d30.toISOString().slice(0, 10);

  const d365 = new Date(now);
  d365.setFullYear(d365.getFullYear() - 1);
  const d365Str = d365.toISOString().slice(0, 10);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await dbAll(`
    SELECT re.result_position, r.date
    FROM race_entries re
    JOIN races r ON r.id = re.race_id
    WHERE re.jockey_id = ?
    AND r.status = '結果確定'
    AND re.result_position IS NOT NULL
  `, [jockeyId]);

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
