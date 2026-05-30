/**
 * IPAT レース単位スケジューラー (デーモン)
 *
 * 動作:
 *   1. 起動時に今日のレース計画を構築 (買い目+予算配分)
 *   2. ポーリングループ:
 *      - 発走20分前: baseline オッズを netkeiba から fetch & odds_snapshots に保存
 *      - 発走7分前: 直前オッズを fetch → +30%上昇馬除外フィルタ → IPAT投票
 *   3. 全レース完了 or 17:30 JST で終了
 *
 * 使い方:
 *   npx tsx scripts/ipat-race-scheduler.ts --budget 10000 --headless
 *   npx tsx scripts/ipat-race-scheduler.ts --budget 10000 --headless --dry-run
 *
 * 環境変数 (.env.local): TURSO_*, IPAT_INET_ID, IPAT_MEMBER_NO, IPAT_PASSWORD, IPAT_PARS_NO
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { chromium, type Browser, type Page } from 'playwright';
import { createClient, type Client } from '@libsql/client';
import {
  loginToIpat,
  navigateToBetBasic,
  selectVenueAndRace,
  placeBet as placeBetIpat,
  confirmPurchase,
  calcTotalAmount,
  type IpatBet,
  type IpatCredentials,
} from '../src/lib/ipat-client';

// .env.local 読み込み
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = line.match(/^(\w+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const args = process.argv.slice(2);
const getArg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const dryRun = args.includes('--dry-run');
const headless = !args.includes('--headed');
const minutesBeforeBet = parseInt(getArg('--minutes-before') || '7');
const minutesBeforeBaseline = parseInt(getArg('--baseline-before') || '20');

// 設定ファイル読み込み (config/strategy-config.json)
interface StrategyConfig {
  dailyBudget: number;
  tanshoCap: number;
  matchScoreThreshold: number;
  scoreWeight: { highThreshold: number; highAmount: number; lowAmount: number };
  tansho?: { restDaysMin: number; includeTheory2?: boolean };
  umaren?: { enabled: boolean; perPoint: number; strategy?: string; popN?: number; scoreMin?: number; raceNumMin?: number; excludeGrades?: string[] };
  wideEnabled?: boolean;
  oddsRiseExcludeThreshold: number;
  raceWeight: {
    ageMult_3yoOnly: number;
    ageMult_default: number;
    gradeMult: Record<string, number>;
  };
}
function loadConfig(): StrategyConfig {
  const path = 'config/strategy-config.json';
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
  // フォールバック (config無しでも動く)
  return {
    dailyBudget: 10000,
    tanshoCap: 0.5,
    matchScoreThreshold: 55,
    scoreWeight: { highThreshold: 65, highAmount: 200, lowAmount: 100 },
    tansho: { restDaysMin: 50 },
    umaren: { enabled: true, perPoint: 100, strategy: 'cand_box', popN: 3 },
    wideEnabled: false,
    oddsRiseExcludeThreshold: 0.3,
    raceWeight: {
      ageMult_3yoOnly: 0.5, ageMult_default: 1.0,
      gradeMult: { G1: 0.7, G2: 0.8, G3: 0.9, 'リステッド': 1.0, OP: 1.0, 'オープン': 1.0, '3勝クラス': 1.3, '2勝クラス': 1.5, '1勝クラス': 1.4, default: 1.0 },
    },
  };
}
const config = loadConfig();
const budget = parseInt(getArg('--budget') || String(config.dailyBudget));
const riseThreshold = parseFloat(getArg('--filter-odds-rise') || String(config.oddsRiseExcludeThreshold));
const SCORE_THRESHOLD = config.matchScoreThreshold;
const UMAREN_ENABLED = config.umaren?.enabled ?? true;
const UMAREN_PER_POINT = config.umaren?.perPoint ?? 100;
const UMAREN_STRATEGY = config.umaren?.strategy ?? 'cand_box';
const UMAREN_POP_N = config.umaren?.popN ?? 3;
const UMAREN_SCORE_MIN = config.umaren?.scoreMin ?? config.matchScoreThreshold;
const TANSHO_REST_DAYS_MIN = config.tansho?.restDaysMin ?? 50;
const TANSHO_INCLUDE_T2 = config.tansho?.includeTheory2 ?? false;
const WIDE_ENABLED = config.wideEnabled ?? false;

const NETKEIBA_BASE = 'https://race.netkeiba.com';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const today = new Date();
today.setHours(today.getHours() + 9);
const date = getArg('--date') || today.toISOString().split('T')[0];

const VENUE_MAP: Record<string, string> = {
  '札幌': 'SAPPORO', '函館': 'HAKODATE', '福島': 'FUKUSHIMA',
  '新潟': 'NIIGATA', '東京': 'TOKYO', '中山': 'NAKAYAMA',
  '中京': 'CHUKYO', '京都': 'KYOTO', '阪神': 'HANSHIN', '小倉': 'KOKURA',
};

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });

// ── ログ ──
const logDir = `${process.env.HOME}/Library/Logs/keiba`;
mkdirSync(logDir, { recursive: true });
function log(s: string) {
  const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  console.log(`[${ts}] ${s}`);
}

// ── レース計画 ──
interface BetItem {
  type: 'WIDE' | 'TANSYO' | 'UMAREN';
  horses: number[];     // ワイドは複数、単勝1頭、馬連2頭
  amount: number;       // 1ペアor1点あたり
  tag: string;          // 識別用 (e.g., "wide:基本", "tansho:休養F理論1", "umaren:候補x1番人気")
}

interface RacePlan {
  raceId: string;
  date: string;
  venueName: string;     // 京都
  venueCode: string;     // KYOTO
  raceNumber: number;
  raceName: string;
  grade: string;
  raceTime: Date;        // 発走時刻 (JST)
  weight: number;
  candidateNums: number[]; // しょーさん候補(>=55)
  popularNums: number[];   // 1〜3人気馬番
  initialBets: BetItem[]; // フィルタ前の買い目
  finalBets?: BetItem[];   // フィルタ後の買い目
  baselineOdds?: Map<number, number>;
  currentOdds?: Map<number, number>;
  status: 'pending' | 'baselined' | 'bet' | 'skipped' | 'error';
  errorMsg?: string;
}

function computeRaceWeight(rn: number, name: string, grade: string): number {
  const is3yo = name.startsWith('3歳') && !name.includes('以上');
  const ageMult = is3yo ? config.raceWeight.ageMult_3yoOnly : config.raceWeight.ageMult_default;
  const g = config.raceWeight.gradeMult[grade] ?? config.raceWeight.gradeMult.default;
  return rn * ageMult * g;
}

function parseRaceTime(timeStr: string, baseDate: Date): Date {
  const [h, m] = timeStr.split(':').map(s => parseInt(s));
  // JST 基準。Node の Date は LocalTime(JSTを期待)。CIではTZ=Asia/Tokyo必要
  const d = new Date(baseDate);
  d.setHours(h, m, 0, 0);
  return d;
}

// ── レース計画構築 ──
async function buildDayPlans(): Promise<RacePlan[]> {
  const rows = await db.execute({
    sql: `SELECT p.race_id, p.analysis_json, r.racecourse_name, r.race_number, r.name, r.grade, r.time
          FROM predictions p JOIN races r ON p.race_id = r.id
          WHERE r.date = ? AND p.analysis_json LIKE '%shosanPrediction%'
          ORDER BY r.time, r.racecourse_name, r.race_number`,
    args: [date],
  });

  const plans: RacePlan[] = [];
  for (const row of rows.rows) {
    const raceId = String(row.race_id);
    const venueName = String(row.racecourse_name);
    const venueCode = VENUE_MAP[venueName];
    if (!venueCode) continue;
    const timeStr = String(row.time || '');
    if (!/^\d{2}:\d{2}/.test(timeStr)) continue;
    const raceTime = parseRaceTime(timeStr, today);

    let a: any;
    try { a = JSON.parse(String(row.analysis_json)); } catch {}
    const sp = a?.shosanPrediction;
    const rname = String(row.name || ''), rgrade = String(row.grade || '');
    const raceNum = Number(row.race_number);
    const weight = computeRaceWeight(raceNum, rname, rgrade);

    const initialBets: BetItem[] = [];
    let candidateNums: number[] = [];
    let popularNums: number[] = [];

    // ── 馬連: しょーさん候補(matchScore>=55) ∪ オッズ1〜N位 を全頭ボックス ──
    if (UMAREN_ENABLED && sp) {
      const qualified = (sp.candidates || []).filter((c: any) => (c.matchScore || 0) >= UMAREN_SCORE_MIN);
      if (qualified.length > 0) {
        const popRows = await db.execute({ sql: `SELECT horse_number FROM race_entries WHERE race_id = ? AND odds > 0 ORDER BY odds ASC LIMIT ?`, args: [raceId, UMAREN_POP_N] });
        const popNums = popRows.rows.map(x => Number(x.horse_number));
        popularNums = popNums;
        candidateNums = qualified.map((c: any) => Number(c.horseNumber));
        const boxHorses = [...new Set([...candidateNums, ...popNums])].sort((a, b) => a - b);
        // 候補の max matchScore で base をブースト (s50=1.0, s60=1.2, s75=1.5)
        const maxScore = Math.max(...qualified.map((c: any) => c.matchScore || 0));
        const boost = 1 + Math.max(0, (maxScore - 50) / 50);  // s50:1.0, s60:1.2, s75:1.5
        const baseAmt = UMAREN_PER_POINT * boost;  // float、最終100円丸めは allocateBudget で
        if (boxHorses.length >= 2) {
          for (let i = 0; i < boxHorses.length; i++) {
            for (let j = i + 1; j < boxHorses.length; j++) {
              initialBets.push({ type: 'UMAREN', horses: [boxHorses[i], boxHorses[j]], amount: baseAmt, tag: `umaren:候補∪オッズ1-${UMAREN_POP_N}位box(maxS=${maxScore})` });
            }
          }
        }
      }
    }

    // ── 単勝: theory=1 ∩ restDays >= N日 (config: tansho.restDaysMin) ──
    if (sp) {
      const tanshoTargets = (sp.candidates || []).filter((c: any) => {
        const tok = TANSHO_INCLUDE_T2 ? (c.theory === 1 || c.theory === 2) : (c.theory === 1);
        return tok && (c.restDays ?? 0) >= TANSHO_REST_DAYS_MIN;
      });
      for (const c of tanshoTargets) {
        const score = (c.matchScore || 0);
        const tAmount = score >= config.scoreWeight.highThreshold ? config.scoreWeight.highAmount : config.scoreWeight.lowAmount;
        initialBets.push({ type: 'TANSYO', horses: [Number(c.horseNumber)], amount: tAmount, tag: `tansho:t1+rest>=${TANSHO_REST_DAYS_MIN}日(score=${score})` });
      }
    }

    if (initialBets.length === 0) continue;

    plans.push({
      raceId, date, venueName, venueCode,
      raceNumber: Number(row.race_number),
      raceName: rname, grade: rgrade,
      raceTime, weight,
      candidateNums, popularNums,
      initialBets,
      status: 'pending',
    });
  }
  return plans;
}

function allocateBudget(plans: RacePlan[]) {
  // 単勝・馬連ともレース重み比例で配分
  //   rawShare = baseAmount × race_weight、合計で正規化
  //   各bet.amount = budget × rawShare / rawTotal、100円単位丸め、最低100円
  //   合計が予算超過 → 低weight順に削除
  const items: Array<{ plan: RacePlan; bet: BetItem; base: number }> = [];
  for (const p of plans) for (const b of p.initialBets) items.push({ plan: p, bet: b, base: b.amount });
  if (items.length === 0) return;
  const rawTotal = items.reduce((s, x) => s + x.base * x.plan.weight, 0);
  if (rawTotal > 0) {
    for (const x of items) {
      const target = budget * (x.base * x.plan.weight) / rawTotal;
      x.bet.amount = Math.max(100, Math.floor(target / 100) * 100);
    }
  }
  // コスト計算 (WIDEはペア数倍)
  const cost = (b: BetItem) => b.type === 'WIDE' ? b.amount * Math.max(1, b.horses.length * (b.horses.length - 1) / 2) : b.amount;
  let total = items.reduce((s, x) => s + cost(x.bet), 0);
  if (total > budget) {
    const sorted = [...items].sort((a, b) => a.plan.weight - b.plan.weight);
    const drop = new Set<BetItem>();
    for (const x of sorted) {
      if (total <= budget) break;
      drop.add(x.bet);
      total -= cost(x.bet);
    }
    for (const p of plans) p.initialBets = p.initialBets.filter(b => !drop.has(b));
  }
  // 余り予算を高weight順に +100円ずつ再配分 (消化率最大化)
  const live = items.filter(x => plans.some(p => p.initialBets.includes(x.bet)));
  if (total < budget && live.length > 0) {
    const sorted = [...live].sort((a, b) => b.plan.weight - a.plan.weight);
    let i = 0, safety = 0;
    while (total < budget && safety < 1000) {
      const x = sorted[i % sorted.length];
      const add = x.bet.type === 'WIDE' ? 100 * Math.max(1, x.bet.horses.length * (x.bet.horses.length - 1) / 2) : 100;
      if (total + add <= budget) {
        x.bet.amount += 100;
        total += add;
      }
      i++; safety++;
      if (i > sorted.length && total + 100 > budget) break;
    }
  }
  const finalItems = plans.flatMap(p => p.initialBets);
  const tCnt = finalItems.filter(b => b.type === 'TANSYO').length;
  const tSum = finalItems.filter(b => b.type === 'TANSYO').reduce((s, b) => s + b.amount, 0);
  const uCnt = finalItems.filter(b => b.type === 'UMAREN').length;
  const uSum = finalItems.filter(b => b.type === 'UMAREN').reduce((s, b) => s + b.amount, 0);
  log(`[budget] 予算${budget}円 → 単勝${tSum}円(${tCnt}点) + 馬連${uSum}円(${uCnt}点) = ${total}円 (重み配分)`);
}

// ── netkeiba オッズ取得 ──
async function fetchCurrentOdds(raceId: string): Promise<Map<number, number>> {
  const url = `${NETKEIBA_BASE}/api/api_get_jra_odds.html?race_id=${raceId}&type=1&action=init&compress=0`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return new Map();
    const data: any = await res.json();
    const winOdds = data?.data?.odds?.['1'];
    if (!winOdds) return new Map();
    const out = new Map<number, number>();
    for (const [numStr, vals] of Object.entries<any>(winOdds)) {
      const n = parseInt(numStr);
      const o = parseFloat(vals[0]);
      if (n > 0 && o > 0) out.set(n, o);
    }
    return out;
  } catch (e) {
    log(`  ⚠ odds fetch failed: ${(e as Error).message}`);
    return new Map();
  }
}

async function saveOddsSnapshot(raceId: string, odds: Map<number, number>) {
  const ts = (() => { const d = new Date(Date.now() + 9 * 3600_000); return d.toISOString().replace('T', ' ').slice(0, 19); })();
  for (const [n, o] of odds) {
    try {
      await db.execute({
        sql: `INSERT INTO odds_snapshots (race_id, horse_number, odds, snapshot_time) VALUES (?, ?, ?, ?)`,
        args: [raceId, n, o, ts],
      });
    } catch (e) { /* ignore individual failures */ }
  }
}

