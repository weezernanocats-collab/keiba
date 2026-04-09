/**
 * しょーさん予想バックテスト
 *
 * 過去の結果確定レースに対して理論を適用し、的中率・ROIを計算
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { evaluateShosanTheory, type HorseEntry, type PastPerf } from '../src/lib/shoshan-theory';

const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!.replace('libsql://', 'https://'),
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function dbAll<T>(sql: string, args: unknown[] = []): Promise<T[]> {
  const r = await db.execute({ sql, args });
  return r.rows as T[];
}

async function main() {
  console.log('=== しょーさん予想 バックテスト ===\n');

  // 結果確定レースを取得
  const races = await dbAll<{
    id: string; date: string; racecourse_name: string; race_number: number; name: string;
  }>(`SELECT id, date, racecourse_name, race_number, name FROM races
      WHERE status = '結果確定' ORDER BY date DESC`);

  console.log(`対象レース数: ${races.length}\n`);

  // 統計
  let totalRaces = 0;
  let racesWithCandidates = 0;
  let totalCandidates = 0;
  let totalWins = 0;       // 候補馬が1着
  let totalTop3 = 0;       // 候補馬が3着以内
  let umarenBets = 0;
  let umarenHits = 0;
  let umarenInvested = 0;
  let umarenReturned = 0;
  const successExamples: string[] = [];

  const BATCH = 50;
  for (let i = 0; i < races.length; i += BATCH) {
    const batch = races.slice(i, i + BATCH);
    const raceIds = batch.map(r => r.id);
    const ph = raceIds.map(() => '?').join(',');

    // 出走馬情報
    const allEntries = await dbAll<{
      race_id: string; horse_number: number; horse_name: string;
      horse_id: string; jockey_id: string; result_position: number;
    }>(`SELECT race_id, horse_number, horse_name, horse_id, jockey_id, result_position
        FROM race_entries WHERE race_id IN (${ph})`, raceIds);

    // horse_idリスト
    const horseIds = [...new Set(allEntries.map(e => e.horse_id).filter(Boolean))];

    // 過去成績
    const allPastPerfs = new Map<string, PastPerf[]>();
    const PP_BATCH = 200;
    for (let j = 0; j < horseIds.length; j += PP_BATCH) {
      const hBatch = horseIds.slice(j, j + PP_BATCH);
      const hph = hBatch.map(() => '?').join(',');
      const perfs = await dbAll<{
        horse_id: string; date: string; position: number;
        corner_positions: string; jockey_name: string; entries: number;
      }>(`SELECT horse_id, date, position, corner_positions, jockey_name, entries
          FROM past_performances WHERE horse_id IN (${hph})
          ORDER BY date DESC`, hBatch);
      for (const p of perfs) {
        if (!allPastPerfs.has(p.horse_id)) allPastPerfs.set(p.horse_id, []);
        allPastPerfs.get(p.horse_id)!.push({
          date: p.date,
          position: p.position,
          cornerPositions: p.corner_positions || '',
          jockeyName: p.jockey_name || '',
          entries: p.entries,
        });
      }
    }

    // 前走騎手マップ（race_entriesから取得）
    // horse_idごとに、このレース日付より前のレースの騎手を取得
    const prevJockeyCache = new Map<string, Map<string, string>>(); // race_id -> (horse_id -> prev_jockey_id)

    for (const race of batch) {
      const raceEntries = allEntries.filter(e => e.race_id === race.id);
      if (raceEntries.length < 4) continue; // 少頭数はスキップ

      // 前走騎手マップを構築
      const prevJockeyMap = new Map<string, string>();
      for (const entry of raceEntries) {
        if (!entry.horse_id) continue;
        // 同じ馬の前のレースのrace_entriesから騎手を取得
        const prevEntry = await dbAll<{ jockey_id: string }>(`
          SELECT re.jockey_id FROM race_entries re
          JOIN races r ON re.race_id = r.id
          WHERE re.horse_id = ? AND r.date < ? AND r.status = '結果確定'
          ORDER BY r.date DESC LIMIT 1
        `, [entry.horse_id, race.date]);
        if (prevEntry.length > 0) {
          prevJockeyMap.set(entry.horse_id, prevEntry[0].jockey_id);
        }
      }

      // 出走馬をHorseEntry形式に変換
      const horseEntries: HorseEntry[] = raceEntries.map(e => ({
        horseNumber: e.horse_number,
        horseName: e.horse_name,
        horseId: e.horse_id,
        jockeyId: e.jockey_id,
        jockeyName: '', // 名前はなくてもOK
      }));

      // 過去成績マップ（このレース日付より前のもののみ）
      const filteredPastPerfs = new Map<string, PastPerf[]>();
      for (const entry of raceEntries) {
        const perfs = allPastPerfs.get(entry.horse_id) || [];
        filteredPastPerfs.set(entry.horse_id, perfs.filter(p => p.date < race.date));
      }

      // 理論評価
      const result = evaluateShosanTheory(
        race.date, race.racecourse_name, horseEntries, filteredPastPerfs, prevJockeyMap
      );

      totalRaces++;

      if (result.candidates.length > 0) {
        racesWithCandidates++;
        totalCandidates += result.candidates.length;

        // 着順マップ
        const posMap = new Map<number, number>();
        for (const e of raceEntries) {
          if (e.result_position > 0) posMap.set(e.horse_number, e.result_position);
        }

        // 候補馬の着順チェック
        for (const c of result.candidates) {
          const pos = posMap.get(c.horseNumber);
          if (pos === 1) {
            totalWins++;
            successExamples.push(`WIN ${race.date} ${race.racecourse_name}${race.race_number}R ${c.horseName}(${c.horseNumber}番) 理論${c.theory} ${c.jockeyName} ${c.matchScore}%`);
          }
          if (pos && pos <= 3) totalTop3++;
        }

        // 馬連チェック
        const top2 = [...posMap.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2).map(([n]) => n);
        for (const rec of result.umarenRecommendations) {
          umarenBets++;
          umarenInvested += 100;
          const isHit = rec.horses.length === 2 &&
            top2.length === 2 &&
            rec.horses.includes(top2[0]) && rec.horses.includes(top2[1]);
          if (isHit) {
            umarenHits++;
            // 馬連オッズは推定（実オッズが取れないため）
            // 単勝オッズの積 × 0.08 で推定
            const odds1 = raceEntries.find(e => e.horse_number === rec.horses[0]);
            const odds2 = raceEntries.find(e => e.horse_number === rec.horses[1]);
            // オッズ不明の場合は5.0倍で推定
            umarenReturned += 100 * 10; // 馬連平均配当で推定
          }
        }
      }
    }

    if ((i + BATCH) % 500 === 0 || i + BATCH >= races.length) {
      process.stdout.write(`\r  処理: ${Math.min(i + BATCH, races.length)}/${races.length}レース`);
    }
  }

  console.log('\n');
  console.log('=== 結果 ===');
  console.log(`総レース数: ${totalRaces}`);
  console.log(`候補あり: ${racesWithCandidates}レース (${(racesWithCandidates / totalRaces * 100).toFixed(1)}%)`);
  console.log(`総候補馬: ${totalCandidates}`);
  console.log(`候補馬1着: ${totalWins} / ${totalCandidates} (${totalCandidates > 0 ? (totalWins / totalCandidates * 100).toFixed(1) : 0}%)`);
  console.log(`候補馬3着以内: ${totalTop3} / ${totalCandidates} (${totalCandidates > 0 ? (totalTop3 / totalCandidates * 100).toFixed(1) : 0}%)`);
  console.log('');
  console.log('=== 馬連 ===');
  console.log(`ベット数: ${umarenBets}`);
  console.log(`的中: ${umarenHits} (${umarenBets > 0 ? (umarenHits / umarenBets * 100).toFixed(1) : 0}%)`);
  console.log('');
  console.log('=== 成功例（1着） ===');
  successExamples.slice(0, 20).forEach(e => console.log(`  ${e}`));
  if (successExamples.length > 20) console.log(`  ... 他${successExamples.length - 20}件`);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
