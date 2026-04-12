import { dbAll, dbGet, dbRun, dbRunNamed, dbBatch } from './database';
import type {
  Horse, Jockey, Race, RaceEntry, PastPerformance,
  Prediction, PredictionPick, RaceAnalysis, RecommendedBet,
  RACECOURSES
} from '@/types';

// SQLite datetime('now') は UTC だが 'Z' サフィックスなし → JS で local 扱いされるのを防ぐ
function ensureUtcSuffix(dt: string): string {
  if (!dt) return dt;
  if (dt.endsWith('Z') || dt.includes('+') || dt.includes('T')) return dt;
  return dt.replace(' ', 'T') + 'Z';
}

// ==================== 競馬場 ====================

export async function getAllRacecourses() {
  return dbAll('SELECT * FROM racecourses ORDER BY region, name');
}

export async function seedRacecourses(racecourses: typeof RACECOURSES) {
  const statements = racecourses.map(rc => ({
    sql: 'INSERT INTO racecourses (id, name, region, prefecture) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, region = excluded.region, prefecture = excluded.prefecture',
    args: [rc.id, rc.name, rc.region, rc.prefecture],
  }));
  await dbBatch(statements);
}

// ==================== レース ====================

export async function getRacesByDate(date: string) {
  const rows = await dbAll<Record<string, unknown>>(`
    SELECT r.*, COUNT(e.id) as entry_count, p.confidence as prediction_confidence,
      (SELECT MIN(re2.odds) FROM race_entries re2 WHERE re2.race_id = r.id AND re2.odds > 0) as top_odds
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    LEFT JOIN predictions p ON r.id = p.race_id
    WHERE r.date = ?
    GROUP BY r.id
    ORDER BY r.racecourse_name, r.race_number
  `, [date]);
  return rows.map(r => ({
    ...mapRace(r),
    entryCount: (r.entry_count ?? 0) as number,
    confidence: r.prediction_confidence != null ? Number(r.prediction_confidence) : null,
    topOdds: r.top_odds != null ? Number(r.top_odds) : null,
  }));
}

export async function getRacesByDateRange(startDate: string, endDate: string) {
  const rows = await dbAll<Record<string, unknown>>(`
    SELECT r.*, COUNT(e.id) as entry_count, p.confidence as prediction_confidence,
      (SELECT MIN(re2.odds) FROM race_entries re2 WHERE re2.race_id = r.id AND re2.odds > 0) as top_odds
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    LEFT JOIN predictions p ON r.id = p.race_id
    WHERE r.date BETWEEN ? AND ?
    GROUP BY r.id
    ORDER BY r.date, r.racecourse_name, r.race_number
  `, [startDate, endDate]);
  return rows.map(r => ({
    ...mapRace(r),
    entryCount: (r.entry_count ?? 0) as number,
    confidence: r.prediction_confidence != null ? Number(r.prediction_confidence) : null,
    topOdds: r.top_odds != null ? Number(r.top_odds) : null,
  }));
}

