/**
 * しょーさん予想 ROI分析バックテスト
 *
 * オッズ（人気）込みでの収益分析:
 * 1. 候補馬のオッズ分布（人気馬 vs 人気薄の割合）
 * 2. マッチスコア閾値別の候補馬数・単勝的中率・単勝ROI・3着以内率・馬連ROI
 * 3. 万馬券（配当100倍以上）の頻度
 * 4. 理論1と理論2の別々の成績
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { evaluateShosanTheory, type HorseEntry, type PastPerf } from '../src/lib/shoshan-theory';

// .env.local 読み込み
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

// ==================== 統計カウンター ====================

interface TheoryStats {
  candidates: number;
  wins: number;
  top3: number;
  tanshoBet: number;    // 単勝投資額（候補馬1頭=100円）
  tanshoReturn: number; // 単勝回収額
  umarenBets: number;
  umarenHits: number;
  umarenInvested: number;
  umarenReturned: number;
  mankaken: number;     // 万馬券（単勝100倍以上）
  // オッズ分布
  oddsBuckets: { [key: string]: { count: number; wins: number; invested: number; returned: number } };
  // 個別結果記録
  bigWins: { date: string; venue: string; raceNum: number; horse: string; odds: number; theory: number; matchScore: number }[];
}

function newStats(): TheoryStats {
  return {
    candidates: 0, wins: 0, top3: 0,
    tanshoBet: 0, tanshoReturn: 0,
    umarenBets: 0, umarenHits: 0, umarenInvested: 0, umarenReturned: 0,
    mankaken: 0,
    oddsBuckets: {
      '1-3倍': { count: 0, wins: 0, invested: 0, returned: 0 },
      '3-5倍': { count: 0, wins: 0, invested: 0, returned: 0 },
      '5-10倍': { count: 0, wins: 0, invested: 0, returned: 0 },
      '10-20倍': { count: 0, wins: 0, invested: 0, returned: 0 },
      '20-50倍': { count: 0, wins: 0, invested: 0, returned: 0 },
      '50-100倍': { count: 0, wins: 0, invested: 0, returned: 0 },
      '100倍+': { count: 0, wins: 0, invested: 0, returned: 0 },
      '不明': { count: 0, wins: 0, invested: 0, returned: 0 },
    },
    bigWins: [],
  };
}

function getOddsBucket(odds: number | null): string {
  if (odds == null || odds <= 0) return '不明';
  if (odds < 3) return '1-3倍';
  if (odds < 5) return '3-5倍';
  if (odds < 10) return '5-10倍';
  if (odds < 20) return '10-20倍';
  if (odds < 50) return '20-50倍';
  if (odds < 100) return '50-100倍';
  return '100倍+';
}

// 閾値ごとの統計
interface ThresholdResult {
  threshold: number;
  all: TheoryStats;
  theory1: TheoryStats;
  theory2: TheoryStats;
}

async function main() {
  console.log('=== しょーさん予想 ROI分析バックテスト ===\n');

  // 結果確定レースを取得
  const races = await dbAll<{
    id: string; date: string; racecourse_name: string; race_number: number; name: string;
  }>(`SELECT id, date, racecourse_name, race_number, name FROM races
      WHERE status = '結果確定' ORDER BY date DESC`);

  console.log(`対象レース数: ${races.length}\n`);

  // 閾値リスト
  const THRESHOLDS = [0, 50, 55, 60, 65, 70, 75, 80];
  const results: Map<number, ThresholdResult> = new Map();
  for (const th of THRESHOLDS) {
    results.set(th, {
      threshold: th,
      all: newStats(),
      theory1: newStats(),
      theory2: newStats(),
    });
  }

  // 全候補馬リスト（閾値0のもの）をスコア分布分析用に保持
  const allCandidateScores: number[] = [];

  const BATCH = 50;
  for (let i = 0; i < races.length; i += BATCH) {
    const batch = races.slice(i, i + BATCH);
    const raceIds = batch.map(r => r.id);
    const ph = raceIds.map(() => '?').join(',');

    // 出走馬情報（odds含む）
    const allEntries = await dbAll<{
      race_id: string; horse_number: number; horse_name: string;
      horse_id: string; jockey_id: string; result_position: number; odds: number | null;
    }>(`SELECT race_id, horse_number, horse_name, horse_id, jockey_id, result_position, odds
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

    // 馬連オッズキャッシュ (race_id -> Map<"h1-h2" -> odds>)
    const umarenOddsCache = new Map<string, Map<string, number>>();
    const umarenRows = await dbAll<{
      race_id: string; horse_number1: number; horse_number2: number; odds: number;
    }>(`SELECT race_id, horse_number1, horse_number2, odds
        FROM odds WHERE race_id IN (${ph}) AND bet_type = 'umaren'`, raceIds);
    for (const row of umarenRows) {
      if (!umarenOddsCache.has(row.race_id)) umarenOddsCache.set(row.race_id, new Map());
      const key = [Math.min(row.horse_number1, row.horse_number2), Math.max(row.horse_number1, row.horse_number2)].join('-');
      umarenOddsCache.get(row.race_id)!.set(key, row.odds);
    }

    for (const race of batch) {
      const raceEntries = allEntries.filter(e => e.race_id === race.id);
      if (raceEntries.length < 4) continue;

      // 前走騎手マップを構築
      const prevJockeyMap = new Map<string, string>();
      for (const entry of raceEntries) {
        if (!entry.horse_id) continue;
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
        jockeyName: '',
      }));

      // 過去成績マップ（データリーケージ防止: レース日以前のもののみ）
      const filteredPastPerfs = new Map<string, PastPerf[]>();
      for (const entry of raceEntries) {
        const perfs = allPastPerfs.get(entry.horse_id) || [];
        filteredPastPerfs.set(entry.horse_id, perfs.filter(p => p.date < race.date));
      }

      // 理論評価（閾値なしで全候補を取得）
      const result = evaluateShosanTheory(
        race.date, race.racecourse_name, horseEntries, filteredPastPerfs, prevJockeyMap
      );

      if (result.candidates.length === 0) continue;

      // 着順マップ
      const posMap = new Map<number, number>();
      for (const e of raceEntries) {
        if (e.result_position > 0) posMap.set(e.horse_number, e.result_position);
      }

      // オッズマップ
      const oddsMap = new Map<number, number>();
      for (const e of raceEntries) {
        if (e.odds != null && e.odds > 0) oddsMap.set(e.horse_number, e.odds);
      }

      // 1-2着の馬番
      const top2 = [...posMap.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, 2)
        .map(([n]) => n);

      // 馬連オッズ取得
      const raceUmarenOdds = umarenOddsCache.get(race.id) || new Map<string, number>();

      // 各候補について閾値ごとに集計
      for (const c of result.candidates) {
        allCandidateScores.push(c.matchScore);
        const pos = posMap.get(c.horseNumber);
        const candOdds = oddsMap.get(c.horseNumber) || null;
        const isWin = pos === 1;
        const isTop3 = pos != null && pos <= 3;

        for (const th of THRESHOLDS) {
          if (c.matchScore < th) continue;

          const r = results.get(th)!;
          const statsAll = r.all;
          const statsTheory = c.theory === 1 ? r.theory1 : r.theory2;

          for (const stats of [statsAll, statsTheory]) {
            stats.candidates++;
            stats.tanshoBet += 100;

            // オッズ分布
            const bucket = getOddsBucket(candOdds);
            stats.oddsBuckets[bucket].count++;
            if (candOdds != null && candOdds > 0) {
              stats.oddsBuckets[bucket].invested += 100;
            }

            if (isWin) {
              stats.wins++;
              stats.oddsBuckets[bucket].wins++;
              if (candOdds != null && candOdds > 0) {
                const ret = Math.floor(candOdds * 100);
                stats.tanshoReturn += ret;
                stats.oddsBuckets[bucket].returned += ret;
                if (candOdds >= 100) {
                  stats.mankaken++;
                }
              }
              // 高配当の記録
              if (candOdds != null && candOdds >= 10) {
                stats.bigWins.push({
                  date: race.date,
                  venue: race.racecourse_name,
                  raceNum: race.race_number,
                  horse: c.horseName,
                  odds: candOdds,
                  theory: c.theory,
                  matchScore: c.matchScore,
                });
              }
            }
            if (isTop3) stats.top3++;
          }
        }
      }

      // 馬連の集計（閾値別）
      for (const th of THRESHOLDS) {
        const thCandidates = result.candidates.filter(c => c.matchScore >= th);
        if (thCandidates.length < 2) continue;

        const r = results.get(th)!;

        // 全候補からの馬連ペア
        for (let a = 0; a < thCandidates.length; a++) {
          for (let b = a + 1; b < thCandidates.length; b++) {
            const h1 = Math.min(thCandidates[a].horseNumber, thCandidates[b].horseNumber);
            const h2 = Math.max(thCandidates[a].horseNumber, thCandidates[b].horseNumber);
            const key = `${h1}-${h2}`;
            const umarenOdds = raceUmarenOdds.get(key);

            r.all.umarenBets++;
            r.all.umarenInvested += 100;

            // 理論別も
            const isBothTheory1 = thCandidates[a].theory === 1 && thCandidates[b].theory === 1;
            const isBothTheory2 = thCandidates[a].theory === 1 && thCandidates[b].theory === 2
              || thCandidates[a].theory === 2 && thCandidates[b].theory === 1;

            const isHit = top2.length === 2 &&
              ((h1 === top2[0] && h2 === top2[1]) || (h1 === top2[1] && h2 === top2[0]));

            if (isHit) {
              r.all.umarenHits++;
              if (umarenOdds != null && umarenOdds > 0) {
                r.all.umarenReturned += Math.floor(umarenOdds * 100);
              }
            }
          }
        }
      }
    }

    if ((i + BATCH) % 200 === 0 || i + BATCH >= races.length) {
      process.stdout.write(`\r  処理中: ${Math.min(i + BATCH, races.length)}/${races.length}レース`);
    }
  }

  console.log('\n');

  // ==================== 結果出力 ====================

  // 1. スコア分布
  console.log('=== マッチスコア分布 ===');
  const scoreRanges = [
    [45, 50], [50, 55], [55, 60], [60, 65], [65, 70], [70, 75], [75, 80], [80, 85], [85, 90], [90, 100]
  ];
  for (const [lo, hi] of scoreRanges) {
    const count = allCandidateScores.filter(s => s >= lo && s < hi).length;
    if (count > 0) {
      console.log(`  ${lo}-${hi}%: ${count}頭`);
    }
  }
  console.log('');

  // 2. 閾値別サマリー
  console.log('=== 閾値別サマリー（全理論） ===');
  console.log('閾値  | 候補数 | 勝率   | 単勝ROI | 3着内率 | 馬連数 | 馬連的中 | 馬連ROI | 万馬券');
  console.log('------|--------|--------|---------|---------|--------|---------|---------|-------');
  for (const th of THRESHOLDS) {
    const s = results.get(th)!.all;
    if (s.candidates === 0) continue;
    const winRate = (s.wins / s.candidates * 100).toFixed(1);
    const tanshoRoi = s.tanshoBet > 0 ? (s.tanshoReturn / s.tanshoBet * 100).toFixed(0) : '-';
    const top3Rate = (s.top3 / s.candidates * 100).toFixed(1);
    const umarenHitRate = s.umarenBets > 0 ? (s.umarenHits / s.umarenBets * 100).toFixed(1) : '-';
    const umarenRoi = s.umarenInvested > 0 ? (s.umarenReturned / s.umarenInvested * 100).toFixed(0) : '-';
    console.log(
      `${String(th).padStart(4)}% | ${String(s.candidates).padStart(6)} | ${winRate.padStart(5)}% | ${(tanshoRoi + '%').padStart(7)} | ${top3Rate.padStart(6)}% | ${String(s.umarenBets).padStart(6)} | ${(umarenHitRate + '%').padStart(7)} | ${(umarenRoi + '%').padStart(7)} | ${s.mankaken}`
    );
  }
  console.log('');

  // 3. 理論別サマリー
  for (const theoryNum of [1, 2]) {
    console.log(`=== 理論${theoryNum} 閾値別サマリー ===`);
    console.log('閾値  | 候補数 | 勝率   | 単勝ROI | 3着内率 | 万馬券');
    console.log('------|--------|--------|---------|---------|-------');
    for (const th of THRESHOLDS) {
      const s = theoryNum === 1 ? results.get(th)!.theory1 : results.get(th)!.theory2;
      if (s.candidates === 0) continue;
      const winRate = (s.wins / s.candidates * 100).toFixed(1);
      const tanshoRoi = s.tanshoBet > 0 ? (s.tanshoReturn / s.tanshoBet * 100).toFixed(0) : '-';
      const top3Rate = (s.top3 / s.candidates * 100).toFixed(1);
      console.log(
        `${String(th).padStart(4)}% | ${String(s.candidates).padStart(6)} | ${winRate.padStart(5)}% | ${(tanshoRoi + '%').padStart(7)} | ${top3Rate.padStart(6)}% | ${s.mankaken}`
      );
    }
    console.log('');
  }

  // 4. オッズ分布（閾値0 = 全候補）
  console.log('=== オッズ分布（全候補） ===');
  const allStats = results.get(0)!.all;
  console.log('オッズ帯   | 候補数 | 割合   | 勝率   | 単勝ROI | 期待勝率*');
  console.log('-----------|--------|--------|--------|---------|----------');
  console.log('  * 期待勝率 = 単勝ROI 100%に必要な勝率（帯の中央値ベース）');
  const medianOddsMap: Record<string, number> = {
    '1-3倍': 2, '3-5倍': 4, '5-10倍': 7.5, '10-20倍': 15, '20-50倍': 35, '50-100倍': 75, '100倍+': 150, '不明': 0,
  };
  for (const [bucket, data] of Object.entries(allStats.oddsBuckets)) {
    if (data.count === 0) continue;
    const pct = (data.count / allStats.candidates * 100).toFixed(1);
    const winRate = (data.wins / data.count * 100).toFixed(1);
    const roi = data.invested > 0 ? (data.returned / data.invested * 100).toFixed(0) : '-';
    const medOdds = medianOddsMap[bucket] || 0;
    const expectedWinRate = medOdds > 0 ? (1 / medOdds * 100).toFixed(1) : '-';
    console.log(
      `${bucket.padEnd(10)} | ${String(data.count).padStart(6)} | ${pct.padStart(5)}% | ${winRate.padStart(5)}% | ${(roi + '%').padStart(7)} | ${(expectedWinRate + '%').padStart(9)}`
    );
  }
  console.log('');

  // 5. 閾値65%のオッズ帯別詳細
  const th65 = results.get(65);
  if (th65) {
    console.log('=== オッズ分布（閾値65%） ===');
    console.log('オッズ帯   | 候補数 | 割合   | 勝率   | 単勝ROI');
    console.log('-----------|--------|--------|--------|--------');
    for (const [bucket, data] of Object.entries(th65.all.oddsBuckets)) {
      if (data.count === 0) continue;
      const pct = (data.count / th65.all.candidates * 100).toFixed(1);
      const winRate = (data.wins / data.count * 100).toFixed(1);
      const roi = data.invested > 0 ? (data.returned / data.invested * 100).toFixed(0) : '-';
      console.log(
        `${bucket.padEnd(10)} | ${String(data.count).padStart(6)} | ${pct.padStart(5)}% | ${winRate.padStart(5)}% | ${(roi + '%').padStart(7)}`
      );
    }
    console.log('');

    // 理論1の閾値65%
    console.log('=== オッズ分布（閾値65% 理論1のみ） ===');
    console.log('オッズ帯   | 候補数 | 勝率   | 単勝ROI');
    console.log('-----------|--------|--------|--------');
    for (const [bucket, data] of Object.entries(th65.theory1.oddsBuckets)) {
      if (data.count === 0) continue;
      const winRate = (data.wins / data.count * 100).toFixed(1);
      const roi = data.invested > 0 ? (data.returned / data.invested * 100).toFixed(0) : '-';
      console.log(
        `${bucket.padEnd(10)} | ${String(data.count).padStart(6)} | ${winRate.padStart(5)}% | ${(roi + '%').padStart(7)}`
      );
    }
    console.log('');

    // 理論2の閾値65%
    console.log('=== オッズ分布（閾値65% 理論2のみ） ===');
    console.log('オッズ帯   | 候補数 | 勝率   | 単勝ROI');
    console.log('-----------|--------|--------|--------');
    for (const [bucket, data] of Object.entries(th65.theory2.oddsBuckets)) {
      if (data.count === 0) continue;
      const winRate = (data.wins / data.count * 100).toFixed(1);
      const roi = data.invested > 0 ? (data.returned / data.invested * 100).toFixed(0) : '-';
      console.log(
        `${bucket.padEnd(10)} | ${String(data.count).padStart(6)} | ${winRate.padStart(5)}% | ${(roi + '%').padStart(7)}`
      );
    }
    console.log('');
  }

  // 閾値75%のオッズ帯別詳細（ROI 123%の詳細）
  const th75 = results.get(75);
  if (th75) {
    console.log('=== オッズ分布（閾値75%） ===');
    console.log('オッズ帯   | 候補数 | 勝率   | 単勝ROI');
    console.log('-----------|--------|--------|--------');
    for (const [bucket, data] of Object.entries(th75.all.oddsBuckets)) {
      if (data.count === 0) continue;
      const winRate = (data.wins / data.count * 100).toFixed(1);
      const roi = data.invested > 0 ? (data.returned / data.invested * 100).toFixed(0) : '-';
      console.log(
        `${bucket.padEnd(10)} | ${String(data.count).padStart(6)} | ${winRate.padStart(5)}% | ${(roi + '%').padStart(7)}`
      );
    }
    console.log('');
  }

  // 6. 高配当的中リスト（閾値0）
  console.log('=== 高配当的中 TOP20（単勝10倍以上） ===');
  const bigWins = allStats.bigWins.sort((a, b) => b.odds - a.odds).slice(0, 20);
  for (const w of bigWins) {
    console.log(`  ${w.date} ${w.venue}${w.raceNum}R ${w.horse} 単勝${w.odds.toFixed(1)}倍 理論${w.theory} スコア${w.matchScore}%`);
  }
  console.log('');

  // 7. サマリー
  console.log('=== 分析サマリー ===');
  const s0 = results.get(0)!.all;
  const s65 = results.get(65)!.all;
  const s75 = results.get(75)!.all;
  console.log(`全候補: ${s0.candidates}頭, 勝率${(s0.wins/s0.candidates*100).toFixed(1)}%, 単勝ROI ${(s0.tanshoReturn/s0.tanshoBet*100).toFixed(0)}%`);
  console.log(`閾値65%: ${s65.candidates}頭, 勝率${(s65.wins/s65.candidates*100).toFixed(1)}%, 単勝ROI ${(s65.tanshoReturn/s65.tanshoBet*100).toFixed(0)}%`);
  console.log(`閾値75%: ${s75.candidates}頭, 勝率${(s75.wins/s75.candidates*100).toFixed(1)}%, 単勝ROI ${(s75.tanshoReturn/s75.tanshoBet*100).toFixed(0)}%`);
  console.log(`人気薄(10倍+)の割合: ${((s0.oddsBuckets['10-20倍'].count + s0.oddsBuckets['20-50倍'].count + s0.oddsBuckets['50-100倍'].count + s0.oddsBuckets['100倍+'].count) / s0.candidates * 100).toFixed(1)}%`);
  console.log(`万馬券的中: ${s0.mankaken}回`);
  console.log('');
  console.log('=== 完了 ===');
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
