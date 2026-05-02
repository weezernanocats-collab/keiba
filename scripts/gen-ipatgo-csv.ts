/**
 * IPATGO用 馬連CSV生成スクリプト
 *
 * 戦略: しょーさん候補(スコア65+) × 1番人気 馬連
 * バックテストROI: 188.8%
 *
 * 使い方:
 *   npx tsx scripts/gen-ipatgo-csv.ts --date 2026-05-03
 *   npx tsx scripts/gen-ipatgo-csv.ts --date 2026-05-03 --amount 500
 *   npx tsx scripts/gen-ipatgo-csv.ts --date 2026-05-03 --dry-run
 *
 * 出力: /tmp/ipatgo_YYYYMMDD.csv
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

// 引数パース
const args = process.argv.slice(2);
const dateIdx = args.indexOf('--date');
const amountIdx = args.indexOf('--amount');
const minScoreIdx = args.indexOf('--min-score');
const dryRun = args.includes('--dry-run');

const today = new Date();
today.setHours(today.getHours() + 9);
const date = dateIdx >= 0 ? args[dateIdx + 1] : today.toISOString().split('T')[0];
const amount = amountIdx >= 0 ? parseInt(args[amountIdx + 1]) : 100;
const minScore = minScoreIdx >= 0 ? parseInt(args[minScoreIdx + 1]) : 65;

// 競馬場名 → IPATGOコード
const VENUE_MAP: Record<string, string> = {
  '札幌': 'SAPPORO', '函館': 'HAKODATE', '福島': 'FUKUSHIMA',
  '新潟': 'NIIGATA', '東京': 'TOKYO', '中山': 'NAKAYAMA',
  '中京': 'CHUKYO', '京都': 'KYOTO', '阪神': 'HANSHIN', '小倉': 'KOKURA',
};

interface BetLine {
  venue: string;
  raceNumber: number;
  raceName: string;
  axis: { number: number; name: string; theory: number; score: number };
  partner: { number: number; name: string; odds: number };
  ipatgoLine: string;
}

async function main() {
  const dateCompact = date.replace(/-/g, '');

  console.log(`[ipatgo] ${date} / スコア${minScore}+ × 1番人気 馬連 / ${amount}円`);
  console.log('');

  // しょーさん候補があるレースを取得
  const rows = await db.execute({
    sql: `SELECT p.race_id, p.analysis_json, r.racecourse_name, r.race_number, r.name, r.time
          FROM predictions p
          JOIN races r ON p.race_id = r.id
          WHERE r.date = ? AND p.analysis_json LIKE '%shosanPrediction%'
          ORDER BY r.time, r.racecourse_name, r.race_number`,
    args: [date],
  });

  const bets: BetLine[] = [];

  for (const row of rows.rows) {
    const raceId = String(row.race_id);
    const venue = String(row.racecourse_name);
    const raceNumber = Number(row.race_number);
    const raceName = String(row.name);
    const venueCode = VENUE_MAP[venue];
    if (!venueCode) continue;

    // しょーさん候補を抽出（スコアフィルタ）
    let analysis: any;
    try { analysis = JSON.parse(String(row.analysis_json)); } catch { continue; }
    const candidates = analysis?.shosanPrediction?.candidates || [];
    const qualified = candidates.filter((c: any) => (c.matchScore || 0) >= minScore);
    if (qualified.length === 0) continue;

    // 1番人気を取得
    const entries = await db.execute({
      sql: `SELECT horse_number, horse_name, odds, popularity FROM race_entries
            WHERE race_id = ? AND odds > 0 ORDER BY odds ASC LIMIT 1`,
      args: [raceId],
    });
    if (entries.rows.length === 0) continue;
    const fav = entries.rows[0];
    const favNumber = Number(fav.horse_number);
    const favName = String(fav.horse_name);
    const favOdds = Number(fav.odds);

    for (const c of qualified) {
      const axisNumber = Number(c.horseNumber);
      // 軸と1番人気が同じ馬なら馬連にならないのでスキップ
      if (axisNumber === favNumber) continue;

      // 組番: 若番を左に
      const [small, large] = axisNumber < favNumber
        ? [axisNumber, favNumber]
        : [favNumber, axisNumber];
      const combo = `${String(small).padStart(2, '0')}-${String(large).padStart(2, '0')}`;

      const ipatgoLine = `${dateCompact},${venueCode},${raceNumber},UMAREN,NORMAL,,${combo},${amount}`;

      bets.push({
        venue,
        raceNumber,
        raceName,
        axis: { number: axisNumber, name: c.horseName, theory: c.theory, score: c.matchScore },
        partner: { number: favNumber, name: favName, odds: favOdds },
        ipatgoLine,
      });
    }
  }

  if (bets.length === 0) {
    console.log('対象なし（スコア65+のしょーさん候補がいないか、1番人気と同馬）');
    db.close();
    return;
  }

  // 表示
  console.log(`対象: ${bets.length}点 (合計 ${(amount * bets.length).toLocaleString()}円)`);
  console.log('');
  for (const b of bets) {
    console.log(`  ${b.venue}${b.raceNumber}R ${b.raceName}`);
    console.log(`    軸: ${b.axis.number}番 ${b.axis.name} (T${b.axis.theory} スコア${b.axis.score})`);
    console.log(`    相手: ${b.partner.number}番 ${b.partner.name} (${b.partner.odds}倍)`);
    console.log(`    → 馬連 ${b.axis.number}-${b.partner.number} ${amount}円`);
    console.log('');
  }

  // CSV出力
  const csvLines = bets.map(b => b.ipatgoLine);
  const csvContent = csvLines.join('\n') + '\n';

  if (dryRun) {
    console.log('[dry-run] CSV内容:');
    console.log(csvContent);
  } else {
    const outPath = `/tmp/ipatgo_${dateCompact}.csv`;
    writeFileSync(outPath, csvContent);
    console.log(`CSV出力: ${outPath}`);
    console.log('');
    console.log('使い方: IPATGOにこのCSVを読み込ませて投票');
  }

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
