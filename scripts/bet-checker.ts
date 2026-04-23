/**
 * 馬券セット条件判定スクリプト
 *
 * odds-watcher.sh から発走前に呼ばれ:
 *   1. bet_targets テーブルから active な買い目を取得
 *   2. 該当レースの現在オッズを取得
 *   3. 合成オッズを計算し条件判定
 *   4. 条件クリアなら配分計算→通知→ステータス更新
 *
 * 使い方:
 *   npx tsx scripts/bet-checker.ts --date 2026-04-26
 *   npx tsx scripts/bet-checker.ts --date 2026-04-26 --race-label 中山11R
 */
import { readFileSync, existsSync } from 'fs';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('ERROR: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
  process.exit(1);
}

import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const BASE_URL = 'https://race.netkeiba.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// netkeiba API type番号
const BET_TYPE_API: Record<string, number> = {
  '単勝': 1, '複勝': 1, '馬連': 4, 'ワイド': 5, '馬単': 6, '三連複': 7, '三連単': 8,
};

interface OddsEntry { key: string; odds: number; minOdds?: number; maxOdds?: number }

async function fetchOddsFromApi(raceId: string, apiType: number): Promise<Map<string, OddsEntry>> {
  const apiUrl = `${BASE_URL}/api/api_get_jra_odds.html?race_id=${raceId}&type=${apiType}&action=init&compress=0`;
  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return new Map();

  const text = await response.text();
  let data: { data?: { odds?: Record<string, Record<string, [string, string, string]>> } };
  try { data = JSON.parse(text); } catch { return new Map(); }

  const result = new Map<string, OddsEntry>();
  const oddsData = data.data?.odds;
  if (!oddsData) return result;

  // type=1: odds['1']=単勝, odds['2']=複勝
  // type=4: odds['4']=馬連  key="XXYY" (XX<YY)
  // type=5: odds['5']=ワイド key="XXYY" values=[minOdds, maxOdds, popularity]
  // type=6: odds['6']=馬単  key="XXYY" (XX=1着, YY=2着, 順序あり)
  // type=7: odds['7']=三連複 key="XXYYZZ" (XX<YY<ZZ)
  // type=8: odds['8']=三連単 key="XXYYZZ" (順序あり)
  for (const [typeKey, entries] of Object.entries(oddsData)) {
    for (const [key, values] of Object.entries(entries)) {
      const oddsVal = parseFloat(values[0].replace(/,/g, ''));
      if (oddsVal > 0) {
        const entry: OddsEntry = { key, odds: oddsVal };
        if (typeKey === '5') {
          entry.minOdds = oddsVal;
          entry.maxOdds = parseFloat(values[1].replace(/,/g, ''));
        }
        result.set(key, entry);
      }
    }
  }
  return result;
}

function padHorseNum(n: number): string {
  return n.toString().padStart(2, '0');
}

function parseCombination(label: string): number[] {
  return label.split('-').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
}

interface BetTarget {
  id: number;
  user_id: string;
  date: string;
  race_id: string | null;
  race_label: string;
  bet_type: string;
  combinations: string;
  budget: number;
  min_synthetic_odds: number;
  auto_distribute: number;
}

