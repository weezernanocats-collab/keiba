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
const budget = parseInt(getArg('--budget') || '10000');
const riseThreshold = parseFloat(getArg('--filter-odds-rise') || '0.3');
const minutesBeforeBet = parseInt(getArg('--minutes-before') || '7');
const minutesBeforeBaseline = parseInt(getArg('--baseline-before') || '20');
const SCORE_THRESHOLD = 55;

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
  type: 'WIDE' | 'TANSYO';
  horses: number[];     // ワイドは複数、単勝は1頭
  amount: number;       // 1ペアor1点あたり
  tag: string;          // 識別用 (e.g., "wide:基本", "tansho:休養F理論1")
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
  // (2026-05-11更新) 中堅クラス(1勝/2勝)を厚く、オープン以上を薄く調整
  const is3yo = name.startsWith('3歳') && !name.includes('以上');
  const ageMult = is3yo ? 0.5 : 1.0;
  let g = 1.0;
  if (grade === 'G1') g = 0.7;
  else if (grade === 'G2') g = 0.8;
  else if (grade === 'G3') g = 0.9;
  else if (grade === 'リステッド' || grade === 'OP' || grade === 'オープン') g = 1.0;
  else if (grade === '3勝クラス') g = 1.3;
  else if (grade === '2勝クラス') g = 1.5;
  else if (grade === '1勝クラス') g = 1.4;
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
    try { a = JSON.parse(String(row.analysis_json)); } catch { continue; }
    const sp = a?.shosanPrediction;
    if (!sp) continue;
    const rname = String(row.name || ''), rgrade = String(row.grade || '');
    const weight = computeRaceWeight(Number(row.race_number), rname, rgrade);

    const initialBets: BetItem[] = [];

    // ── ワイドボックス ──
    const qualified = (sp.candidates || []).filter((c: any) => (c.matchScore || 0) >= SCORE_THRESHOLD);
    let candidateNums: number[] = [];
    let popularNums: number[] = [];
    if (qualified.length > 0) {
      const top3 = await db.execute({ sql: `SELECT horse_number FROM race_entries WHERE race_id = ? AND odds > 0 ORDER BY odds ASC LIMIT 3`, args: [raceId] });
      if (top3.rows.length >= 3) {
        popularNums = top3.rows.map(x => Number(x.horse_number));
        candidateNums = qualified.map((c: any) => Number(c.horseNumber));
        if (!candidateNums.some(n => popularNums.includes(n))) {
          const horses = [...new Set([...candidateNums, ...popularNums])].sort((x, y) => x - y);
          if (horses.length >= 2) {
            initialBets.push({ type: 'WIDE', horses, amount: 0, tag: 'wide:候補+1-3人気' });
          }
        }
      }
    }

    // ── 単勝(休養F+理論1) ──
    const restT1 = (sp.restFilteredCandidates || []).filter((c: any) => c.theory === 1);
    for (const c of restT1) {
      initialBets.push({ type: 'TANSYO', horses: [Number(c.horseNumber)], amount: 100, tag: 'tansho:休養F理論1' });
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
  // 単勝: 100円固定 × 件数。上限 budget*0.5
  const allTansho = plans.flatMap(p => p.initialBets.filter(b => b.type === 'TANSYO'));
  const tanshoCap = Math.floor(budget * 0.5);
  const maxT = Math.floor(tanshoCap / 100);
  // 先頭から最大件数まで採用
  const keepSet = new Set(allTansho.slice(0, maxT));
  for (const p of plans) {
    p.initialBets = p.initialBets.filter(b => b.type !== 'TANSYO' || keepSet.has(b));
  }
  const tanshoSpent = [...keepSet].length * 100;

  // ワイド: 残予算をレース重みで按分
  const wideRaces = plans.filter(p => p.initialBets.some(b => b.type === 'WIDE'));
  const wideBudget = budget - tanshoSpent;
  if (wideRaces.length > 0 && wideBudget > 0) {
    const totalW = wideRaces.reduce((s, p) => s + p.weight, 0);
    for (const p of wideRaces) {
      const rb = wideBudget * p.weight / totalW;
      for (const b of p.initialBets) {
        if (b.type !== 'WIDE') continue;
        const n = b.horses.length;
        const pairs = (n * (n - 1)) / 2;
        b.amount = Math.max(100, Math.floor(rb / pairs / 100) * 100);
      }
    }
  }

  log(`[budget] 予算${budget}円 → 単勝${tanshoSpent}円(${[...keepSet].length}点) + ワイド残予算${wideBudget}円(${wideRaces.length}レース)`);
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
    } else {
      // WIDE: 該当馬を除外
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
      // 元のamountを維持 (1ペアあたり); ペア数が減れば総額減
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
    // dry-run時はブラウザ起動しない
    throw new Error('dry-run mode: not opening browser');
  }

  log('[ipat] ブラウザ起動 + ログイン中...');
  ipatBrowser = await chromium.launch({ headless, slowMo: headless ? 0 : 200 });
  const context = await ipatBrowser.newContext({ viewport: { width: 1280, height: 900 } });
  ipatPage = await context.newPage();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  await ipatPage.goto('https://www.ipat.jra.go.jp/index.cgi');
  await ipatPage.waitForLoadState('domcontentloaded');
  await wait(2000);

  const inetInput = ipatPage.locator("input[name^='inetid']").first();
  await inetInput.waitFor({ timeout: 10000 });
  await inetInput.fill(process.env.IPAT_INET_ID || '');
  await wait(500);
  await ipatPage.locator("a[onclick^='javascript'], a[onclick^='JavaScript']").first().click();
  await wait(3000);

  const pwInputs = ipatPage.locator("input[name^='p']");
  await pwInputs.first().waitFor({ timeout: 10000 });
  await pwInputs.first().fill(process.env.IPAT_PASSWORD || '');
  await wait(300);
  const iInputs = ipatPage.locator("input[name^='i']");
  await iInputs.nth(2).fill(process.env.IPAT_MEMBER_NO || '');
  await wait(300);
  const rInputs = ipatPage.locator("input[name^='r']");
  await rInputs.nth(1).fill(process.env.IPAT_PARS_NO || '');
  await wait(300);
  await ipatPage.locator("a[onclick^='JavaScript'], a[onclick^='javascript']").first().click();
  await wait(3000);
  log('[ipat] ログイン完了');

  // 通常投票画面
  const betBasicBtn = ipatPage.locator("button[href^='#!/bet/basic'], a[href^='#!/bet/basic']").first();
  await betBasicBtn.waitFor({ timeout: 10000 });
  await betBasicBtn.click();
  await wait(2000);

  return ipatPage;
}

