import { dbAll, dbGet, dbRun, dbRunNamed, dbBatch } from './database';
import type {
  Horse, Jockey, Race, RaceEntry, PastPerformance,
  Odds, Prediction, PredictionPick, RaceAnalysis, RecommendedBet,
  RACECOURSES
} from '@/types';

// ==================== 競馬場 ====================

export async function getAllRacecourses() {
  return dbAll('SELECT * FROM racecourses ORDER BY region, name');
}

export async function seedRacecourses(racecourses: typeof RACECOURSES) {
  const statements = racecourses.map(rc => ({
    sql: 'INSERT OR REPLACE INTO racecourses (id, name, region, prefecture) VALUES (?, ?, ?, ?)',
    args: [rc.id, rc.name, rc.region, rc.prefecture],
  }));
  await dbBatch(statements);
}

// ==================== レース ====================

export async function getRacesByDate(date: string) {
  return dbAll<Race & { entry_count: number }>(`
    SELECT r.*, COUNT(e.id) as entry_count
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    WHERE r.date = ?
    GROUP BY r.id
    ORDER BY r.racecourse_name, r.race_number
  `, [date]);
}

export async function getRacesByDateRange(startDate: string, endDate: string) {
  return dbAll<Race & { entry_count: number }>(`
    SELECT r.*, COUNT(e.id) as entry_count
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    WHERE r.date BETWEEN ? AND ?
    GROUP BY r.id
    ORDER BY r.date, r.racecourse_name, r.race_number
  `, [startDate, endDate]);
}

export async function getRaceById(raceId: string) {
  const race = await dbGet<Race>('SELECT * FROM races WHERE id = ?', [raceId]);
  if (!race) return null;

  const entries = await dbAll<RaceEntry>(`
    SELECT * FROM race_entries WHERE race_id = ? ORDER BY horse_number
  `, [raceId]);

  return { ...race, entries };
}

export async function getUpcomingRaces(limit: number = 50) {
  return dbAll<Race & { entry_count: number }>(`
    SELECT r.*, COUNT(e.id) as entry_count
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    WHERE r.date >= date('now')
    AND r.status IN ('予定', '出走確定')
    GROUP BY r.id
    ORDER BY r.date, r.racecourse_name, r.race_number
    LIMIT ?
  `, [limit]);
}

export async function getRecentResults(limit: number = 50) {
  return dbAll<Race & { entry_count: number }>(`
    SELECT r.*, COUNT(e.id) as entry_count
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    WHERE r.status = '結果確定'
    GROUP BY r.id
    ORDER BY r.date DESC, r.racecourse_name DESC, r.race_number DESC
    LIMIT ?
  `, [limit]);
}

export async function upsertRace(race: Partial<Race> & { id: string }) {
  await dbRunNamed(`
    INSERT OR REPLACE INTO races (id, name, date, time, racecourse_id, racecourse_name, race_number, grade, track_type, distance, track_condition, weather, status)
    VALUES (@id, @name, @date, @time, @racecourse_id, @racecourse_name, @race_number, @grade, @track_type, @distance, @track_condition, @weather, @status)
  `, {
    id: race.id,
    name: race.name || '',
    date: race.date || '',
    time: race.time || null,
    racecourse_id: race.racecourseId || '',
    racecourse_name: race.racecourseName || '',
    race_number: race.raceNumber || 0,
    grade: race.grade || null,
    track_type: race.trackType || 'ダート',
    distance: race.distance || 0,
    track_condition: race.trackCondition || null,
    weather: race.weather || null,
    status: race.status || '予定',
  });
}

// ==================== 出走馬 ====================

