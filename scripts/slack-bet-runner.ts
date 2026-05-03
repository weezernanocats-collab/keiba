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

// ── ユーザー設定型 ──

interface UserBetConfig {
  userId: string;
  dailyBudget: number;
  betTypes: { tansho: boolean; umaren: boolean; wide: boolean; umatan: boolean; sanrenpuku: boolean; sanrentan: boolean };
  strategies: { shoshan: boolean; ai: boolean; shoshan_ai: boolean };
  strategyWeights: Record<string, number>;
  minOdds: number | null;
  maxOdds: number | null;
  active: boolean;
}

// デフォルト設定（木村用 = 従来ロジック互換）
const DEFAULT_CONFIG: UserBetConfig = {
  userId: 'default',
  dailyBudget: 5000,
  betTypes: { tansho: true, umaren: true, wide: false, umatan: false, sanrenpuku: false, sanrentan: false },
  strategies: { shoshan: true, ai: true, shoshan_ai: true },
  strategyWeights: { shoshan: 40, ai: 20, shoshan_ai: 40 },
  minOdds: null,
  maxOdds: null,
  active: true,
};

async function loadUserConfig(userId: string): Promise<UserBetConfig | null> {
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  try {
    const rows = await db.execute({
      sql: 'SELECT * FROM user_bet_configs WHERE user_id = ? AND active = 1',
      args: [userId],
    });
    if (rows.rows.length === 0) return null;
    const row = rows.rows[0];
    return {
      userId: String(row.user_id),
      dailyBudget: Number(row.daily_budget),
      betTypes: JSON.parse(String(row.bet_types)),
      strategies: JSON.parse(String(row.strategies)),
      strategyWeights: JSON.parse(String(row.strategy_weights)),
      minOdds: row.min_odds != null ? Number(row.min_odds) : null,
      maxOdds: row.max_odds != null ? Number(row.max_odds) : null,
      active: true,
    };
  } finally {
    db.close();
  }
}

async function loadAllActiveConfigs(): Promise<UserBetConfig[]> {
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  try {
    const rows = await db.execute({ sql: 'SELECT * FROM user_bet_configs WHERE active = 1', args: [] });
    return rows.rows.map(row => ({
      userId: String(row.user_id),
      dailyBudget: Number(row.daily_budget),
      betTypes: JSON.parse(String(row.bet_types)),
      strategies: JSON.parse(String(row.strategies)),
      strategyWeights: JSON.parse(String(row.strategy_weights)),
      minOdds: row.min_odds != null ? Number(row.min_odds) : null,
      maxOdds: row.max_odds != null ? Number(row.max_odds) : null,
      active: true,
    }));
  } finally {
    db.close();
  }
}

// ── 買い目生成（ユーザー設定対応） ──

