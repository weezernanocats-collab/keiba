import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });

async function main() {
  // Step 1: Clean duplicates - keep newest per race
  const dupes = await db.execute(
    `SELECT race_id, COUNT(*) as c FROM predictions GROUP BY race_id HAVING c > 1`
  );
  if (dupes.rows.length > 0) {
    console.log(`Found ${dupes.rows.length} races with duplicate predictions, cleaning...`);
    for (const row of dupes.rows) {
      // Keep the latest (highest id), delete older ones
      await db.execute(
        `DELETE FROM predictions WHERE race_id = ? AND id != (SELECT MAX(id) FROM predictions WHERE race_id = ?)`,
        [row.race_id, row.race_id]
      );
    }
    console.log('Duplicates cleaned.\n');
  }

  // Step 2: Count
  const preds = await db.execute('SELECT COUNT(*) as c FROM predictions');
  const races = await db.execute("SELECT COUNT(*) as c FROM races WHERE date = (SELECT MAX(date) FROM races)");
  console.log(`Predictions: ${preds.rows[0].c} / ${races.rows[0].c} races`);

  // Step 3: Check quality - look at horseScores in analysis_json
  const samples = await db.execute(
    `SELECT p.race_id, r.name as race_name, p.confidence, p.picks_json, p.analysis_json, p.summary
     FROM predictions p
     JOIN races r ON p.race_id = r.id
     WHERE r.date = (SELECT MAX(date) FROM races)
     ORDER BY r.id
     LIMIT 5`
  );

  for (const row of samples.rows) {
    console.log(`\n--- ${row.race_name} (confidence: ${row.confidence}) ---`);

    const picks = JSON.parse(row.picks_json as string);
    const analysis = JSON.parse(row.analysis_json as string);

    // Check if scores are differentiated
    const horseScores = analysis.horseScores || {};
    const scoreEntries = Object.entries(horseScores);
    if (scoreEntries.length > 0) {
      const totalScores = scoreEntries.map(([num, factors]: [string, unknown]) => {
        const f = factors as Record<string, number>;
        const total = Object.values(f).reduce((sum: number, v: number) => sum + v, 0) / Object.keys(f).length;
        return { num, total: Math.round(total * 10) / 10 };
      });
      totalScores.sort((a, b) => b.total - a.total);

      const min = Math.min(...totalScores.map(s => s.total));
      const max = Math.max(...totalScores.map(s => s.total));
      console.log(`  Score range: ${min} - ${max} (spread: ${(max - min).toFixed(1)})`);
      console.log(`  Top 3: ${totalScores.slice(0, 3).map(s => `#${s.num}=${s.total}`).join(', ')}`);
    } else {
      console.log('  No horseScores found in analysis!');
    }

    // Show top pick with reason
    if (picks[0]) {
      const reason = picks[0].reason || 'no reason';
      console.log(`  Top pick: #${picks[0].horseNumber} ${picks[0].horseName}`);
      console.log(`  Reason: ${reason.substring(0, 100)}`);
    }

    // Summary preview
    const summary = row.summary as string;
    if (summary) {
      console.log(`  Summary: ${summary.substring(0, 120)}...`);
    }
  }

  db.close();
}

main();
