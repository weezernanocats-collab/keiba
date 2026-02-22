import { getDatabase } from './database';
import type {
  Horse, Jockey, Race, RaceEntry, PastPerformance,
  Odds, Prediction, PredictionPick, RaceAnalysis, RecommendedBet,
  RACECOURSES
} from '@/types';

// ==================== 競馬場 ====================

export function getAllRacecourses() {
  const db = getDatabase();
  return db.prepare('SELECT * FROM racecourses ORDER BY region, name').all();
}

export function seedRacecourses(racecourses: typeof RACECOURSES) {
  const db = getDatabase();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO racecourses (id, name, region, prefecture) VALUES (?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    for (const rc of racecourses) {
      stmt.run(rc.id, rc.name, rc.region, rc.prefecture);
    }
  });
  tx();
}

// ==================== レース ====================

export function getRacesByDate(date: string) {
  const db = getDatabase();
  return db.prepare(`
    SELECT r.*, COUNT(e.id) as entry_count
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    WHERE r.date = ?
    GROUP BY r.id
    ORDER BY r.racecourse_name, r.race_number
  `).all(date) as (Race & { entry_count: number })[];
}

export function getRacesByDateRange(startDate: string, endDate: string) {
  const db = getDatabase();
  return db.prepare(`
    SELECT r.*, COUNT(e.id) as entry_count
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    WHERE r.date BETWEEN ? AND ?
    GROUP BY r.id
    ORDER BY r.date, r.racecourse_name, r.race_number
  `).all(startDate, endDate) as (Race & { entry_count: number })[];
}

export function getRaceById(raceId: string) {
  const db = getDatabase();
  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(raceId) as Race | undefined;
  if (!race) return null;

  const entries = db.prepare(`
    SELECT * FROM race_entries WHERE race_id = ? ORDER BY horse_number
  `).all(raceId) as RaceEntry[];

  return { ...race, entries };
}

export function getUpcomingRaces(limit: number = 50) {
  const db = getDatabase();
  return db.prepare(`
    SELECT r.*, COUNT(e.id) as entry_count
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    WHERE r.date >= date('now')
    AND r.status IN ('予定', '出走確定')
    GROUP BY r.id
    ORDER BY r.date, r.racecourse_name, r.race_number
    LIMIT ?
  `).all(limit) as (Race & { entry_count: number })[];
}

export function getRecentResults(limit: number = 50) {
  const db = getDatabase();
  return db.prepare(`
    SELECT r.*, COUNT(e.id) as entry_count
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    WHERE r.status = '結果確定'
    GROUP BY r.id
    ORDER BY r.date DESC, r.racecourse_name DESC, r.race_number DESC
    LIMIT ?
  `).all(limit) as (Race & { entry_count: number })[];
}

export function upsertRace(race: Partial<Race> & { id: string }) {
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO races (id, name, date, time, racecourse_id, racecourse_name, race_number, grade, track_type, distance, track_condition, weather, status)
    VALUES (@id, @name, @date, @time, @racecourse_id, @racecourse_name, @race_number, @grade, @track_type, @distance, @track_condition, @weather, @status)
  `).run({
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

export function upsertRaceEntry(raceId: string, entry: Partial<RaceEntry>) {
  const db = getDatabase();
  // まず既存エントリを確認
  const existing = db.prepare(
    'SELECT id FROM race_entries WHERE race_id = ? AND horse_number = ?'
  ).get(raceId, entry.horseNumber);

  if (existing) {
    db.prepare(`
      UPDATE race_entries SET
        post_position = ?, horse_id = ?, horse_name = ?, age = ?, sex = ?,
        weight = ?, jockey_id = ?, jockey_name = ?, trainer_name = ?,
        handicap_weight = ?, result_position = ?, result_time = ?,
        result_margin = ?, result_last_three_furlongs = ?,
        result_corner_positions = ?, result_weight = ?, result_weight_change = ?
      WHERE race_id = ? AND horse_number = ?
    `).run(
      entry.postPosition, entry.horseId, entry.horseName, entry.age, entry.sex,
      entry.weight, entry.jockeyId, entry.jockeyName, entry.trainerName,
      entry.handicapWeight, entry.result?.position, entry.result?.time,
      entry.result?.margin, entry.result?.lastThreeFurlongs,
      entry.result?.cornerPositions, entry.result?.weight, entry.result?.weightChange,
      raceId, entry.horseNumber,
    );
  } else {
    db.prepare(`
      INSERT INTO race_entries (
        race_id, post_position, horse_number, horse_id, horse_name, age, sex,
        weight, jockey_id, jockey_name, trainer_name, handicap_weight,
        result_position, result_time, result_margin, result_last_three_furlongs,
        result_corner_positions, result_weight, result_weight_change
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      raceId, entry.postPosition, entry.horseNumber, entry.horseId, entry.horseName,
      entry.age, entry.sex, entry.weight, entry.jockeyId, entry.jockeyName,
      entry.trainerName, entry.handicapWeight, entry.result?.position,
      entry.result?.time, entry.result?.margin, entry.result?.lastThreeFurlongs,
      entry.result?.cornerPositions, entry.result?.weight, entry.result?.weightChange,
    );
  }
}