export async function getRaceById(raceId: string) {
  const race = await dbGet<Record<string, unknown>>('SELECT * FROM races WHERE id = ?', [raceId]);
  if (!race) return null;

  const rawEntries = await dbAll<Record<string, unknown>>(`
    SELECT * FROM race_entries WHERE race_id = ? ORDER BY horse_number
  `, [raceId]);

  return { ...mapRace(race), entries: rawEntries.map(mapRaceEntry) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRace(row: Record<string, any>): Race {
  return {
    id: row.id ?? '',
    name: row.name ?? '',
    date: row.date ?? '',
    time: row.time ?? undefined,
    racecourseId: row.racecourse_id ?? row.racecourseId ?? '',
    racecourseName: row.racecourse_name ?? row.racecourseName ?? '',
    raceNumber: row.race_number ?? row.raceNumber ?? 0,
    grade: row.grade ?? undefined,
    trackType: row.track_type ?? row.trackType ?? '芝',
    distance: row.distance ?? 0,
    trackCondition: row.track_condition ?? row.trackCondition ?? undefined,
    weather: row.weather ?? undefined,
    entries: [],
    status: row.status ?? '予定',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRaceEntry(row: Record<string, any>): RaceEntry {
  return {
    postPosition: row.post_position ?? row.postPosition ?? 0,
    horseNumber: row.horse_number ?? row.horseNumber ?? 0,
    horseId: row.horse_id ?? row.horseId ?? '',
    horseName: row.horse_name ?? row.horseName ?? '',
    age: row.age ?? 0,
    sex: row.sex ?? '牡',
    weight: row.weight ?? undefined,
    jockeyId: row.jockey_id ?? row.jockeyId ?? '',
    jockeyName: row.jockey_name ?? row.jockeyName ?? '',
    trainerName: row.trainer_name ?? row.trainerName ?? '',
    handicapWeight: row.handicap_weight ?? row.handicapWeight ?? 0,
    odds: row.odds ?? undefined,
    popularity: row.popularity ?? undefined,
    result: row.result_position != null ? {
      position: row.result_position,
      time: row.result_time ?? undefined,
      margin: row.result_margin ?? undefined,
      lastThreeFurlongs: row.result_last_three_furlongs ?? undefined,
      cornerPositions: row.result_corner_positions ?? undefined,
      weight: row.result_weight ?? undefined,
      weightChange: row.result_weight_change ?? undefined,
    } : undefined,
  };
}

export async function getUpcomingRaces(limit: number = 50) {
  // JST日付を計算（UTC+9）- SQLite の date('now') は UTC のため
  const now = new Date();
  const jstOffset = 9 * 60 * 60_000;
  const jstToday = new Date(now.getTime() + jstOffset).toISOString().split('T')[0];

  const rows = await dbAll<Record<string, unknown>>(`
    SELECT r.*, COUNT(e.id) as entry_count, p.confidence as prediction_confidence,
      p.generated_at as prediction_generated_at,
      (SELECT MIN(re2.odds) FROM race_entries re2 WHERE re2.race_id = r.id AND re2.odds > 0) as top_odds,
      json_extract(p.analysis_json, '$.aiRankingBets.pattern') as ai_pattern,
      json_array_length(json_extract(p.analysis_json, '$.shosanPrediction.candidates')) as shosan_count
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    LEFT JOIN predictions p ON r.id = p.race_id
    WHERE r.date >= ?
    AND r.status IN ('予定', '出走確定')
    GROUP BY r.id
    ORDER BY r.date, r.racecourse_name, r.race_number
    LIMIT ?
  `, [jstToday, limit]);
  return rows.map(r => ({
    ...mapRace(r),
    entryCount: (r.entry_count ?? 0) as number,
    confidence: r.prediction_confidence != null ? Number(r.prediction_confidence) : null,
    predictionGeneratedAt: r.prediction_generated_at ? ensureUtcSuffix(r.prediction_generated_at as string) : null,
    topOdds: r.top_odds != null ? Number(r.top_odds) : null,
    aiPattern: (r.ai_pattern as string) || null,
    shosanCount: r.shosan_count != null ? Number(r.shosan_count) : 0,
  }));
}

export async function getRecentResults(limit: number = 50) {
  const rows = await dbAll<Record<string, unknown>>(`
    SELECT r.*, COUNT(e.id) as entry_count, p.confidence as prediction_confidence,
      (SELECT MIN(re2.odds) FROM race_entries re2 WHERE re2.race_id = r.id AND re2.odds > 0) as top_odds
    FROM races r
    LEFT JOIN race_entries e ON r.id = e.race_id
    LEFT JOIN predictions p ON r.id = p.race_id
    WHERE r.status = '結果確定'
    GROUP BY r.id
    ORDER BY r.date DESC, r.racecourse_name DESC, r.race_number DESC
    LIMIT ?
  `, [limit]);
  return rows.map(r => ({
    ...mapRace(r),
    entryCount: (r.entry_count ?? 0) as number,
    confidence: r.prediction_confidence != null ? Number(r.prediction_confidence) : null,
    topOdds: r.top_odds != null ? Number(r.top_odds) : null,
  }));
}

export async function upsertRace(race: Partial<Race> & { id: string }) {
  // racecourseId が未指定の場合、raceIdから推定する（FK制約対策）
  const racecourseId = race.racecourseId || inferRacecourseIdFromRaceId(race.id);

  await dbRunNamed(`
    INSERT INTO races (id, name, date, time, racecourse_id, racecourse_name, race_number, grade, track_type, distance, track_condition, weather, status)
    VALUES (@id, @name, @date, @time, @racecourse_id, @racecourse_name, @race_number, @grade, COALESCE(NULLIF(@track_type, ''), 'ダート'), @distance, @track_condition, @weather, @status)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(NULLIF(@name, ''), races.name),
      date = COALESCE(NULLIF(@date, ''), races.date),
      time = COALESCE(@time, races.time),
      racecourse_id = COALESCE(NULLIF(@racecourse_id, ''), races.racecourse_id),
      racecourse_name = COALESCE(NULLIF(@racecourse_name, ''), races.racecourse_name),
      race_number = CASE WHEN @race_number > 0 THEN @race_number ELSE races.race_number END,
      grade = COALESCE(@grade, races.grade),
      track_type = COALESCE(NULLIF(@track_type, ''), races.track_type),
      distance = CASE WHEN @distance > 0 THEN @distance ELSE races.distance END,
      track_condition = COALESCE(@track_condition, races.track_condition),
      weather = COALESCE(@weather, races.weather),
      status = CASE WHEN @status IS NOT NULL AND @status != '' THEN @status ELSE races.status END
  `, {
    id: race.id,
    name: race.name || '',
    date: race.date || '',
    time: race.time || null,
    racecourse_id: racecourseId,
    racecourse_name: race.racecourseName || '',
    race_number: race.raceNumber || 0,
    grade: race.grade || null,
    track_type: race.trackType || '',
    distance: race.distance || 0,
    track_condition: race.trackCondition || null,
    weather: race.weather || null,
    status: race.status || '',
  });
}

/** raceId からracecourse_idを推定 (netkeiba IDの5-6桁目が競馬場コード) */
function inferRacecourseIdFromRaceId(raceId: string): string {
  const codeMap: Record<string, string> = {
    '01': 'sapporo', '02': 'hakodate', '03': 'fukushima', '04': 'niigata',
    '05': 'tokyo', '06': 'nakayama', '07': 'chukyo', '08': 'kyoto',
    '09': 'hanshin', '10': 'kokura',
    '30': 'monbetsu', '35': 'morioka', '36': 'mizusawa',
    '42': 'urawa', '43': 'funabashi', '44': 'ooi', '45': 'kawasaki',
    '46': 'kanazawa', '48': 'kasamatsu', '50': 'nagoya',
    '51': 'sonoda', '54': 'kochi', '55': 'saga',
  };
  const code = raceId.substring(4, 6);
  return codeMap[code] || 'unknown';
}

// ==================== 出走馬 ====================

export async function upsertRaceEntry(raceId: string, entry: Partial<RaceEntry>) {
  // undefined → null 変換（Turso/libsql は undefined を受け付けない）
  // NOT NULL 制約のあるカラムはフォールバック値を設定（結果取得時にINSERTになるケース対策）
  const postPosition = entry.postPosition ?? 0;
  const horseId = entry.horseId ?? `unknown_${raceId}_${entry.horseNumber}`;

  // FK制約対策: horse_id が horses テーブルに存在しない場合、プレースホルダーを挿入
  await dbRun(
    "INSERT OR IGNORE INTO horses (id, name, age, sex) VALUES (?, ?, ?, ?)",
    [horseId, entry.horseName || `${entry.horseNumber}番`, entry.age || 0, entry.sex || '牡']
  );
  const horseName = entry.horseName ?? `${entry.horseNumber}番`;
  const age = entry.age ?? null;
  const sex = entry.sex ?? null;
  const weight = entry.weight ?? null;
  const jockeyId = entry.jockeyId ?? null;
  const jockeyName = entry.jockeyName || '不明';
  const trainerName = entry.trainerName ?? null;
  const handicapWeight = entry.handicapWeight ?? 0;
  const resultPosition = entry.result?.position ?? null;
  const resultTime = entry.result?.time ?? null;
  const resultMargin = entry.result?.margin ?? null;
  const resultLastThreeFurlongs = entry.result?.lastThreeFurlongs ?? null;
  const resultCornerPositions = entry.result?.cornerPositions ?? null;
  const resultWeight = entry.result?.weight ?? null;
  const resultWeightChange = entry.result?.weightChange ?? null;

  // INSERT...ON CONFLICT DO UPDATE（SELECT不要）
  await dbRun(`
    INSERT INTO race_entries (
      race_id, post_position, horse_number, horse_id, horse_name, age, sex,
      weight, jockey_id, jockey_name, trainer_name, handicap_weight,
      result_position, result_time, result_margin, result_last_three_furlongs,
      result_corner_positions, result_weight, result_weight_change
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(race_id, horse_number) DO UPDATE SET
      post_position = CASE WHEN excluded.post_position > 0 THEN excluded.post_position ELSE race_entries.post_position END,
      horse_id = COALESCE(NULLIF(excluded.horse_id, ''), race_entries.horse_id),
      horse_name = COALESCE(NULLIF(excluded.horse_name, ''), race_entries.horse_name),
      age = COALESCE(excluded.age, race_entries.age),
      sex = COALESCE(excluded.sex, race_entries.sex),
      weight = COALESCE(excluded.weight, race_entries.weight),
      jockey_id = COALESCE(NULLIF(excluded.jockey_id, ''), race_entries.jockey_id),
      jockey_name = CASE WHEN excluded.jockey_name NOT IN ('不明', '') THEN excluded.jockey_name ELSE race_entries.jockey_name END,
      trainer_name = COALESCE(NULLIF(excluded.trainer_name, ''), race_entries.trainer_name),
      handicap_weight = CASE WHEN excluded.handicap_weight > 0 THEN excluded.handicap_weight ELSE race_entries.handicap_weight END,
      result_position = COALESCE(excluded.result_position, race_entries.result_position),
      result_time = COALESCE(excluded.result_time, race_entries.result_time),
      result_margin = COALESCE(excluded.result_margin, race_entries.result_margin),
      result_last_three_furlongs = COALESCE(excluded.result_last_three_furlongs, race_entries.result_last_three_furlongs),
      result_corner_positions = COALESCE(excluded.result_corner_positions, race_entries.result_corner_positions),
      result_weight = COALESCE(excluded.result_weight, race_entries.result_weight),
      result_weight_change = COALESCE(excluded.result_weight_change, race_entries.result_weight_change)
  `, [
    raceId, postPosition, entry.horseNumber, horseId, horseName,
    age, sex, weight, jockeyId, jockeyName,
    trainerName, handicapWeight, resultPosition,
    resultTime, resultMargin, resultLastThreeFurlongs,
    resultCornerPositions, resultWeight, resultWeightChange,
  ]);
}

// ==================== 馬 ====================

export async function getHorseById(horseId: string) {
  const horse = await dbGet<Record<string, unknown> & { id: string; name: string; age: number }>('SELECT * FROM horses WHERE id = ?', [horseId]);
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
    INSERT INTO horses (
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
    ON CONFLICT(id) DO UPDATE SET
      name = @name, name_en = @name_en, age = @age, sex = @sex,
      color = @color, birth_date = @birth_date,
      father_id = @father_id, father_name = @father_name,
      mother_id = @mother_id, mother_name = @mother_name,
      trainer_name = @trainer_name, owner_name = @owner_name,
      total_races = @total_races, wins = @wins, seconds = @seconds, thirds = @thirds,
      total_earnings = @total_earnings, condition_overall = @condition_overall,
      condition_weight = @condition_weight, condition_weight_change = @condition_weight_change,
      training_comment = @training_comment, updated_at = datetime('now')
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
    INSERT INTO jockeys (
      id, name, name_en, age, region, belongs_to,
      total_races, wins, win_rate, place_rate, show_rate,
      total_earnings, updated_at
    ) VALUES (
      @id, @name, @name_en, @age, @region, @belongs_to,
      @total_races, @wins, @win_rate, @place_rate, @show_rate,
      @total_earnings, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      name = @name, name_en = @name_en, age = @age, region = @region,
      belongs_to = @belongs_to, total_races = @total_races, wins = @wins,
      win_rate = @win_rate, place_rate = @place_rate, show_rate = @show_rate,
      total_earnings = @total_earnings, updated_at = datetime('now')
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
    timeIndex: row.time_index ?? row.timeIndex ?? null,
    trackIndex: row.track_index ?? row.trackIndex ?? null,
    // v9.0: JOINで取得したレースグレード（存在する場合のみ）
    grade: row.race_grade ?? undefined,
  };
}

export async function getHorsePastPerformances(horseId: string, beforeDate?: string, limit: number = 100) {
  if (beforeDate) {
    const rows = await dbAll(`
      SELECT * FROM past_performances WHERE horse_id = ? AND date < ? ORDER BY date DESC LIMIT ?
    `, [horseId, beforeDate, limit]);
    return rows.map(mapPastPerformance);
  }
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
      corner_positions, odds, popularity, prize, time_index, track_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    horseId, perf.raceId ?? null, perf.date ?? null, perf.raceName ?? null, perf.racecourseName ?? null,
    perf.trackType ?? null, perf.distance ?? 0, perf.trackCondition ?? null, perf.weather ?? null,
    perf.entries ?? 0, perf.postPosition ?? 0, perf.horseNumber ?? 0, perf.position ?? 0,
    perf.jockeyName ?? null, perf.handicapWeight ?? 0, perf.weight ?? 0, perf.weightChange ?? 0,
    perf.time ?? null, perf.margin ?? null, perf.lastThreeFurlongs ?? null, perf.cornerPositions ?? null,
    perf.odds ?? 0, perf.popularity ?? 0, perf.prize ?? 0,
    perf.timeIndex ?? null, perf.trackIndex ?? null,
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

export async function upsertRaceEntryOdds(raceId: string, horseNumber: number, odds: number, popularity: number) {
  await dbRun(`
    UPDATE race_entries SET odds = ?, popularity = ? WHERE race_id = ? AND horse_number = ?
  `, [odds, popularity, raceId, horseNumber]);
}

/**
 * 1レース分のオッズデータを一括バッチ保存（単勝・複勝・race_entries・スナップショット）
 */
export async function batchUpsertOddsForRace(
  raceId: string,
  winOdds: { horseNumber: number; odds: number }[],
  placeOdds: { horseNumber: number; minOdds: number; maxOdds: number }[],
  snapshotTime: string,
): Promise<void> {
  const statements: { sql: string; args: unknown[] }[] = [];

  for (const w of winOdds) {
    // upsertOdds: 単勝
    statements.push({
      sql: `INSERT OR REPLACE INTO odds (race_id, bet_type, horse_number1, horse_number2, horse_number3, odds, min_odds, max_odds, updated_at)
            VALUES (?, '単勝', ?, NULL, NULL, ?, NULL, NULL, datetime('now'))`,
      args: [raceId, w.horseNumber, w.odds],
    });
    // upsertRaceEntryOdds
    statements.push({
      sql: `UPDATE race_entries SET odds = ?, popularity = 0 WHERE race_id = ? AND horse_number = ?`,
      args: [w.odds, raceId, w.horseNumber],
    });
    // insertOddsSnapshot
    statements.push({
      sql: `INSERT INTO odds_snapshots (race_id, horse_number, odds, snapshot_time) VALUES (?, ?, ?, ?)`,
      args: [raceId, w.horseNumber, w.odds, snapshotTime],
    });
  }

  for (const p of placeOdds) {
    // upsertOdds: 複勝
    statements.push({
      sql: `INSERT OR REPLACE INTO odds (race_id, bet_type, horse_number1, horse_number2, horse_number3, odds, min_odds, max_odds, updated_at)
            VALUES (?, '複勝', ?, NULL, NULL, ?, ?, ?, datetime('now'))`,
      args: [raceId, p.horseNumber, p.minOdds, p.minOdds, p.maxOdds],
    });
  }

  if (statements.length > 0) {
    await dbBatch(statements);
  }
}

// ==================== オッズ時系列 ====================

export async function insertOddsSnapshot(raceId: string, horseNumber: number, odds: number, snapshotTime: string) {
  await dbRun(`
    INSERT INTO odds_snapshots (race_id, horse_number, odds, snapshot_time)
    VALUES (?, ?, ?, ?)
  `, [raceId, horseNumber, odds, snapshotTime]);
}

export async function getOddsSnapshots(raceId: string): Promise<{ horse_number: number; odds: number; snapshot_time: string }[]> {
  return dbAll(`
    SELECT horse_number, odds, snapshot_time
    FROM odds_snapshots
    WHERE race_id = ?
    ORDER BY horse_number, snapshot_time
  `, [raceId]) as Promise<{ horse_number: number; odds: number; snapshot_time: string }[]>;
}

export interface OddsMovement {
  horseNumber: number;
  firstOdds: number;
  lastOdds: number;
  oddsChange: number;
  oddsChangeRate: number;
  snapshotCount: number;
  volatility: number;
}

export async function getOddsMovement(raceId: string): Promise<OddsMovement[]> {
  const snapshots = await getOddsSnapshots(raceId);
  if (snapshots.length === 0) return [];

  const byHorse = new Map<number, { odds: number; time: string }[]>();
  for (const s of snapshots) {
    const arr = byHorse.get(s.horse_number) || [];
    arr.push({ odds: s.odds, time: s.snapshot_time });
    byHorse.set(s.horse_number, arr);
  }

  const result: OddsMovement[] = [];
  for (const [horseNumber, entries] of byHorse) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.time.localeCompare(b.time));

    const firstOdds = entries[0].odds;
    const lastOdds = entries[entries.length - 1].odds;
    const oddsValues = entries.map(e => e.odds);
    const mean = oddsValues.reduce((s, v) => s + v, 0) / oddsValues.length;
    const variance = oddsValues.reduce((s, v) => s + (v - mean) ** 2, 0) / oddsValues.length;

    result.push({
      horseNumber,
      firstOdds,
      lastOdds,
      oddsChange: lastOdds - firstOdds,
      oddsChangeRate: firstOdds > 0 ? (lastOdds - firstOdds) / firstOdds : 0,
      snapshotCount: entries.length,
      volatility: Math.sqrt(variance),
    });
  }

  return result;
}

// ==================== ラップタイム ====================

export async function upsertRaceLapTimes(raceId: string, lapTimes: number[], paceType: string) {
  await dbRun(`
    UPDATE races SET lap_times_json = ?, pace_type = ? WHERE id = ?
  `, [JSON.stringify(lapTimes), paceType, raceId]);
}

export async function getRaceLapTimes(raceId: string): Promise<{ lapTimes: number[]; paceType: string } | null> {
  const row = await dbGet<{ lap_times_json: string | null; pace_type: string | null }>(
    `SELECT lap_times_json, pace_type FROM races WHERE id = ?`,
    [raceId]
  );
  if (!row?.lap_times_json) return null;
  try {
    return {
      lapTimes: JSON.parse(row.lap_times_json),
      paceType: row.pace_type || 'ミドル',
    };
  } catch {
    return null;
  }
}

/**
 * ラップタイムからペースタイプを判定
 * 前半と後半のラップ合計を比較
 */
export function classifyPaceType(lapTimes: number[]): string {
  // 最初の1ラップはスタート加速区間のため除外（常に遅い → 前半が遅く見えるバイアスを排除）
  const laps = lapTimes.length > 4 ? lapTimes.slice(1) : lapTimes;
  if (laps.length < 4) return 'ミドル';

  const halfIdx = Math.floor(laps.length / 2);
  const firstHalf = laps.slice(0, halfIdx);
  const secondHalf = laps.slice(halfIdx);

  const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

  const diff = secondAvg - firstAvg;
  // 前半が速い (後半遅い) = ハイペース
  // 後半が速い (前半遅い) = スローペース
  if (diff > 0.3) return 'ハイ';
  if (diff < -0.3) return 'スロー';
  return 'ミドル';
}

// ==================== AI予想 ====================

export async function getPredictionByRaceId(raceId: string) {
  const row = await dbGet<Record<string, unknown>>(`
    SELECT * FROM predictions WHERE race_id = ? ORDER BY generated_at DESC LIMIT 1
  `, [raceId]);

  if (!row) return null;

  return {
    raceId: row.race_id as string,
    generatedAt: ensureUtcSuffix(row.generated_at as string),
    confidence: row.confidence as number,
    summary: row.summary as string,
    analysis: JSON.parse(row.analysis_json as string || '{}') as RaceAnalysis,
    topPicks: JSON.parse(row.picks_json as string || '[]') as PredictionPick[],
    recommendedBets: JSON.parse(row.bets_json as string || '[]') as RecommendedBet[],
  };
}

export async function savePrediction(prediction: Prediction) {
  // 同一race_idの古い予測を削除してから新規挿入
  // prediction_resultsがFK参照しているため先に削除（結果確定済みレースの再生成時）
  await dbRun(`DELETE FROM prediction_results WHERE race_id = ?`, [prediction.raceId]);
  await dbRun(`DELETE FROM predictions WHERE race_id = ?`, [prediction.raceId]);
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

// ダッシュボード統計のインメモリキャッシュ（COUNT系クエリを毎回叩かない）
interface DashboardStats {
  totalHorses: number;
  totalJockeys: number;
  totalRaces: number;
  upcomingRaces: number;
  totalPredictions: number;
  accuracy: {
    totalEvaluated: number;
    winHitRate: number;
    placeHitRate: number;
    top3Coverage: number;
  } | null;
}
let dashboardCache: { data: DashboardStats; expires: number } | null = null;
const DASHBOARD_CACHE_TTL = 5 * 60 * 1000; // 5分

export async function getDashboardStats(): Promise<DashboardStats> {
  if (dashboardCache && Date.now() < dashboardCache.expires) {
    return dashboardCache.data;
  }

  // 6個のCOUNTクエリを2個のクエリに統合
  const raceCounts = await dbGet<{
    total_races: number;
    upcoming_races: number;
  }>(`SELECT
    COUNT(*) as total_races,
    SUM(CASE WHEN date >= date('now') AND status IN ('予定', '出走確定') THEN 1 ELSE 0 END) as upcoming_races
    FROM races`);

  const [totalHorses, totalJockeys, totalPredictions] = await Promise.all([
    dbGet<{ count: number }>('SELECT COUNT(*) as count FROM horses'),
    dbGet<{ count: number }>('SELECT COUNT(*) as count FROM jockeys'),
    dbGet<{ count: number }>('SELECT COUNT(*) as count FROM predictions'),
  ]);

  // 的中率統計（1クエリでCOUNT+集計）
  const accuracyData = await dbGet<{ total_evaluated: number; win_hit_rate: number; place_hit_rate: number; top3_coverage: number }>(`
    SELECT
      COUNT(*) as total_evaluated,
      ROUND(AVG(win_hit) * 100, 1) as win_hit_rate,
      ROUND(AVG(place_hit) * 100, 1) as place_hit_rate,
      ROUND(AVG(CAST(top3_picks_hit as REAL) / 3.0) * 100, 1) as top3_coverage
    FROM prediction_results
  `);

  const result = {
    totalHorses: totalHorses!.count,
    totalJockeys: totalJockeys!.count,
    totalRaces: raceCounts!.total_races,
    upcomingRaces: raceCounts!.upcoming_races,
    totalPredictions: totalPredictions!.count,
    accuracy: accuracyData && accuracyData.total_evaluated > 0 ? {
      totalEvaluated: accuracyData.total_evaluated,
      winHitRate: accuracyData.win_hit_rate,
      placeHitRate: accuracyData.place_hit_rate,
      top3Coverage: accuracyData.top3_coverage,
    } : null,
  };

  dashboardCache = { data: result, expires: Date.now() + DASHBOARD_CACHE_TTL };
  return result;
}

// ==================== 騎手勝率取得（予想エンジン用） ====================

/**
 * 騎手IDからDB上の勝率・複勝率を取得する。
 * jockeysテーブルに登録がない場合は race_entries から計算する。
 * どちらもなければデフォルト値を返す。
 */
export async function getJockeyStats(jockeyId: string, beforeDate?: string): Promise<{ winRate: number; placeRate: number }> {
  const DEFAULT_WIN_RATE = 0.08;
  const DEFAULT_PLACE_RATE = 0.20;

  if (!jockeyId) return { winRate: DEFAULT_WIN_RATE, placeRate: DEFAULT_PLACE_RATE };

  // beforeDate 未指定時は jockeys テーブルの集計済み値を使用
  if (!beforeDate) {
    const jockey = await dbGet<{ win_rate: number; place_rate: number; total_races: number }>(
      'SELECT win_rate, place_rate, total_races FROM jockeys WHERE id = ?',
      [jockeyId]
    );

    if (jockey && jockey.total_races > 0 && jockey.win_rate > 0) {
      return { winRate: jockey.win_rate, placeRate: jockey.place_rate };
    }
  }

  // race_entries + races から計算（beforeDate指定時は日付フィルタ付き）
  const dateFilter = beforeDate ? ' AND r.date < ?' : '';
  const args = beforeDate ? [jockeyId, beforeDate] : [jockeyId];

  const stats = await dbGet<{ total: number; wins: number; places: number }>(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN e.result_position <= 3 THEN 1 ELSE 0 END) as places
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id = ? AND r.status = '結果確定' AND e.result_position IS NOT NULL${dateFilter}
  `, args);

  if (stats && stats.total >= 5) {
    return {
      winRate: stats.wins / stats.total,
      placeRate: stats.places / stats.total,
    };
  }

  return { winRate: DEFAULT_WIN_RATE, placeRate: DEFAULT_PLACE_RATE };
}

// ==================== 調教師統計（予想エンジン用） ====================

/**
 * 調教師名からDB上の勝率・複勝率を race_entries から計算する。
 */
export interface TrainerStatsResult {
  winRate: number;
  placeRate: number;
  sprintWinRate: number;
  mileWinRate: number;
  longWinRate: number;
  heavyWinRate: number;
  gradeWinRate: number;
}

export async function getTrainerStats(trainerName: string, beforeDate?: string): Promise<TrainerStatsResult> {
  const DEF_W = 0.08;
  const DEF_P = 0.20;
  const defaults: TrainerStatsResult = {
    winRate: DEF_W, placeRate: DEF_P,
    sprintWinRate: DEF_W, mileWinRate: DEF_W, longWinRate: DEF_W,
    heavyWinRate: DEF_W, gradeWinRate: DEF_W,
  };

  if (!trainerName) return defaults;

  const dateFilter = beforeDate ? ' AND r.date < ?' : '';
  const args: (string | number)[] = [trainerName];
  if (beforeDate) args.push(beforeDate);

  const stats = await dbGet<{
    total: number; wins: number; places: number;
    sprint_total: number; sprint_wins: number;
    mile_total: number; mile_wins: number;
    long_total: number; long_wins: number;
    heavy_total: number; heavy_wins: number;
    grade_total: number; grade_wins: number;
  }>(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN e.result_position <= 3 THEN 1 ELSE 0 END) as places,
      SUM(CASE WHEN r.distance <= 1400 THEN 1 ELSE 0 END) as sprint_total,
      SUM(CASE WHEN r.distance <= 1400 AND e.result_position = 1 THEN 1 ELSE 0 END) as sprint_wins,
      SUM(CASE WHEN r.distance BETWEEN 1401 AND 1800 THEN 1 ELSE 0 END) as mile_total,
      SUM(CASE WHEN r.distance BETWEEN 1401 AND 1800 AND e.result_position = 1 THEN 1 ELSE 0 END) as mile_wins,
      SUM(CASE WHEN r.distance >= 1801 THEN 1 ELSE 0 END) as long_total,
      SUM(CASE WHEN r.distance >= 1801 AND e.result_position = 1 THEN 1 ELSE 0 END) as long_wins,
      SUM(CASE WHEN r.track_condition IN ('重', '不良') THEN 1 ELSE 0 END) as heavy_total,
      SUM(CASE WHEN r.track_condition IN ('重', '不良') AND e.result_position = 1 THEN 1 ELSE 0 END) as heavy_wins,
      SUM(CASE WHEN r.grade IN ('G3', 'G2', 'G1') THEN 1 ELSE 0 END) as grade_total,
      SUM(CASE WHEN r.grade IN ('G3', 'G2', 'G1') AND e.result_position = 1 THEN 1 ELSE 0 END) as grade_wins
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.trainer_name = ? AND r.status = '結果確定' AND e.result_position IS NOT NULL${dateFilter}
  `, args);

  if (!stats || stats.total < 10) return defaults;

  const safeRate = (wins: number, total: number) => total >= 5 ? wins / total : DEF_W;

  return {
    winRate: stats.wins / stats.total,
    placeRate: stats.places / stats.total,
    sprintWinRate: safeRate(stats.sprint_wins, stats.sprint_total),
    mileWinRate: safeRate(stats.mile_wins, stats.mile_total),
    longWinRate: safeRate(stats.long_wins, stats.long_total),
    heavyWinRate: safeRate(stats.heavy_wins, stats.heavy_total),
    gradeWinRate: safeRate(stats.grade_wins, stats.grade_total),
  };
}

// ==================== 交互作用統計（予想エンジン用） ====================

/**
 * 種牡馬×馬場タイプの勝率を取得
 */
export async function getSireTrackWinRate(fatherName: string, trackType: string, beforeDate?: string): Promise<number> {
  if (!fatherName) return 0.07;

  const dateFilter = beforeDate ? ' AND pp.date < ?' : '';
  const args: (string | number)[] = [fatherName, trackType];
  if (beforeDate) args.push(beforeDate);

  const stats = await dbGet<{ total: number; wins: number }>(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN pp.position = 1 THEN 1 ELSE 0 END) as wins
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE h.father_name = ? AND pp.track_type = ? AND pp.position IS NOT NULL${dateFilter}
  `, args);

  if (stats && stats.total >= 10) {
    return stats.wins / stats.total;
  }
  return 0.07;
}

/**
 * 騎手×距離帯の勝率を取得
 */
export async function getJockeyDistanceWinRate(jockeyId: string, distance: number, beforeDate?: string): Promise<number> {
  if (!jockeyId) return 0.08;

  const dateFilter = beforeDate ? ' AND r.date < ?' : '';
  const args: (string | number)[] = [jockeyId, distance];
  if (beforeDate) args.push(beforeDate);

  // 距離帯: ±200m
  const stats = await dbGet<{ total: number; wins: number }>(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id = ? AND r.status = '結果確定' AND e.result_position IS NOT NULL
      AND ABS(r.distance - ?) <= 200${dateFilter}
  `, args);

  if (stats && stats.total >= 10) {
    return stats.wins / stats.total;
  }
  return 0.08;
}

/**
 * 騎手×コースの勝率を取得
 */
export async function getJockeyCourseWinRate(jockeyId: string, racecourseName: string, beforeDate?: string): Promise<number> {
  if (!jockeyId) return 0.08;

  const dateFilter = beforeDate ? ' AND r.date < ?' : '';
  const args: (string | number)[] = [jockeyId, racecourseName];
  if (beforeDate) args.push(beforeDate);

  const stats = await dbGet<{ total: number; wins: number }>(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id = ? AND r.racecourse_name = ? AND r.status = '結果確定' AND e.result_position IS NOT NULL${dateFilter}
  `, args);

  if (stats && stats.total >= 10) {
    return stats.wins / stats.total;
  }
  return 0.08;
}

// ==================== バッチクエリ（prediction-builder 用） ====================

/**
 * 複数馬の過去成績を一括取得する。
 * 各馬ごとに beforeDate 前の最新 limit 件を返す。
 */
export async function getHorsePastPerformancesBatch(
  horseIds: string[],
  beforeDate: string,
  limit: number = 100,
): Promise<Map<string, PastPerformance[]>> {
  const result = new Map<string, PastPerformance[]>();
  if (horseIds.length === 0) return result;

  const uniqueIds = [...new Set(horseIds)];
  const placeholders = uniqueIds.map(() => '?').join(',');

  // ROW_NUMBER で各馬ごとに limit 件に絞る
  // v9.0: LEFT JOIN races で grade を取得（classChange 計算用）
  const rows = await dbAll(`
    SELECT * FROM (
      SELECT pp.*, r.grade AS race_grade,
             ROW_NUMBER() OVER (PARTITION BY pp.horse_id ORDER BY pp.date DESC) as rn
      FROM past_performances pp
      LEFT JOIN races r ON r.id = pp.race_id
      WHERE pp.horse_id IN (${placeholders}) AND pp.date < ?
    ) sub
    WHERE sub.rn <= ?
    ORDER BY sub.horse_id, sub.date DESC
  `, [...uniqueIds, beforeDate, limit]);

  // 初期化
  for (const id of uniqueIds) {
    result.set(id, []);
  }
  for (const row of rows) {
    const horseId = (row as Record<string, unknown>).horse_id as string;
    const perfs = result.get(horseId);
    if (perfs) {
      perfs.push(mapPastPerformance(row));
    }
  }
  return result;
}

/**
 * 複数馬の基本情報を一括取得する。
 */
export async function getHorsesByIds(
  horseIds: string[],
): Promise<Map<string, Record<string, unknown> & { id: string; name: string; strengths: string[]; weaknesses: string[] }>> {
  const result = new Map<string, Record<string, unknown> & { id: string; name: string; strengths: string[]; weaknesses: string[] }>();
  if (horseIds.length === 0) return result;

  const uniqueIds = [...new Set(horseIds)];
  const placeholders = uniqueIds.map(() => '?').join(',');

  const [horses, traits] = await Promise.all([
    dbAll<Record<string, unknown> & { id: string; name: string }>(
      `SELECT * FROM horses WHERE id IN (${placeholders})`,
      uniqueIds,
    ),
    dbAll<{ horse_id: string; trait_type: string; description: string }>(
      `SELECT * FROM horse_traits WHERE horse_id IN (${placeholders})`,
      uniqueIds,
    ),
  ]);

  // traits をまとめる
  const traitsByHorse = new Map<string, { strengths: string[]; weaknesses: string[] }>();
  for (const t of traits) {
    if (!traitsByHorse.has(t.horse_id)) {
      traitsByHorse.set(t.horse_id, { strengths: [], weaknesses: [] });
    }
    const entry = traitsByHorse.get(t.horse_id)!;
    if (t.trait_type === 'strength') entry.strengths.push(t.description);
    else if (t.trait_type === 'weakness') entry.weaknesses.push(t.description);
  }

  for (const h of horses) {
    const t = traitsByHorse.get(h.id) || { strengths: [], weaknesses: [] };
    result.set(h.id, { ...h, strengths: t.strengths, weaknesses: t.weaknesses });
  }
  return result;
}

/**
 * 複数騎手の勝率・複勝率を一括取得する。
 */
export async function getJockeyStatsBatch(
  jockeyIds: string[],
  beforeDate: string,
): Promise<Map<string, { winRate: number; placeRate: number }>> {
  const DEFAULT_WIN_RATE = 0.08;
  const DEFAULT_PLACE_RATE = 0.20;
  const defaults = { winRate: DEFAULT_WIN_RATE, placeRate: DEFAULT_PLACE_RATE };

  const result = new Map<string, { winRate: number; placeRate: number }>();
  if (jockeyIds.length === 0) return result;

  const uniqueIds = [...new Set(jockeyIds.filter(id => !!id))];
  // デフォルト値で初期化（空IDの馬も含めて）
  for (const id of jockeyIds) {
    if (!id) result.set('', { ...defaults });
  }
  if (uniqueIds.length === 0) return result;

  const placeholders = uniqueIds.map(() => '?').join(',');

  const rows = await dbAll<{ jockey_id: string; total: number; wins: number; places: number }>(`
    SELECT
      e.jockey_id,
      COUNT(*) as total,
      SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN e.result_position <= 3 THEN 1 ELSE 0 END) as places
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id IN (${placeholders}) AND r.status = '結果確定' AND e.result_position IS NOT NULL AND r.date < ?
    GROUP BY e.jockey_id
  `, [...uniqueIds, beforeDate]);

  for (const id of uniqueIds) {
    result.set(id, { ...defaults });
  }
  for (const row of rows) {
    if (row.total >= 5) {
      result.set(row.jockey_id, {
        winRate: row.wins / row.total,
        placeRate: row.places / row.total,
      });
    }
  }
  return result;
}

/**
 * 複数調教師の統計を一括取得する。
 */
export async function getTrainerStatsBatch(
  trainerNames: string[],
  beforeDate: string,
): Promise<Map<string, TrainerStatsResult>> {
  const DEF_W = 0.08;
  const DEF_P = 0.20;
  const defaults: TrainerStatsResult = {
    winRate: DEF_W, placeRate: DEF_P,
    sprintWinRate: DEF_W, mileWinRate: DEF_W, longWinRate: DEF_W,
    heavyWinRate: DEF_W, gradeWinRate: DEF_W,
  };

  const result = new Map<string, TrainerStatsResult>();
  if (trainerNames.length === 0) return result;

  const uniqueNames = [...new Set(trainerNames.filter(n => !!n))];
  for (const n of trainerNames) {
    if (!n) result.set('', { ...defaults });
  }
  if (uniqueNames.length === 0) return result;

  const placeholders = uniqueNames.map(() => '?').join(',');

  const rows = await dbAll<{
    trainer_name: string;
    total: number; wins: number; places: number;
    sprint_total: number; sprint_wins: number;
    mile_total: number; mile_wins: number;
    long_total: number; long_wins: number;
    heavy_total: number; heavy_wins: number;
    grade_total: number; grade_wins: number;
  }>(`
    SELECT
      e.trainer_name,
      COUNT(*) as total,
      SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN e.result_position <= 3 THEN 1 ELSE 0 END) as places,
      SUM(CASE WHEN r.distance <= 1400 THEN 1 ELSE 0 END) as sprint_total,
      SUM(CASE WHEN r.distance <= 1400 AND e.result_position = 1 THEN 1 ELSE 0 END) as sprint_wins,
      SUM(CASE WHEN r.distance BETWEEN 1401 AND 1800 THEN 1 ELSE 0 END) as mile_total,
      SUM(CASE WHEN r.distance BETWEEN 1401 AND 1800 AND e.result_position = 1 THEN 1 ELSE 0 END) as mile_wins,
      SUM(CASE WHEN r.distance >= 1801 THEN 1 ELSE 0 END) as long_total,
      SUM(CASE WHEN r.distance >= 1801 AND e.result_position = 1 THEN 1 ELSE 0 END) as long_wins,
      SUM(CASE WHEN r.track_condition IN ('重', '不良') THEN 1 ELSE 0 END) as heavy_total,
      SUM(CASE WHEN r.track_condition IN ('重', '不良') AND e.result_position = 1 THEN 1 ELSE 0 END) as heavy_wins,
      SUM(CASE WHEN r.grade IN ('G3', 'G2', 'G1') THEN 1 ELSE 0 END) as grade_total,
      SUM(CASE WHEN r.grade IN ('G3', 'G2', 'G1') AND e.result_position = 1 THEN 1 ELSE 0 END) as grade_wins
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.trainer_name IN (${placeholders}) AND r.status = '結果確定' AND e.result_position IS NOT NULL AND r.date < ?
    GROUP BY e.trainer_name
  `, [...uniqueNames, beforeDate]);

  const safeRate = (wins: number, total: number) => total >= 5 ? wins / total : DEF_W;

  // デフォルトで初期化
  for (const n of uniqueNames) {
    result.set(n, { ...defaults });
  }
  for (const row of rows) {
    if (row.total >= 10) {
      result.set(row.trainer_name, {
        winRate: row.wins / row.total,
        placeRate: row.places / row.total,
        sprintWinRate: safeRate(row.sprint_wins, row.sprint_total),
        mileWinRate: safeRate(row.mile_wins, row.mile_total),
        longWinRate: safeRate(row.long_wins, row.long_total),
        heavyWinRate: safeRate(row.heavy_wins, row.heavy_total),
        gradeWinRate: safeRate(row.grade_wins, row.grade_total),
      });
    }
  }
  return result;
}

/**
 * 複数種牡馬×馬場タイプの勝率を一括取得する。
 */
export async function getSireTrackWinRateBatch(
  sireNames: string[],
  trackType: string,
  beforeDate: string,
): Promise<Map<string, number>> {
  const DEFAULT_RATE = 0.07;
  const result = new Map<string, number>();
  if (sireNames.length === 0) return result;

  const uniqueNames = [...new Set(sireNames.filter(n => !!n))];
  for (const n of sireNames) {
    if (!n) result.set('', DEFAULT_RATE);
  }
  if (uniqueNames.length === 0) return result;

  const placeholders = uniqueNames.map(() => '?').join(',');

  const rows = await dbAll<{ father_name: string; total: number; wins: number }>(`
    SELECT h.father_name,
           COUNT(*) as total,
           SUM(CASE WHEN pp.position = 1 THEN 1 ELSE 0 END) as wins
    FROM past_performances pp
    JOIN horses h ON pp.horse_id = h.id
    WHERE h.father_name IN (${placeholders}) AND pp.track_type = ? AND pp.position IS NOT NULL AND pp.date < ?
    GROUP BY h.father_name
  `, [...uniqueNames, trackType, beforeDate]);

  for (const n of uniqueNames) {
    result.set(n, DEFAULT_RATE);
  }
  for (const row of rows) {
    if (row.total >= 10) {
      result.set(row.father_name, row.wins / row.total);
    }
  }
  return result;
}

/**
 * 複数騎手×距離帯（±200m）の勝率を一括取得する。
 */
export async function getJockeyDistanceWinRateBatch(
  jockeyIds: string[],
  distance: number,
  beforeDate: string,
): Promise<Map<string, number>> {
  const DEFAULT_RATE = 0.08;
  const result = new Map<string, number>();
  if (jockeyIds.length === 0) return result;

  const uniqueIds = [...new Set(jockeyIds.filter(id => !!id))];
  for (const id of jockeyIds) {
    if (!id) result.set('', DEFAULT_RATE);
  }
  if (uniqueIds.length === 0) return result;

  const placeholders = uniqueIds.map(() => '?').join(',');

  const rows = await dbAll<{ jockey_id: string; total: number; wins: number }>(`
    SELECT e.jockey_id,
           COUNT(*) as total,
           SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id IN (${placeholders}) AND r.status = '結果確定' AND e.result_position IS NOT NULL
      AND ABS(r.distance - ?) <= 200 AND r.date < ?
    GROUP BY e.jockey_id
  `, [...uniqueIds, distance, beforeDate]);

  for (const id of uniqueIds) {
    result.set(id, DEFAULT_RATE);
  }
  for (const row of rows) {
    if (row.total >= 10) {
      result.set(row.jockey_id, row.wins / row.total);
    }
  }
  return result;
}

/**
 * 複数騎手×コースの勝率を一括取得する。
 */
export async function getJockeyCourseWinRateBatch(
  jockeyIds: string[],
  courseName: string,
  beforeDate: string,
): Promise<Map<string, number>> {
  const DEFAULT_RATE = 0.08;
  const result = new Map<string, number>();
  if (jockeyIds.length === 0) return result;

  const uniqueIds = [...new Set(jockeyIds.filter(id => !!id))];
  for (const id of jockeyIds) {
    if (!id) result.set('', DEFAULT_RATE);
  }
  if (uniqueIds.length === 0) return result;

  const placeholders = uniqueIds.map(() => '?').join(',');

  const rows = await dbAll<{ jockey_id: string; total: number; wins: number }>(`
    SELECT e.jockey_id,
           COUNT(*) as total,
           SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id IN (${placeholders}) AND r.racecourse_name = ? AND r.status = '結果確定' AND e.result_position IS NOT NULL AND r.date < ?
    GROUP BY e.jockey_id
  `, [...uniqueIds, courseName, beforeDate]);

  for (const id of uniqueIds) {
    result.set(id, DEFAULT_RATE);
  }
  for (const row of rows) {
    if (row.total >= 10) {
      result.set(row.jockey_id, row.wins / row.total);
    }
  }
  return result;
}

// ==================== キャリブレーション ====================

/** 最新の適用済みキャリブレーション重みを取得 */
export async function getActiveCalibrationWeights(): Promise<Record<string, number> | null> {
  const row = await dbGet<{ weights_json: string }>(
    'SELECT weights_json FROM calibration_weights WHERE applied = 1 ORDER BY created_at DESC LIMIT 1'
  );
  if (!row) return null;
  try {
    return JSON.parse(row.weights_json);
  } catch {
    return null;
  }
}

/** キャリブレーション結果を保存 */
export async function saveCalibrationWeights(
  weights: Record<string, number>,
  evaluatedRaces: number,
  applied: boolean,
  notes?: string
): Promise<void> {
  await dbRun(`
    INSERT INTO calibration_weights (weights_json, evaluated_races, applied, notes)
    VALUES (?, ?, ?, ?)
  `, [JSON.stringify(weights), evaluatedRaces, applied ? 1 : 0, notes || null]);
}

// ==================== カテゴリ別キャリブレーション ====================

/** カテゴリ別校正結果を保存 */
export async function saveCategoryCalibration(
  category: string,
  multipliers: Record<string, number>,
  evaluatedRaces: number,
  applied: boolean,
  notes?: string,
): Promise<void> {
  await dbRun(`
    INSERT INTO category_calibration (category, multipliers_json, evaluated_races, applied, notes)
    VALUES (?, ?, ?, ?, ?)
  `, [category, JSON.stringify(multipliers), evaluatedRaces, applied ? 1 : 0, notes || null]);
}

/** 有効なカテゴリ別校正結果を全カテゴリ取得 */
export async function getActiveCategoryCalibrations(): Promise<Map<string, Record<string, number>> | null> {
  const rows = await dbAll<{ category: string; multipliers_json: string }>(
    `SELECT category, multipliers_json FROM category_calibration
     WHERE applied = 1
     AND id IN (SELECT MAX(id) FROM category_calibration WHERE applied = 1 GROUP BY category)`
  );
  if (rows.length === 0) return null;
  const result = new Map<string, Record<string, number>>();
  for (const row of rows) {
    try {
      result.set(row.category, JSON.parse(row.multipliers_json));
    } catch {
      // パース失敗は無視
    }
  }
  return result.size > 0 ? result : null;
}

// ==================== スケジューラー実行記録 ====================

/** スケジューラー実行記録を保存 */
export async function recordSchedulerRun(
  jobType: string,
  targetDate: string,
  status: 'running' | 'completed' | 'failed',
  detail?: string,
  error?: string,
): Promise<number> {
  const result = await dbRun(`
    INSERT INTO scheduler_runs (job_type, target_date, status, detail, error, completed_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? != 'running' THEN datetime('now') ELSE NULL END)
  `, [jobType, targetDate, status, detail || null, error || null, status]);
  return Number(result.lastInsertRowid || 0);
}

/** スケジューラー実行記録を更新 */
export async function updateSchedulerRun(
  id: number,
  status: 'completed' | 'failed',
  detail?: string,
  error?: string,
): Promise<void> {
  await dbRun(`
    UPDATE scheduler_runs SET status = ?, detail = ?, error = ?, completed_at = datetime('now')
    WHERE id = ?
  `, [status, detail || null, error || null, id]);
}

/** 特定日・ジョブタイプのスケジューラー実行が今日既に実行済みかを返す */
export async function hasSchedulerRunToday(jobType: string, targetDate: string): Promise<boolean> {
  // 'running' ステータスは10分後に自動失効（Vercelタイムアウトで放置された記録を無視）
  const row = await dbGet<{ c: number }>(
    `SELECT COUNT(*) as c FROM scheduler_runs
     WHERE job_type = ? AND target_date = ?
     AND DATE(started_at, '+9 hours') = DATE('now', '+9 hours')
     AND (status = 'completed' OR (status = 'running' AND started_at > datetime('now', '-10 minutes')))`,
    [jobType, targetDate]
  );
  return (row?.c ?? 0) > 0;
}

/** 最近のスケジューラー実行記録を取得 */
export async function getRecentSchedulerRuns(limit: number = 20) {
  return dbAll(
    'SELECT * FROM scheduler_runs ORDER BY started_at DESC LIMIT ?',
    [limit]
  );
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
