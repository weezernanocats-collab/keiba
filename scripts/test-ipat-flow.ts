/**
 * IPAT 操作フロー検証スクリプト (購入確定はしない)
 *
 * 共有モジュール src/lib/ipat-client.ts の動作を検証する。
 * scheduler が使う同じ関数群を呼んで、ログイン→レース選択→
 * 買い目セット→投票一覧表示 までを実行。最後の購入確定は実行しない。
 *
 * 使い方:
 *   npx tsx scripts/test-ipat-flow.ts --venue 東京 --race 1 [--horse 7] [--headless]
 *   npx tsx scripts/test-ipat-flow.ts --venue 京都 --race 5 --horse 3 --headless
 *
 * 操作内容:
 *   1. IPAT ログイン
 *   2. 通常投票画面へ
 *   3. 指定会場+レースを選択
 *   4. 単勝1点 (--horse 指定がなければ1番) を100円でセット
 *   5. 投票一覧を表示
 *   6. ブラウザを開いたまま停止 (Ctrl+C で終了)
 *
 * 重要: 購入確定処理 (confirmPurchase) は実行しない。
 *       手動で「お買い目を確認」画面を確認後、ブラウザを閉じる。
 */
import { readFileSync, existsSync } from 'fs';
import { chromium } from 'playwright';
import {
  loginToIpat,
  navigateToBetBasic,
  selectVenueAndRace,
  placeBet,
  type IpatBet,
  type IpatCredentials,
} from '../src/lib/ipat-client';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = line.match(/^(\w+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const args = process.argv.slice(2);
const getArg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const headless = args.includes('--headless');
const venue = getArg('--venue');
const raceNum = parseInt(getArg('--race') || '0');
const horseNum = parseInt(getArg('--horse') || '1');
const boxHorses = (getArg('--box') || '').split(',').map(s => parseInt(s)).filter(n => n > 0);

if (!venue || !raceNum) {
  console.error('Usage: tsx scripts/test-ipat-flow.ts --venue 東京 --race 1 [--horse 7] [--box 1,3,5,7] [--headless]');
  console.error('  --venue: 会場名 (東京/京都/新潟/中山/阪神/中京/小倉/福島/函館/札幌)');
  console.error('  --race:  レース番号 (1〜12)');
  console.error('  --horse: 単勝対象馬番 (デフォルト 1)');
  console.error('  --box:   ワイドbox対象 (カンマ区切り 例: 1,3,5,7)');
  console.error('  --headless: ヘッドレス実行');
  process.exit(1);
}

const log = (s: string) => {
  const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  console.log(`[${ts}] ${s}`);
};

async function main() {
  log(`=== IPAT フロー検証 ===`);
  log(`会場: ${venue} ${raceNum}R`);
  log(`単勝対象馬番: ${horseNum}`);
  if (boxHorses.length >= 2) log(`ワイドbox: ${boxHorses.join(',')}`);
  log(`headless: ${headless}`);

  const creds: IpatCredentials = {
    inetId: process.env.IPAT_INET_ID || '',
    memberNo: process.env.IPAT_MEMBER_NO || '',
    password: process.env.IPAT_PASSWORD || '',
    parsNo: process.env.IPAT_PARS_NO || '',
  };

  log('ブラウザ起動...');
  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 200 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    log('IPATログイン...');
    await loginToIpat(page, creds);
    log('✓ ログイン完了');

    log('通常投票画面へ...');
    await navigateToBetBasic(page);
    log('✓ basic画面へ遷移');

    log(`会場 ${venue} / レース ${raceNum}R 選択...`);
    await selectVenueAndRace(page, venue, raceNum, log);
    log('✓ レース選択完了');

    // 単勝1点セット
    const tanshoBet: IpatBet = { type: 'TANSYO', horses: [horseNum], amount: 100 };
    log(`単勝 ${horseNum}番 100円 セット...`);
    await placeBet(page, tanshoBet, log);
    log('✓ 単勝セット完了');

    // --box指定があればワイドbox 1点 (100円/pair) セット
    if (boxHorses.length >= 2) {
      const wideBet: IpatBet = { type: 'WIDE', horses: boxHorses, amount: 100 };
      log(`ワイドbox [${boxHorses.join(',')}] 100円/ペア セット...`);
      await placeBet(page, wideBet, log);
      log('✓ ワイドセット完了');
    }

    // 投票一覧表示まで (購入確定はしない)
    log('投票一覧表示...');
    const showListBtn = page.locator("button[ng-click*='onShowBetList()']").first();
    await showListBtn.waitFor({ timeout: 5000 });
    await showListBtn.click();
    await new Promise(r => setTimeout(r, 2000));
    log('✓ 投票一覧表示完了');

    log('');
    log('========================================');
    log('✅ 全てのIPAT操作が成功しました');
    log('購入確定はしません。手動でブラウザを閉じて終了してください');
    log('Ctrl+C で停止');
    log('========================================');

    // ヘッドレスでない場合はブラウザを開いたまま待機
    if (!headless) {
      await new Promise(() => {}); // 無限待機
    } else {
      // ヘッドレスの場合は5秒待ってからスクショ取って終了
      await page.screenshot({ path: '/tmp/ipat_test_final.png' });
      log('スクショ: /tmp/ipat_test_final.png');
      await new Promise(r => setTimeout(r, 3000));
      await browser.close();
    }
  } catch (e) {
    log(`❌ エラー: ${(e as Error).message}`);
    await page.screenshot({ path: '/tmp/ipat_test_error.png' }).catch(() => {});
    log('スクショ: /tmp/ipat_test_error.png');
    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