interface BetRow {
  venue: string;
  raceNumber: number;
  betType: string;
  combo: string;
  amount: number;
  strategy: string; // 'shoshan' | 'ai' | 'shoshan_ai'
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

const IPAT_BET_TYPES: Record<string, string> = {
  tansho: 'TANSYO', umaren: 'UMAREN', wide: 'WIDE',
  umatan: 'UMATAN', sanrenpuku: 'SANRENPUKU', sanrentan: 'SANRENTAN',
};

function pad(n: number) { return String(n).padStart(2, '0'); }

function makeCombo2(a: number, b: number, ordered: boolean) {
  if (ordered) return `${pad(a)}-${pad(b)}`;
  const [s, l] = a < b ? [a, b] : [b, a];
  return `${pad(s)}-${pad(l)}`;
}

function makeCombo3(a: number, b: number, c: number, ordered: boolean) {
  if (ordered) return `${pad(a)}-${pad(b)}-${pad(c)}`;
  const sorted = [a, b, c].sort((x, y) => x - y);
  return sorted.map(pad).join('-');
}

async function generateBets(date: string, budget: number, config: UserBetConfig): Promise<{ bets: BetRow[]; csvPath: string }> {
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });

  const rows = await db.execute({
    sql: `SELECT p.race_id, p.analysis_json, p.picks_json, r.racecourse_name, r.race_number, r.name, r.time
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
    const shosanNums = shosanQualified.map((c: any) => Number(c.horseNumber));

    // AI予想Top3
    const aiEntries = analysis?.aiOnlyRanking?.entries || [];
    let aiTop: number[] = aiEntries.slice(0, 3).filter((e: any) => e?.horseNumber).map((e: any) => Number(e.horseNumber));

    // フォールバック: picks_json
    if (aiTop.length < 2 && row.picks_json) {
      try {
        const picks = JSON.parse(String(row.picks_json));
        if (Array.isArray(picks)) {
          aiTop = picks.slice(0, 3).map((p: any) => Number(p.horseNumber)).filter(Boolean);
        }
      } catch {}
    }

    // オッズ情報（フィルタ用）
    const oddsRows = await db.execute({
      sql: `SELECT horse_number, odds FROM race_entries WHERE race_id = ? AND odds > 0`,
      args: [raceId],
    });
    const oddsMap: Record<number, number> = {};
    for (const o of oddsRows.rows) oddsMap[Number(o.horse_number)] = Number(o.odds);

    const passOddsFilter = (horseNum: number) => {
      const odds = oddsMap[horseNum];
      if (!odds) return true; // オッズ不明なら通す
      if (config.minOdds && odds < config.minOdds) return false;
      if (config.maxOdds && odds > config.maxOdds) return false;
      return true;
    };

    // しょーさん×AI一致馬
    const shosanAiOverlap = shosanNums.filter((n: number) => aiTop.includes(n));

    const lbl = `${venue}${raceNumber}R`;

    // ── 各戦略で買い目生成 ──

    // しょーさん戦略
    if (config.strategies.shoshan && shosanQualified.length > 0) {
      for (const c of shosanQualified) {
        const num = Number(c.horseNumber);
        if (!passOddsFilter(num)) continue;
        const theory = c.theory || '?';

        if (config.betTypes.tansho) {
          bets.push({ venue: venueCode, raceNumber, betType: 'TANSYO', combo: pad(num), amount: 0, strategy: 'shoshan', label: `${lbl} 単勝 ${num}番 (しょーさんT${theory})` });
        }
        // 2頭券種: しょーさん馬 × AI1位 (同馬ならAI2位)
        let partner = aiTop[0];
        if (partner === num) partner = aiTop[1];
        if (partner && partner !== num && passOddsFilter(partner)) {
          if (config.betTypes.umaren) {
            bets.push({ venue: venueCode, raceNumber, betType: 'UMAREN', combo: makeCombo2(num, partner, false), amount: 0, strategy: 'shoshan', label: `${lbl} 馬連 ${num}-${partner} (しょーさん×AI)` });
          }
          if (config.betTypes.wide) {
            bets.push({ venue: venueCode, raceNumber, betType: 'WIDE', combo: makeCombo2(num, partner, false), amount: 0, strategy: 'shoshan', label: `${lbl} ワイド ${num}-${partner} (しょーさん)` });
          }
          if (config.betTypes.umatan) {
            bets.push({ venue: venueCode, raceNumber, betType: 'UMATAN', combo: makeCombo2(num, partner, true), amount: 0, strategy: 'shoshan', label: `${lbl} 馬単 ${num}→${partner} (しょーさん)` });
          }
        }
        // 3頭券種: しょーさん馬 × AI1位 × AI2位
        const third = aiTop.find(a => a !== num && a !== partner);
        if (partner && third && partner !== num && passOddsFilter(third)) {
          if (config.betTypes.sanrenpuku) {
            bets.push({ venue: venueCode, raceNumber, betType: 'SANRENPUKU', combo: makeCombo3(num, partner, third, false), amount: 0, strategy: 'shoshan', label: `${lbl} 三連複 ${num}-${partner}-${third} (しょーさん)` });
          }
          if (config.betTypes.sanrentan) {
            bets.push({ venue: venueCode, raceNumber, betType: 'SANRENTAN', combo: makeCombo3(num, partner, third, true), amount: 0, strategy: 'shoshan', label: `${lbl} 三連単 ${num}→${partner}→${third} (しょーさん)` });
          }
        }
      }
    }

    // AI戦略
    if (config.strategies.ai && aiTop.length >= 2) {
      const [a1, a2, a3] = aiTop;
      if (passOddsFilter(a1)) {
        if (config.betTypes.tansho) {
          bets.push({ venue: venueCode, raceNumber, betType: 'TANSYO', combo: pad(a1), amount: 0, strategy: 'ai', label: `${lbl} 単勝 ${a1}番 (AI)` });
        }
        if (a2 && passOddsFilter(a2)) {
          if (config.betTypes.umaren) {
            bets.push({ venue: venueCode, raceNumber, betType: 'UMAREN', combo: makeCombo2(a1, a2, false), amount: 0, strategy: 'ai', label: `${lbl} 馬連 ${a1}-${a2} (AI)` });
          }
          if (config.betTypes.wide) {
            bets.push({ venue: venueCode, raceNumber, betType: 'WIDE', combo: makeCombo2(a1, a2, false), amount: 0, strategy: 'ai', label: `${lbl} ワイド ${a1}-${a2} (AI)` });
          }
          if (config.betTypes.umatan) {
            bets.push({ venue: venueCode, raceNumber, betType: 'UMATAN', combo: makeCombo2(a1, a2, true), amount: 0, strategy: 'ai', label: `${lbl} 馬単 ${a1}→${a2} (AI)` });
          }
          if (a3 && passOddsFilter(a3)) {
            if (config.betTypes.sanrenpuku) {
              bets.push({ venue: venueCode, raceNumber, betType: 'SANRENPUKU', combo: makeCombo3(a1, a2, a3, false), amount: 0, strategy: 'ai', label: `${lbl} 三連複 ${a1}-${a2}-${a3} (AI)` });
            }
            if (config.betTypes.sanrentan) {
              bets.push({ venue: venueCode, raceNumber, betType: 'SANRENTAN', combo: makeCombo3(a1, a2, a3, true), amount: 0, strategy: 'ai', label: `${lbl} 三連単 ${a1}→${a2}→${a3} (AI)` });
            }
          }
        }
      }
    }

    // しょーさん×AI掛け合わせ戦略
    if (config.strategies.shoshan_ai && shosanAiOverlap.length > 0) {
      for (const num of shosanAiOverlap) {
        if (!passOddsFilter(num)) continue;
        if (config.betTypes.tansho) {
          bets.push({ venue: venueCode, raceNumber, betType: 'TANSYO', combo: pad(num), amount: 0, strategy: 'shoshan_ai', label: `${lbl} 単勝 ${num}番 (しょーさん×AI一致)` });
        }
        let partner = aiTop.find(a => a !== num);
        if (partner && passOddsFilter(partner)) {
          if (config.betTypes.umaren) {
            bets.push({ venue: venueCode, raceNumber, betType: 'UMAREN', combo: makeCombo2(num, partner, false), amount: 0, strategy: 'shoshan_ai', label: `${lbl} 馬連 ${num}-${partner} (しょーさん×AI一致)` });
          }
          if (config.betTypes.wide) {
            bets.push({ venue: venueCode, raceNumber, betType: 'WIDE', combo: makeCombo2(num, partner, false), amount: 0, strategy: 'shoshan_ai', label: `${lbl} ワイド ${num}-${partner} (しょーさん×AI一致)` });
          }
          if (config.betTypes.umatan) {
            bets.push({ venue: venueCode, raceNumber, betType: 'UMATAN', combo: makeCombo2(num, partner, true), amount: 0, strategy: 'shoshan_ai', label: `${lbl} 馬単 ${num}→${partner} (しょーさん×AI一致)` });
          }
          const third = aiTop.find(a => a !== num && a !== partner);
          if (third && passOddsFilter(third)) {
            if (config.betTypes.sanrenpuku) {
              bets.push({ venue: venueCode, raceNumber, betType: 'SANRENPUKU', combo: makeCombo3(num, partner, third, false), amount: 0, strategy: 'shoshan_ai', label: `${lbl} 三連複 ${num}-${partner}-${third} (しょーさん×AI一致)` });
            }
            if (config.betTypes.sanrentan) {
              bets.push({ venue: venueCode, raceNumber, betType: 'SANRENTAN', combo: makeCombo3(num, partner, third, true), amount: 0, strategy: 'shoshan_ai', label: `${lbl} 三連単 ${num}→${partner}→${third} (しょーさん×AI一致)` });
            }
          }
        }
      }
    }
  }
  db.close();

  if (bets.length === 0) return { bets: [], csvPath: '' };

  // ── 予算配分（戦略ウェイトに基づく） ──
  const strategyBets: Record<string, BetRow[]> = {};
  for (const b of bets) {
    if (!strategyBets[b.strategy]) strategyBets[b.strategy] = [];
    strategyBets[b.strategy].push(b);
  }

  const totalWeight = Object.entries(strategyBets).reduce(
    (s, [strat, bs]) => s + (config.strategyWeights[strat] || 0) * bs.length, 0
  );

  if (totalWeight > 0) {
    for (const [strat, bs] of Object.entries(strategyBets)) {
      const weight = config.strategyWeights[strat] || 0;
      const stratBudget = Math.floor(budget * weight / 100);
      const perBet = Math.max(100, Math.floor(stratBudget / bs.length / 100) * 100);
      for (const b of bs) b.amount = perBet;
    }
  }

  // 合計が予算を超えたら末尾から削る
  let validBets = bets.filter(b => b.amount >= 100);
  const total = validBets.reduce((s, b) => s + b.amount, 0);
  if (total > budget) {
    let excess = total - budget;
    for (let i = validBets.length - 1; i >= 0 && excess > 0; i--) {
      const reduce = Math.min(validBets[i].amount - 100, excess);
      validBets[i].amount -= reduce;
      excess -= reduce;
    }
    validBets = validBets.filter(b => b.amount >= 100);
  }

  // CSV出力
  const dateCompact = date.replace(/-/g, '');
  const csvPath = `/tmp/ipatgo_${dateCompact}_${config.userId}.csv`;
  const csvLines = validBets.map(b =>
    `${dateCompact},${b.venue},${b.raceNumber},${b.betType},NORMAL,,${b.combo},${b.amount}`
  );
  writeFileSync(csvPath, csvLines.join('\n') + '\n');

  return { bets: validBets, csvPath };
}

// ── IPAT投票実行 ──

function runIpatBet(csvPath: string, dryRun = false, userId?: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const ipatArgs = ['tsx', 'scripts/ipat-auto-bet.ts', '--csv', csvPath];
    if (dryRun) ipatArgs.push('--dry-run');
    if (userId) ipatArgs.push('--user', userId);
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

async function executeBetting(budget: number, dryRun = false, userId?: string) {
  const now = new Date();
  now.setHours(now.getHours() + 9);
  const date = now.toISOString().split('T')[0];
  const dateCompact = date.replace(/-/g, '');

  // ユーザー設定ロード
  let config: UserBetConfig = { ...DEFAULT_CONFIG };
  if (userId) {
    const userConfig = await loadUserConfig(userId);
    if (userConfig) {
      config = userConfig;
    }
    config.userId = userId;
  }
  // Slack指定の予算で上書き
  config.dailyBudget = budget;

  const userLabel = userId ? ` [${userId}]` : '';
  console.log(`\n[runner] ${date} 予算${budget.toLocaleString()}円で投票開始${userLabel}`);
  await slackPost(`🏇 投票開始: ${date} 予算 ${budget.toLocaleString()}円${userLabel}`);

  // 1. 買い目生成（ユーザー設定に基づく）
  console.log('[runner] 買い目生成中...');
  const { bets, csvPath } = await generateBets(date, budget, config);

  if (bets.length === 0) {
    const msg = '対象の買い目がありません（しょーさん候補・AI予想なし）';
    console.log(`[runner] ${msg}`);
    await slackPost(`⚠ ${msg}`);
    return;
  }

  const totalAmount = bets.reduce((s, b) => s + b.amount, 0);
  const stratCounts: Record<string, number> = {};
  for (const b of bets) stratCounts[b.strategy] = (stratCounts[b.strategy] || 0) + 1;

  const BET_TYPE_JP: Record<string, string> = { TANSYO: '単勝', UMAREN: '馬連', WIDE: 'ワイド', UMATAN: '馬単', SANRENPUKU: '三連複', SANRENTAN: '三連単' };
  let betSummary = `📋 ${bets.length}点 (合計 ${totalAmount.toLocaleString()}円)\n`;
  betSummary += `  ${Object.entries(stratCounts).map(([s, c]) => `${s}: ${c}点`).join(' / ')}\n`;
  for (const b of bets) {
    betSummary += `  ${VENUE_DISPLAY[b.venue] || b.venue}${b.raceNumber}R ${BET_TYPE_JP[b.betType] || b.betType} ${b.combo} ${b.amount}円\n`;
  }
  console.log(betSummary);
  await slackPost(betSummary);

  // 2. IPAT投票
  console.log(`[runner] IPAT投票実行中...${dryRun ? ' (dry-run)' : ''}`);
  const { success, output } = await runIpatBet(csvPath, dryRun, userId);

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
  await slackPost('🤖 自動投票Bot起動しました。\n「予算 5000」→ デフォルトユーザー\n「予算 5000 naoto」→ 指定ユーザー');

  let lastTs = String(Date.now() / 1000); // 起動時点以降のメッセージのみ
  let processing = false;

  const poll = async () => {
    if (processing) return;

    try {
      const messages = await getRecentMessages(lastTs);
      for (const msg of messages) {
        // 「予算 5000」「予算 5000 naoto」「budget 5000」パターン
        const match = msg.text.match(/(?:予算|budget)\s*(\d+)(?:\s+([a-zA-Z0-9_-]+))?/i);
        if (match) {
          const budget = parseInt(match[1]);
          const targetUser = match[2] || undefined; // ユーザー指定（省略時はデフォルト）
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
            await executeBetting(budget, false, targetUser);
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