async function getBaselineOdds(raceId: string): Promise<Map<number, number>> {
  // odds_snapshots の最古エントリを馬毎に取得
  const r = await db.execute({
    sql: `SELECT horse_number, odds FROM odds_snapshots WHERE race_id = ? AND snapshot_time = (
            SELECT MIN(snapshot_time) FROM odds_snapshots WHERE race_id = ?
          )`,
    args: [raceId, raceId],
  });
  const out = new Map<number, number>();
  for (const row of r.rows) out.set(Number(row.horse_number), Number(row.odds));
  return out;
}

// ── オッズフィルタ適用 ──
function applyOddsFilter(plan: RacePlan): BetItem[] {
  const baseline = plan.baselineOdds;
  const current = plan.currentOdds;
  if (!baseline || !current || baseline.size === 0) {
    log(`  ${plan.venueName}${plan.raceNumber}R: baseline不足 → フィルタなしで実行`);
    return plan.initialBets;
  }

  // 各馬の上昇率
  const riseByHorse = new Map<number, number>();
  for (const [n, baseO] of baseline) {
    const curO = current.get(n);
    if (curO == null || baseO <= 0) continue;
    riseByHorse.set(n, (curO - baseO) / baseO);
  }

  const final: BetItem[] = [];
  for (const b of plan.initialBets) {
    if (b.type === 'TANSYO') {
      const rise = riseByHorse.get(b.horses[0]);
      if (rise != null && rise >= riseThreshold) {
        log(`  🚫 ${plan.venueName}${plan.raceNumber}R 単勝 ${b.horses[0]}番 除外 (rise ${(rise * 100).toFixed(0)}%)`);
      } else {
        final.push(b);
      }
    } else if (b.type === 'UMAREN') {
      // 馬連: いずれかの馬がオッズ上昇していたらこのペア除外
      const rises = b.horses.map(h => ({ h, r: riseByHorse.get(h) }));
      const upHorse = rises.find(x => x.r != null && x.r >= riseThreshold);
      if (upHorse) {
        log(`  🚫 ${plan.venueName}${plan.raceNumber}R 馬連 ${b.horses.join('-')} 除外 (${upHorse.h}番 rise ${((upHorse.r || 0) * 100).toFixed(0)}%)`);
      } else {
        final.push(b);
      }
    } else {
      // WIDE (廃止予定、残ってる場合): 該当馬を除外
      const keep = b.horses.filter(h => {
        const r = riseByHorse.get(h);
        return r == null || r < riseThreshold;
      });
      const dropped = b.horses.filter(h => !keep.includes(h));
      if (dropped.length > 0) {
        log(`  🚫 ${plan.venueName}${plan.raceNumber}R ワイド除外: ${dropped.map(h => `${h}番(${((riseByHorse.get(h) || 0) * 100).toFixed(0)}%)`).join(', ')}`);
      }
      if (keep.length < 2) {
        log(`  ⚠ ${plan.venueName}${plan.raceNumber}R ワイド: 残${keep.length}頭 → 全削除`);
        continue;
      }
      final.push({ ...b, horses: keep });
    }
  }
  return final;
}

