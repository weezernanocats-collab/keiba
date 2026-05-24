/**
 * shoshan_evaluations テーブルの過去レースバックフィル
 *
 * 使い方:
 *   npx tsx scripts/backfill-shoshan-evaluations.ts                # デフォルト: 2024-01-01〜今日
 *   npx tsx scripts/backfill-shoshan-evaluations.ts --from 2025-01-01 --to 2025-12-31
 *   npx tsx scripts/backfill-shoshan-evaluations.ts --recompute     # 既存も上書き
 *   npx tsx scripts/backfill-shoshan-evaluations.ts --version v2    # version指定 (デフォルト v1)
 *
 * 動作:
 *   - 期間内 status='結果確定' かつ race_entries.result_position あるレースを対象
 *   - 過去走 (date < race_date) のみ参照 (リーケージなし)
 *   - shoshan_evaluations に upsert
 *   - 既存 + 同じ version の場合はskip (--recompute 指定時は再計算)
 */
import { readFileSync, existsSync } from 'fs';
import { createClient } from '@libsql/client';
import { evaluateShosanTheory, type HorseEntry, type PastPerf } from '../src/lib/shoshan-theory';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = line.match(/^(\w+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const FROM = arg('--from', '2024-01-01')!;
const todayJst = new Date();
todayJst.setHours(todayJst.getHours() + 9);
const TO = arg('--to', todayJst.toISOString().slice(0, 10))!;
const VERSION = arg('--version', 'v1')!;
const RECOMPUTE = process.argv.includes('--recompute');

async function dbAll<T>(sql: string, args: any[] = []): Promise<T[]> {
  const r = await db.execute({ sql, args });
  return r.rows as T[];
}

async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS shoshan_evaluations (
      race_id TEXT PRIMARY KEY,
      evaluated_at TEXT DEFAULT (datetime('now')),
      version TEXT,
      candidates_json TEXT NOT NULL,
      rest_filtered_json TEXT NOT NULL,
      umaren_recommendations_json TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      rest_filtered_count INTEGER NOT NULL DEFAULT 0,
      has_theory1 INTEGER NOT NULL DEFAULT 0,
      has_theory2 INTEGER NOT NULL DEFAULT 0,
      max_match_score INTEGER,
      FOREIGN KEY (race_id) REFERENCES races(id)
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_shoshan_eval_count ON shoshan_evaluations(candidate_count, max_match_score)`);
}

async function processDate(date: string, skipExisting: boolean): Promise<{ processed: number; saved: number }> {
  const races = await dbAll<{ id: string; racecourse_name: string; race_number: number; name: string }>(
    `SELECT id, racecourse_name, race_number, name FROM races WHERE date = ? AND status = '結果確定'`,
    [date]
  );
  if (races.length === 0) return { processed: 0, saved: 0 };
  const raceIds = races.map(r => r.id);
  const ph = raceIds.map(() => '?').join(',');

  // 既存チェック (同 version)
  let toEvalIds = raceIds;
  if (skipExisting) {
    const existing = await dbAll<{ race_id: string }>(
      `SELECT race_id FROM shoshan_evaluations WHERE race_id IN (${ph}) AND version = ?`,
      [...raceIds, VERSION]
    );
    const exSet = new Set(existing.map(e => e.race_id));
    toEvalIds = raceIds.filter(id => !exSet.has(id));
  }
  if (toEvalIds.length === 0) return { processed: races.length, saved: 0 };

  // race_entries
  const ph2 = toEvalIds.map(() => '?').join(',');
  const entries = await dbAll<{ race_id: string; horse_number: number; horse_name: string; horse_id: string; jockey_id: string; result_position: number | null }>(
    `SELECT race_id, horse_number, horse_name, horse_id, jockey_id, result_position FROM race_entries WHERE race_id IN (${ph2}) AND result_position IS NOT NULL`,
    toEvalIds
  );
  if (entries.length === 0) return { processed: races.length, saved: 0 };
  const byRace = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!byRace.has(e.race_id)) byRace.set(e.race_id, []);
    byRace.get(e.race_id)!.push(e);
  }
  const racesWithEntries = toEvalIds.filter(id => byRace.has(id));
  if (racesWithEntries.length === 0) return { processed: races.length, saved: 0 };

  // past_performances (date < race_date)
  const horseIds = [...new Set(entries.map(e => e.horse_id).filter(Boolean))];
  const allPP = new Map<string, PastPerf[]>();
  const PP_BATCH = 200;
  for (let j = 0; j < horseIds.length; j += PP_BATCH) {
    const hb = horseIds.slice(j, j + PP_BATCH);
    const hph = hb.map(() => '?').join(',');
    const perfs = await dbAll<{ horse_id: string; date: string; position: number; corner_positions: string; jockey_name: string; entries: number; racecourse_name: string }>(
      `SELECT horse_id, date, position, corner_positions, jockey_name, entries, racecourse_name FROM past_performances WHERE horse_id IN (${hph}) AND date < ? ORDER BY date DESC`,
      [...hb, date]
    );
    for (const p of perfs) {
      if (!allPP.has(p.horse_id)) allPP.set(p.horse_id, []);
      allPP.get(p.horse_id)!.push({
        date: p.date, position: p.position, cornerPositions: p.corner_positions || '',
        jockeyName: p.jockey_name || '', entries: p.entries, racecourseName: p.racecourse_name || '',
      });
    }
  }

  // 前走騎手 (bulk)
  const prevJockeyByRace = new Map<string, Map<string, string>>();
  if (horseIds.length > 0) {
    const HBATCH = 200;
    for (let j = 0; j < horseIds.length; j += HBATCH) {
      const hb = horseIds.slice(j, j + HBATCH);
      const hph = hb.map(() => '?').join(',');
      const rows = await dbAll<{ horse_id: string; jockey_id: string; date: string }>(
        `SELECT re.horse_id, re.jockey_id, r.date
         FROM race_entries re JOIN races r ON re.race_id = r.id
         WHERE re.horse_id IN (${hph}) AND r.date < ? AND r.status = '結果確定'
         ORDER BY r.date DESC`,
        [...hb, date]
      );
      const seen = new Map<string, string>();
      for (const row of rows) if (!seen.has(row.horse_id)) seen.set(row.horse_id, row.jockey_id);
      for (const e of entries) {
        if (e.horse_id && seen.has(e.horse_id)) {
          if (!prevJockeyByRace.has(e.race_id)) prevJockeyByRace.set(e.race_id, new Map());
          prevJockeyByRace.get(e.race_id)!.set(e.horse_id, seen.get(e.horse_id)!);
        }
      }
    }
  }

  // 各レースでshoshan評価 → upsert
  let saved = 0;
  for (const race of races) {
    if (!byRace.has(race.id)) continue;
    if (skipExisting && !racesWithEntries.includes(race.id)) continue;
    const re = byRace.get(race.id) || [];
    if (re.length < 4) {
      // 候補なし扱いで保存 (空でも記録残す)
      await db.execute({
        sql: `INSERT OR REPLACE INTO shoshan_evaluations (race_id, version, candidates_json, rest_filtered_json, candidate_count, rest_filtered_count, has_theory1, has_theory2, max_match_score, evaluated_at) VALUES (?, ?, '[]', '[]', 0, 0, 0, 0, NULL, datetime('now'))`,
        args: [race.id, VERSION],
      });
      saved++;
      continue;
    }
    const horseEntries: HorseEntry[] = re.map(e => ({
      horseNumber: e.horse_number, horseName: e.horse_name,
      horseId: e.horse_id, jockeyId: e.jockey_id, jockeyName: '',
    }));
    const filtered = new Map<string, PastPerf[]>();
    for (const e of re) filtered.set(e.horse_id, (allPP.get(e.horse_id) || []).filter(p => p.date < date));
    const result = evaluateShosanTheory(date, race.racecourse_name, horseEntries, filtered, prevJockeyByRace.get(race.id) || new Map(), race.name);
    const candCount = result.candidates.length;
    const restCount = result.restFilteredCandidates.length;
    const hasT1 = result.candidates.some(c => c.theory === 1) ? 1 : 0;
    const hasT2 = result.candidates.some(c => c.theory === 2) ? 1 : 0;
    const maxScore = candCount > 0 ? Math.max(...result.candidates.map(c => c.matchScore)) : null;
    await db.execute({
      sql: `INSERT OR REPLACE INTO shoshan_evaluations
            (race_id, version, candidates_json, rest_filtered_json, umaren_recommendations_json,
             candidate_count, rest_filtered_count, has_theory1, has_theory2, max_match_score, evaluated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [
        race.id, VERSION,
        JSON.stringify(result.candidates),
        JSON.stringify(result.restFilteredCandidates),
        JSON.stringify(result.restFilteredUmarenRecommendations || []),
        candCount, restCount, hasT1, hasT2, maxScore,
      ],
    });
    saved++;
  }
  return { processed: races.length, saved };
}

