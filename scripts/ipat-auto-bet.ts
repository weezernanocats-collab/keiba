/**
 * IPAT自動投票スクリプト (Playwright)
 *
 * しょーさん候補(スコア65+) × 1番人気 馬連を自動投票
 *
 * 使い方:
 *   npx tsx scripts/ipat-auto-bet.ts --date 2026-05-03
 *   npx tsx scripts/ipat-auto-bet.ts --date 2026-05-03 --amount 500
 *   npx tsx scripts/ipat-auto-bet.ts --date 2026-05-03 --dry-run
 *   npx tsx scripts/ipat-auto-bet.ts --csv /tmp/ipatgo_20260503.csv
 *
 * 環境変数 (.env.local):
 *   IPAT_INET_ID=xxxxxxxx     (8桁英数字)
 *   IPAT_MEMBER_NO=xxxxxxxx   (加入者番号8桁)
 *   IPAT_PASSWORD=xxxx        (暗証番号)
 *   IPAT_PARS_NO=xxxx         (P-ARS番号4桁)
 */
import { readFileSync, existsSync } from 'fs';
import { chromium } from 'playwright';

// .env.local読み込み
if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

// ── 引数パース ──
const args = process.argv.slice(2);
const getArg = (name: string) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
const headless = args.includes('--headless');
const csvPath = getArg('--csv');
const userName = getArg('--user'); // DBからユーザー認証情報を読む場合

const today = new Date();
today.setHours(today.getHours() + 9);
const date = getArg('--date') || today.toISOString().split('T')[0];
const amount = parseInt(getArg('--amount') || '100');
const budget = parseInt(getArg('--budget') || '0'); // 0なら--amount固定、>0ならbudgetを買い目数で等分

// ── IPAT認証情報（--user指定時はDBから暗号化済みを復号） ──
async function loadIpatCredentials() {
  if (userName) {
    const { createClient } = await import('@libsql/client');
    const { decrypt } = await import('../src/lib/credential-store');
    const db = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    });
    const rows = await db.execute({
      sql: 'SELECT encrypted_credentials, iv, auth_tag, display_name FROM ipat_users WHERE id = ?',
      args: [userName],
    });
    db.close();
    if (rows.rows.length === 0) {
      throw new Error(`ユーザー "${userName}" が見つかりません。register-ipat-user.ts で登録してください。`);
    }
    const row = rows.rows[0];
    const creds = decrypt(
      String(row.encrypted_credentials),
      String(row.iv),
      String(row.auth_tag),
    );
    console.log(`[ipat] ユーザー: ${row.display_name} (${userName})`);
    return creds;
  }
  return {
    inetId: process.env.IPAT_INET_ID || '',
    memberNo: process.env.IPAT_MEMBER_NO || '',
    password: process.env.IPAT_PASSWORD || '',
    parsNo: process.env.IPAT_PARS_NO || '',
  };
}

// デフォルト値（main内で上書き）
let IPAT = {
  inetId: process.env.IPAT_INET_ID || '',
  memberNo: process.env.IPAT_MEMBER_NO || '',
  password: process.env.IPAT_PASSWORD || '',
  parsNo: process.env.IPAT_PARS_NO || '',
};

// ── 競馬場コード → IPAT表示名マッピング ──
const VENUE_DISPLAY: Record<string, string> = {
  'SAPPORO': '札幌', 'HAKODATE': '函館', 'FUKUSHIMA': '福島',
  'NIIGATA': '新潟', 'TOKYO': '東京', 'NAKAYAMA': '中山',
  'CHUKYO': '中京', 'KYOTO': '京都', 'HANSHIN': '阪神', 'KOKURA': '小倉',
};

// ── 券種名マッピング ──
const BET_TYPE_DISPLAY: Record<string, string> = {
  'TANSYO': '単勝', 'FUKUSYO': '複勝', 'WAKUREN': '枠連',
  'UMAREN': '馬連', 'UMATAN': '馬単', 'WIDE': 'ワイド',
  'SANRENPUKU': '三連複', 'SANRENTAN': '三連単',
};

