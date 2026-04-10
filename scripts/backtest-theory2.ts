/**
 * 理論2（前走好走+アゲ騎手）だけに絞った詳細バックテスト
 *
 * 分析項目:
 * - オッズ帯別の勝率・ROI
 * - ジョッキーゾーン別
 * - 前走騎手タイプ別（AGE騎手 / ルメール・川田）
 * - 継続騎乗 vs 乗り替わり
 * - 前走着順別
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

interface BetStat {
  total: number; wins: number; place3: number; inv: number; ret: number;
}
const newStat = (): BetStat => ({ total: 0, wins: 0, place3: 0, inv: 0, ret: 0 });
const record = (s: BetStat, isWin: boolean, isPlace3: boolean, odds: number) => {
  s.total++; s.inv += 100;
  if (isWin) { s.wins++; s.ret += 100 * odds; }
  if (isPlace3) s.place3++;
};
const fmt = (s: BetStat, label: string): string => {
  if (s.total === 0) return `${label.padEnd(20)} | -`;
  const wr = (s.wins / s.total * 100).toFixed(1);
  const p3r = (s.place3 / s.total * 100).toFixed(1);
  const roi = (s.ret / s.inv * 100).toFixed(0);
  const profit = Math.round(s.ret - s.inv);
  return `${label.padEnd(20)} | n=${String(s.total).padStart(4)} | 勝率${wr.padStart(5)}% | 3着内${p3r.padStart(5)}% | ROI${roi.padStart(4)}% | 収支${profit >= 0 ? '+' : ''}${profit}`;
};

async function main() {
  console.log('=== 理論2 詳細バックテスト ===\n');

  const races = await dbAll<{
    id: string; date: string; racecourse_name: string; status: string;
  }>(`SELECT id, date, racecourse_name, status FROM races WHERE status = '結果確定' ORDER BY date DESC`);
  console.log(`対象レース: ${races.length}件\n`);

  // 集計
  const stats = {
    overall: newStat(),
    // オッズ帯別
    odds_1_3: newStat(),
    odds_3_5: newStat(),
    odds_5_10: newStat(),
    odds_10_20: newStat(),
    odds_20plus: newStat(),
    // 今走ゾーン別
    zone1: newStat(),  // 武豊、松山、横山武、坂井
    zone2: newStat(),  // 岩田望、鮫島駿、荻野極
    zone3: newStat(),
    zone4: newStat(),
    // 前走騎手タイプ別
    prevAge: newStat(),      // 前走もアゲ騎手
    prevTopJock: newStat(),  // 前走がルメール・川田等の一流
    // 乗替vs継続
    jockeyChange: newStat(),
    jockeyStay: newStat(),
    // 前走着順別
    prev1st: newStat(),
    prev2nd: newStat(),
    prev3rd: newStat(),
    // スコア別
    score45_54: newStat(),
    score55_64: newStat(),
    score65_74: newStat(),
    score75plus: newStat(),
    // 組み合わせ: オッズ3-5 × Zone2
    sweet_3_5_z2: newStat(),
  };

  const BATCH = 50;
  for (let i = 0; i < races.length; i += BATCH) {
    if (i % 500 === 0) process.stdout.write(`\r処理: ${i}/${races.length}`);
    const batch = races.slice(i, i + BATCH);
    const raceIds = batch.map(r => r.id);
    const ph = raceIds.map(() => '?').join(',');

    const allEntries = await dbAll<{
      race_id: string; horse_number: number; horse_name: string;
      horse_id: string; jockey_id: string; result_position: number; odds: number | null;
    }>(`SELECT race_id, horse_number, horse_name, horse_id, jockey_id, result_position, odds
        FROM race_entries WHERE race_id IN (${ph})`, raceIds);

    const horseIds = [...new Set(allEntries.map(e => e.horse_id).filter(Boolean))];
    const ppMap = new Map<string, PastPerf[]>();
    if (horseIds.length > 0) {
      const hph = horseIds.map(() => '?').join(',');
      const perfs = await dbAll<{
        horse_id: string; date: string; position: number; corner_positions: string;
        entries: number; racecourse_name: string;
      }>(`SELECT horse_id, date, position, corner_positions, entries, racecourse_name
          FROM past_performances WHERE horse_id IN (${hph}) ORDER BY date DESC`, horseIds);
      for (const p of perfs) {
        if (!ppMap.has(p.horse_id)) ppMap.set(p.horse_id, []);
        ppMap.get(p.horse_id)!.push({
          date: p.date, position: p.position, cornerPositions: p.corner_positions || '',
          entries: p.entries, racecourseName: p.racecourse_name || '',
        });
      }
    }

    // race_entriesから前走騎手を一括取得
    const prevJockeyMap = new Map<string, Map<string, string>>(); // race_id -> horse_id -> prev_jockey_id
    for (const race of batch) prevJockeyMap.set(race.id, new Map());

    // バッチで前走騎手取得
    for (const race of batch) {
      const raceEntries = allEntries.filter(e => e.race_id === race.id);
      if (raceEntries.length < 4) continue;
      const hIds = raceEntries.map(e => e.horse_id).filter(Boolean);
      if (hIds.length === 0) continue;
      const hph2 = hIds.map(() => '?').join(',');
      const prev = await dbAll<{ horse_id: string; jockey_id: string }>(
        `SELECT re.horse_id, re.jockey_id FROM race_entries re
         JOIN races r ON re.race_id = r.id
         WHERE re.horse_id IN (${hph2}) AND r.date < ?
           AND (re.horse_id, r.date) IN (
             SELECT re2.horse_id, MAX(r2.date)
             FROM race_entries re2 JOIN races r2 ON re2.race_id = r2.id
             WHERE re2.horse_id IN (${hph2}) AND r2.date < ?
             GROUP BY re2.horse_id
           )`,
        [...hIds, race.date, ...hIds, race.date]
      );
      const pjMap = prevJockeyMap.get(race.id)!;
      for (const p of prev) if (p.jockey_id) pjMap.set(p.horse_id, p.jockey_id);
    }

    // 各レースで理論2候補を評価
    for (const race of batch) {
      const raceEntries = allEntries.filter(e => e.race_id === race.id);
      if (raceEntries.length < 4) continue;

      const horseEntries: HorseEntry[] = raceEntries.map(e => ({
        horseNumber: e.horse_number, horseName: e.horse_name,
        horseId: e.horse_id, jockeyId: e.jockey_id || '', jockeyName: '',
      }));

      const filteredPP = new Map<string, PastPerf[]>();
      for (const e of raceEntries) {
        const perfs = ppMap.get(e.horse_id) || [];
        filteredPP.set(e.horse_id, perfs.filter(p => p.date < race.date));
      }

      const pj = prevJockeyMap.get(race.id) || new Map();
      const result = evaluateShosanTheory(race.date, race.racecourse_name, horseEntries, filteredPP, pj);

      // 理論2のみ抽出
      const t2 = result.candidates.filter(c => c.theory === 2);
      if (t2.length === 0) continue;

      // posMap
      const posMap = new Map<number, { pos: number; odds: number }>();
      for (const e of raceEntries) {
        if (e.result_position != null && e.result_position > 0) {
          posMap.set(e.horse_number, { pos: e.result_position, odds: e.odds || 0 });
        }
      }

      const AGE_IDS = ['00666','01126','01170','01163','01174','01157','01160','01075','01144','01200','01150','01115','01122','01178','01220','01091','01197','01127'];
      const TOP_JOCK = ['00660','00733']; // ルメール、川田

      for (const c of t2) {
        const entry = posMap.get(c.horseNumber);
        if (!entry) continue;
        const odds = entry.odds;
        const isWin = entry.pos === 1;
        const isP3 = entry.pos <= 3;

        record(stats.overall, isWin, isP3, odds);

        // オッズ帯
        if (odds > 0 && odds < 3) record(stats.odds_1_3, isWin, isP3, odds);
        else if (odds >= 3 && odds < 5) record(stats.odds_3_5, isWin, isP3, odds);
        else if (odds >= 5 && odds < 10) record(stats.odds_5_10, isWin, isP3, odds);
        else if (odds >= 10 && odds < 20) record(stats.odds_10_20, isWin, isP3, odds);
        else if (odds >= 20) record(stats.odds_20plus, isWin, isP3, odds);

        // 今走ゾーン
        if (c.jockeyZone === 1) record(stats.zone1, isWin, isP3, odds);
        else if (c.jockeyZone === 2) record(stats.zone2, isWin, isP3, odds);
        else if (c.jockeyZone === 3) record(stats.zone3, isWin, isP3, odds);
        else if (c.jockeyZone === 4) record(stats.zone4, isWin, isP3, odds);

        // 前走騎手
        const horseId = raceEntries.find(e => e.horse_number === c.horseNumber)?.horse_id;
        const prevJid = horseId ? pj.get(horseId) : undefined;
        if (prevJid) {
          if (AGE_IDS.includes(prevJid)) record(stats.prevAge, isWin, isP3, odds);
          if (TOP_JOCK.includes(prevJid)) record(stats.prevTopJock, isWin, isP3, odds);
          // 継続vs乗替
          const currJid = raceEntries.find(e => e.horse_number === c.horseNumber)?.jockey_id;
          if (currJid === prevJid) record(stats.jockeyStay, isWin, isP3, odds);
          else record(stats.jockeyChange, isWin, isP3, odds);
        }

        // 前走着順
        const perfs = filteredPP.get(horseId || '') || [];
        if (perfs[0]) {
          if (perfs[0].position === 1) record(stats.prev1st, isWin, isP3, odds);
          else if (perfs[0].position === 2) record(stats.prev2nd, isWin, isP3, odds);
          else if (perfs[0].position === 3) record(stats.prev3rd, isWin, isP3, odds);
        }

        // スコア別
        if (c.matchScore >= 75) record(stats.score75plus, isWin, isP3, odds);
        else if (c.matchScore >= 65) record(stats.score65_74, isWin, isP3, odds);
        else if (c.matchScore >= 55) record(stats.score55_64, isWin, isP3, odds);
        else record(stats.score45_54, isWin, isP3, odds);

        // スイートスポット
        if (odds >= 3 && odds < 5 && c.jockeyZone === 2) {
          record(stats.sweet_3_5_z2, isWin, isP3, odds);
        }
      }
    }
  }

  console.log('\n\n=== 結果 ===\n');
  console.log(fmt(stats.overall, '理論2 全体'));
  console.log('');
  console.log('--- オッズ帯別 ---');
  console.log(fmt(stats.odds_1_3, 'オッズ 1-3倍'));
  console.log(fmt(stats.odds_3_5, 'オッズ 3-5倍'));
  console.log(fmt(stats.odds_5_10, 'オッズ 5-10倍'));
  console.log(fmt(stats.odds_10_20, 'オッズ 10-20倍'));
  console.log(fmt(stats.odds_20plus, 'オッズ 20倍+'));
  console.log('');
  console.log('--- 今走ゾーン別 ---');
  console.log(fmt(stats.zone1, 'Zone 1 (武豊等)'));
  console.log(fmt(stats.zone2, 'Zone 2 (岩田望等)'));
  console.log(fmt(stats.zone3, 'Zone 3'));
  console.log(fmt(stats.zone4, 'Zone 4'));
  console.log('');
  console.log('--- 前走騎手 ---');
  console.log(fmt(stats.prevAge, '前走もAGE騎手'));
  console.log(fmt(stats.prevTopJock, '前走ルメ川田'));
  console.log('');
  console.log('--- 騎乗パターン ---');
  console.log(fmt(stats.jockeyChange, '乗り替わり'));
  console.log(fmt(stats.jockeyStay, '継続騎乗'));
  console.log('');
  console.log('--- 前走着順 ---');
  console.log(fmt(stats.prev1st, '前走1着'));
  console.log(fmt(stats.prev2nd, '前走2着'));
  console.log(fmt(stats.prev3rd, '前走3着'));
  console.log('');
  console.log('--- スコア別 ---');
  console.log(fmt(stats.score45_54, 'スコア 45-54'));
  console.log(fmt(stats.score55_64, 'スコア 55-64'));
  console.log(fmt(stats.score65_74, 'スコア 65-74'));
  console.log(fmt(stats.score75plus, 'スコア 75+'));
  console.log('');
  console.log('--- スイートスポット候補 ---');
  console.log(fmt(stats.sweet_3_5_z2, 'オッズ3-5×Z2'));
}

main().catch(e => { console.error(e); process.exit(1); });
