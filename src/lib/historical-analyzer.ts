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

import { getDatabase } from './database';

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
  seasonalMap: Map<string, SeasonalStats[]>;
  secondStartMap: Map<string, SecondStartBonus | null>;
}

// ==================== メイン関数 ====================

/**
 * レース条件に基づいて統計コンテキストを一括構築する。
 * 予測エンジンから1レースにつき1回だけ呼ぶ。
 */
export function buildRaceContext(
  racecourseName: string,
  trackType: string,
  distance: number,
  month: number,
  horses: { horseId: string; fatherName: string; jockeyId: string; trainerName: string }[],
): RaceHistoricalContext {
  const courseDistStats = getCourseDistanceStats(racecourseName, trackType, distance);

  const sireStatsMap = new Map<string, SireStats>();
  const uniqueSires = [...new Set(horses.map(h => h.fatherName).filter(Boolean))];
  for (const sire of uniqueSires) {
    const stats = getSireStats(sire);
    if (stats) sireStatsMap.set(sire, stats);
  }

  const jockeyTrainerMap = new Map<string, JockeyTrainerCombo>();
  for (const h of horses) {
    if (h.jockeyId && h.trainerName) {
      const key = `${h.jockeyId}__${h.trainerName}`;
      if (!jockeyTrainerMap.has(key)) {
        const combo = getJockeyTrainerCombo(h.jockeyId, h.trainerName);
        if (combo) jockeyTrainerMap.set(key, combo);
      }
    }
  }

  const seasonalMap = new Map<string, SeasonalStats[]>();
  for (const h of horses) {
    const stats = getHorseSeasonalStats(h.horseId);
    if (stats.length > 0) seasonalMap.set(h.horseId, stats);
  }

  const secondStartMap = new Map<string, SecondStartBonus | null>();
  for (const h of horses) {
    secondStartMap.set(h.horseId, getSecondStartBonus(h.horseId));
  }

  return { courseDistStats, sireStatsMap, jockeyTrainerMap, seasonalMap, secondStartMap };
}

// ==================== 個別統計関数 ====================

function getCourseDistanceStats(
  racecourseName: string,
  trackType: string,
  distance: number,
): CourseDistanceStats | null {
  const db = getDatabase();
  const tolerance = 100;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = db.prepare(`
    SELECT post_position, position, entries, last_three_furlongs, corner_positions
    FROM past_performances
    WHERE racecourse_name = ?
    AND track_type = ?
    AND distance BETWEEN ? AND ?
    AND entries > 0
  `).all(racecourseName, trackType, distance - tolerance, distance + tolerance);

  if (rows.length < 10) return null;

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

function getSireStats(sireName: string): SireStats | null {
  const db = getDatabase();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = db.prepare(`
    SELECT pp.track_type, pp.distance, pp.track_condition, pp.position, pp.entries
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE h.father_name = ?
    AND pp.entries > 0
  `).all(sireName);

  if (rows.length < 5) return null;

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

function getJockeyTrainerCombo(jockeyId: string, trainerName: string): JockeyTrainerCombo | null {
  const db = getDatabase();

  // race_entries + races テーブルから結果確定レースのコンボ成績を集計
  // ただし、past_performances にも jockey_name と trainer_name (horsesから) があるので活用
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = db.prepare(`
    SELECT pp.position, pp.entries
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE pp.jockey_name = (SELECT name FROM jockeys WHERE id = ?)
    AND h.trainer_name = ?
    AND pp.entries > 0
  `).all(jockeyId, trainerName);

  if (rows.length < 3) return null;

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

function getHorseSeasonalStats(horseId: string): SeasonalStats[] {
  const db = getDatabase();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = db.prepare(`
    SELECT
      CAST(substr(date, 6, 2) AS INTEGER) as month,
      position, entries
    FROM past_performances
    WHERE horse_id = ?
    AND date IS NOT NULL
    AND entries > 0
  `).all(horseId);

  if (rows.length < 3) return [];

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
function getSecondStartBonus(horseId: string): SecondStartBonus | null {
  const db = getDatabase();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = db.prepare(`
    SELECT date, position, entries
    FROM past_performances
    WHERE horse_id = ?
    AND entries > 0
    ORDER BY date ASC
  `).all(horseId);

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
  if (!stats || stats.totalRaces < 20) return 50;

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
