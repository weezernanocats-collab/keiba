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
const csvPath = getArg('--csv');

const today = new Date();
today.setHours(today.getHours() + 9);
const date = getArg('--date') || today.toISOString().split('T')[0];
const amount = parseInt(getArg('--amount') || '100');

// ── IPAT認証情報 ──
const IPAT = {
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
  combo: string;       // "03-07"
  horses: number[];    // [3, 7]
  amount: number;
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
    sql: `SELECT p.race_id, p.analysis_json, r.racecourse_name, r.race_number
          FROM predictions p
          JOIN races r ON p.race_id = r.id
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

    let analysis: { shosanPrediction?: { candidates?: Array<{ horseNumber: number; matchScore: number }> } };
    try { analysis = JSON.parse(String(row.analysis_json)); } catch { continue; }
    const candidates = analysis?.shosanPrediction?.candidates || [];
    const qualified = candidates.filter(c => (c.matchScore || 0) >= 65);
    if (qualified.length === 0) continue;

    const entries = await db.execute({
      sql: `SELECT horse_number FROM race_entries WHERE race_id = ? AND odds > 0 ORDER BY odds ASC LIMIT 1`,
      args: [raceId],
    });
    if (entries.rows.length === 0) continue;
    const favNumber = Number(entries.rows[0].horse_number);

    for (const c of qualified) {
      const axisNumber = Number(c.horseNumber);
      if (axisNumber === favNumber) continue;
      const [small, large] = axisNumber < favNumber ? [axisNumber, favNumber] : [favNumber, axisNumber];
      bets.push({
        date,
        venue: venueCode,
        venueName: venue,
        raceNumber: Number(row.race_number),
        betType: 'UMAREN',
        betTypeName: '馬連',
        combo: `${String(small).padStart(2, '0')}-${String(large).padStart(2, '0')}`,
        horses: [small, large],
        amount,
      });
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

// ── メイン処理 ──
async function main() {
  // 1. 買い目読み込み
  const bets = await loadBets();
  if (bets.length === 0) {
    console.log('対象の買い目がありません');
    return;
  }

  const totalAmount = bets.reduce((s, b) => s + b.amount, 0);
  console.log(`\n[ipat] ${date} 自動投票`);
  console.log(`  対象: ${bets.length}点 (合計 ${totalAmount.toLocaleString()}円)`);
  if (dryRun) console.log('  ⚠ dry-runモード: 投票確定せずに停止します');
  console.log('');

  for (const b of bets) {
    console.log(`  ${b.venueName}${b.raceNumber}R ${b.betTypeName} ${b.combo} ${b.amount}円`);
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

  // 3. ブラウザ起動（画面表示あり）
  console.log('[ipat] ブラウザ起動...');
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
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

      // 会場選択
      const venueButtons = page.locator("button[ng-click*='selectCourse']");
      await venueButtons.first().waitFor({ timeout: 10000 });
      const venueCount = await venueButtons.count();
      let venueFound = false;
      for (let i = 0; i < venueCount; i++) {
        const text = await venueButtons.nth(i).textContent();
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

      // レース選択
      const raceButtons = page.locator("button[ng-click*='selectRace']");
      await wait(1000);
      const raceCount = await raceButtons.count();
      let raceFound = false;
      for (let i = 0; i < raceCount; i++) {
        const text = await raceButtons.nth(i).textContent();
        if (text?.trim() === String(group.raceNumber)) {
          await raceButtons.nth(i).click();
          raceFound = true;
          break;
        }
      }
      if (!raceFound) {
        console.warn(`  ⚠ ${group.raceNumber}R が見つかりません、スキップ`);
        continue;
      }
      await wait(1500);

      // 各買い目を投票
      for (const bet of group.bets) {
        console.log(`  馬連 ${bet.combo} ${bet.amount}円 をセット中...`);

        // 券種選択（馬連）
        const typeSelect = page.locator("select[ng-model*='oSelectType']").first();
        await typeSelect.waitFor({ timeout: 5000 });
        await typeSelect.selectOption({ label: bet.betTypeName });
        await wait(800);

        // 方式選択（ながし）
        const methodSelect = page.locator("select[ng-model*='oSelectMethod']").first();
        await methodSelect.waitFor({ timeout: 5000 });
        await methodSelect.selectOption({ label: 'ながし' });
        await wait(800);

        // 軸馬選択（小さい方の馬番 = しょーさん候補）
        // ながしモード: 軸馬のチェックボックスをクリック
        // 軸のセクションは最初のhorse number area
        const axisHorse = bet.horses[0];
        const partnerHorse = bet.horses[1];

        // 軸馬: 'ax' prefix のlabel、または最初のセクションの馬番label
        // IPATのながしUIは軸と相手が分かれている
        // セレクタはIPATのバージョンで変わる可能性があるため、複数パターンを試行
        const axisSelectors = [
          `label[for='ax_no${axisHorse}']`,
          `label[for='axno${axisHorse}']`,
          `label[for='ax${axisHorse}']`,
        ];

        let axisClicked = false;
        for (const sel of axisSelectors) {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
            await el.click();
            axisClicked = true;
            break;
          }
        }

        if (!axisClicked) {
          // フォールバック: ながしの軸エリアの馬番ボタンをテキストで探す
          // 多くのIPAT実装では「軸」セクション内の馬番ラベルをクリック
          const allLabels = page.locator('.axis-area label, .jiku label, [class*="axis"] label, [class*="jiku"] label');
          const labelCount = await allLabels.count();
          for (let i = 0; i < labelCount; i++) {
            const text = await allLabels.nth(i).textContent();
            if (text?.trim() === String(axisHorse)) {
              await allLabels.nth(i).click();
              axisClicked = true;
              break;
            }
          }
        }

        if (!axisClicked) {
          // 最終フォールバック: ボックスに切り替えて2頭選択
          console.log('    ながしの軸セレクタが見つからない → ボックスに切替');
          await methodSelect.selectOption({ label: 'ボックス' });
          await wait(800);

          // ボックスの場合: 2頭をクリック
          for (const h of bet.horses) {
            const label = page.locator(`label[for^='no${h}']`).first();
            if (await label.isVisible({ timeout: 2000 }).catch(() => false)) {
              await label.click();
            } else {
              // テキスト一致で探す
              const numLabels = page.locator("label[for^='no']");
              const cnt = await numLabels.count();
              for (let i = 0; i < cnt; i++) {
                const t = await numLabels.nth(i).textContent();
                if (t?.trim() === String(h)) {
                  await numLabels.nth(i).click();
                  break;
                }
              }
            }
            await wait(300);
          }
        } else {
          // 相手馬選択
          await wait(500);
          const partnerSelectors = [
            `label[for='no${partnerHorse}']`,
            `label[for^='no${partnerHorse}']`,
          ];
          let partnerClicked = false;
          for (const sel of partnerSelectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
              await el.click();
              partnerClicked = true;
              break;
            }
          }
          if (!partnerClicked) {
            // テキスト一致で相手馬を探す
            const partnerLabels = page.locator("label[for^='no']");
            const cnt = await partnerLabels.count();
            for (let i = 0; i < cnt; i++) {
              const t = await partnerLabels.nth(i).textContent();
              if (t?.trim() === String(partnerHorse)) {
                await partnerLabels.nth(i).click();
                break;
              }
            }
          }
        }
        await wait(500);

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
