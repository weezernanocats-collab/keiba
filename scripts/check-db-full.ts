import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
const env = readFileSync('.env.local','utf-8');
for (const l of env.split('\n')) { const m = l.match(/^(\w+)="?([^"]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
async function main() {
  const total = await db.execute("SELECT COUNT(*) as c FROM races");
  const confirmed = await db.execute("SELECT COUNT(*) as c FROM races WHERE status = '結果確定'");
  const dateRange = await db.execute("SELECT MIN(date) as min_d, MAX(date) as max_d FROM races");
  const preds = await db.execute("SELECT COUNT(*) as c FROM predictions");
  const noPred = await db.execute("SELECT COUNT(*) as c FROM races WHERE status = '結果確定' AND id NOT IN (SELECT race_id FROM predictions)");
  const entries = await db.execute("SELECT COUNT(*) as c FROM race_entries");
  const horses = await db.execute("SELECT COUNT(*) as c FROM horses");
  const perfs = await db.execute("SELECT COUNT(*) as c FROM past_performances");
  console.log(`全レース数: ${total.rows[0].c}`);
  console.log(`結果確定: ${confirmed.rows[0].c}`);
  console.log(`日付範囲: ${dateRange.rows[0].min_d} 〜 ${dateRange.rows[0].max_d}`);
  console.log(`予想数: ${preds.rows[0].c}`);
  console.log(`予想未生成(結果確定): ${noPred.rows[0].c}`);
  console.log(`出走データ: ${entries.rows[0].c}`);
  console.log(`馬: ${horses.rows[0].c}`);
  console.log(`過去戦績: ${perfs.rows[0].c}`);
  db.close();
}
main();