async function main() {
  console.log(`=== shoshan_evaluations バックフィル ${FROM}〜${TO} (version=${VERSION}, recompute=${RECOMPUTE}) ===`);
  await ensureTable();
  const dates = await dbAll<{ date: string }>(
    `SELECT DISTINCT date FROM races WHERE date BETWEEN ? AND ? AND status = '結果確定'
     AND id IN (SELECT race_id FROM race_entries WHERE result_position IS NOT NULL)
     ORDER BY date`,
    [FROM, TO]
  );
  console.log(`対象日数: ${dates.length}`);

  let totalProcessed = 0, totalSaved = 0;
  const t0 = Date.now();
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i].date;
    const { processed, saved } = await processDate(d, !RECOMPUTE);
    totalProcessed += processed;
    totalSaved += saved;
    if ((i + 1) % 10 === 0 || i === dates.length - 1) {
      const elapsed = (Date.now() - t0) / 1000;
      const eta = (elapsed / (i + 1)) * (dates.length - i - 1);
      console.log(`  ${i + 1}/${dates.length} (${d}) elapsed=${elapsed.toFixed(0)}s eta=${eta.toFixed(0)}s, saved=${totalSaved}, processed=${totalProcessed}`);
    }
  }
  console.log(`\n完了: 処理${totalProcessed}レース、保存${totalSaved}`);

  // 検証
  const counts = await dbAll<{ candidate_count: number; n: number }>(`
    SELECT
      CASE WHEN candidate_count = 0 THEN 0 ELSE candidate_count END AS candidate_count,
      COUNT(*) AS n FROM shoshan_evaluations
    GROUP BY candidate_count ORDER BY candidate_count
  `);
  console.log(`\n候補数別 (DB全体):`);
  for (const c of counts) console.log(`  候補${c.candidate_count}頭: ${c.n}レース`);

  db.close();
}

main().catch(e => { console.error('ERR:', e); process.exit(1); });
