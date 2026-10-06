/**
 * 集計結果の永続キャッシュ
 *
 * 目的: /api/accuracy-stats のような「全履歴を走査する集計」を毎リクエスト再計算させない。
 *
 * 背景 (2026-09 の Turso 読み取り枠枯渇):
 *   accuracy-stats は1リクエストで86クエリ/180,426行読んでいた (DB全体57万行の約3分の1)。
 *   プロセス内 Map キャッシュだけでは Vercel のインスタンスが入れ替わるたびに失効し、
 *   予想ページを開くたびに全走査が走っていた。本番の応答は28.6秒で maxDuration 30秒の寸前。
 *
 * 判定ロジック:
 *   1. hard TTL 超過        → 必ず再計算（下の指紋で拾えない更新への保険）
 *   2. soft TTL 以内        → そのまま返す（1行読むだけ）
 *   3. それ以外             → 指紋を照合し、一致すれば返す（指紋は3行程度）
 */
import { dbAll, dbGet, dbRun } from './database';

/** この時間内は指紋の照合すらせずキャッシュを返す */
const SOFT_TTL_MS = 30 * 60 * 1000;

/**
 * この時間を超えたら指紋が一致しても再計算する。
 * 指紋は INSERT/DELETE は拾えるが `UPDATE predictions SET bets_json = ...`
 * (ev-calculator / accuracy-tracker) のような上書きは拾えないため、その保険。
 */
const HARD_TTL_MS = 12 * 60 * 60 * 1000;

let tableReady = false;

/** stats_cache テーブルを用意する (本番DBは ensureInitialized がスキーマ作成をスキップするため個別に実行) */
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await dbRun(`CREATE TABLE IF NOT EXISTS stats_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    source_count INTEGER NOT NULL,
    computed_at TEXT NOT NULL,
    source_fp TEXT
  )`);
  // 既存テーブル (source_fp が無い初期版) への追加
  try {
    await dbRun('ALTER TABLE stats_cache ADD COLUMN source_fp TEXT');
  } catch {
    // 既に存在する場合のエラーは無視
  }
  tableReady = true;
}

/**
 * 集計の入力が変化したかを測る指紋。
 * COUNT(*) はテーブル全走査になるので、主キーの MAX(id) を使って
 * インデックス参照（数行）で済ませる。
 */
async function sourceFingerprint(): Promise<string> {
  const row = await dbGet<{ pr: number | null; p: number | null }>(
    `SELECT (SELECT MAX(id) FROM prediction_results) AS pr,
            (SELECT MAX(id) FROM predictions) AS p`
  );
  return `pr:${row?.pr ?? 0}/p:${row?.p ?? 0}`;
}

export interface CachedStats<T> {
  data: T;
  computedAt: string;
  ageMs: number;
  /** どの判定で返したか (ログ・デバッグ用) */
  reason: 'soft-ttl' | 'unchanged-source';
}

/**
 * 有効なキャッシュがあれば返す。無ければ null (呼び出し側で再計算して put する)
 * @param force true なら必ず null を返す (強制再計算)
 */
export async function getStats<T>(cacheKey: string, force = false): Promise<CachedStats<T> | null> {
  if (force) return null;
  await ensureTable();

  const rows = await dbAll<{ payload: string; source_fp: string | null; computed_at: string }>(
    'SELECT payload, source_fp, computed_at FROM stats_cache WHERE cache_key = ?',
    [cacheKey]
  );
  const row = rows[0];
  if (!row) return null;

  const computedAt = String(row.computed_at);
  const ageMs = Date.now() - new Date(computedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs >= HARD_TTL_MS) return null;

  const parse = (reason: CachedStats<T>['reason']): CachedStats<T> | null => {
    try {
      return { data: JSON.parse(row.payload) as T, computedAt, ageMs, reason };
    } catch {
      return null; // 壊れたペイロードは無視して再計算させる
    }
  };

  if (ageMs < SOFT_TTL_MS) return parse('soft-ttl');

  // soft TTL を過ぎたら集計元が変わっていないかだけ確認する
  const current = await sourceFingerprint();
  if (row.source_fp && current === row.source_fp) return parse('unchanged-source');

  return null;
}

/** 計算結果を保存する */
export async function putStats(cacheKey: string, data: unknown): Promise<void> {
  await ensureTable();
  const fp = await sourceFingerprint();
  await dbRun(
    `INSERT INTO stats_cache (cache_key, payload, source_count, computed_at, source_fp)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload = excluded.payload,
       computed_at = excluded.computed_at,
       source_fp = excluded.source_fp`,
    [cacheKey, JSON.stringify(data), new Date().toISOString(), fp]
  );
}