// ==================== 馬 ====================

export function getHorseById(horseId: string) {
  const db = getDatabase();
  const horse = db.prepare('SELECT * FROM horses WHERE id = ?').get(horseId) as Record<string, unknown> | undefined;
  if (!horse) return null;

  const traits = db.prepare('SELECT * FROM horse_traits WHERE horse_id = ?').all(horseId) as { trait_type: string; description: string }[];
  const strengths = traits.filter(t => t.trait_type === 'strength').map(t => t.description);
  const weaknesses = traits.filter(t => t.trait_type === 'weakness').map(t => t.description);

  return { ...horse, strengths, weaknesses };
}

export function searchHorses(query: string, limit: number = 20) {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM horses WHERE name LIKE ? ORDER BY total_earnings DESC LIMIT ?
  `).all(`%${query}%`, limit);
}

export function getAllHorses(limit: number = 100, offset: number = 0) {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM horses ORDER BY total_earnings DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function upsertHorse(horse: Partial<Horse> & { id: string }) {
  const db = getDatabase();
  db.prepare(`
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
  `).run({
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

export function setHorseTraits(horseId: string, strengths: string[], weaknesses: string[]) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM horse_traits WHERE horse_id = ?').run(horseId);
    const stmt = db.prepare('INSERT INTO horse_traits (horse_id, trait_type, description) VALUES (?, ?, ?)');
    for (const s of strengths) stmt.run(horseId, 'strength', s);
    for (const w of weaknesses) stmt.run(horseId, 'weakness', w);
  });
  tx();
}

// ==================== 騎手 ====================

export function getJockeyById(jockeyId: string) {
  const db = getDatabase();
  return db.prepare('SELECT * FROM jockeys WHERE id = ?').get(jockeyId);
}

export function searchJockeys(query: string, limit: number = 20) {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM jockeys WHERE name LIKE ? ORDER BY wins DESC LIMIT ?
  `).all(`%${query}%`, limit);
}

export function getAllJockeys(limit: number = 100, offset: number = 0) {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM jockeys ORDER BY wins DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function upsertJockey(jockey: Partial<Jockey> & { id: string }) {
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO jockeys (
      id, name, name_en, age, region, belongs_to,
      total_races, wins, win_rate, place_rate, show_rate,
      total_earnings, updated_at
    ) VALUES (
      @id, @name, @name_en, @age, @region, @belongs_to,
      @total_races, @wins, @win_rate, @place_rate, @show_rate,
      @total_earnings, datetime('now')
    )
  `).run({
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

export function getHorsePastPerformances(horseId: string, limit: number = 50) {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM past_performances WHERE horse_id = ? ORDER BY date DESC LIMIT ?
  `).all(horseId, limit);
  return rows.map(mapPastPerformance);
}

export function insertPastPerformance(horseId: string, perf: Partial<PastPerformance>) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO past_performances (
      horse_id, race_id, date, race_name, racecourse_name, track_type,
      distance, track_condition, weather, entries, post_position,
      horse_number, position, jockey_name, handicap_weight,
      weight, weight_change, time, margin, last_three_furlongs,
      corner_positions, odds, popularity, prize
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    horseId, perf.raceId, perf.date, perf.raceName, perf.racecourseName,
    perf.trackType, perf.distance, perf.trackCondition, perf.weather,
    perf.entries, perf.postPosition, perf.horseNumber, perf.position,
    perf.jockeyName, perf.handicapWeight, perf.weight, perf.weightChange,
    perf.time, perf.margin, perf.lastThreeFurlongs, perf.cornerPositions,
    perf.odds, perf.popularity, perf.prize,
  );
}

// ==================== オッズ ====================