async function checkAndNotify(target: BetTarget): Promise<boolean> {
  const combinations: string[] = JSON.parse(target.combinations);
  const raceId = target.race_id;

  if (!raceId) {
    console.log(`  [${target.race_label}] race_id なし、スキップ`);
    return false;
  }

  // API type を決定
  const apiType = BET_TYPE_API[target.bet_type];
  if (!apiType) {
    console.log(`  [${target.race_label}] ${target.bet_type} は自動オッズ取得未対応`);
    return false;
  }

  // オッズ取得
  const oddsMap = await fetchOddsFromApi(raceId, apiType);
  if (oddsMap.size === 0) {
    console.log(`  [${target.race_label}] オッズ取得失敗`);
    return false;
  }

  // 組み合わせごとのオッズを取得
  const betCombinations: { label: string; odds: number }[] = [];

  for (const combo of combinations) {
    const nums = parseCombination(combo);
    let lookupKey: string | null = null;

    if (['単勝', '複勝'].includes(target.bet_type) && nums.length === 1) {
      lookupKey = padHorseNum(nums[0]);
    } else if (['馬連', 'ワイド'].includes(target.bet_type) && nums.length === 2) {
      // 馬連/ワイド: key = "XXYY" (XX < YY、順不同)
      const sorted = [nums[0], nums[1]].sort((a, b) => a - b);
      lookupKey = padHorseNum(sorted[0]) + padHorseNum(sorted[1]);
    } else if (target.bet_type === '馬単' && nums.length === 2) {
      // 馬単: key = "XXYY" (XX=1着, YY=2着、順序あり)
      lookupKey = padHorseNum(nums[0]) + padHorseNum(nums[1]);
    } else if (target.bet_type === '三連複' && nums.length === 3) {
      // 三連複: key = "XXYYZZ" (XX < YY < ZZ)
      const sorted = [...nums].sort((a, b) => a - b);
      lookupKey = sorted.map(padHorseNum).join('');
    } else if (target.bet_type === '三連単' && nums.length === 3) {
      // 三連単: key = "XXYYZZ" (順序あり)
      lookupKey = nums.map(padHorseNum).join('');
    }

    if (lookupKey) {
      const entry = oddsMap.get(lookupKey);
      if (entry) {
        // ワイドは最低オッズ(minOdds)を使用（保守的に計算）
        const odds = target.bet_type === 'ワイド' && entry.minOdds ? entry.minOdds : entry.odds;
        betCombinations.push({ label: combo, odds });
      }
    }
  }

  if (betCombinations.length === 0) {
    console.log(`  [${target.race_label}] 有効な組み合わせなし`);
    return false;
  }

  // 合成オッズ計算
  const sumInverseOdds = betCombinations.reduce((sum, c) => sum + 1 / c.odds, 0);
  const syntheticOdds = Math.round((1 / sumInverseOdds) * 100) / 100;
  const conditionMet = syntheticOdds >= target.min_synthetic_odds;

  // 配分計算
  const allocations = betCombinations.map(c => {
    let amount: number;
    if (target.auto_distribute) {
      // 均等払い戻し
      const rawAmount = target.budget * (1 / c.odds) / sumInverseOdds;
      amount = Math.max(100, Math.ceil(rawAmount / 100) * 100);
    } else {
      // 均等金額
      amount = Math.max(100, Math.floor(target.budget / betCombinations.length / 100) * 100);
    }
    return {
      label: c.label,
      odds: c.odds,
      amount,
      payout: Math.floor(amount * c.odds),
    };
  });

  const totalInvestment = allocations.reduce((sum, a) => sum + a.amount, 0);
  const minPayout = Math.min(...allocations.map(a => a.payout));
  const actualROI = totalInvestment > 0 ? Math.round((minPayout / totalInvestment) * 1000) / 1000 : 0;

  const resultJson = {
    syntheticOdds,
    conditionMet,
    allocations,
    totalInvestment,
    minPayout,
    actualROI,
  };

  // DB更新
  const newStatus = conditionMet ? 'triggered' : 'active';
  await db.execute({
    sql: `UPDATE bet_targets SET status = ?, result_json = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [newStatus, JSON.stringify(resultJson), target.id],
  });

  // 結果表示
  console.log(`  [${target.race_label} ${target.bet_type}] 合成オッズ: ${syntheticOdds}倍 ${conditionMet ? '→ 条件クリア!' : '→ 未達'}`);

  if (conditionMet) {
    // 通知テキスト生成
    const lines: string[] = [
      `${target.race_label} ${target.bet_type} 条件クリア!`,
      `合成オッズ: ${syntheticOdds}倍`,
      '',
    ];
    for (const a of allocations) {
      lines.push(`${a.label} ${a.odds}倍 → ${a.amount.toLocaleString()}円`);
    }
    lines.push('');
    lines.push(`合計: ${totalInvestment.toLocaleString()}円`);
    lines.push(`最低払戻: ${minPayout.toLocaleString()}円 (${Math.round(actualROI * 100)}%)`);

    const notifyText = lines.join('\n');
    console.log(notifyText);

    // __NOTIFY_JSON__ マーカー出力（odds-watcher.sh からパース用）
    console.log(`__NOTIFY_JSON__${JSON.stringify({ raceLabel: target.race_label, betType: target.bet_type, ...resultJson })}__END_JSON__`);
  }

  return conditionMet;
}

async function main() {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf('--date');
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : new Date().toISOString().split('T')[0];
  const raceLabelIdx = args.indexOf('--race-label');
  const raceLabel = raceLabelIdx >= 0 && args[raceLabelIdx + 1] ? args[raceLabelIdx + 1] : null;

  let sql = `SELECT * FROM bet_targets WHERE date = ? AND status = 'active'`;
  const sqlArgs: unknown[] = [date];

  if (raceLabel) {
    sql += ' AND race_label = ?';
    sqlArgs.push(raceLabel);
  }

  const result = await db.execute({ sql, args: sqlArgs });
  const targets = result.rows as unknown as BetTarget[];

  if (targets.length === 0) {
    console.log(`アクティブな買い目なし (date=${date})`);
    db.close();
    return;
  }

  console.log(`=== 馬券条件チェック (${date}, ${targets.length}件) ===`);

  let triggeredCount = 0;
  for (const target of targets) {
    try {
      const triggered = await checkAndNotify(target);
      if (triggered) triggeredCount++;
    } catch (e) {
      console.error(`  [${target.race_label}] エラー:`, e);
    }
  }

  console.log(`\n条件クリア: ${triggeredCount}/${targets.length}件`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
