import { createClient, type Client, type InStatement, type Row, type InValue } from '@libsql/client';
import path from 'path';
import fs from 'fs';

let client: Client | null = null;
let initialized = false;

function getClient(): Client {
  if (client) return client;

  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (tursoUrl) {
    // Turso クラウド接続
    client = createClient({
      url: tursoUrl,
      authToken: tursoToken,
    });
  } else {
    // ローカル開発用: ファイルベースSQLite
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    client = createClient({
      url: `file:${path.join(dataDir, 'keiba.db')}`,
    });
  }

  return client;
}

// DB初期化（テーブル作成）- 初回のみ実行
export async function ensureInitialized(): Promise<Client> {
  const db = getClient();
  if (initialized) return db;

  await db.batch(SCHEMA_STATEMENTS);
  initialized = true;
  return db;
}

// ==================== ヘルパー関数 ====================

/** SELECT → 複数行取得 */
export async function dbAll<T = Row>(sql: string, args?: unknown[]): Promise<T[]> {
  const db = await ensureInitialized();
  const result = await db.execute({ sql, args: (args || []) as InValue[] });
  return result.rows as T[];
}

/** SELECT → 1行取得 */
export async function dbGet<T = Row>(sql: string, args?: unknown[]): Promise<T | undefined> {
  const rows = await dbAll<T>(sql, args);
  return rows[0];
}