export function getOddsByRaceId(raceId: string) {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM odds WHERE race_id = ? ORDER BY bet_type, odds
  `).all(raceId);
}

export function upsertOdds(raceId: string, betType: string, horses: number[], oddsValue: number, minOdds?: number, maxOdds?: number) {
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO odds (race_id, bet_type, horse_number1, horse_number2, horse_number3, odds, min_odds, max_odds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(raceId, betType, horses[0] || null, horses[1] || null, horses[2] || null, oddsValue, minOdds || null, maxOdds || null);
}

// ==================== AI予想 ====================

export function getPredictionByRaceId(raceId: string) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT * FROM predictions WHERE race_id = ? ORDER BY generated_at DESC LIMIT 1
  `).get(raceId) as Record<string, unknown> | undefined;

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

export function savePrediction(prediction: Prediction) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO predictions (race_id, generated_at, confidence, summary, analysis_json, picks_json, bets_json)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
  `).run(
    prediction.raceId,
    prediction.confidence,
    prediction.summary,
    JSON.stringify(prediction.analysis),
    JSON.stringify(prediction.topPicks),
    JSON.stringify(prediction.recommendedBets),
  );
}

// ==================== 統計 ====================

export function getDashboardStats() {
  const db = getDatabase();
  const totalHorses = (db.prepare('SELECT COUNT(*) as count FROM horses').get() as { count: number }).count;
  const totalJockeys = (db.prepare('SELECT COUNT(*) as count FROM jockeys').get() as { count: number }).count;
  const totalRaces = (db.prepare('SELECT COUNT(*) as count FROM races').get() as { count: number }).count;
  const upcomingRaces = (db.prepare("SELECT COUNT(*) as count FROM races WHERE date >= date('now') AND status IN ('予定', '出走確定')").get() as { count: number }).count;
  const totalPredictions = (db.prepare('SELECT COUNT(*) as count FROM predictions').get() as { count: number }).count;

  return { totalHorses, totalJockeys, totalRaces, upcomingRaces, totalPredictions };
}

// ==================== 騎手成績（レース別） ====================

export function getJockeyRecentResults(jockeyId: string, limit: number = 20) {
  const db = getDatabase();
  return db.prepare(`
    SELECT e.*, r.name as race_name, r.date, r.racecourse_name, r.track_type, r.distance
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id = ? AND r.status = '結果確定'
    ORDER BY r.date DESC
    LIMIT ?
  `).all(jockeyId, limit);
}

// ==================== 大規模データ向け統計クエリ ====================

/** 種牡馬別統計: コース×馬場×距離レンジ別の成績 */
export function getSireStats(fatherName: string) {
  const db = getDatabase();
  return db.prepare(`
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
  `).all(fatherName);
}

/** 種牡馬の全体勝率サマリ */
export function getSireSummary(fatherName: string) {
  const db = getDatabase();
  return db.prepare(`
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
  `).get(fatherName);
}

/** コース別統計: 競馬場×芝ダート×距離の全馬成績分布 */
export function getCourseStats(racecourseName: string, trackType: string) {
  const db = getDatabase();
  return db.prepare(`
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
  `).all(racecourseName, trackType);
}

/** DB全体のデータ量サマリ（バルクインポートの確認用） */
export function getDataVolumeSummary() {
  const db = getDatabase();
  const horses = (db.prepare('SELECT COUNT(*) as c FROM horses').get() as { c: number }).c;
  const races = (db.prepare('SELECT COUNT(*) as c FROM races').get() as { c: number }).c;
  const pastPerfs = (db.prepare('SELECT COUNT(*) as c FROM past_performances').get() as { c: number }).c;
  const entries = (db.prepare('SELECT COUNT(*) as c FROM race_entries').get() as { c: number }).c;
  const odds = (db.prepare('SELECT COUNT(*) as c FROM odds').get() as { c: number }).c;
  const predictions = (db.prepare('SELECT COUNT(*) as c FROM predictions').get() as { c: number }).c;
  const avgPPperHorse = horses > 0
    ? (db.prepare('SELECT ROUND(AVG(cnt), 1) as avg FROM (SELECT COUNT(*) as cnt FROM past_performances GROUP BY horse_id)').get() as { avg: number })?.avg || 0
    : 0;
  const uniqueSires = (db.prepare("SELECT COUNT(DISTINCT father_name) as c FROM horses WHERE father_name IS NOT NULL AND father_name != ''").get() as { c: number }).c;
  const uniqueCourses = (db.prepare('SELECT COUNT(DISTINCT racecourse_name) as c FROM past_performances').get() as { c: number }).c;

  return {
    horses, races, pastPerfs, entries, odds, predictions,
    avgPPperHorse, uniqueSires, uniqueCourses,
  };
}
