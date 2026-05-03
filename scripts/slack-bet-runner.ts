/**
 * Slack自動投票ランナー
 *
 * Slackチャンネルで「予算 5000」と送ると:
 *   1. 買い目を自動生成（しょーさん×AI マルチ戦略）
 *   2. IPAT自動投票を実行
 *   3. 結果をSlack通知
 *
 * 使い方:
 *   npx tsx scripts/slack-bet-runner.ts              # 常駐監視モード
 *   npx tsx scripts/slack-bet-runner.ts --once 5000  # 1回実行（テスト用）
 *
 * 環境変数 (.env.local):
 *   SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 *   IPAT_INET_ID, IPAT_MEMBER_NO, IPAT_PASSWORD, IPAT_PARS_NO
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { execSync, spawn } from 'child_process';

// .env.local読み込み
if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID || '';
const POLL_INTERVAL_MS = 30_000; // 30秒ごとにポーリング

// ── Slack API ──

async function slackPost(text: string) {
  if (!SLACK_TOKEN || !SLACK_CHANNEL) {
    console.log(`[slack] (未設定) ${text}`);
    return;
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
  });
  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) console.error(`[slack] 送信失敗: ${data.error}`);
}

async function slackUploadFile(filePath: string, comment: string) {
  if (!SLACK_TOKEN || !SLACK_CHANNEL || !existsSync(filePath)) return;
  const fileData = readFileSync(filePath);
  // v2: files.getUploadURLExternal + complete
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      filename: filePath.split('/').pop() || 'screenshot.png',
      length: String(fileData.length),
    }),
  });
  const urlData = await urlRes.json() as { ok: boolean; upload_url?: string; file_id?: string };
  if (!urlData.ok || !urlData.upload_url || !urlData.file_id) return;

  await fetch(urlData.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fileData,
  });

  await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      files: [{ id: urlData.file_id, title: comment }],
      channel_id: SLACK_CHANNEL,
      initial_comment: comment,
    }),
  });
}

async function getRecentMessages(oldest: string): Promise<Array<{ text: string; ts: string; user: string }>> {
  if (!SLACK_TOKEN || !SLACK_CHANNEL) return [];
  const params = new URLSearchParams({
    channel: SLACK_CHANNEL,
    oldest,
    limit: '20',
  });
  const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
  });
  const data = await res.json() as { ok: boolean; messages?: Array<{ text: string; ts: string; user?: string; bot_id?: string }> };
  if (!data.ok || !data.messages) return [];
  // bot自身のメッセージは除外
  return data.messages
    .filter(m => !m.bot_id)
    .map(m => ({ text: m.text || '', ts: m.ts, user: m.user || '' }));
}

// ── 買い目生成（マルチ戦略） ──

interface BetRow {
  venue: string;
  raceNumber: number;
  betType: string;
  combo: string;
  amount: number;
  priority: number; // 1=shoshan, 2=AI-only
  label: string;
}

const VENUE_MAP: Record<string, string> = {
  '札幌': 'SAPPORO', '函館': 'HAKODATE', '福島': 'FUKUSHIMA',
  '新潟': 'NIIGATA', '東京': 'TOKYO', '中山': 'NAKAYAMA',
  '中京': 'CHUKYO', '京都': 'KYOTO', '阪神': 'HANSHIN', '小倉': 'KOKURA',
};
const VENUE_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(VENUE_MAP).map(([k, v]) => [v, k])
);

async function generateBets(date: string, budget: number): Promise<{ bets: BetRow[]; csvPath: string }> {
  const { createClient } = await import('@libsql/client');
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  // 全レースの予想を取得
  const rows = await db.execute({
    sql: `SELECT p.race_id, p.analysis_json, r.racecourse_name, r.race_number, r.name, r.time
          FROM predictions p
          JOIN races r ON p.race_id = r.id
          WHERE r.date = ? AND p.analysis_json IS NOT NULL
          ORDER BY r.time, r.racecourse_name, r.race_number`,
    args: [date],
  });

  const bets: BetRow[] = [];

  for (const row of rows.rows) {
    const raceId = String(row.race_id);
    const venue = String(row.racecourse_name);
    const raceNumber = Number(row.race_number);
    const venueCode = VENUE_MAP[venue];
    if (!venueCode) continue;

    let analysis: any;
    try { analysis = JSON.parse(String(row.analysis_json)); } catch { continue; }

    // しょーさん候補
    const candidates = analysis?.shosanPrediction?.candidates || [];
    const shosanQualified = candidates.filter((c: any) => (c.matchScore || 0) >= 50);

    // AI予想Top2 (aiOnlyRanking は { entries: [...] } 形式)
    const aiEntries = analysis?.aiOnlyRanking?.entries || [];
    let aiTop1 = aiEntries[0]?.horseNumber ? Number(aiEntries[0].horseNumber) : null;
    let aiTop2 = aiEntries[1]?.horseNumber ? Number(aiEntries[1].horseNumber) : null;

    // フォールバック: picks_jsonからAI Top2
    if (!aiTop1) {
      const picksRow = await db.execute({
        sql: `SELECT picks_json FROM predictions WHERE race_id = ?`,
        args: [raceId],
      });
      if (picksRow.rows.length > 0 && picksRow.rows[0].picks_json) {
        try {
          const picks = JSON.parse(String(picksRow.rows[0].picks_json));
          if (Array.isArray(picks) && picks.length >= 2) {
            aiTop1 = Number(picks[0].horseNumber);
            aiTop2 = Number(picks[1].horseNumber);
          }
        } catch {}
      }
    }

    // 1番人気（市場）
    const entries = await db.execute({
      sql: `SELECT horse_number, odds FROM race_entries
            WHERE race_id = ? AND odds > 0 ORDER BY odds ASC LIMIT 1`,
      args: [raceId],
    });
    const favNumber = entries.rows.length > 0 ? Number(entries.rows[0].horse_number) : null;

    if (shosanQualified.length > 0) {
      // ── しょーさんレース: 単勝 + 馬連(しょーさん×AI1位) ──
      for (const c of shosanQualified) {
        const shosanNum = Number(c.horseNumber);

        // 単勝
        bets.push({
          venue: venueCode, raceNumber, betType: 'TANSYO',
          combo: String(shosanNum).padStart(2, '0'),
          amount: 0, priority: 1,
          label: `${venue}${raceNumber}R 単勝 ${shosanNum}番 (しょーさんT${c.theory})`,
        });

        // 馬連: しょーさん × AI1位（同馬ならAI2位）
        let partner = aiTop1;
        if (partner === shosanNum) partner = aiTop2;
        if (partner && partner !== shosanNum) {
          const [s, l] = shosanNum < partner ? [shosanNum, partner] : [partner, shosanNum];
          bets.push({
            venue: venueCode, raceNumber, betType: 'UMAREN',
            combo: `${String(s).padStart(2, '0')}-${String(l).padStart(2, '0')}`,
            amount: 0, priority: 1,
            label: `${venue}${raceNumber}R 馬連 ${s}-${l} (しょーさん×AI)`,
          });
        }
      }
    } else if (aiTop1 && aiTop2 && aiTop1 !== favNumber) {
      // ── AI onlyレース: AI1位×2位 馬連（AI1位≠1番人気のとき） ──
      const [s, l] = aiTop1 < aiTop2 ? [aiTop1, aiTop2] : [aiTop2, aiTop1];
      bets.push({
        venue: venueCode, raceNumber, betType: 'UMAREN',
        combo: `${String(s).padStart(2, '0')}-${String(l).padStart(2, '0')}`,
        amount: 0, priority: 2,
        label: `${venue}${raceNumber}R 馬連 ${s}-${l} (AI)`,
      });
    }
  }
  db.close();

  if (bets.length === 0) return { bets: [], csvPath: '' };

  // ── 予算配分 ──
  // priority 1 (shoshan) = 2x base, priority 2 (AI) = 1x base
  const totalWeight = bets.reduce((s, b) => s + (b.priority === 1 ? 2 : 1), 0);
  const baseAmount = Math.floor(budget / totalWeight / 100) * 100; // 100円単位
  const minBet = 100;

  for (const b of bets) {
    b.amount = Math.max(minBet, baseAmount * (b.priority === 1 ? 2 : 1));
  }

  // 実合計が予算をオーバーしたら調整
  const total = bets.reduce((s, b) => s + b.amount, 0);
  if (total > budget) {
    // priority 2 から100円ずつ減らす
    const p2Bets = bets.filter(b => b.priority === 2);
    let excess = total - budget;
    for (const b of p2Bets) {
      if (excess <= 0) break;
      const reduce = Math.min(b.amount - minBet, excess);
      b.amount -= reduce;
      excess -= reduce;
    }
  }

  // 金額0のベットを除外
  const validBets = bets.filter(b => b.amount >= minBet);

  // CSV出力
  const dateCompact = date.replace(/-/g, '');
  const csvPath = `/tmp/ipatgo_${dateCompact}_auto.csv`;
  const csvLines = validBets.map(b =>
    `${dateCompact},${b.venue},${b.raceNumber},${b.betType},NORMAL,,${b.combo},${b.amount}`
  );
  writeFileSync(csvPath, csvLines.join('\n') + '\n');

  return { bets: validBets, csvPath };
}

// ── IPAT投票実行 ──

function runIpatBet(csvPath: string, dryRun = false): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const ipatArgs = ['tsx', 'scripts/ipat-auto-bet.ts', '--csv', csvPath];
    if (dryRun) ipatArgs.push('--dry-run');
    const proc = spawn('npx', ipatArgs, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let output = '';
    proc.stdout.on('data', (d: Buffer) => {
      const line = d.toString();
      output += line;
      process.stdout.write(line); // ローカルコンソールにも出力
    });
    proc.stderr.on('data', (d: Buffer) => {
      output += d.toString();
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0, output });
    });

    // 5分タイムアウト
    setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, output: output + '\n[timeout] 5分経過でタイムアウト' });
    }, 5 * 60 * 1000);
  });
}

// ── メイン処理 ──

async function executeBetting(budget: number, dryRun = false) {
  const now = new Date();
  now.setHours(now.getHours() + 9);
  const date = now.toISOString().split('T')[0];
  const dateCompact = date.replace(/-/g, '');

  console.log(`\n[runner] ${date} 予算${budget.toLocaleString()}円で投票開始`);
  await slackPost(`🏇 投票開始: ${date} 予算 ${budget.toLocaleString()}円`);

  // 1. 買い目生成
  console.log('[runner] 買い目生成中...');
  const { bets, csvPath } = await generateBets(date, budget);

  if (bets.length === 0) {
    const msg = '対象の買い目がありません（しょーさん候補・AI予想なし）';
    console.log(`[runner] ${msg}`);
    await slackPost(`⚠ ${msg}`);
    return;
  }

  const totalAmount = bets.reduce((s, b) => s + b.amount, 0);
  const shosanCount = bets.filter(b => b.priority === 1).length;
  const aiCount = bets.filter(b => b.priority === 2).length;

  let betSummary = `📋 ${bets.length}点 (合計 ${totalAmount.toLocaleString()}円)\n`;
  betSummary += `  しょーさん: ${shosanCount}点 / AI: ${aiCount}点\n`;
  for (const b of bets) {
    betSummary += `  ${VENUE_DISPLAY[b.venue] || b.venue}${b.raceNumber}R ${b.betType === 'TANSYO' ? '単勝' : '馬連'} ${b.combo} ${b.amount}円\n`;
  }
  console.log(betSummary);
  await slackPost(betSummary);

  // 2. IPAT投票
  console.log(`[runner] IPAT投票実行中...${dryRun ? ' (dry-run)' : ''}`);
  const { success, output } = await runIpatBet(csvPath, dryRun);

  // 3. 結果通知
  if (success) {
    const resultMsg = `✅ 投票完了! ${bets.length}点 ${totalAmount.toLocaleString()}円`;
    console.log(`[runner] ${resultMsg}`);
    await slackPost(resultMsg);

    // スクリーンショット送信
    const screenshotPath = `/tmp/ipat_result_${dateCompact}.png`;
    await slackUploadFile(screenshotPath, '投票確認画面');
  } else {
    const errMsg = `❌ 投票失敗\n${output.slice(-500)}`;
    console.error(`[runner] ${errMsg}`);
    await slackPost(errMsg);

    // エラースクリーンショット
    const errorScreenshots = execSync(`ls -t /tmp/ipat_error_*.png 2>/dev/null | head -1`).toString().trim();
    if (errorScreenshots) {
      await slackUploadFile(errorScreenshots, 'エラー時スクリーンショット');
    }
  }
}

// ── Slackポーリング or ワンショット ──

async function main() {
  const args = process.argv.slice(2);

  // --once モード: テスト用に1回実行
  if (args.includes('--once')) {
    const budgetIdx = args.indexOf('--once');
    const budget = parseInt(args[budgetIdx + 1] || '5000');
    const isDryRun = args.includes('--dry-run');
    console.log(`[runner] ワンショットモード: 予算${budget}円${isDryRun ? ' (dry-run)' : ''}`);
    await executeBetting(budget, isDryRun);
    return;
  }

  // 常駐監視モード
  if (!SLACK_TOKEN || !SLACK_CHANNEL) {
    console.error('[runner] SLACK_BOT_TOKEN / SLACK_CHANNEL_ID が未設定です');
    process.exit(1);
  }

  console.log('[runner] Slack監視モード開始');
  console.log(`[runner] チャンネル ${SLACK_CHANNEL} で「予算 XXXX」を待機中...`);
  await slackPost('🤖 自動投票Bot起動しました。「予算 5000」で投票開始します。');

  let lastTs = String(Date.now() / 1000); // 起動時点以降のメッセージのみ
  let processing = false;

  const poll = async () => {
    if (processing) return;

    try {
      const messages = await getRecentMessages(lastTs);
      for (const msg of messages) {
        // 「予算 5000」「予算5000」「budget 5000」パターン
        const match = msg.text.match(/(?:予算|budget)\s*(\d+)/i);
        if (match) {
          const budget = parseInt(match[1]);
          if (budget < 100) {
            await slackPost('⚠ 予算は100円以上で指定してください');
            lastTs = msg.ts;
            continue;
          }
          if (budget > 100000) {
            await slackPost('⚠ 予算が高すぎます（上限10万円）');
            lastTs = msg.ts;
            continue;
          }

          processing = true;
          lastTs = msg.ts;

          try {
            await executeBetting(budget);
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            console.error(`[runner] 実行エラー: ${errMsg}`);
            await slackPost(`❌ 実行エラー: ${errMsg}`);
          } finally {
            processing = false;
          }
          break; // 1メッセージ処理したらループ抜ける
        }
        lastTs = msg.ts;
      }
    } catch (e) {
      // ネットワークエラー等は無視して次のポーリングへ
      console.error(`[runner] ポーリングエラー: ${e instanceof Error ? e.message : e}`);
    }
  };

  // 初回ポーリング
  await poll();
  // 定期ポーリング
  setInterval(poll, POLL_INTERVAL_MS);

  // プロセスを維持
  process.on('SIGINT', async () => {
    console.log('\n[runner] 終了中...');
    await slackPost('🤖 自動投票Bot停止しました');
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
