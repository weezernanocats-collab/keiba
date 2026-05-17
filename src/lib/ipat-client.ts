/**
 * IPAT 自動操作の共有モジュール
 *
 * scripts/ipat-auto-bet.ts と scripts/ipat-race-scheduler.ts から
 * 共通で使用する。実装の二重化を防ぐため、IPAT UI 操作は全てここに集約する。
 *
 * 動作実績: ipat-auto-bet.ts の本番稼働実績(2026-05-09 以降)に基づく。
 * セレクタ変更が必要な場合はここを修正すれば両スクリプトに反映される。
 */
import type { Page } from 'playwright';

export interface IpatCredentials {
  inetId: string;
  memberNo: string;
  password: string;
  parsNo: string;
}

export interface IpatBet {
  type: 'TANSYO' | 'FUKUSYO' | 'WIDE' | 'UMAREN' | 'UMATAN' | 'SANRENPUKU' | 'SANRENTAN' | 'WAKUREN';
  horses: number[];       // 単勝/複勝は1頭、その他は2-N頭
  amount: number;         // 1点(ボックスの場合1ペア)あたりの金額(円)
}

const BET_TYPE_LABEL: Record<string, string> = {
  TANSYO: '単勝',
  FUKUSYO: '複勝',
  WAKUREN: '枠連',
  UMAREN: '馬連',
  UMATAN: '馬単',
  WIDE: 'ワイド',
  SANRENPUKU: '3連複',
  SANRENTAN: '3連単',
};

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── 馬番ラベルクリック ──
export async function clickHorseLabel(page: Page, horseNum: number, logFn: (s: string) => void = () => {}): Promise<void> {
  const padded = String(horseNum).padStart(2, '0');
  // 1. for属性で直接検索 (例: label[for='no01'], label[for='no1'])
  for (const forVal of [`no${padded}`, `no${horseNum}`]) {
    const label = page.locator(`label[for='${forVal}']`);
    if (await label.isVisible({ timeout: 500 }).catch(() => false)) {
      try { await label.click({ timeout: 3000 }); return; } catch {}
    }
  }
  // 2. label[for^='no'] テキストマッチ
  const labels = page.locator("label[for^='no']");
  const count = await labels.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const text = (await labels.nth(i).textContent().catch(() => ''))?.trim();
    if (text === String(horseNum) || text === padded) {
      try { await labels.nth(i).click({ timeout: 3000 }); return; } catch {}
    }
  }
  // 3. checkbox value 検索 (フォールバック)
  const checkbox = page.locator(`input[type='checkbox'][value='${padded}'], input[type='checkbox'][value='${horseNum}']`).first();
  if (await checkbox.isVisible({ timeout: 500 }).catch(() => false)) {
    try { await checkbox.click({ timeout: 3000 }); return; } catch {}
  }
  // 失敗時診断
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `/tmp/ipat_click_fail_${horseNum}_${ts}.png`;
    await page.screenshot({ path, fullPage: false });
    logFn(`📸 失敗スクショ: ${path}`);
    const labelFors = await page.locator('label[for]').evaluateAll(els => (els as HTMLLabelElement[]).map(e => e.htmlFor)).catch(() => []);
    logFn(`DOM labels(for): ${labelFors.slice(0, 30).join(', ')}`);
  } catch {}
  throw new Error(`馬番 ${horseNum} のラベルが見つかりません`);
}