// ── IPAT ブラウザ + ログイン + 投票 ──
let ipatPage: Page | null = null;
let ipatBrowser: Browser | null = null;

async function ensureIpatLogin(): Promise<Page> {
  if (ipatPage && !ipatPage.isClosed()) return ipatPage;

  if (dryRun) {
    throw new Error('dry-run mode: not opening browser');
  }

  log('[ipat] ブラウザ起動 + ログイン中...');
  ipatBrowser = await chromium.launch({ headless, slowMo: headless ? 0 : 200 });
  const context = await ipatBrowser.newContext({ viewport: { width: 1280, height: 900 } });
  ipatPage = await context.newPage();

  const creds: IpatCredentials = {
    inetId: process.env.IPAT_INET_ID || '',
    memberNo: process.env.IPAT_MEMBER_NO || '',
    password: process.env.IPAT_PASSWORD || '',
    parsNo: process.env.IPAT_PARS_NO || '',
  };
  await loginToIpat(ipatPage, creds);
  log('[ipat] ログイン完了');
  await navigateToBetBasic(ipatPage);

  return ipatPage;
}

async function submitBetsForRace(plan: RacePlan, finalBets: BetItem[]) {
  if (dryRun) {
    log(`[dry] ${plan.venueName}${plan.raceNumber}R 投票スキップ`);
    for (const b of finalBets) {
      if (b.type === 'WIDE') log(`  ワイド[${b.horses.join(',')}] ${b.amount}円/ペア`);
      else if (b.type === 'UMAREN') log(`  馬連 ${b.horses.join('-')} ${b.amount}円`);
      else log(`  単勝 ${b.horses[0]}番 ${b.amount}円`);
    }
    return;
  }
  const page = await ensureIpatLogin();

  log(`[ipat] ${plan.venueName}${plan.raceNumber}R に移動...`);
  // 会場・レース選択
  await selectVenueAndRace(page, plan.venueName, plan.raceNumber, log);

  // IpatBet 形式に変換 (scheduler の BetItem と ipat-client の IpatBet は型互換)
  const ipatBets: IpatBet[] = finalBets.map(b => ({
    type: b.type as IpatBet['type'],
    horses: b.horses,
    amount: b.amount,
  }));

  // 各買い目をセット
  let setCount = 0;
  for (const b of ipatBets) {
    await placeBetIpat(page, b, log);
    setCount++;
    log(`    ✓ セット完了 (${setCount}/${ipatBets.length})`);
  }

  // 投票一覧 → 合計入力 → 購入確定
  const totalAmount = calcTotalAmount(ipatBets);
  log(`  全${setCount}点セット完了 → 投票一覧へ (合計${totalAmount.toLocaleString()}円)`);
  await confirmPurchase(page, totalAmount, log);
  log(`  ✓ ${plan.venueName}${plan.raceNumber}R 投票完了 (${setCount}点 ${totalAmount.toLocaleString()}円)`);
}

