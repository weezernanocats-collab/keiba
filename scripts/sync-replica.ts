/**
 * Turso → ローカルSQLite レプリカ同期
 *
 * 目的: 分析・バックテストを Turso の読み取り枠を消費せずに回す。
 * Turso 側は本スクリプト実行時に1テーブル1パスだけ読む。
 *
 * 使い方:
 *   npx tsx scripts/sync-replica.ts                 # 全テーブル同期
 *   npx tsx scripts/sync-replica.ts --tables races,race_entries
 *   npx tsx scripts/sync-replica.ts --out data/replica.db
 *   npx tsx scripts/sync-replica.ts --count-only    # 行数見積りだけ出す
 *
 * 注意: 出力先は毎回まっさらなファイルを新規作成する (DELETE/DROP を一切使わない)。
 *       既存ファイルがある場合は --replace 指定時のみ .bak へ退避する。
 */
import { readFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import path from 'path';
import { createClient, type Client } from '@libsql/client';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = line.match(/^(\w+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const countOnly = argv.includes('--count-only');
const outPath = arg('out') ?? 'data/replica.db';
const onlyTables = arg('tables')?.split(',').map(s => s.trim()).filter(Boolean);
const PAGE = Number(arg('page') ?? 5000);

function remoteClient(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL が未設定');
  if (!url.startsWith('https://')) {
    throw new Error(`Turso接続は https:// のみ許可 (現在: ${url.split(':')[0]}://...)`);
  }
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

async function main() {
  const remote = remoteClient();

  // --- スキーマ取得 ---
  const master = await remote.execute(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
  );
  const allTables = master.rows
    .filter(r => r.type === 'table')
    .map(r => String(r.name));
  const targets = onlyTables ?? allTables;
  const unknown = targets.filter(t => !allTables.includes(t));
  if (unknown.length) throw new Error(`存在しないテーブル: ${unknown.join(', ')}`);

  // --- 行数見積り ---
  const counts: Record<string, number> = {};
  for (const t of targets) {
    const r = await remote.execute(`SELECT COUNT(*) n FROM "${t}"`);
    counts[t] = Number(r.rows[0].n);
  }
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  console.log('=== Turso 側 行数 ===');
  for (const t of targets.slice().sort((a, b) => counts[b] - counts[a])) {
    console.log(`  ${t.padEnd(26)} ${counts[t].toLocaleString()}`);
  }
  console.log(`  ${'TOTAL'.padEnd(26)} ${total.toLocaleString()}`);
  if (countOnly) {
    console.log('\n--count-only 指定のため同期せず終了');
    return;
  }

  // --- ローカル側準備 ---
  const absOut = path.resolve(outPath);
  mkdirSync(path.dirname(absOut), { recursive: true });

  // 既存レプリカは消さずに .bak へ退避し、常に新規ファイルへ書く
  if (existsSync(absOut)) {
    if (!argv.includes('--replace')) {
      throw new Error(
        `${absOut} が既に存在する。退避して作り直すなら --replace を付ける (旧ファイルは .bak に残る)`
      );
    }
    for (const suffix of ['', '-shm', '-wal']) {
      const f = absOut + suffix;
      if (existsSync(f)) renameSync(f, `${f}.bak`);
    }
    console.log(`既存レプリカを ${absOut}.bak へ退避`);
  }

  const local = createClient({ url: `file:${absOut}` });

  // テーブル + インデックスを作成 (既存ならスキップ)
  for (const row of master.rows) {
    const name = String(row.name);
    const tbl = String(row.tbl_name);
    if (!targets.includes(tbl)) continue;
    const sql = String(row.sql);
    try {
      await local.execute(sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists/i.test(msg)) console.warn(`  [warn] ${row.type} ${name}: ${msg}`);
    }
  }

  // --- テーブル単位でコピー ---
  console.log(`\n=== 同期開始 → ${absOut} ===`);
  let copied = 0;
  for (const t of targets) {
    // 出力先は新規ファイルなので既存行のクリアは不要
    const colsRes = await remote.execute(`SELECT * FROM "${t}" LIMIT 0`);
    const cols = colsRes.columns;
    const colList = cols.map(c => `"${c}"`).join(',');
    const placeholders = `(${cols.map(() => '?').join(',')})`;

    let lastRid = 0;
    let n = 0;
    for (;;) {
      const page = await remote.execute({
        sql: `SELECT rowid AS __rid, ${colList} FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        args: [lastRid, PAGE],
      });
      if (page.rows.length === 0) break;
      lastRid = Number((page.rows[page.rows.length - 1] as Record<string, unknown>).__rid);

      // ローカルへは複数行INSERTでまとめる (トランザクション内)
      const tx = await local.transaction('write');
      try {
        const CHUNK = 200;
        for (let i = 0; i < page.rows.length; i += CHUNK) {
          const slice = page.rows.slice(i, i + CHUNK);
          const args: unknown[] = [];
          for (const row of slice) {
            const r = row as unknown as Record<string, unknown>;
            for (const c of cols) args.push(r[c] ?? null);
          }
          await tx.execute({
            sql: `INSERT INTO "${t}" (${colList}) VALUES ${slice.map(() => placeholders).join(',')}`,
            args: args as never,
          });
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }

      n += page.rows.length;
      if (page.rows.length < PAGE) break;
    }
    copied += n;
    console.log(`  ${t.padEnd(26)} ${n.toLocaleString()} 行`);
  }

  console.log(`\n完了: ${copied.toLocaleString()} 行 → ${absOut}`);
  console.log('以降の分析は TURSO_DATABASE_URL を外し、file: 接続で実行する');
}

main().then(() => process.exit(0)).catch(e => {
  console.error('同期失敗:', e instanceof Error ? e.message : e);
  process.exit(1);
});
