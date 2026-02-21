import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;

  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'keiba.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initializeDatabase(db);

  return db;
}

function initializeDatabase(db: Database.Database): void {
  db.exec(`
    -- 競馬場マスタ
    CREATE TABLE IF NOT EXISTS racecourses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL CHECK(region IN ('中央', '地方')),
      prefecture TEXT NOT NULL
    );

    -- 馬マスタ
    CREATE TABLE IF NOT EXISTS horses (
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
    );

    -- 騎手マスタ
    CREATE TABLE IF NOT EXISTS jockeys (
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
    );

    -- レース
    CREATE TABLE IF NOT EXISTS races (
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
    );

    -- 出走馬
    CREATE TABLE IF NOT EXISTS race_entries (
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
    );

    -- オッズ
    CREATE TABLE IF NOT EXISTS odds (
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
    );

    -- 過去成績
    CREATE TABLE IF NOT EXISTS past_performances (
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
    );

    -- AI予想
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      race_id TEXT NOT NULL,
      generated_at TEXT DEFAULT (datetime('now')),
      confidence INTEGER,
      summary TEXT,
      analysis_json TEXT,
      picks_json TEXT,
      bets_json TEXT,
      FOREIGN KEY (race_id) REFERENCES races(id)
    );

    -- 馬の強み・弱み
    CREATE TABLE IF NOT EXISTS horse_traits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      horse_id TEXT NOT NULL,
      trait_type TEXT NOT NULL CHECK(trait_type IN ('strength', 'weakness')),
      description TEXT NOT NULL,
      FOREIGN KEY (horse_id) REFERENCES horses(id)
    );

    -- インデックス
    CREATE INDEX IF NOT EXISTS idx_races_date ON races(date);
    CREATE INDEX IF NOT EXISTS idx_races_racecourse ON races(racecourse_id);
    CREATE INDEX IF NOT EXISTS idx_race_entries_race ON race_entries(race_id);
    CREATE INDEX IF NOT EXISTS idx_race_entries_horse ON race_entries(horse_id);
    CREATE INDEX IF NOT EXISTS idx_past_performances_horse ON past_performances(horse_id);
    CREATE INDEX IF NOT EXISTS idx_odds_race ON odds(race_id);
    CREATE INDEX IF NOT EXISTS idx_predictions_race ON predictions(race_id);
    CREATE INDEX IF NOT EXISTS idx_horse_traits_horse ON horse_traits(horse_id);
  `);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