// ── メイン処理 ──
async function processBet(plan: RacePlan) {
  const label = `${plan.venueName}${plan.raceNumber}R`;
  try {
    // 1. 直前オッズ fetch
    plan.currentOdds = await fetchCurrentOdds(plan.raceId);
    await saveOddsSnapshot(plan.raceId, plan.currentOdds);

    // 2. baseline 取得
    plan.baselineOdds = await getBaselineOdds(plan.raceId);

    // 3. フィルタ適用
    plan.finalBets = applyOddsFilter(plan);
    if (plan.finalBets.length === 0) {
      log(`  ${label}: フィルタ後ベットなし → skip`);
      plan.status = 'skipped';
      await slackNotify(`🚫 *${label}*: 全候補が+30%オッズ上昇のため skip`);
      return;
    }

    // 4. IPAT投票
    const planSummary = plan.finalBets.map(b => {
      if (b.type === 'WIDE') {
        const pairs = b.horses.length * (b.horses.length - 1) / 2;
        return `ワイド[${b.horses.join(',')}] ${pairs}点×${b.amount}円`;
      }
      if (b.type === 'UMAREN') {
        return `馬連${b.horses.join('-')} ${b.amount}円`;
      }
      return `単勝${b.horses[0]} ${b.amount}円`;
    }).join(' / ');
    await submitBetsForRace(plan, plan.finalBets);
    plan.status = 'bet';

    // 成功通知
    const totalAmount = plan.finalBets.reduce((s, b) => {
      if (b.type === 'WIDE') {
        const pairs = Math.max(1, b.horses.length * (b.horses.length - 1) / 2);
        return s + b.amount * pairs;
      }
      return s + b.amount;
    }, 0);
    consecutiveFailures = 0;
    await slackNotify(`✅ *${label}* 投票完了 ${totalAmount.toLocaleString()}円\n${planSummary}`);
  } catch (e) {
    plan.status = 'error';
    plan.errorMsg = (e as Error).message;
    log(`  ✗ ${label}: ${plan.errorMsg}`);
    consecutiveFailures++;
    const baseMsg = `❌ *${label}* 投票失敗\nエラー: ${plan.errorMsg}\n手動投票推奨 (締切: 発走1分前まで)`;
    if (consecutiveFailures >= 3) {
      await slackNotify(`🚨 <!here> *${consecutiveFailures}レース連続失敗* — scheduler 異常の可能性\n${baseMsg}`);
    } else {
      await slackNotify(baseMsg);
    }
  }
}