interface Bet {
  date: string;
  venue: string;       // IPAT会場コード (TOKYO等)
  venueName: string;   // 日本語 (東京等)
  raceNumber: number;
  betType: string;     // UMAREN等
  betTypeName: string; // 馬連等
  combo: string;       // "03-07" or "01-02-04-07" (box)
  horses: number[];    // [3, 7] or [1,2,4,7] (box)
  amount: number;      // 1点(1ペア)あたりの金額
  weight?: number;     // レース重み（予算配分用）
}

// 戦略設定ファイル読み込み (config/strategy-config.json)
interface StrategyConfig {
  dailyBudget: number;
  tanshoCap: number;
  matchScoreThreshold: number;
  scoreWeight: { highThreshold: number; highAmount: number; lowAmount: number };
  tansho?: { restDaysMin: number };
  umaren?: { enabled: boolean; perPoint: number; strategy?: string; popN?: number; scoreMin?: number; raceNumMin?: number; excludeGrades?: string[] };
  wideEnabled?: boolean;
  oddsRiseExcludeThreshold: number;
  raceWeight: {
    ageMult_3yoOnly: number;
    ageMult_default: number;
    gradeMult: Record<string, number>;
  };
}
function loadStrategyConfig(): StrategyConfig {
  const path = 'config/strategy-config.json';
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
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
const strategyConfig = loadStrategyConfig();
const tanshoRestDaysMin = strategyConfig.tansho?.restDaysMin ?? 50;
const umarenEnabled = strategyConfig.umaren?.enabled ?? true;
const umarenPerPoint = strategyConfig.umaren?.perPoint ?? 100;
const umarenStrategy = strategyConfig.umaren?.strategy ?? 'cand_box';
const umarenPopN = strategyConfig.umaren?.popN ?? 3;
const umarenScoreMin = strategyConfig.umaren?.scoreMin ?? strategyConfig.matchScoreThreshold;
const wideEnabled = strategyConfig.wideEnabled ?? false;

function computeRaceWeight(raceNumber: number, name: string, grade: string): number {
  const is3yoOnly = name.startsWith('3歳') && !name.includes('以上');
  const ageMult = is3yoOnly ? strategyConfig.raceWeight.ageMult_3yoOnly : strategyConfig.raceWeight.ageMult_default;
  const gradeMult = strategyConfig.raceWeight.gradeMult[grade] ?? strategyConfig.raceWeight.gradeMult.default;
  return raceNumber * ageMult * gradeMult;
}

// ── CSV読み込み or DB生成 ──
async function loadBets(): Promise<Bet[]> {
  if (csvPath) {
    return loadBetsFromCsv(csvPath);
  }
  return loadBetsFromDb();
}

function loadBetsFromCsv(path: string): Bet[] {
  const content = readFileSync(path, 'utf-8').trim();
  return content.split('\n').filter(l => l.trim()).map(line => {
    const [d, venue, race, betType, _method, _multi, combo, amt] = line.split(',');
    const horses = combo.split('-').map(Number);
    return {
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      venue,
      venueName: VENUE_DISPLAY[venue] || venue,
      raceNumber: parseInt(race),
      betType,
      betTypeName: BET_TYPE_DISPLAY[betType] || betType,
      combo,
      horses,
      amount: parseInt(amt),
    };
  });
}

async function loadBetsFromDb(): Promise<Bet[]> {
  const { createClient } = await import('@libsql/client');
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const VENUE_MAP: Record<string, string> = {
    '札幌': 'SAPPORO', '函館': 'HAKODATE', '福島': 'FUKUSHIMA',
    '新潟': 'NIIGATA', '東京': 'TOKYO', '中山': 'NAKAYAMA',
    '中京': 'CHUKYO', '京都': 'KYOTO', '阪神': 'HANSHIN', '小倉': 'KOKURA',
  };

  const rows = await db.execute({
    sql: `SELECT p.race_id, p.analysis_json, r.racecourse_name, r.race_number, r.name, r.grade
          FROM predictions p JOIN races r ON p.race_id = r.id
          WHERE r.date = ? AND p.analysis_json LIKE '%shosanPrediction%'
          ORDER BY r.racecourse_name, r.race_number`,
    args: [date],
  });

  const bets: Bet[] = [];
  for (const row of rows.rows) {
    const raceId = String(row.race_id);
    const venue = String(row.racecourse_name);
    const venueCode = VENUE_MAP[venue];
    if (!venueCode) continue;

    let analysis: {
      shosanPrediction?: {
        candidates?: Array<{ horseNumber: number; matchScore: number; theory?: number; restDays?: number }>;
      };
    } | null = null;
    if (row.analysis_json) {
      try { analysis = JSON.parse(String(row.analysis_json)); } catch {}
    }
    const sp = analysis?.shosanPrediction;
    const raceName = String(row.name || '');
    const grade = String(row.grade || '');
    const raceNumber = Number(row.race_number);
    const weight = computeRaceWeight(raceNumber, raceName, grade);

    // ── 馬連: しょーさん候補(matchScore>=55) ∪ オッズ1〜N位 を全頭ボックス ──
    if (umarenEnabled && sp) {
      const qualified = (sp.candidates || []).filter(c => (c.matchScore || 0) >= umarenScoreMin);
      if (qualified.length > 0) {
        const popRows = await db.execute({
          sql: `SELECT horse_number FROM race_entries WHERE race_id = ? AND odds > 0 ORDER BY odds ASC LIMIT ?`,
          args: [raceId, umarenPopN],
        });
        const popNums = popRows.rows.map(r => Number(r.horse_number));
        const candidateNums = qualified.map(c => Number(c.horseNumber));
        // 候補と人気を全部混ぜてボックス (全ペア)
        const boxHorses = [...new Set([...candidateNums, ...popNums])].sort((a, b) => a - b);
        if (boxHorses.length >= 2) {
          for (let i = 0; i < boxHorses.length; i++) {
            for (let j = i + 1; j < boxHorses.length; j++) {
              const pair = [boxHorses[i], boxHorses[j]];
              bets.push({
                date, venue: venueCode, venueName: venue, raceNumber,
                betType: 'UMAREN', betTypeName: '馬連',
                combo: pair.map(n => String(n).padStart(2, '0')).join('-'),
                horses: pair, amount: umarenPerPoint, weight,
              });
            }
          }
        }
      }
    }

    // ── 単勝: theory=1 ∩ 前走から N日以上空いた馬 (config: tansho.restDaysMin) ──
    // 既存の休養F (0-27 OR 56-69 OR 91-120) は撤廃、>=50日 (デフォルト) 一本化
    // matchScore別重み: >=65 は 200円、<65 は 100円
    if (sp) {
      const tanshoTargets = (sp.candidates || []).filter(c =>
        c.theory === 1 && (c.restDays ?? 0) >= tanshoRestDaysMin
      );
      for (const c of tanshoTargets) {
        const score = c.matchScore || 0;
        const tanshoAmount = score >= strategyConfig.scoreWeight.highThreshold ? strategyConfig.scoreWeight.highAmount : strategyConfig.scoreWeight.lowAmount;
        bets.push({
          date, venue: venueCode, venueName: venue, raceNumber,
          betType: 'TANSYO', betTypeName: '単勝',
          combo: String(c.horseNumber).padStart(2, '0'),
          horses: [c.horseNumber],
          amount: tanshoAmount,
          weight,
        });
      }
    }
  }
  db.close();
  return bets;
}

// ── 買い目をレース単位にグループ化 ──
function groupBets(bets: Bet[]) {
  const map = new Map<string, { venue: string; venueName: string; raceNumber: number; bets: Bet[] }>();
  for (const b of bets) {
    const key = `${b.venue}_${b.raceNumber}`;
    if (!map.has(key)) {
      map.set(key, { venue: b.venue, venueName: b.venueName, raceNumber: b.raceNumber, bets: [] });
    }
    map.get(key)!.bets.push(b);
  }
  return [...map.values()];
}

// ── 馬番ラベルクリック ──
async function clickHorseLabel(page: import('playwright').Page, horseNum: number) {
  const padded = String(horseNum).padStart(2, '0');
  // 1. for属性で直接検索（例: label[for='no01'], label[for='no1']）
  for (const forVal of [`no${padded}`, `no${horseNum}`]) {
    const label = page.locator(`label[for='${forVal}']`);
    if (await label.isVisible({ timeout: 500 }).catch(() => false)) {
      await label.click();
      return;
    }
  }
  // 2. for属性がno始まりのlabelからテキストマッチ
  const labels = page.locator("label[for^='no']");
  const count = await labels.count();
  for (let i = 0; i < count; i++) {
    const text = (await labels.nth(i).textContent().catch(() => ''))?.trim();
    if (text === String(horseNum) || text === padded) {
      await labels.nth(i).click();
      return;
    }
  }
  // 3. チェックボックス直接（フォールバック）
  const checkbox = page.locator(`input[type='checkbox'][value='${padded}'], input[type='checkbox'][value='${horseNum}']`).first();
  if (await checkbox.isVisible({ timeout: 500 }).catch(() => false)) {
    await checkbox.click();
    return;
  }
  throw new Error(`馬番 ${horseNum} のラベルが見つかりません`);
}

// ── メイン処理 ──
async function main() {
  // 0. 認証情報ロード（--user指定時はDBから復号）
  IPAT = await loadIpatCredentials();

  // 1. 買い目読み込み
  let bets = await loadBets();
  if (bets.length === 0) {
    console.log('対象の買い目がありません');
    return;
  }

  // 1.5 予算配分: --budget指定時 (単勝・馬連ともレース重みで比例配分)
  //   - 各bet の rawShare = baseAmount(b.amount) × race_weight
  //   - 合計 rawTotal で正規化 → 各bet amount = budget × rawShare / rawTotal
  //   - 100円単位丸め、最低100円
  //   - 合計が予算超過 → 低weight順に削除
  if (budget > 0 && bets.length > 0) {
    const items = bets.map(b => ({ bet: b, base: b.amount, weight: b.weight || 1 }));
    const rawTotal = items.reduce((s, x) => s + x.base * x.weight, 0);
    if (rawTotal > 0) {
      for (const x of items) {
        const target = budget * (x.base * x.weight) / rawTotal;
        x.bet.amount = Math.max(100, Math.floor(target / 100) * 100);
      }
    }
    // 予算オーバーチェック (低weight順に削除)
    let totalSpent = bets.reduce((s, b) => {
      if (b.betType === 'WIDE') {
        const n = b.horses.length;
        const pairs = Math.max(1, n * (n - 1) / 2);
        return s + b.amount * pairs;
      }
      return s + b.amount;
    }, 0);
    if (totalSpent > budget) {
      const sorted = [...bets].sort((a, b) => (a.weight || 0) - (b.weight || 0));
      for (const b of sorted) {
        if (totalSpent <= budget) break;
        const cost = b.betType === 'WIDE'
          ? b.amount * Math.max(1, b.horses.length * (b.horses.length - 1) / 2)
          : b.amount;
        bets = bets.filter(x => x !== b);
        totalSpent -= cost;
      }
    }
    const tCnt = bets.filter(b => b.betType === 'TANSYO').length;
    const tSum = bets.filter(b => b.betType === 'TANSYO').reduce((s, b) => s + b.amount, 0);
    const uCnt = bets.filter(b => b.betType === 'UMAREN').length;
    const uSum = bets.filter(b => b.betType === 'UMAREN').reduce((s, b) => s + b.amount, 0);
    console.log(`[budget] 予算${budget}円 → 単勝${tSum}円(${tCnt}点) + 馬連${uSum}円(${uCnt}点) = ${totalSpent}円 (重み配分)`);
  }

  // 各買い目の合計金額計算
  // 馬連は horses=[a,b] の2頭ペア=1点なので amount そのまま
  const totalAmount = bets.reduce((s, b) => {
    if (b.betType === 'WIDE') {
      const n = b.horses.length;
      const pairs = Math.max(1, n * (n - 1) / 2);
      return s + b.amount * pairs;
    }
    return s + b.amount;
  }, 0);
  console.log(`\n[ipat] ${date} 自動投票`);
  console.log(`  対象: ${bets.length}件 (合計 ${totalAmount.toLocaleString()}円)`);
  if (dryRun) console.log('  ⚠ dry-runモード: 投票確定せずに停止します');
  console.log('');

  for (const b of bets) {
    if (b.betType === 'WIDE') {
      const n = b.horses.length;
      const pairs = Math.max(1, n * (n - 1) / 2);
      const raceTotal = b.amount * pairs;
      console.log(`  ${b.venueName}${b.raceNumber}R ワイドボックス ${b.combo} (${pairs}点 × ${b.amount}円 = ${raceTotal}円, w=${(b.weight || 0).toFixed(1)})`);
    } else if (b.betType === 'UMAREN') {
      console.log(`  ${b.venueName}${b.raceNumber}R 馬連 ${b.combo} ${b.amount}円 (候補×1番人気, w=${(b.weight || 0).toFixed(1)})`);
    } else {
      console.log(`  ${b.venueName}${b.raceNumber}R 単勝 ${b.combo}番 ${b.amount}円 (休養F理論1)`);
    }
  }
  console.log('');

  // 2. 認証情報チェック
  if (!IPAT.inetId || !IPAT.memberNo || !IPAT.password || !IPAT.parsNo) {
    console.error('IPAT認証情報が不足しています。.env.local に以下を設定してください:');
    console.error('  IPAT_INET_ID=xxxxxxxx');
    console.error('  IPAT_MEMBER_NO=xxxxxxxx');
    console.error('  IPAT_PASSWORD=xxxx');
    console.error('  IPAT_PARS_NO=xxxx');
    process.exit(1);
  }

  // 3. ブラウザ起動（--headlessでバックグラウンド実行）
  console.log(`[ipat] ブラウザ起動${headless ? ' (headless)' : ''}...`);
  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 300 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  try {
    // 4. IPATログイン（2段階）
    console.log('[ipat] ログイン中...');
    await page.goto('https://www.ipat.jra.go.jp/index.cgi');
    await page.waitForLoadState('domcontentloaded');
    await wait(2000);

    // Step 1: INET ID
    const inetInput = page.locator("input[name^='inetid']").first();
    await inetInput.waitFor({ timeout: 10000 });
    await inetInput.fill(IPAT.inetId);
    await wait(500);
    await page.locator("a[onclick^='javascript'], a[onclick^='JavaScript']").first().click();
    await wait(3000);

    // Step 2: 暗証番号 + 加入者番号 + P-ARS番号
    const pwInputs = page.locator("input[name^='p']");
    await pwInputs.first().waitFor({ timeout: 10000 });
    await pwInputs.first().fill(IPAT.password);
    await wait(300);

    const iInputs = page.locator("input[name^='i']");
    // 加入者番号は3番目のinput[name^='i']（0-indexed: 2）
    const memberInput = iInputs.nth(2);
    await memberInput.fill(IPAT.memberNo);
    await wait(300);

    const rInputs = page.locator("input[name^='r']");
    // P-ARS番号は2番目のinput[name^='r']（0-indexed: 1）
    await rInputs.nth(1).fill(IPAT.parsNo);
    await wait(300);

    await page.locator("a[onclick^='JavaScript'], a[onclick^='javascript']").first().click();
    await wait(3000);
    console.log('[ipat] ログイン完了');

    // 5. 通常投票画面へ
    console.log('[ipat] 通常投票画面へ...');
    const betBasicBtn = page.locator("button[href^='#!/bet/basic'], a[href^='#!/bet/basic']").first();
    await betBasicBtn.waitFor({ timeout: 10000 });
    await betBasicBtn.click();
    await wait(2000);

    // 6. 買い目をグループ化して投票
    const groups = groupBets(bets);
    let betCount = 0;

    for (const group of groups) {
      console.log(`\n[ipat] ${group.venueName}${group.raceNumber}R に移動...`);

      // 会場・レース選択: ボタンモード（初回）またはプルダウンモード（セット後）
      await page.evaluate(() => window.scrollTo(0, 0));
      await wait(500);

      const courseBtnVisible = await page.locator("button[ng-click*='selectCourse']").first()
        .isVisible({ timeout: 1000 }).catch(() => false);

      if (courseBtnVisible) {
        // ボタンモード（初回表示時）
        const venueButtons = page.locator("button[ng-click*='selectCourse']");
        const venueCount = await venueButtons.count();
        let venueFound = false;
        for (let i = 0; i < venueCount; i++) {
          const text = await venueButtons.nth(i).textContent().catch(() => '');
          if (text?.includes(group.venueName)) {
            await venueButtons.nth(i).click();
            venueFound = true;
            break;
          }
        }
        if (!venueFound) {
          console.warn(`  ⚠ ${group.venueName} が見つかりません、スキップ`);
          continue;
        }
        await wait(1500);

        // レースボタン選択
        const raceButtons = page.locator("button[ng-click*='selectRace']");
        await wait(1000);
        const raceCount = await raceButtons.count().catch(() => 0);
        let raceFound = false;
        const racePattern = `${group.raceNumber}R`;
        for (let i = 0; i < raceCount; i++) {
          const text = (await raceButtons.nth(i).textContent().catch(() => ''))?.trim();
          if (text?.startsWith(racePattern)) {
            await raceButtons.nth(i).click();
            raceFound = true;
            break;
          }
        }
        if (!raceFound) {
          console.warn(`  ⚠ ${group.raceNumber}R が見つかりません、スキップ`);
          await page.screenshot({ path: `/tmp/ipat_debug_race_notfound_${group.venueName}${group.raceNumber}.png` });
          continue;
        }
      } else {
        // プルダウンモード（セット後）
        const courseSelect = page.locator("select[ng-model='vm.cSelectedCourseId']");
        await courseSelect.waitFor({ timeout: 5000 });
        // テキストラベルで選択（例: "東京(日)" → "東京"を含むオプション）
        const courseOptions = await courseSelect.locator('option').all();
        let courseSelected = false;
        for (const opt of courseOptions) {
          const text = await opt.textContent().catch(() => '');
          if (text?.includes(group.venueName)) {
            const val = await opt.getAttribute('value');
            if (val) {
              await courseSelect.selectOption(val);
              courseSelected = true;
              break;
            }
          }
        }
        if (!courseSelected) {
          console.warn(`  ⚠ ${group.venueName} が見つかりません、スキップ`);
          continue;
        }
        await wait(1000);

        // レースプルダウン選択
        const raceSelect = page.locator("select[ng-model='vm.oSelectedJgRn']");
        await raceSelect.waitFor({ timeout: 5000 });
        const raceOptions = await raceSelect.locator('option').all();
        let raceSelected = false;
        const racePattern = `${group.raceNumber}R`;
        for (const opt of raceOptions) {
          const text = (await opt.textContent().catch(() => ''))?.trim();
          if (text?.startsWith(racePattern)) {
            const val = await opt.getAttribute('value');
            if (val) {
              await raceSelect.selectOption(val);
              raceSelected = true;
              break;
            }
          }
        }
        if (!raceSelected) {
          console.warn(`  ⚠ ${group.raceNumber}R が見つかりません、スキップ`);
          await page.screenshot({ path: `/tmp/ipat_debug_race_notfound_${group.venueName}${group.raceNumber}.png` });
          continue;
        }
      }
      console.log(`  会場 ${group.venueName} / レース ${group.raceNumber}R 選択`);
      await wait(1500);

      // 各買い目を投票
      for (const bet of group.bets) {
        console.log(`  ${bet.betTypeName} ${bet.combo} ${bet.amount}円 をセット中...`);

        // 券種選択
        const typeSelect = page.locator("select[ng-model*='oSelectType']").first();
        await typeSelect.waitFor({ timeout: 5000 });
        await typeSelect.selectOption({ label: bet.betTypeName });
        await wait(800);

        const isTansho = bet.betType === 'TANSYO' || bet.betType === 'FUKUSYO';

        if (isTansho) {
          // 単勝・複勝: 方式選択なし、1頭クリックするだけ
          const horseNum = bet.horses[0];
          await clickHorseLabel(page, horseNum);
          await wait(500);
        } else {
          // 馬連等: ボックスで2頭選択
          const methodSelect = page.locator("select[ng-model*='oSelectMethod']").first();
          await methodSelect.waitFor({ timeout: 5000 });
          await methodSelect.selectOption({ label: 'ボックス' });
          await wait(800);

          for (const h of bet.horses) {
            await clickHorseLabel(page, h);
            await wait(300);
          }
          await wait(500);
        }

        // 金額入力（100円単位 → IPAT入力は100円を1として入力）
        const amountInput = page.locator("input[ng-model*='nUnit']").first();
        await amountInput.waitFor({ timeout: 5000 });
        await amountInput.fill(String(bet.amount / 100));
        await wait(300);

        // セットボタン
        const setBtn = page.locator("button[ng-click*='onSet()']").first();
        await setBtn.waitFor({ timeout: 5000 });
        await setBtn.click();
        await wait(1500);
        betCount++;
        console.log(`    ✓ セット完了 (${betCount}/${bets.length})`);

        // セット後のスクリーンショットとUI要素ダンプ（デバッグ用、初回のみ）
        if (betCount === 1) {
          await page.screenshot({ path: '/tmp/ipat_debug_after_set.png' });
          const headerEls = await page.evaluate(() => {
            const els: string[] = [];
            document.querySelectorAll('select, [class*="course"], [class*="race"], [class*="jou"], [class*="sel"]').forEach(el => {
              const tag = el.tagName;
              const cls = el.className;
              const text = (el.textContent || '').trim().slice(0, 80);
              const ngModel = el.getAttribute('ng-model') || '';
              const ngClick = el.getAttribute('ng-click') || '';
              const ngChange = el.getAttribute('ng-change') || '';
              els.push(`${tag} class="${cls}" ngModel="${ngModel}" ngClick="${ngClick}" ngChange="${ngChange}" text="${text}"`);
            });
            return els;
          });
          console.log('[debug] セット後のUI要素:');
          for (const e of headerEls) console.log('  ' + e);
        }
      }
    }

    if (betCount === 0) {
      console.log('\n[ipat] セットされた買い目がありません');
      await browser.close();
      return;
    }

    // 7. 投票一覧表示
    console.log(`\n[ipat] 全${betCount}点セット完了 → 投票一覧へ`);
    const showListBtn = page.locator("button[ng-click*='onShowBetList()']").first();
    await showListBtn.waitFor({ timeout: 5000 });
    await showListBtn.click();
    await wait(2000);

    // 合計金額を取得
    const totalSpan = page.locator("span[ng-bind*='getCalcTotalAmount']").first();
    let displayedTotal = '';
    if (await totalSpan.isVisible({ timeout: 3000 }).catch(() => false)) {
      displayedTotal = (await totalSpan.textContent())?.trim() || '';
    }
    console.log(`[ipat] 投票一覧: 合計 ${displayedTotal || totalAmount.toLocaleString() + '円'}`);

    if (dryRun) {
      console.log('\n[ipat] ⚠ dry-runモード: ここで停止します');
      console.log('[ipat] ブラウザは開いたままです。手動で確認/投票できます。');
      console.log('[ipat] Ctrl+C で終了');
      // ブラウザを閉じずに待機
      await new Promise(() => {});
      return;
    }

    // 8. 合計金額入力 → 購入確定
    console.log('[ipat] 投票確定処理...');
    const totalInput = page.locator("input[ng-model*='cAmountTotal']").first();
    await totalInput.waitFor({ timeout: 5000 });
    await totalInput.fill(String(totalAmount));
    await wait(500);

    // 購入ボタン
    const purchaseBtn = page.locator("button[ng-click*='clickPurchase()']").first();
    await purchaseBtn.click();
    await wait(2000);

    // 最終確認ダイアログ
    const confirmBtn = page.locator("button[ng-click*='dismiss()']").nth(1);
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmBtn.click();
      await wait(2000);
    }

    console.log(`\n[ipat] 投票完了! ${betCount}点 ${totalAmount.toLocaleString()}円`);

    // スクリーンショット保存
    await page.screenshot({ path: `/tmp/ipat_result_${date.replace(/-/g, '')}.png` });
    console.log(`[ipat] スクリーンショット: /tmp/ipat_result_${date.replace(/-/g, '')}.png`);

    await wait(5000);
    await browser.close();

  } catch (error) {
    console.error('\n[ipat] エラー:', error instanceof Error ? error.message : error);
    // エラー時もスクリーンショットを保存
    try {
      await page.screenshot({ path: `/tmp/ipat_error_${Date.now()}.png` });
      console.log(`[ipat] エラー時スクリーンショット保存済み`);
    } catch {}
    console.log('[ipat] ブラウザは開いたままです。Ctrl+C で終了');
    await new Promise(() => {});
  }
}

main().catch(e => { console.error(e); process.exit(1); });