export async function upsertRaceEntry(raceId: string, entry: Partial<RaceEntry>) {
  // まず既存エントリを確認
  const existing = await dbGet<{ id: number }>(
    'SELECT id FROM race_entries WHERE race_id = ? AND horse_number = ?',
    [raceId, entry.horseNumber]
  );

  if (existing) {
    await dbRun(`
      UPDATE race_entries SET
        post_position = ?, horse_id = ?, horse_name = ?, age = ?, sex = ?,
        weight = ?, jockey_id = ?, jockey_name = ?, trainer_name = ?,
        handicap_weight = ?, result_position = ?, result_time = ?,
        result_margin = ?, result_last_three_furlongs = ?,
        result_corner_positions = ?, result_weight = ?, result_weight_change = ?
      WHERE race_id = ? AND horse_number = ?
    `, [
      entry.postPosition, entry.horseId, entry.horseName, entry.age, entry.sex,
      entry.weight, entry.jockeyId, entry.jockeyName, entry.trainerName,
      entry.handicapWeight, entry.result?.position, entry.result?.time,
      entry.result?.margin, entry.result?.lastThreeFurlongs,
      entry.result?.cornerPositions, entry.result?.weight, entry.result?.weightChange,
      raceId, entry.horseNumber,
    ]);
  } else {
    await dbRun(`
      INSERT INTO race_entries (
        race_id, post_position, horse_number, horse_id, horse_name, age, sex,
        weight, jockey_id, jockey_name, trainer_name, handicap_weight,
        result_position, result_time, result_margin, result_last_three_furlongs,
        result_corner_positions, result_weight, result_weight_change
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      raceId, entry.postPosition, entry.horseNumber, entry.horseId, entry.horseName,
      entry.age, entry.sex, entry.weight, entry.jockeyId, entry.jockeyName,
      entry.trainerName, entry.handicapWeight, entry.result?.position,
      entry.result?.time, entry.result?.margin, entry.result?.lastThreeFurlongs,
      entry.result?.cornerPositions, entry.result?.weight, entry.result?.weightChange,
    ]);
  }
}

// ==================== 馬 ====================

export async function getHorseById(horseId: string) {
  const horse = await dbGet<Record<string, unknown>>('SELECT * FROM horses WHERE id = ?', [horseId]);
  if (!horse) return null;

  const traits = await dbAll<{ trait_type: string; description: string }>('SELECT * FROM horse_traits WHERE horse_id = ?', [horseId]);
  const strengths = traits.filter(t => t.trait_type === 'strength').map(t => t.description);
  const weaknesses = traits.filter(t => t.trait_type === 'weakness').map(t => t.description);

  return { ...horse, strengths, weaknesses };
}

export async function searchHorses(query: string, limit: number = 20) {
  return dbAll(`
    SELECT * FROM horses WHERE name LIKE ? ORDER BY total_earnings DESC LIMIT ?
  `, [`%${query}%`, limit]);
}

export async function getAllHorses(limit: number = 100, offset: number = 0) {
  return dbAll(`
    SELECT * FROM horses ORDER BY total_earnings DESC LIMIT ? OFFSET ?
  `, [limit, offset]);
}

export async function upsertHorse(horse: Partial<Horse> & { id: string }) {
  await dbRunNamed(`
    INSERT OR REPLACE INTO horses (
      id, name, name_en, age, sex, color, birth_date,
      father_id, father_name, mother_id, mother_name,
      trainer_name, owner_name, total_races, wins, seconds, thirds,
      total_earnings, condition_overall, condition_weight, condition_weight_change,
      training_comment, updated_at
    ) VALUES (
      @id, @name, @name_en, @age, @sex, @color, @birth_date,
      @father_id, @father_name, @mother_id, @mother_name,
      @trainer_name, @owner_name, @total_races, @wins, @seconds, @thirds,
      @total_earnings, @condition_overall, @condition_weight, @condition_weight_change,
      @training_comment, datetime('now')
    )
  `, {
    id: horse.id,
    name: horse.name || '',
    name_en: horse.nameEn || null,
    age: horse.age || 0,
    sex: horse.sex || '牡',
    color: horse.color || '',
    birth_date: horse.birthDate || null,
    father_id: horse.fatherId || null,
    father_name: horse.fatherName || '',
    mother_id: horse.motherId || null,
    mother_name: horse.motherName || '',
    trainer_name: horse.trainerName || '',
    owner_name: horse.ownerName || '',
    total_races: horse.totalRaces || 0,
    wins: horse.wins || 0,
    seconds: horse.seconds || 0,
    thirds: horse.thirds || 0,
    total_earnings: horse.totalEarnings || 0,
    condition_overall: horse.condition?.overall || '普通',
    condition_weight: horse.condition?.weight || null,
    condition_weight_change: horse.condition?.weightChange || null,
    training_comment: horse.condition?.trainingComment || null,
  });
}

export async function setHorseTraits(horseId: string, strengths: string[], weaknesses: string[]) {
  const statements: { sql: string; args: unknown[] }[] = [
    { sql: 'DELETE FROM horse_traits WHERE horse_id = ?', args: [horseId] },
    ...strengths.map(s => ({
      sql: 'INSERT INTO horse_traits (horse_id, trait_type, description) VALUES (?, ?, ?)',
      args: [horseId, 'strength', s],
    })),
    ...weaknesses.map(w => ({
      sql: 'INSERT INTO horse_traits (horse_id, trait_type, description) VALUES (?, ?, ?)',
      args: [horseId, 'weakness', w],
    })),
  ];
  await dbBatch(statements);
}

// ==================== 騎手 ====================

export async function getJockeyById(jockeyId: string) {
  return dbGet('SELECT * FROM jockeys WHERE id = ?', [jockeyId]);
}

export async function searchJockeys(query: string, limit: number = 20) {
  return dbAll(`
    SELECT * FROM jockeys WHERE name LIKE ? ORDER BY wins DESC LIMIT ?
  `, [`%${query}%`, limit]);
}

export async function getAllJockeys(limit: number = 100, offset: number = 0) {
  return dbAll(`
    SELECT * FROM jockeys ORDER BY wins DESC LIMIT ? OFFSET ?
  `, [limit, offset]);
}

export async function upsertJockey(jockey: Partial<Jockey> & { id: string }) {
  await dbRunNamed(`
    INSERT OR REPLACE INTO jockeys (
      id, name, name_en, age, region, belongs_to,
      total_races, wins, win_rate, place_rate, show_rate,
      total_earnings, updated_at
    ) VALUES (
      @id, @name, @name_en, @age, @region, @belongs_to,
      @total_races, @wins, @win_rate, @place_rate, @show_rate,
      @total_earnings, datetime('now')
    )
  `, {
    id: jockey.id,
    name: jockey.name || '',
    name_en: jockey.nameEn || null,
    age: jockey.age || null,
    region: jockey.region || '中央',
    belongs_to: jockey.belongsTo || '',
    total_races: jockey.totalRaces || 0,
    wins: jockey.wins || 0,
    win_rate: jockey.winRate || 0,
    place_rate: jockey.placeRate || 0,
    show_rate: jockey.showRate || 0,
    total_earnings: jockey.totalEarnings || 0,
  });
}

// ==================== 過去成績 ====================

// DBのスネークケースカラムをキャメルケースにマッピング
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapPastPerformance(row: any): PastPerformance {
  return {
    raceId: row.race_id ?? row.raceId ?? '',
    date: row.date ?? '',
    raceName: row.race_name ?? row.raceName ?? '',
    racecourseName: row.racecourse_name ?? row.racecourseName ?? '',
    trackType: row.track_type ?? row.trackType ?? '芝',
    distance: row.distance ?? 0,
    trackCondition: row.track_condition ?? row.trackCondition ?? '良',
    weather: row.weather ?? '晴',
    entries: row.entries ?? 0,
    postPosition: row.post_position ?? row.postPosition ?? 0,
    horseNumber: row.horse_number ?? row.horseNumber ?? 0,
    position: row.position ?? 0,
    jockeyName: row.jockey_name ?? row.jockeyName ?? '',
    handicapWeight: row.handicap_weight ?? row.handicapWeight ?? 0,
    weight: row.weight ?? 0,
    weightChange: row.weight_change ?? row.weightChange ?? 0,
    time: row.time ?? '',
    margin: row.margin ?? '',
    lastThreeFurlongs: row.last_three_furlongs ?? row.lastThreeFurlongs ?? '',
    cornerPositions: row.corner_positions ?? row.cornerPositions ?? '',
    odds: row.odds ?? 0,
    popularity: row.popularity ?? 0,
    prize: row.prize ?? 0,
  };
}

export async function getHorsePastPerformances(horseId: string, limit: number = 100) {
  const rows = await dbAll(`
    SELECT * FROM past_performances WHERE horse_id = ? ORDER BY date DESC LIMIT ?
  `, [horseId, limit]);
  return rows.map(mapPastPerformance);
}

export async function insertPastPerformance(horseId: string, perf: Partial<PastPerformance>) {
  await dbRun(`
    INSERT INTO past_performances (
      horse_id, race_id, date, race_name, racecourse_name, track_type,
      distance, track_condition, weather, entries, post_position,
      horse_number, position, jockey_name, handicap_weight,
      weight, weight_change, time, margin, last_three_furlongs,
      corner_positions, odds, popularity, prize
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    horseId, perf.raceId, perf.date, perf.raceName, perf.racecourseName,
    perf.trackType, perf.distance, perf.trackCondition, perf.weather,
    perf.entries, perf.postPosition, perf.horseNumber, perf.position,
    perf.jockeyName, perf.handicapWeight, perf.weight, perf.weightChange,
    perf.time, perf.margin, perf.lastThreeFurlongs, perf.cornerPositions,
    perf.odds, perf.popularity, perf.prize,
  ]);
}

// ==================== オッズ ====================

export async function getOddsByRaceId(raceId: string) {
  return dbAll(`
    SELECT * FROM odds WHERE race_id = ? ORDER BY bet_type, odds
  `, [raceId]);
}

export async function upsertOdds(raceId: string, betType: string, horses: number[], oddsValue: number, minOdds?: number, maxOdds?: number) {
  await dbRun(`
    INSERT OR REPLACE INTO odds (race_id, bet_type, horse_number1, horse_number2, horse_number3, odds, min_odds, max_odds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [raceId, betType, horses[0] || null, horses[1] || null, horses[2] || null, oddsValue, minOdds || null, maxOdds || null]);
}

// ==================== AI予想 ====================

export async function getPredictionByRaceId(raceId: string) {
  const row = await dbGet<Record<string, unknown>>(`
    SELECT * FROM predictions WHERE race_id = ? ORDER BY generated_at DESC LIMIT 1
  `, [raceId]);

  if (!row) return null;

  return {
    raceId: row.race_id as string,
    generatedAt: row.generated_at as string,
    confidence: row.confidence as number,
    summary: row.summary as string,
    analysis: JSON.parse(row.analysis_json as string || '{}') as RaceAnalysis,
    topPicks: JSON.parse(row.picks_json as string || '[]') as PredictionPick[],
    recommendedBets: JSON.parse(row.bets_json as string || '[]') as RecommendedBet[],
  };
}

export async function savePrediction(prediction: Prediction) {
  await dbRun(`
    INSERT INTO predictions (race_id, generated_at, confidence, summary, analysis_json, picks_json, bets_json)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
  `, [
    prediction.raceId,
    prediction.confidence,
    prediction.summary,
    JSON.stringify(prediction.analysis),
    JSON.stringify(prediction.topPicks),
    JSON.stringify(prediction.recommendedBets),
  ]);
}

// ==================== 統計 ====================

export async function getDashboardStats() {
  const totalHorses = ((await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM horses'))!).count;
  const totalJockeys = ((await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM jockeys'))!).count;
  const totalRaces = ((await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM races'))!).count;
  const upcomingRaces = ((await dbGet<{ count: number }>("SELECT COUNT(*) as count FROM races WHERE date >= date('now') AND status IN ('予定', '出走確定')"))!).count;
  const totalPredictions = ((await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM predictions'))!).count;

  // 的中率統計
  const predResults = (await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM prediction_results'))!;
  const accuracyData = predResults.c > 0 ? await dbGet<{ total_evaluated: number; win_hit_rate: number; place_hit_rate: number; top3_coverage: number }>(`
    SELECT
      COUNT(*) as total_evaluated,
      ROUND(AVG(win_hit) * 100, 1) as win_hit_rate,
      ROUND(AVG(place_hit) * 100, 1) as place_hit_rate,
      ROUND(AVG(CAST(top3_picks_hit as REAL) / 3.0) * 100, 1) as top3_coverage
    FROM prediction_results
  `) : null;

  return {
    totalHorses, totalJockeys, totalRaces, upcomingRaces, totalPredictions,
    accuracy: accuracyData ? {
      totalEvaluated: accuracyData.total_evaluated,
      winHitRate: accuracyData.win_hit_rate,
      placeHitRate: accuracyData.place_hit_rate,
      top3Coverage: accuracyData.top3_coverage,
    } : null,
  };
}

// ==================== 騎手成績（レース別） ====================

export async function getJockeyRecentResults(jockeyId: string, limit: number = 20) {
  return dbAll(`
    SELECT e.*, r.name as race_name, r.date, r.racecourse_name, r.track_type, r.distance
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id = ? AND r.status = '結果確定'
    ORDER BY r.date DESC
    LIMIT ?
  `, [jockeyId, limit]);
}

// ==================== 大規模データ向け統計クエリ ====================

/** 種牡馬別統計: コース×馬場×距離レンジ別の成績 */
export async function getSireStats(fatherName: string) {
  return dbAll(`
    SELECT
      pp.track_type,
      pp.racecourse_name,
      CASE
        WHEN pp.distance <= 1400 THEN '短距離'
        WHEN pp.distance <= 1800 THEN 'マイル'
        WHEN pp.distance <= 2200 THEN '中距離'
        ELSE '長距離'
      END as distance_category,
      pp.track_condition,
      COUNT(*) as total_runs,
      SUM(CASE WHEN pp.position = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pp.position <= 3 THEN 1 ELSE 0 END) as top3,
      ROUND(AVG(CAST(pp.position as REAL) / COALESCE(pp.entries, 16)), 3) as avg_position_ratio,
      ROUND(AVG(CAST(pp.last_three_furlongs as REAL)), 2) as avg_last_3f
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE h.father_name = ?
    GROUP BY pp.track_type, pp.racecourse_name, distance_category, pp.track_condition
    HAVING total_runs >= 3
    ORDER BY total_runs DESC
  `, [fatherName]);
}

/** 種牡馬の全体勝率サマリ */
export async function getSireSummary(fatherName: string) {
  return dbGet(`
    SELECT
      h.father_name,
      COUNT(DISTINCT h.id) as num_offspring,
      COUNT(*) as total_runs,
      SUM(CASE WHEN pp.position = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pp.position <= 3 THEN 1 ELSE 0 END) as top3,
      ROUND(CAST(SUM(CASE WHEN pp.position = 1 THEN 1 ELSE 0 END) as REAL) / COUNT(*), 4) as win_rate,
      ROUND(CAST(SUM(CASE WHEN pp.position <= 3 THEN 1 ELSE 0 END) as REAL) / COUNT(*), 4) as top3_rate
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE h.father_name = ?
    GROUP BY h.father_name
  `, [fatherName]);
}

/** コース別統計: 競馬場×芝ダート×距離の全馬成績分布 */
export async function getCourseStats(racecourseName: string, trackType: string) {
  return dbAll(`
    SELECT
      pp.distance,
      pp.track_condition,
      COUNT(*) as total_runs,
      SUM(CASE WHEN pp.position = 1 THEN 1 ELSE 0 END) as wins,
      ROUND(AVG(CAST(pp.last_three_furlongs as REAL)), 2) as avg_last_3f,
      ROUND(AVG(CASE WHEN pp.time IS NOT NULL AND pp.time != '' THEN
        CAST(SUBSTR(pp.time, 1, INSTR(pp.time, ':') - 1) as REAL) * 60 +
        CAST(SUBSTR(pp.time, INSTR(pp.time, ':') + 1) as REAL)
      END), 2) as avg_time_seconds
    FROM past_performances pp
    WHERE pp.racecourse_name = ? AND pp.track_type = ?
    GROUP BY pp.distance, pp.track_condition
    HAVING total_runs >= 5
    ORDER BY pp.distance, pp.track_condition
  `, [racecourseName, trackType]);
}

/** DB全体のデータ量サマリ（バルクインポートの確認用） */
export async function getDataVolumeSummary() {
  const horses = ((await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM horses'))!).c;
  const races = ((await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM races'))!).c;
  const pastPerfs = ((await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM past_performances'))!).c;
  const entries = ((await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM race_entries'))!).c;
  const odds = ((await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM odds'))!).c;
  const predictions = ((await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM predictions'))!).c;
  const avgPPperHorse = horses > 0
    ? ((await dbGet<{ avg: number }>('SELECT ROUND(AVG(cnt), 1) as avg FROM (SELECT COUNT(*) as cnt FROM past_performances GROUP BY horse_id)'))?.avg || 0)
    : 0;
  const uniqueSires = ((await dbGet<{ c: number }>("SELECT COUNT(DISTINCT father_name) as c FROM horses WHERE father_name IS NOT NULL AND father_name != ''"))!).c;
  const uniqueCourses = ((await dbGet<{ c: number }>('SELECT COUNT(DISTINCT racecourse_name) as c FROM past_performances'))!).c;

  return {
    horses, races, pastPerfs, entries, odds, predictions,
    avgPPperHorse, uniqueSires, uniqueCourses,
  };
}