async function processBaseline(plan: RacePlan) {
  // 中間スナップショット (時系列観察、フィルタには使わない)
  try {
    const odds = await fetchCurrentOdds(plan.raceId);
    if (odds.size > 0) {
      await saveOddsSnapshot(plan.raceId, odds);
      plan.status = 'baselined';
      log(`  📷 ${plan.venueName}${plan.raceNumber}R 中間snapshot (${odds.size}頭)`);
    }
  } catch (e) {
    log(`  ⚠ ${plan.venueName}${plan.raceNumber}R snapshot失敗: ${(e as Error).message}`);
  }
}

function nowJst(): Date {
  return new Date();
}

// ── Slack 通知 ──
let consecutiveFailures = 0;
async function slackNotify(msg: string) {
  const token = process.env.SLACK_BOT_TOKEN;
  const ch = process.env.SLACK_CHANNEL_ID;
  if (!token || !ch) { log('Slack設定なし、通知skip'); return; }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: ch, text: msg }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) log(`Slack送信失敗: ${data.error}`);
  } catch (e) {
    log(`Slack送信エラー: ${(e as Error).message}`);
  }
}

async function main() {
  log(`=== IPAT レーススケジューラー起動 (${date}) ===`);
  log(`予算: ${budget}円 / フィルタ閾値: +${(riseThreshold * 100).toFixed(0)}% / 投票タイミング: 発走${minutesBeforeBet}分前`);
  if (dryRun) log('⚠ dry-run mode');

  const plans = await buildDayPlans();
  if (plans.length === 0) {
    log('対象の買い目があるレースがありません');
    return;
  }
  allocateBudget(plans);

  log(`\n=== 計画 (${plans.length}レース) ===`);
  const planLines: string[] = [];
  let tanTotal = 0, tanCount = 0;
  let umaTotal = 0, umaCount = 0;
  for (const p of plans) {
    const tStr = p.raceTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const wide = p.initialBets.find(b => b.type === 'WIDE');
    const umaren = p.initialBets.filter(b => b.type === 'UMAREN');
    const tans = p.initialBets.filter(b => b.type === 'TANSYO');
    const wideStr = wide ? `ワイド[${wide.horses.join(',')}]×${wide.amount}円` : '';
    const umaSum = umaren.reduce((s, u) => s + u.amount, 0);
    const tansSum = tans.reduce((s, t) => s + t.amount, 0);
    const umarenStr = umaren.length > 0
      ? `馬連[${umaren.map(u => u.horses.join('-')).join(',')}]×${umaren[0].amount}円=${umaSum}円`
      : '';
    const tansStr = tans.length > 0
      ? `単勝[${tans.map(t => `${t.horses[0]}番${t.amount}円`).join(',')}]=${tansSum}円`
      : '';
    const line = `  ${tStr} ${p.venueName}${p.raceNumber}R w=${p.weight.toFixed(1)} ${tansStr} ${umarenStr}${wideStr}`.replace(/\s+/g, ' ').trim();
    log('  ' + line);
    planLines.push('  ' + line);
    tanTotal += tansSum; tanCount += tans.length;
    umaTotal += umaSum;  umaCount += umaren.length;
  }
  const grandTotal = tanTotal + umaTotal;

  // 起動時の Slack 通知 (計画一覧 + 単勝/馬連合計)
  const header = `📋 *本日 (${date}) の投票計画* — ${plans.length}レース、予算${budget.toLocaleString()}円`;
  const totals = `合計: 単勝 ${tanTotal.toLocaleString()}円 (${tanCount}点) / 馬連 ${umaTotal.toLocaleString()}円 (${umaCount}点) = ${grandTotal.toLocaleString()}円`;
  await slackNotify(`${header}\n${totals}\n\`\`\`${planLines.join('\n')}\`\`\``);

  // ── 起動時: 全レースの morning baseline odds を取得 ──
  log(`\n=== Morning baseline 取得 (全${plans.length}レース) ===`);
  let baselineSuccess = 0;
  for (const p of plans) {
    const odds = await fetchCurrentOdds(p.raceId);
    if (odds.size > 0) {
      await saveOddsSnapshot(p.raceId, odds);
      baselineSuccess++;
    }
    await new Promise(r => setTimeout(r, 800)); // netkeiba負荷分散
  }
  log(`[baseline] ${baselineSuccess}/${plans.length} 取得成功 (これがフィルタの基準値)`);

  // ポーリングループ
  log('\n=== ポーリング開始 ===');
  while (true) {
    const now = nowJst();
    // 17:30 JST 以降は終了
    if (now.getHours() >= 17 && now.getMinutes() >= 30) {
      log('17:30 JST に達したため終了');
      break;
    }
    const pending = plans.filter(p => p.status === 'pending' || p.status === 'baselined');
    if (pending.length === 0) {
      log('全レース処理完了');
      break;
    }

    for (const p of plans) {
      if (p.status !== 'pending' && p.status !== 'baselined') continue;
      const minsTo = (p.raceTime.getTime() - now.getTime()) / 60000;

      // -20分: 中間スナップショット (時系列観察用、フィルタは朝baseline使用)
      if (p.status === 'pending' && minsTo <= minutesBeforeBaseline && minsTo > minutesBeforeBet + 1) {
        await processBaseline(p);
      }

      // -7分: 投票
      if (minsTo <= minutesBeforeBet && minsTo > 1) {
        log(`▶ ${p.venueName}${p.raceNumber}R 投票実行 (発走${minsTo.toFixed(1)}分前)`);
        await processBet(p);
      }

      // -1分: 投票締切間近・諦め
      if (minsTo <= 1 && p.status !== 'bet' && p.status !== 'error') {
        log(`⏰ ${p.venueName}${p.raceNumber}R: 締切間近のためskip`);
        p.status = 'skipped';
      }
    }

    await new Promise(r => setTimeout(r, 30_000));
  }

  // 最終サマリ
  log('\n=== 結果サマリ ===');
  const counts = { pending: 0, baselined: 0, bet: 0, skipped: 0, error: 0 };
  for (const p of plans) counts[p.status]++;
  log(`  投票: ${counts.bet} / skip: ${counts.skipped} / error: ${counts.error}`);
  for (const p of plans.filter(p => p.status === 'error')) {
    log(`    ✗ ${p.venueName}${p.raceNumber}R: ${p.errorMsg}`);
  }

  // 終了時 Slack 通知
  const errorLines = plans.filter(p => p.status === 'error').map(p => `  ✗ ${p.venueName}${p.raceNumber}R: ${p.errorMsg}`);
  const errorBlock = errorLines.length > 0 ? `\n*失敗レース:*\n\`\`\`${errorLines.join('\n')}\`\`\`` : '';
  const indicator = counts.error > 0 ? '⚠️' : '🎯';
  await slackNotify(`${indicator} *本日 (${date}) のscheduler終了*\n投票: ${counts.bet} / skip: ${counts.skipped} / error: ${counts.error}${errorBlock}`);

  // 状態ファイル保存
  const stateFile = `${logDir}/scheduler-${date}.json`;
  writeFileSync(stateFile, JSON.stringify(plans.map(p => ({
    raceId: p.raceId, label: `${p.venueName}${p.raceNumber}R`,
    raceTime: p.raceTime.toISOString(), status: p.status,
    finalBets: p.finalBets, errorMsg: p.errorMsg,
  })), null, 2));
  log(`状態ファイル保存: ${stateFile}`);

  if (ipatBrowser) await ipatBrowser.close();
}

main().catch(e => {
  log(`致命エラー: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}).finally(() => db.close());
