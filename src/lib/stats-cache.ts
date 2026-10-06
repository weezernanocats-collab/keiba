/**
 * 集計結果の永続キャッシュ
 *
 * 目的: /api/accuracy-stats のような「全履歴を走査する集計」を毎リクエスト再計算させない。
 *
 * 背景 (2026-09 の Turso 読み取り枠枯渇):
 *   accuracy-stats は1リクエストで約50万行読む = DB全体(57万行)をほぼ丸ごと読む量。
 *   プロセス内 Map キャッシュだけでは Vercel のインスタンスが入れ替わるたびに失効し、
 *   予想ページを開くたびに全走査が走っていた。
 *
 * 判定ロジック:
 *   1. キャッシュが soft TTL 以内 → そのまま返す (1行読むだけ)
 *   2. soft TTL 超過 → prediction_results の件数だけ数え、前回と同じなら返す (約8千行)
 *   3. 件数が変わっている = 新しい結果が確定した → 呼び出し側で再計算
 */
import { dbAll, dbGet, dbRun } from './database';

/** この時間内はカウント確認すらせずキャッシュを返す */
const SOFT_TTL_MS = 30 * 60 * 1000;

let tableReady = false;

/** stats_cache テーブルを用意する (本番DBは ensureInitialized がスキーマ作成をスキップするため個別に実行) */
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await dbRun(`CREATE TABLE IF NOT EXISTS stats_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    source_count INTEGER NOT NULL,
    computed_at TEXT NOT NULL
  )`);
  tableReady = true;
}

/** 集計の入力が変化したかを測る軽量な指標 */
async function sourceCount(): Promise<number> {
  const row = await dbGet<{ n: number }>('SELECT COUNT(*) as n FROM prediction_results');
  return Number(row?.n ?? 0);
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

  const rows = await dbAll<{ payload: string; source_count: number; computed_at: string }>(
    'SELECT payload, source_count, computed_at FROM stats_cache WHERE cache_key = ?',
    [cacheKey]
  );
  const row = rows[0];
  if (!row) return null;

  const computedAt = String(row.computed_at);
  const ageMs = Date.now() - new Date(computedAt).getTime();

  const parse = (reason: CachedStats<T>['reason']): CachedStats<T> | null => {
    try {
      return { data: JSON.parse(row.payload) as T, computedAt, ageMs, reason };
    } catch {
      return null; // 壊れたペイロードは無視して再計算させる
    }
  };

  if (ageMs < SOFT_TTL_MS) return parse('soft-ttl');

  // soft TTL を過ぎたら「集計元が増えたか」だけ確認する
  const current = await sourceCount();
  if (current === Number(row.source_count)) return parse('unchanged-source');

  return null;
}

/** 計算結果を保存する */
export async function putStats(cacheKey: string, data: unknown): Promise<void> {
  await ensureTable();
  const count = await sourceCount();
  await dbRun(
    `INSERT INTO stats_cache (cache_key, payload, source_count, computed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload = excluded.payload,
       source_count = excluded.source_count,
       computed_at = excluded.computed_at`,
    [cacheKey, JSON.stringify(data), count, new Date().toISOString()]
  );
}