/** INSERT/UPDATE/DELETE → 実行 */
export async function dbRun(sql: string, args?: unknown[]): Promise<{ rowsAffected: number; lastInsertRowid: bigint | undefined }> {
  const db = await ensureInitialized();
  const result = await db.execute({ sql, args: (args || []) as InValue[] });
  return { rowsAffected: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
}

/** 名前付きパラメータでINSERT/UPDATE/DELETE */
export async function dbRunNamed(sql: string, args: Record<string, unknown>): Promise<{ rowsAffected: number; lastInsertRowid: bigint | undefined }> {
  const db = await ensureInitialized();
  const result = await db.execute({ sql, args: args as Record<string, InValue> });
  return { rowsAffected: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
}

/** 複数のSQL文をバッチ実行（トランザクション） */
export async function dbBatch(statements: (string | { sql: string; args: unknown[] })[]): Promise<void> {
  const db = await ensureInitialized();
  const typed = statements.map(s =>
    typeof s === 'string' ? s : { sql: s.sql, args: s.args as InValue[] }
  );
  await db.batch(typed, 'write');
}

/** 複数のSQL文を順次実行 */
export async function dbExec(sql: string): Promise<void> {
  const db = await ensureInitialized();
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (statements.length > 0) {
    await db.batch(statements, 'write');
  }
}

export async function closeDatabase(): Promise<void> {
  if (client) {
    client.close();
    client = null;
    initialized = false;
  }
}

// ==================== スキーマ定義 ====================

const SCHEMA_STATEMENTS: InStatement[] = [
  `CREATE TABLE IF NOT EXISTS racecourses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    region TEXT NOT NULL CHECK(region IN ('中央', '地方')),
    prefecture TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS horses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_en TEXT,
    age INTEGER NOT NULL,
    sex TEXT NOT NULL CHECK(sex IN ('牡', '牝', 'セ')),
    color TEXT,
    birth_date TEXT,
    father_id TEXT,
    father_name TEXT,
    mother_id TEXT,
    mother_name TEXT,
    trainer_name TEXT,
    owner_name TEXT,
    total_races INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    seconds INTEGER DEFAULT 0,
    thirds INTEGER DEFAULT 0,
    total_earnings REAL DEFAULT 0,
    condition_overall TEXT DEFAULT '普通',
    condition_weight REAL,
    condition_weight_change REAL,
    training_comment TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS jockeys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_en TEXT,
    age INTEGER,
    region TEXT CHECK(region IN ('中央', '地方')),
    belongs_to TEXT,
    total_races INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    place_rate REAL DEFAULT 0,
    show_rate REAL DEFAULT 0,
    total_earnings REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS races (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT,
    racecourse_id TEXT NOT NULL,
    racecourse_name TEXT NOT NULL,
    race_number INTEGER NOT NULL,
    grade TEXT,
    track_type TEXT NOT NULL CHECK(track_type IN ('芝', 'ダート', '障害')),
    distance INTEGER NOT NULL,
    track_condition TEXT CHECK(track_condition IN ('良', '稍重', '重', '不良')),
    weather TEXT,
    status TEXT DEFAULT '予定' CHECK(status IN ('予定', '出走確定', '結果確定', '中止')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (racecourse_id) REFERENCES racecourses(id)
  )`,

  `CREATE TABLE IF NOT EXISTS race_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id TEXT NOT NULL,
    post_position INTEGER NOT NULL,
    horse_number INTEGER NOT NULL,
    horse_id TEXT NOT NULL,
    horse_name TEXT NOT NULL,
    age INTEGER,
    sex TEXT,
    weight REAL,
    jockey_id TEXT,
    jockey_name TEXT NOT NULL,
    trainer_name TEXT,
    handicap_weight REAL NOT NULL,
    result_position INTEGER,
    result_time TEXT,
    result_margin TEXT,
    result_last_three_furlongs TEXT,
    result_corner_positions TEXT,
    result_weight REAL,
    result_weight_change REAL,
    FOREIGN KEY (race_id) REFERENCES races(id),
    FOREIGN KEY (horse_id) REFERENCES horses(id)
  )`,

  `CREATE TABLE IF NOT EXISTS odds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id TEXT NOT NULL,
    bet_type TEXT NOT NULL,
    horse_number1 INTEGER NOT NULL,
    horse_number2 INTEGER,
    horse_number3 INTEGER,
    odds REAL NOT NULL,
    min_odds REAL,
    max_odds REAL,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (race_id) REFERENCES races(id)
  )`,

  `CREATE TABLE IF NOT EXISTS past_performances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    horse_id TEXT NOT NULL,
    race_id TEXT,
    date TEXT NOT NULL,
    race_name TEXT NOT NULL,
    racecourse_name TEXT NOT NULL,
    track_type TEXT NOT NULL,
    distance INTEGER NOT NULL,
    track_condition TEXT,
    weather TEXT,
    entries INTEGER,
    post_position INTEGER,
    horse_number INTEGER,
    position INTEGER NOT NULL,
    jockey_name TEXT,
    handicap_weight REAL,
    weight REAL,
    weight_change REAL,
    time TEXT,
    margin TEXT,
    last_three_furlongs TEXT,
    corner_positions TEXT,
    odds REAL,
    popularity INTEGER,
    prize REAL DEFAULT 0,
    FOREIGN KEY (horse_id) REFERENCES horses(id)
  )`,

  `CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id TEXT NOT NULL,
    generated_at TEXT DEFAULT (datetime('now')),
    confidence INTEGER,
    summary TEXT,
    analysis_json TEXT,
    picks_json TEXT,
    bets_json TEXT,
    FOREIGN KEY (race_id) REFERENCES races(id)
  )`,

  `CREATE TABLE IF NOT EXISTS horse_traits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    horse_id TEXT NOT NULL,
    trait_type TEXT NOT NULL CHECK(trait_type IN ('strength', 'weakness')),
    description TEXT NOT NULL,
    FOREIGN KEY (horse_id) REFERENCES horses(id)
  )`,

  `CREATE TABLE IF NOT EXISTS prediction_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id TEXT NOT NULL,
    prediction_id INTEGER NOT NULL,
    evaluated_at TEXT DEFAULT (datetime('now')),
    top_pick_horse_id TEXT,
    top_pick_actual_position INTEGER,
    win_hit INTEGER DEFAULT 0,
    place_hit INTEGER DEFAULT 0,
    top3_picks_hit INTEGER DEFAULT 0,
    predicted_confidence INTEGER,
    bet_investment REAL DEFAULT 0,
    bet_return REAL DEFAULT 0,
    bet_roi REAL DEFAULT 0,
    FOREIGN KEY (race_id) REFERENCES races(id),
    FOREIGN KEY (prediction_id) REFERENCES predictions(id)
  )`,

  // インデックス
  `CREATE INDEX IF NOT EXISTS idx_races_date ON races(date)`,
  `CREATE INDEX IF NOT EXISTS idx_races_racecourse ON races(racecourse_id)`,
  `CREATE INDEX IF NOT EXISTS idx_race_entries_race ON race_entries(race_id)`,
  `CREATE INDEX IF NOT EXISTS idx_race_entries_horse ON race_entries(horse_id)`,
  `CREATE INDEX IF NOT EXISTS idx_past_performances_horse ON past_performances(horse_id)`,
  `CREATE INDEX IF NOT EXISTS idx_odds_race ON odds(race_id)`,
  `CREATE INDEX IF NOT EXISTS idx_predictions_race ON predictions(race_id)`,
  `CREATE INDEX IF NOT EXISTS idx_horse_traits_horse ON horse_traits(horse_id)`,
  `CREATE INDEX IF NOT EXISTS idx_past_performances_horse_date ON past_performances(horse_id, date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_past_performances_course_track ON past_performances(racecourse_name, track_type)`,
  `CREATE INDEX IF NOT EXISTS idx_past_performances_distance ON past_performances(track_type, distance)`,
  `CREATE INDEX IF NOT EXISTS idx_horses_father ON horses(father_name)`,
  `CREATE INDEX IF NOT EXISTS idx_horses_trainer ON horses(trainer_name)`,
  `CREATE INDEX IF NOT EXISTS idx_race_entries_jockey ON race_entries(jockey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_races_status ON races(status, date)`,
  `CREATE INDEX IF NOT EXISTS idx_prediction_results_race ON prediction_results(race_id)`,
];
