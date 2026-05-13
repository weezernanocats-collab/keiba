/**
 * 週次 戦略パラメータチューニング + Slack通知
 *
 * 毎週月曜のtrain-model.yml実行後に走らせる。
 *
 * フロー:
 *   1. config/strategy-config.json 読み込み (現状パラメータ)
 *   2. 直近12週(84日)のデータを Train(週-12〜-4) / Validate(週-4〜-1) に分割
 *   3. 近傍パラメータをグリッドサーチ (各次元 ±maxWeeklyMove)
 *   4. Train+Validate 両方で現状を +5pt 以上上回るパラメータがあれば採用
 *   5. config 更新 (history に履歴追加)
 *   6. Slack通知 (採用 or 維持を報告)
 *
 * 安全装置:
 *   - 1週あたり 1パラメータの動きは config.tuneBounds.maxWeeklyMove 以内
 *   - Train/Validate 両方で改善が条件 (片方だけはNG)
 *   - 採用後4週連続赤字なら自動ロールバック (rollbackCheck() で別途判定)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createClient } from '@libsql/client';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = line.match(/^(\w+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });

const CONFIG_PATH = 'config/strategy-config.json';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipSlack = args.includes('--skip-slack');

interface Config {
  version: string;
  lastUpdated: string;
  dailyBudget: number;
  tanshoCap: number;
  matchScoreThreshold: number;
  scoreWeight: { highThreshold: number; highAmount: number; lowAmount: number };
  oddsRiseExcludeThreshold: number;
  raceWeight: any;
  tuneBounds: Record<string, { min: number; max: number; step: number; maxWeeklyMove: number }>;
  history: Array<{ date: string; change: string; params: any; trainRoi: number; validateRoi: number }>;
}

const cfg: Config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));

// ── データロード (直近12週の候補+結果) ──
interface RaceData {
  raceId: string; date: string;
  restT1: Array<{ horseNumber: number; matchScore: number; isRestFiltered: boolean }>;
  entries: Map<number, { odds: number; pos: number | null }>;
}

async function loadWindow(startDate: string, endDate: string): Promise<RaceData[]> {
  const races = await db.execute({
    sql: `SELECT id, date FROM races WHERE date BETWEEN ? AND ? AND status = '結果確定'
          AND id IN (SELECT race_id FROM race_entries WHERE result_position IS NOT NULL)`,
    args: [startDate, endDate],
  });
  if (races.rows.length === 0) return [];
  const raceIds = races.rows.map(r => String(r.id));
  const ph = raceIds.map(() => '?').join(',');

  // predictions
  const preds = await db.execute({
    sql: `SELECT race_id, analysis_json FROM predictions WHERE race_id IN (${ph})`,
    args: raceIds,
  });
  const predMap = new Map<string, any>();
  for (const p of preds.rows) {
    try { predMap.set(String(p.race_id), JSON.parse(String(p.analysis_json))); } catch {}
  }

  // entries
  const ents = await db.execute({
    sql: `SELECT race_id, horse_number, odds, result_position FROM race_entries WHERE race_id IN (${ph}) AND result_position IS NOT NULL`,
    args: raceIds,
  });
  const entsByRace = new Map<string, Map<number, { odds: number; pos: number | null }>>();
  for (const row of ents.rows) {
    const id = String(row.race_id);
    if (!entsByRace.has(id)) entsByRace.set(id, new Map());
    entsByRace.get(id)!.set(Number(row.horse_number), {
      odds: Number(row.odds || 0),
      pos: row.result_position == null ? null : Number(row.result_position),
    });
  }

  const out: RaceData[] = [];
  for (const r of races.rows) {
    const raceId = String(r.id);
    const a = predMap.get(raceId);
    if (!a?.shosanPrediction) continue;
    const restT1 = (a.shosanPrediction.restFilteredCandidates || []).filter((c: any) => c.theory === 1).map((c: any) => ({
      horseNumber: c.horseNumber, matchScore: c.matchScore || 0, isRestFiltered: true,
    }));
    const entries = entsByRace.get(raceId);
    if (!entries) continue;
    out.push({ raceId, date: String(r.date), restT1, entries });
  }
  return out;
}

// ── 戦略評価 (パラメータ可変) ──
interface Params {
  matchScoreThreshold: number;
  highThreshold: number;
  highAmount: number;
  lowAmount: number;
}

function evalSingleTansho(races: RaceData[], p: Params): { bet: number; pay: number; hits: number; total: number } {
  // 単勝×休養F理論1 のみ評価 (DB内で完結する戦略)
  let bet = 0, pay = 0, hits = 0, total = 0;
  for (const r of races) {
    for (const c of r.restT1) {
      if (c.matchScore < 0) continue; // 安全
      const e = r.entries.get(c.horseNumber);
      if (!e || e.odds <= 0) continue;
      const amount = c.matchScore >= p.highThreshold ? p.highAmount : p.lowAmount;
      bet += amount;
      total++;
      if (e.pos === 1) { pay += amount * e.odds; hits++; }
    }
  }
  return { bet, pay, hits, total };
}

// ── グリッドサーチ ──
function neighborValues(current: number, bound: { min: number; max: number; step: number; maxWeeklyMove: number }): number[] {
  const out: number[] = [];
  for (let v = current - bound.maxWeeklyMove; v <= current + bound.maxWeeklyMove; v += bound.step) {
    const rounded = Math.round(v / bound.step) * bound.step;
    if (rounded >= bound.min && rounded <= bound.max) out.push(rounded);
  }
  return [...new Set(out)];
}

interface TuneResult {
  params: Params;
  trainRoi: number;
  validateRoi: number;
  trainBet: number;
  validateBet: number;
}

async function main() {
  // 日付計算 — Train 24週、Validate 4週
  const today = new Date();
  const ymd = (d: Date) => d.toISOString().split('T')[0];
  const offsetDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const trainStart = ymd(offsetDays(today, -168));  // -24週
  const trainEnd = ymd(offsetDays(today, -28));      // -4週
  const validateStart = ymd(offsetDays(today, -28));
  const validateEnd = ymd(offsetDays(today, -1));

  console.log(`=== 週次戦略チューニング ===`);
  console.log(`Train: ${trainStart} 〜 ${trainEnd}`);
  console.log(`Validate: ${validateStart} 〜 ${validateEnd}`);
  console.log(`現状 config:`);
  console.log(`  matchScoreThreshold: ${cfg.matchScoreThreshold}`);
  console.log(`  highThreshold: ${cfg.scoreWeight.highThreshold}`);
  console.log(`  highAmount: ${cfg.scoreWeight.highAmount}`);
  console.log(`  lowAmount: ${cfg.scoreWeight.lowAmount}`);

  const train = await loadWindow(trainStart, trainEnd);
  const validate = await loadWindow(validateStart, validateEnd);
  console.log(`\nデータ: train=${train.length}レース, validate=${validate.length}レース`);

  // 現状パラメータの基準ROI
  const currentParams: Params = {
    matchScoreThreshold: cfg.matchScoreThreshold,
    highThreshold: cfg.scoreWeight.highThreshold,
    highAmount: cfg.scoreWeight.highAmount,
    lowAmount: cfg.scoreWeight.lowAmount,
  };
  const baseTrain = evalSingleTansho(train, currentParams);
  const baseVal = evalSingleTansho(validate, currentParams);
  const baseTrainRoi = baseTrain.bet > 0 ? baseTrain.pay / baseTrain.bet * 100 : 0;
  const baseValRoi = baseVal.bet > 0 ? baseVal.pay / baseVal.bet * 100 : 0;
  console.log(`\n現状ROI: Train ${baseTrainRoi.toFixed(1)}% (${baseTrain.total}件, bet${baseTrain.bet}円) / Validate ${baseValRoi.toFixed(1)}% (${baseVal.total}件, bet${baseVal.bet}円)`);

  // サンプル不足チェック (bet基準で評価)
  if (baseTrain.bet < 10000 || baseVal.bet < 3000) {
    console.log(`⚠ サンプル不足のためチューニングskip (train bet=${baseTrain.bet}, validate bet=${baseVal.bet})`);
    if (!skipSlack) await slackNotify(
`⚠ *週次戦略チューニング (${ymd(today)})*
データ不足のためskip
• Train: ${baseTrain.total}件 (bet ${baseTrain.bet}円) — 必要: 10,000円以上
• Validate: ${baseVal.total}件 (bet ${baseVal.bet}円) — 必要: 3,000円以上
• 現状ROI 表示は参考値: Train ${baseTrainRoi.toFixed(1)}% / Validate ${baseValRoi.toFixed(1)}%`
    );
    db.close();
    return;
  }

  // グリッドサーチ
  const msValues = neighborValues(currentParams.matchScoreThreshold, cfg.tuneBounds.matchScoreThreshold);
  const htValues = neighborValues(currentParams.highThreshold, cfg.tuneBounds.scoreWeightHighThreshold);
  const haValues = neighborValues(currentParams.highAmount, cfg.tuneBounds.scoreWeightHighAmount);
  console.log(`\nグリッド: ${msValues.length} × ${htValues.length} × ${haValues.length} = ${msValues.length * htValues.length * haValues.length}`);

  const results: TuneResult[] = [];
  for (const ms of msValues) {
    for (const ht of htValues) {
      for (const ha of haValues) {
        const p: Params = { matchScoreThreshold: ms, highThreshold: ht, highAmount: ha, lowAmount: 100 };
        const tr = evalSingleTansho(train, p);
        const va = evalSingleTansho(validate, p);
        if (tr.bet < 5000 || va.bet < 1500) continue;
        results.push({
          params: p,
          trainRoi: tr.pay / tr.bet * 100,
          validateRoi: va.pay / va.bet * 100,
          trainBet: tr.bet, validateBet: va.bet,
        });
      }
    }
  }

  // 採用判定: Train+Validate 両方で現状 +5pt 以上上回る
  const candidates = results.filter(r =>
    r.trainRoi >= baseTrainRoi + 5 &&
    r.validateRoi >= baseValRoi + 5
  );
  candidates.sort((a, b) => (b.trainRoi + b.validateRoi) - (a.trainRoi + a.validateRoi));

  console.log(`\n候補 (+5pt以上改善): ${candidates.length}件`);
  for (const c of candidates.slice(0, 5)) {
    console.log(`  ms=${c.params.matchScoreThreshold} ht=${c.params.highThreshold} ha=${c.params.highAmount}: Train ${c.trainRoi.toFixed(1)}% Val ${c.validateRoi.toFixed(1)}%`);
  }

  if (candidates.length === 0) {
    console.log('\n→ 採用候補なし。現状維持。');
    if (!skipSlack) await slackNotify(
`📊 *週次戦略チューニング (${ymd(today)})*
現状維持 (採用候補なし)
• Train ROI: ${baseTrainRoi.toFixed(1)}% (${baseTrain.total}件)
• Validate ROI: ${baseValRoi.toFixed(1)}% (${baseVal.total}件)
• matchScoreThreshold=${currentParams.matchScoreThreshold}, highThreshold=${currentParams.highThreshold}, highAmount=${currentParams.highAmount}`
    );
    db.close();
    return;
  }

  // 最良候補を採用
  const best = candidates[0];
  console.log(`\n採用候補: ms=${best.params.matchScoreThreshold} ht=${best.params.highThreshold} ha=${best.params.highAmount}`);
  console.log(`  Train ROI: ${baseTrainRoi.toFixed(1)}% → ${best.trainRoi.toFixed(1)}% (+${(best.trainRoi - baseTrainRoi).toFixed(1)}pt)`);
  console.log(`  Validate ROI: ${baseValRoi.toFixed(1)}% → ${best.validateRoi.toFixed(1)}% (+${(best.validateRoi - baseValRoi).toFixed(1)}pt)`);

  if (dryRun) {
    console.log('--dry-run: config更新せず');
    db.close();
    return;
  }

  // config更新
  const before = { ...currentParams };
  cfg.matchScoreThreshold = best.params.matchScoreThreshold;
  cfg.scoreWeight.highThreshold = best.params.highThreshold;
  cfg.scoreWeight.highAmount = best.params.highAmount;
  cfg.lastUpdated = new Date().toISOString();
  const changeStr = [
    before.matchScoreThreshold !== best.params.matchScoreThreshold && `matchScore:${before.matchScoreThreshold}→${best.params.matchScoreThreshold}`,
    before.highThreshold !== best.params.highThreshold && `highThreshold:${before.highThreshold}→${best.params.highThreshold}`,
    before.highAmount !== best.params.highAmount && `highAmount:${before.highAmount}→${best.params.highAmount}`,
  ].filter(Boolean).join(', ');
  cfg.history.push({
    date: ymd(today),
    change: changeStr || 'no-change',
    params: {
      matchScoreThreshold: best.params.matchScoreThreshold,
      'scoreWeight.highThreshold': best.params.highThreshold,
      'scoreWeight.highAmount': best.params.highAmount,
    },
    trainRoi: Math.round(best.trainRoi * 10) / 10,
    validateRoi: Math.round(best.validateRoi * 10) / 10,
  });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`✅ config更新: ${changeStr}`);

  if (!skipSlack) {
    await slackNotify(
`🔧 *週次戦略チューニング (${ymd(today)})*
*パラメータ更新:* ${changeStr}
• Train ROI: ${baseTrainRoi.toFixed(1)}% → ${best.trainRoi.toFixed(1)}% (+${(best.trainRoi - baseTrainRoi).toFixed(1)}pt)
• Validate ROI: ${baseValRoi.toFixed(1)}% → ${best.validateRoi.toFixed(1)}% (+${(best.validateRoi - baseValRoi).toFixed(1)}pt)
• Train: ${baseTrain.total}件 / Validate: ${baseVal.total}件`
    );
  }

  db.close();
}

async function slackNotify(msg: string) {
  const token = process.env.SLACK_BOT_TOKEN;
  const ch = process.env.SLACK_CHANNEL_ID;
  if (!token || !ch) { console.log('SLACK_BOT_TOKEN/CHANNEL_ID未設定、通知skip'); return; }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: ch, text: msg }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) console.error('Slack送信失敗:', data.error);
    else console.log('Slack送信完了');
  } catch (e) {
    console.error('Slack送信エラー:', (e as Error).message);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