async function clickHorseLabel(page: Page, horseNum: number) {
  const padded = String(horseNum).padStart(2, '0');
  const label = page.locator(`label[for$='_${padded}']`).first();
  if (await label.isVisible({ timeout: 500 }).catch(() => false)) {
    await label.click();
    return;
  }
  const checkbox = page.locator(`input[id$='_${padded}']`).first();
  if (await checkbox.isVisible({ timeout: 500 }).catch(() => false)) {
    await checkbox.click();
    return;
  }
  throw new Error(`馬番 ${horseNum} のラベルが見つかりません`);
}

async function submitBetsForRace(plan: RacePlan, finalBets: BetItem[]) {
  if (dryRun) {
    log(`[dry] ${plan.venueName}${plan.raceNumber}R 投票スキップ`);
    for (const b of finalBets) {
      if (b.type === 'WIDE') log(`  ワイド[${b.horses.join(',')}] ${b.amount}円/ペア`);
      else log(`  単勝 ${b.horses[0]}番 ${b.amount}円`);
    }
    return;
  }
  const page = await ensureIpatLogin();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  log(`[ipat] ${plan.venueName}${plan.raceNumber}R に移動...`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(500);

  // 会場・レース選択 (簡略版: 既にbasicモードに居る前提)
  const courseSelectVisible = await page.locator("select[ng-model='vm.cSelectedCourseId']").isVisible({ timeout: 1000 }).catch(() => false);
  if (courseSelectVisible) {
    // プルダウンモード
    const courseSelect = page.locator("select[ng-model='vm.cSelectedCourseId']");
    const options = await courseSelect.locator('option').all();
    for (const opt of options) {
      const t = await opt.textContent().catch(() => '');
      if (t?.includes(plan.venueName)) {
        const v = await opt.getAttribute('value');
        if (v) { await courseSelect.selectOption(v); break; }
      }
    }
    await wait(1000);
    const raceSelect = page.locator("select[ng-model='vm.cSelectedRaceNumber']");
    await raceSelect.selectOption(String(plan.raceNumber));
    await wait(1500);
  } else {
    // ボタンモード (初回)
    const venueBtns = page.locator("button[ng-click*='selectCourse']");
    const vc = await venueBtns.count();
    for (let i = 0; i < vc; i++) {
      const t = await venueBtns.nth(i).textContent().catch(() => '');
      if (t?.includes(plan.venueName)) { await venueBtns.nth(i).click(); break; }
    }
    await wait(1500);
    const raceBtns = page.locator("button[ng-click*='selectRace']");
    const rc = await raceBtns.count().catch(() => 0);
    const pattern = `${plan.raceNumber}R`;
    for (let i = 0; i < rc; i++) {
      const t = (await raceBtns.nth(i).textContent().catch(() => ''))?.trim();
      if (t?.startsWith(pattern)) { await raceBtns.nth(i).click(); break; }
    }
    await wait(1500);
  }

  // 各買い目を投入
  for (const b of finalBets) {
    const label = b.type === 'WIDE' ? 'ワイド' : '単勝';
    log(`  ${label} [${b.horses.join(',')}] ${b.amount}円 をセット中...`);

    const typeSelect = page.locator("select[ng-model*='oSelectType']").first();
    await typeSelect.waitFor({ timeout: 5000 });
    await typeSelect.selectOption({ label });
    await wait(800);

    if (b.type === 'TANSYO') {
      await clickHorseLabel(page, b.horses[0]);
      await wait(500);
    } else {
      const methodSelect = page.locator("select[ng-model*='oSelectMethod']").first();
      await methodSelect.waitFor({ timeout: 5000 });
      await methodSelect.selectOption({ label: 'ボックス' });
      await wait(800);
      for (const h of b.horses) { await clickHorseLabel(page, h); await wait(300); }
      await wait(500);
    }

    const amountInput = page.locator("input[ng-model*='nUnit']").first();
    await amountInput.waitFor({ timeout: 5000 });
    await amountInput.fill(String(b.amount / 100));
    await wait(300);

    const setBtn = page.locator("button[ng-click*='onSet()']").first();
    await setBtn.waitFor({ timeout: 5000 });
    await setBtn.click();
    await wait(1500);
  }

  // 投票一覧 → 確定
  log('  投票確定処理...');
  // 投票一覧ボタン (画面下部)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(500);
  const summaryBtn = page.locator("button[ng-click*='showList'], button[ng-click*='showBetList']").first();
  if (await summaryBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await summaryBtn.click();
    await wait(2000);
  }
  // 投票確定
  const confirmBtn = page.locator("button[ng-click*='onVoteConfirm'], button[ng-click*='confirmVote']").first();
  if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await confirmBtn.click();
    await wait(2000);
    // 確認ダイアログのOK
    const okBtn = page.locator("button[ng-click*='ok'], button:has-text('OK')").first();
    if (await okBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await okBtn.click();
      await wait(2000);
    }
  }
  log(`  ✓ ${plan.venueName}${plan.raceNumber}R 投票完了`);
}