// ── IPAT 2段階ログイン ──
export async function loginToIpat(page: Page, creds: IpatCredentials): Promise<void> {
  if (!creds.inetId || !creds.memberNo || !creds.password || !creds.parsNo) {
    throw new Error('IPAT認証情報が不足しています (INET_ID/MEMBER_NO/PASSWORD/PARS_NO)');
  }

  await page.goto('https://www.ipat.jra.go.jp/index.cgi');
  await page.waitForLoadState('domcontentloaded');
  await wait(2000);

  // Step 1: INET ID
  const inetInput = page.locator("input[name^='inetid']").first();
  await inetInput.waitFor({ timeout: 10000 });
  await inetInput.fill(creds.inetId);
  await wait(500);
  await page.locator("a[onclick^='javascript'], a[onclick^='JavaScript']").first().click();
  await wait(3000);

  // Step 2: 暗証番号 + 加入者番号 + P-ARS番号
  const pwInputs = page.locator("input[name^='p']");
  await pwInputs.first().waitFor({ timeout: 10000 });
  await pwInputs.first().fill(creds.password);
  await wait(300);

  const iInputs = page.locator("input[name^='i']");
  // 加入者番号は3番目のinput[name^='i']（0-indexed: 2）
  await iInputs.nth(2).fill(creds.memberNo);
  await wait(300);

  const rInputs = page.locator("input[name^='r']");
  // P-ARS番号は2番目のinput[name^='r']（0-indexed: 1）
  await rInputs.nth(1).fill(creds.parsNo);
  await wait(300);

  await page.locator("a[onclick^='JavaScript'], a[onclick^='javascript']").first().click();
  await wait(3000);
}

// ── 通常投票画面へ ──
export async function navigateToBetBasic(page: Page): Promise<void> {
  const betBasicBtn = page.locator("button[href^='#!/bet/basic'], a[href^='#!/bet/basic']").first();
  await betBasicBtn.waitFor({ timeout: 10000 });
  await betBasicBtn.click();
  await wait(2000);
}

// ── 会場・レース選択 ──
export async function selectVenueAndRace(page: Page, venueName: string, raceNumber: number, logFn: (s: string) => void = () => {}): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(500);

  // ボタンモード(初回) or プルダウンモード(セット後)
  const courseBtnVisible = await page.locator("button[ng-click*='selectCourse']").first()
    .isVisible({ timeout: 1000 }).catch(() => false);

  if (courseBtnVisible) {
    // ボタンモード
    const venueButtons = page.locator("button[ng-click*='selectCourse']");
    const venueCount = await venueButtons.count();
    let venueFound = false;
    for (let i = 0; i < venueCount; i++) {
      const t = await venueButtons.nth(i).textContent().catch(() => '');
      if (t?.includes(venueName)) {
        await venueButtons.nth(i).click();
        venueFound = true;
        break;
      }
    }
    if (!venueFound) throw new Error(`${venueName} ボタンが見つかりません`);
    await wait(1500);

    const raceButtons = page.locator("button[ng-click*='selectRace']");
    await wait(1000);
    const raceCount = await raceButtons.count().catch(() => 0);
    let raceFound = false;
    const racePattern = `${raceNumber}R`;
    for (let i = 0; i < raceCount; i++) {
      const t = (await raceButtons.nth(i).textContent().catch(() => ''))?.trim();
      if (t?.startsWith(racePattern)) {
        await raceButtons.nth(i).click();
        raceFound = true;
        break;
      }
    }
    if (!raceFound) {
      await page.screenshot({ path: `/tmp/ipat_race_notfound_${venueName}${raceNumber}.png` }).catch(() => {});
      throw new Error(`${raceNumber}R ボタンが見つかりません`);
    }
  } else {
    // プルダウンモード
    const courseSelect = page.locator("select[ng-model='vm.cSelectedCourseId']");
    await courseSelect.waitFor({ timeout: 5000 });
    const courseOptions = await courseSelect.locator('option').all();
    let courseSelected = false;
    for (const opt of courseOptions) {
      const t = await opt.textContent().catch(() => '');
      if (t?.includes(venueName)) {
        const v = await opt.getAttribute('value');
        if (v) { await courseSelect.selectOption(v); courseSelected = true; break; }
      }
    }
    if (!courseSelected) throw new Error(`${venueName} プルダウン option なし`);
    await wait(1000);

    const raceSelect = page.locator("select[ng-model='vm.oSelectedJgRn']");
    await raceSelect.waitFor({ timeout: 5000 });
    const raceOptions = await raceSelect.locator('option').all();
    let raceSelected = false;
    const racePattern = `${raceNumber}R`;
    for (const opt of raceOptions) {
      const t = (await opt.textContent().catch(() => ''))?.trim();
      if (t?.startsWith(racePattern)) {
        const v = await opt.getAttribute('value');
        if (v) { await raceSelect.selectOption(v); raceSelected = true; break; }
      }
    }
    if (!raceSelected) {
      await page.screenshot({ path: `/tmp/ipat_race_notfound_${venueName}${raceNumber}.png` }).catch(() => {});
      throw new Error(`${raceNumber}R プルダウン option なし`);
    }
  }
  logFn(`  会場 ${venueName} / レース ${raceNumber}R 選択`);
  await wait(1500);
}

