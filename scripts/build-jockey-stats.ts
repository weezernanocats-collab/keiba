/**
 * ローカル実行スクリプト: 騎手統計を race_entries から集計して jockeys テーブルに書き込む
 *
 * 使い方: npx tsx scripts/build-jockey-stats.ts
 *
 * - race_entries の結果データ（result_position）から全騎手の勝率・複勝率等を計算
 * - jockeys テーブルに upsert
 * - 既存のシードデータ（j001等）は実IDで上書き
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';

// Load .env.local manually
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

const TURSO_URL = process.env.TURSO_DATABASE_URL!;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN!;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in .env.local');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ==================== Racecourse region inference ====================

const CENTRAL_RACECOURSES = new Set([
  '札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉',
]);

// ==================== Main ====================

async function main() {
  console.log('=== Build Jockey Stats from race_entries ===\n');

  // Step 1: Aggregate stats from race_entries
  const stats = await db.execute(`
    SELECT
      e.jockey_id,
      e.jockey_name,
      COUNT(*) as total_races,
      SUM(CASE WHEN e.result_position = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN e.result_position <= 2 THEN 1 ELSE 0 END) as places,
      SUM(CASE WHEN e.result_position <= 3 THEN 1 ELSE 0 END) as shows,
      GROUP_CONCAT(DISTINCT r.racecourse_name) as racecourses
    FROM race_entries e
    JOIN races r ON e.race_id = r.id
    WHERE e.jockey_id IS NOT NULL
      AND e.result_position IS NOT NULL
      AND r.status = '結果確定'
    GROUP BY e.jockey_id
    ORDER BY total_races DESC
  `);

  console.log(`Found ${stats.rows.length} jockeys with result data\n`);

  // Step 2: Build upsert statements
  let upserted = 0;
  const batchSize = 20;

  for (let i = 0; i < stats.rows.length; i += batchSize) {
    const batch = stats.rows.slice(i, i + batchSize);
    const stmts = batch.map(row => {
      const totalRaces = row.total_races as number;
      const wins = row.wins as number;
      const places = row.places as number;
      const shows = row.shows as number;
      const winRate = totalRaces > 0 ? Math.round((wins / totalRaces) * 1000) / 1000 : 0;
      const placeRate = totalRaces > 0 ? Math.round((places / totalRaces) * 1000) / 1000 : 0;
      const showRate = totalRaces > 0 ? Math.round((shows / totalRaces) * 1000) / 1000 : 0;

      // Infer region from racecourses
      const racecourses = (row.racecourses as string || '').split(',');
      const centralCount = racecourses.filter(rc => CENTRAL_RACECOURSES.has(rc)).length;
      const region = centralCount > racecourses.length / 2 ? '中央' : '地方';

      return {
        sql: `INSERT INTO jockeys (id, name, age, region, total_races, wins, win_rate, place_rate, show_rate, updated_at)
              VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(id) DO UPDATE SET
                name = CASE WHEN LENGTH(excluded.name) >= LENGTH(jockeys.name) THEN excluded.name ELSE jockeys.name END,
                region = excluded.region,
                total_races = excluded.total_races,
                wins = excluded.wins,
                win_rate = excluded.win_rate,
                place_rate = excluded.place_rate,
                show_rate = excluded.show_rate,
                updated_at = datetime('now')`,
        args: [
          row.jockey_id as string,
          row.jockey_name as string,
          region,
          totalRaces,
          wins,
          winRate,
          placeRate,
          showRate,
        ],
      };
    });

    await db.batch(stmts, 'write');
    upserted += batch.length;
  }

  console.log(`Upserted ${upserted} jockeys\n`);

  // Step 3: Show top jockeys
  const top = await db.execute(
    'SELECT id, name, region, total_races, wins, win_rate, place_rate, show_rate FROM jockeys ORDER BY wins DESC LIMIT 20'
  );

  console.log('Top 20 jockeys by wins:');
  console.log('  ID     | Name       | Region | Races | Wins | WinRate | PlaceRate | ShowRate');
  console.log('  -------+------------+--------+-------+------+---------+-----------+---------');
  for (const r of top.rows) {
    const id = String(r.id).padEnd(6);
    const name = String(r.name).padEnd(10);
    const region = String(r.region).padEnd(4);
    const races = String(r.total_races).padStart(5);
    const wins = String(r.wins).padStart(4);
    const wr = ((r.win_rate as number) * 100).toFixed(1).padStart(6) + '%';
    const pr = ((r.place_rate as number) * 100).toFixed(1).padStart(6) + '%';
    const sr = ((r.show_rate as number) * 100).toFixed(1).padStart(6) + '%';
    console.log(`  ${id} | ${name} | ${region} | ${races} | ${wins} | ${wr} | ${pr} | ${sr}`);
  }

  // Step 4: Summary
  const total = await db.execute('SELECT COUNT(*) as c FROM jockeys');
  const withData = await db.execute('SELECT COUNT(*) as c FROM jockeys WHERE total_races >= 5');
  console.log(`\nTotal jockeys: ${total.rows[0].c}`);
  console.log(`With 5+ races: ${withData.rows[0].c}`);

  db.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
