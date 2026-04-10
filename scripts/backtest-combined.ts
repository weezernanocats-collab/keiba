/**
 * 掛け合わせバックテスト
 *
 * - しょーさん理論
 * - AI独自推奨 (aiOnlyRanking, 市場オッズ除外)
 * - AI予想Top (picks_json, 市場オッズ込み)
 * - 市場オッズ
 *
 * の組み合わせで成績を分析
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

interface RaceData {
  race_id: string;
  date: string;
  racecourse_name: string;
  picks_json: string;
  analysis_json: string;
}

interface BetStat {
  bets: number;
  wins: number;
  invested: number;
  returned: number;
}

function newStat(): BetStat {
  return { bets: 0, wins: 0, invested: 0, returned: 0 };
}

function recordBet(stat: BetStat, isHit: boolean, odds: number) {
  stat.bets++;
  stat.invested += 100;
  if (isHit) {
    stat.wins++;
    stat.returned += 100 * odds;
  }
}

function format(stat: BetStat, label: string): string {
  if (stat.bets === 0) return `${label}: -`;
  const winRate = (stat.wins / stat.bets * 100).toFixed(1);
  const roi = (stat.returned / stat.invested * 100).toFixed(1);
  const profit = Math.round(stat.returned - stat.invested);
  return `${label}: ${stat.wins}/${stat.bets} (${winRate}%) ROI:${roi}% 収支:${profit >= 0 ? '+' : ''}${profit}`;
}

async function main() {
  console.log('=== 掛け合わせバックテスト ===\n');

  // 結果確定レース取得
  const races = await dbAll<RaceData>(`
    SELECT p.race_id, r.date, r.racecourse_name, p.picks_json, p.analysis_json
    FROM predictions p JOIN races r ON p.race_id = r.id
    WHERE r.status = '結果確定'
    ORDER BY r.date DESC
  `);
  console.log(`対象レース: ${races.length}件\n`);

  // 集計バケット
  const stats = {
    // ベースライン
    aiTop1: newStat(),                  // AI(市場込み) Top1
    aiOnlyTop1: newStat(),              // AI独自 Top1
    shosanAll: newStat(),               // しょーさん理論該当馬
    shosan65: newStat(),                // しょーさん65%以上
    shosan75: newStat(),                // しょーさん75%以上

    // しょーさん理論 ∩ AI(市場込み)
    shosan_aiTop1: newStat(),           // 両方Top1
    shosan_aiTop3: newStat(),           // しょーさん∩AI Top3
    shosan_NOT_aiTop3: newStat(),       // しょーさんあり、AI Top3に入ってない

    // しょーさん理論 ∩ AI独自
    shosan_aiOnlyTop3: newStat(),       // しょーさん∩AI独自Top3
    shosan_aiOnlyOut: newStat(),        // しょーさんあり、AI独自Top3に入ってない

    // 市場オッズ別（しょーさん理論該当馬）
    shosanOdds_1_5: newStat(),
    shosanOdds_5_15: newStat(),
    shosanOdds_15_50: newStat(),
    shosanOdds_50plus: newStat(),

    // 高期待値: しょーさん∩AI Top3 ∩ オッズ5倍以上
    sweetSpot: newStat(),
  };

  // 着順マップを取得
  const raceIds = races.map(r => r.race_id);
  const entryMap = new Map<string, Map<number, { position: number; odds: number; horseId: string }>>();
  const allEntriesMap = new Map<string, { horse_number: number; horse_id: string; jockey_id: string; horse_name: string }[]>();

  const BATCH = 200;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const batch = raceIds.slice(i, i + BATCH);
    const ph = batch.map(() => '?').join(',');
    const entries = await dbAll<{
      race_id: string; horse_number: number; horse_id: string;
      jockey_id: string; horse_name: string; result_position: number; odds: number | null;
    }>(`SELECT race_id, horse_number, horse_id, jockey_id, horse_name, result_position, odds
        FROM race_entries WHERE race_id IN (${ph})`, batch);
    for (const e of entries) {
      if (!entryMap.has(e.race_id)) entryMap.set(e.race_id, new Map());
      if (e.result_position != null && e.result_position > 0) {
        entryMap.get(e.race_id)!.set(e.horse_number, {
          position: e.result_position, odds: e.odds ?? 0, horseId: e.horse_id,
        });
      }
      if (!allEntriesMap.has(e.race_id)) allEntriesMap.set(e.race_id, []);
      allEntriesMap.get(e.race_id)!.push({
        horse_number: e.horse_number, horse_id: e.horse_id,
        jockey_id: e.jockey_id, horse_name: e.horse_name,
      });
    }
  }
  console.log('着順データ取得完了\n');

  // 全horse_idの過去成績を一括取得
  const allHorseIds = new Set<string>();
  for (const [, entries] of allEntriesMap) {
    for (const e of entries) if (e.horse_id) allHorseIds.add(e.horse_id);
  }
  const horseIdsArr = [...allHorseIds];
  const ppMap = new Map<string, PastPerf[]>();
  for (let i = 0; i < horseIdsArr.length; i += 300) {
    const batch = horseIdsArr.slice(i, i + 300);
    const ph = batch.map(() => '?').join(',');
    const perfs = await dbAll<{
      horse_id: string; date: string; position: number; corner_positions: string; entries: number;
    }>(`SELECT horse_id, date, position, corner_positions, entries
        FROM past_performances WHERE horse_id IN (${ph}) ORDER BY date DESC`, batch);
    for (const p of perfs) {
      if (!ppMap.has(p.horse_id)) ppMap.set(p.horse_id, []);
      ppMap.get(p.horse_id)!.push({
        date: p.date, position: p.position, cornerPositions: p.corner_positions || '', entries: p.entries,
      });
    }
  }
  console.log('過去成績取得完了\n');

  // 全prev_jockey一括取得（race_entries）
  const prevJockeyMap = new Map<string, Map<string, string>>(); // race_id -> (horse_id -> prev_jockey_id)
  for (const race of races) {
    prevJockeyMap.set(race.race_id, new Map());
  }

  let processed = 0;
  for (const race of races) {
    processed++;
    if (processed % 500 === 0) process.stdout.write(`\r処理: ${processed}/${races.length}`);

    const posMap = entryMap.get(race.race_id);
    if (!posMap || posMap.size < 4) continue;

    const allEntries = allEntriesMap.get(race.race_id) || [];
    const horseEntries: HorseEntry[] = allEntries.map(e => ({
      horseNumber: e.horse_number, horseName: e.horse_name,
      horseId: e.horse_id, jockeyId: e.jockey_id || '', jockeyName: '',
    }));

    // 過去成績マップ
    const filteredPP = new Map<string, PastPerf[]>();
    for (const e of allEntries) {
      const perfs = ppMap.get(e.horse_id) || [];
      filteredPP.set(e.horse_id, perfs.filter(p => p.date < race.date));
    }

    // 前走騎手マップ（DBクエリで取得 - バッチ化したいが時間優先で逐次）
    const pj = new Map<string, string>();
    for (const e of allEntries) {
      const perfs = filteredPP.get(e.horse_id);
      if (!perfs || perfs.length === 0) continue;
      // race_entriesから前走の騎手を取得
      const prev = await dbAll<{ jockey_id: string }>(
        `SELECT re.jockey_id FROM race_entries re JOIN races r ON re.race_id = r.id
         WHERE re.horse_id = ? AND r.date < ? ORDER BY r.date DESC LIMIT 1`,
        [e.horse_id, race.date]
      );
      if (prev.length > 0) pj.set(e.horse_id, prev[0].jockey_id);
    }

    // しょーさん理論評価
    const shosanResult = evaluateShosanTheory(
      race.date, race.racecourse_name, horseEntries, filteredPP, pj
    );

    // AI予想Top picks
    let picks: { horseNumber: number; rank: number }[] = [];
    try {
      picks = JSON.parse(race.picks_json || '[]');
    } catch {}
    const aiTop1 = picks[0];
    const aiTop3Set = new Set(picks.slice(0, 3).map(p => p.horseNumber));

    // AI独自推奨
    let aiOnlyTop3: number[] = [];
    let aiOnlyTop1: number | null = null;
    try {
      const a = JSON.parse(race.analysis_json || '{}');
      const entries = a.aiOnlyRanking?.entries;
      if (entries) {
        aiOnlyTop1 = entries[0]?.horseNumber;
        aiOnlyTop3 = entries.slice(0, 3).map((e: { horseNumber: number }) => e.horseNumber);
      }
    } catch {}
    const aiOnlyTop3Set = new Set(aiOnlyTop3);

    // ==================== ベースライン集計 ====================
    if (aiTop1) {
      const e = posMap.get(aiTop1.horseNumber);
      if (e) recordBet(stats.aiTop1, e.position === 1, e.odds);
    }
    if (aiOnlyTop1) {
      const e = posMap.get(aiOnlyTop1);
      if (e) recordBet(stats.aiOnlyTop1, e.position === 1, e.odds);
    }

    // ==================== しょーさん理論集計 ====================
    for (const c of shosanResult.candidates) {
      const e = posMap.get(c.horseNumber);
      if (!e) continue;

      const isWin = e.position === 1;
      const odds = e.odds;

      // 全候補
      recordBet(stats.shosanAll, isWin, odds);
      if (c.matchScore >= 65) recordBet(stats.shosan65, isWin, odds);
      if (c.matchScore >= 75) recordBet(stats.shosan75, isWin, odds);

      // しょーさん × AI(市場込み)
      if (aiTop1?.horseNumber === c.horseNumber) recordBet(stats.shosan_aiTop1, isWin, odds);
      if (aiTop3Set.has(c.horseNumber)) {
        recordBet(stats.shosan_aiTop3, isWin, odds);
      } else {
        recordBet(stats.shosan_NOT_aiTop3, isWin, odds);
      }

      // しょーさん × AI独自
      if (aiOnlyTop3.length > 0) {
        if (aiOnlyTop3Set.has(c.horseNumber)) recordBet(stats.shosan_aiOnlyTop3, isWin, odds);
        else recordBet(stats.shosan_aiOnlyOut, isWin, odds);
      }

      // オッズ別
      if (odds > 0 && odds < 5) recordBet(stats.shosanOdds_1_5, isWin, odds);
      else if (odds >= 5 && odds < 15) recordBet(stats.shosanOdds_5_15, isWin, odds);
      else if (odds >= 15 && odds < 50) recordBet(stats.shosanOdds_15_50, isWin, odds);
      else if (odds >= 50) recordBet(stats.shosanOdds_50plus, isWin, odds);

      // スイートスポット: しょーさん65%+ × AI Top3 × 5倍以上
      if (c.matchScore >= 65 && aiTop3Set.has(c.horseNumber) && odds >= 5) {
        recordBet(stats.sweetSpot, isWin, odds);
      }
    }
  }

  console.log('\n\n=== 結果 ===\n');

  console.log('--- ベースライン ---');
  console.log('  ' + format(stats.aiTop1, 'AI予想Top1(市場込み)'));
  console.log('  ' + format(stats.aiOnlyTop1, 'AI独自Top1'));
  console.log('  ' + format(stats.shosanAll, 'しょーさん全候補'));
  console.log('  ' + format(stats.shosan65, 'しょーさん65%以上'));
  console.log('  ' + format(stats.shosan75, 'しょーさん75%以上'));
  console.log('');

  console.log('--- しょーさん × AI予想(市場込み) ---');
  console.log('  ' + format(stats.shosan_aiTop1, 'しょーさん∩AI Top1'));
  console.log('  ' + format(stats.shosan_aiTop3, 'しょーさん∩AI Top3'));
  console.log('  ' + format(stats.shosan_NOT_aiTop3, 'しょーさん×AI Top3外'));
  console.log('');

  console.log('--- しょーさん × AI独自 ---');
  console.log('  ' + format(stats.shosan_aiOnlyTop3, 'しょーさん∩AI独自Top3'));
  console.log('  ' + format(stats.shosan_aiOnlyOut, 'しょーさん×AI独自圏外'));
  console.log('');

  console.log('--- しょーさん × オッズ帯 ---');
  console.log('  ' + format(stats.shosanOdds_1_5, 'オッズ1-5倍'));
  console.log('  ' + format(stats.shosanOdds_5_15, 'オッズ5-15倍'));
  console.log('  ' + format(stats.shosanOdds_15_50, 'オッズ15-50倍'));
  console.log('  ' + format(stats.shosanOdds_50plus, 'オッズ50倍+'));
  console.log('');

  console.log('--- スイートスポット ---');
  console.log('  ' + format(stats.sweetSpot, 'しょーさん65%+ ∩ AI Top3 ∩ 5倍+'));
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