// 馬番ラベルが visible になるまで待機 (最大5秒)
async function waitForHorseLabel(page: Page, horseNum: number): Promise<void> {
  const padded = String(horseNum).padStart(2, '0');
  for (const forVal of [`no${padded}`, `no${horseNum}`]) {
    const label = page.locator(`label[for='${forVal}']`);
    if (await label.isVisible({ timeout: 5000 }).catch(() => false)) return;
  }
  // フォールバック: もう少し待ってから諦める (clickHorseLabel側でリトライ&診断)
  await wait(1000);
}

// ── 単一の買い目をセット ──
export async function placeBet(page: Page, bet: IpatBet, logFn: (s: string) => void = () => {}): Promise<void> {
  const label = BET_TYPE_LABEL[bet.type] || bet.type;
  logFn(`  ${label} [${bet.horses.join(',')}] ${bet.amount}円 をセット中...`);

  // 券種選択
  const typeSelect = page.locator("select[ng-model*='oSelectType']").first();
  await typeSelect.waitFor({ timeout: 5000 });
  await typeSelect.selectOption({ label });
  await wait(800);

  const isTansho = bet.type === 'TANSYO' || bet.type === 'FUKUSYO';
  if (isTansho) {
    await waitForHorseLabel(page, bet.horses[0]);
    await clickHorseLabel(page, bet.horses[0], logFn);
    await wait(500);
  } else {
    // ボックスモード
    const methodSelect = page.locator("select[ng-model*='oSelectMethod']").first();
    await methodSelect.waitFor({ timeout: 5000 });
    await methodSelect.selectOption({ label: 'ボックス' });
    await wait(1500);  // ボックスモード切替後の DOM 再描画を確実に待つ (5/16・5/17のbox失敗対策)
    await waitForHorseLabel(page, bet.horses[0]);
    for (const h of bet.horses) {
      await clickHorseLabel(page, h, logFn);
      await wait(400);
    }
    await wait(500);
  }

  // 金額入力 (100円単位 → IPAT入力は100円を1として入力)
  const amountInput = page.locator("input[ng-model*='nUnit']").first();
  await amountInput.waitFor({ timeout: 5000 });
  await amountInput.fill(String(bet.amount / 100));
  await wait(300);

  // セットボタン
  const setBtn = page.locator("button[ng-click*='onSet()']").first();
  await setBtn.waitFor({ timeout: 5000 });
  await setBtn.click();
  await wait(1500);
}

// ── 投票一覧表示 → 合計入力 → 購入確定 ──
export async function confirmPurchase(page: Page, totalAmount: number, logFn: (s: string) => void = () => {}): Promise<void> {
  // 投票一覧
  const showListBtn = page.locator("button[ng-click*='onShowBetList()']").first();
  await showListBtn.waitFor({ timeout: 5000 });
  await showListBtn.click();
  await wait(2000);

  // 合計金額入力
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

  logFn(`  ✓ 投票完了 (合計${totalAmount.toLocaleString()}円)`);
}

// ── IpatBet の合計金額計算 (ボックスの場合ペア数×amount) ──
export function calcTotalAmount(bets: IpatBet[]): number {
  let total = 0;
  for (const b of bets) {
    const isTansho = b.type === 'TANSYO' || b.type === 'FUKUSYO';
    if (isTansho || b.horses.length < 2) {
      total += b.amount;
    } else {
      const n = b.horses.length;
      const pairs = Math.max(1, n * (n - 1) / 2);
      total += b.amount * pairs;
    }
  }
  return total;
}