// ── メイン処理 ──
async function processBet(plan: RacePlan) {
  try {
    // 1. 直前オッズ fetch
    plan.currentOdds = await fetchCurrentOdds(plan.raceId);
    await saveOddsSnapshot(plan.raceId, plan.currentOdds);

    // 2. baseline 取得
    plan.baselineOdds = await getBaselineOdds(plan.raceId);

    // 3. フィルタ適用
    plan.finalBets = applyOddsFilter(plan);
    if (plan.finalBets.length === 0) {
      log(`  ${plan.venueName}${plan.raceNumber}R: フィルタ後ベットなし → skip`);
      plan.status = 'skipped';
      return;
    }

    // 4. IPAT投票
    await submitBetsForRace(plan, plan.finalBets);
    plan.status = 'bet';
  } catch (e) {
    plan.status = 'error';
    plan.errorMsg = (e as Error).message;
    log(`  ✗ ${plan.venueName}${plan.raceNumber}R: ${plan.errorMsg}`);
  }
}

async function processBaseline(plan: RacePlan) {
  try {
    const odds = await fetchCurrentOdds(plan.raceId);
    if (odds.size > 0) {
      await saveOddsSnapshot(plan.raceId, odds);
      plan.status = 'baselined';
      log(`  📷 ${plan.venueName}${plan.raceNumber}R baseline記録 (${odds.size}頭)`);
    }
  } catch (e) {
    log(`  ⚠ ${plan.venueName}${plan.raceNumber}R baseline失敗: ${(e as Error).message}`);
  }
}

function nowJst(): Date {
  // Node の new Date() はシステムTZに依存。launchdで起動するMacはJST想定。
  return new Date();
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
  for (const p of plans) {
    const tStr = p.raceTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const wide = p.initialBets.find(b => b.type === 'WIDE');
    const tans = p.initialBets.filter(b => b.type === 'TANSYO');
    const wideStr = wide ? `ワイド[${wide.horses.join(',')}]×${wide.amount}円` : '';
    const tansStr = tans.length > 0 ? `単勝[${tans.map(t => t.horses[0]).join(',')}]×100円` : '';
    log(`  ${tStr} ${p.venueName}${p.raceNumber}R w=${p.weight.toFixed(1)} ${wideStr} ${tansStr}`);
  }

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

      // -20分: baseline取得 (まだ取ってなければ)
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
