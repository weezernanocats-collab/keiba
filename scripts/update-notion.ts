/**
 * Notion ページ自動更新スクリプト
 *
 * KEIBA MASTER プロジェクトの情報をNotionページに同期する。
 * - アーキテクチャ、仕様、変更履歴、しょーさん予想成績、今後の計画
 * - デプロイ後やモデル更新後に実行して最新状態を反映
 *
 * 使い方:
 *   npx tsx scripts/update-notion.ts
 *   npx tsx scripts/update-notion.ts --section accuracy  # 成績のみ更新
 */
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const NOTION_TOKEN = process.env.NOTION_API_TOKEN;
if (!NOTION_TOKEN) {
  console.error('ERROR: NOTION_API_TOKEN is required in .env.local');
  process.exit(1);
}
const PAGE_ID = '351b0bad-0442-80f0-96be-d537517744b3';
const NOTION_VERSION = '2022-06-28';

import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

// ---- Notion API helpers ----

async function notionRequest(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }
  return res.json();
}

async function clearPageBlocks() {
  const resp = await notionRequest('GET', `/blocks/${PAGE_ID}/children?page_size=100`);
  for (const block of resp.results) {
    await notionRequest('DELETE', `/blocks/${block.id}`);
  }
}

function heading1(text: string) {
  return { object: 'block', type: 'heading_1', heading_1: { rich_text: [{ type: 'text', text: { content: text } }] } };
}

function heading2(text: string) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: text } }] } };
}

function heading3(text: string) {
  return { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: text } }] } };
}

function paragraph(text: string, bold = false) {
  return {
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text }, annotations: { bold } }] },
  };
}

function richParagraph(segments: { text: string; bold?: boolean; code?: boolean; color?: string }[]) {
  return {
    object: 'block', type: 'paragraph',
    paragraph: {
      rich_text: segments.map(s => ({
        type: 'text',
        text: { content: s.text },
        annotations: { bold: s.bold || false, code: s.code || false, color: s.color || 'default' },
      })),
    },
  };
}

function bulletItem(text: string) {
  return {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function codeBlock(text: string, language = 'plain text') {
  return {
    object: 'block', type: 'code',
    code: { rich_text: [{ type: 'text', text: { content: text } }], language },
  };
}

function divider() {
  return { object: 'block', type: 'divider', divider: {} };
}

function tableBlock(headers: string[], rows: string[][]) {
  const width = headers.length;
  const headerRow = {
    type: 'table_row',
    table_row: { cells: headers.map(h => [{ type: 'text', text: { content: h } }]) },
  };
  const dataRows = rows.map(row => ({
    type: 'table_row',
    table_row: { cells: row.map(cell => [{ type: 'text', text: { content: cell } }]) },
  }));
  return {
    object: 'block', type: 'table',
    table: { table_width: width, has_column_header: true, has_row_header: false, children: [headerRow, ...dataRows] },
  };
}

function callout(text: string, emoji = '📌') {
  return {
    object: 'block', type: 'callout',
    callout: { rich_text: [{ type: 'text', text: { content: text } }], icon: { type: 'emoji', emoji } },
  };
}

// ---- Data fetching ----

function getGitLog(n = 20): string[] {
  try {
    return execSync(`git log --oneline -${n}`, { cwd: '/Users/naoto_kimura/kaihatsu/keiba' })
      .toString().trim().split('\n');
  } catch { return []; }
}

async function getShoshanStats() {
  // 全候補を抽出
  const rows = await db.execute({
    sql: "SELECT p.race_id, p.analysis_json, r.date, r.racecourse_name, r.race_number FROM predictions p JOIN races r ON p.race_id = r.id WHERE p.analysis_json LIKE ?",
    args: ["%shosanPrediction%"],
  });

  const seen = new Set<string>();
  const candidates: { raceId: string; date: string; horseNumber: number; horseName: string; theory: number; matchScore: number; jockeyZone: number }[] = [];

  for (const row of rows.rows) {
    const rid = String(row.race_id);
    if (seen.has(rid)) continue;
    seen.add(rid);
    try {
      const a = JSON.parse(String(row.analysis_json));
      const sp = a.shosanPrediction;
      if (!sp?.candidates?.length) continue;
      for (const c of sp.candidates) {
        candidates.push({ raceId: rid, date: String(row.date), horseNumber: c.horseNumber, horseName: c.horseName, theory: c.theory, matchScore: c.matchScore, jockeyZone: c.jockeyZone });
      }
    } catch {}
  }

  // 着順・オッズ紐付け
  let wins = 0, top3 = 0, totalOddsWin = 0, count = 0;
  let t1_count = 0, t1_wins = 0, t1_top3 = 0, t1_roi = 0;
  let t2_count = 0, t2_wins = 0, t2_top3 = 0, t2_roi = 0;
  const byZone: Record<number, { count: number; wins: number; top3: number; roi: number }> = {};

  for (const c of candidates) {
    const entry = await db.execute({
      sql: "SELECT result_position, odds FROM race_entries WHERE race_id = ? AND horse_number = ?",
      args: [c.raceId, c.horseNumber],
    });
    const e = entry.rows[0];
    if (!e || e.result_position == null || Number(e.result_position) <= 0) continue;

    const pos = Number(e.result_position);
    const odds = Number(e.odds) || 0;
    count++;

    if (pos === 1) { wins++; totalOddsWin += odds; }
    if (pos <= 3) top3++;

    if (c.theory === 1) {
      t1_count++;
      if (pos === 1) { t1_wins++; t1_roi += odds; }
      if (pos <= 3) t1_top3++;
    } else {
      t2_count++;
      if (pos === 1) { t2_wins++; t2_roi += odds; }
      if (pos <= 3) t2_top3++;
    }

    const z = c.jockeyZone;
    if (!byZone[z]) byZone[z] = { count: 0, wins: 0, top3: 0, roi: 0 };
    byZone[z].count++;
    if (pos === 1) { byZone[z].wins++; byZone[z].roi += odds; }
    if (pos <= 3) byZone[z].top3++;
  }

  return {
    total: count, wins, top3, winRate: count > 0 ? (wins / count * 100).toFixed(1) : '0',
    top3Rate: count > 0 ? (top3 / count * 100).toFixed(1) : '0',
    winRoi: count > 0 ? (totalOddsWin / count * 100).toFixed(0) : '0',
    theory1: { count: t1_count, wins: t1_wins, top3: t1_top3, roi: t1_count > 0 ? (t1_roi / t1_count * 100).toFixed(0) : '0' },
    theory2: { count: t2_count, wins: t2_wins, top3: t2_top3, roi: t2_count > 0 ? (t2_roi / t2_count * 100).toFixed(0) : '0' },
    byZone,
  };
}

async function getAiStats() {
  const r = await db.execute(
    "SELECT COUNT(*) as cnt, SUM(CASE WHEN pr.win_hit=1 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN pr.place_hit=1 THEN 1 ELSE 0 END) as places, ROUND(SUM(pr.bet_return)/NULLIF(SUM(pr.bet_investment),0), 4) as roi FROM prediction_results pr"
  );
  const row = r.rows[0];
  return {
    total: Number(row.cnt),
    wins: Number(row.wins),
    places: Number(row.places),
    roi: row.roi != null ? (Number(row.roi) * 100).toFixed(0) : '0',
  };
}

// ---- Main ----

async function main() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60_000);
  const updatedAt = jstNow.toISOString().replace('T', ' ').slice(0, 16) + ' JST';

  console.log('[notion] データ収集中...');

  const gitLog = getGitLog(15);
  const shoshanStats = await getShoshanStats();
  const aiStats = await getAiStats();

  console.log('[notion] ページ更新中...');

  // 既存ブロック削除
  await clearPageBlocks();

  // ブロック構築（Notion API は1回の append で最大100ブロック）
  const blocks: unknown[] = [];

  // ---- ヘッダー ----
  blocks.push(callout(`最終更新: ${updatedAt}`, '🕐'));
  blocks.push(divider());

  // ---- アーキテクチャ ----
  blocks.push(heading1('アーキテクチャ'));
  blocks.push(tableBlock(
    ['分類', '技術'],
    [
      ['フレームワーク', 'Next.js 16 (React 19, App Router)'],
      ['言語', 'TypeScript 5.9'],
      ['DB', 'Turso (libsql, HTTPS接続)'],
      ['ホスティング', 'Vercel'],
      ['MLモデル', 'XGBoost + CatBoost v16.0 (カテゴリ別オッズ重み最適化, 週次再学習)'],
      ['スクレイピング', 'Cheerio + yt-dlp + Whisper'],
      ['通知', 'Nodemailer (Gmail) + Slack Webhook'],
      ['スタイル', 'Tailwind CSS 4'],
    ],
  ));
  blocks.push(heading2('主要コンポーネント'));
  blocks.push(bulletItem('Web UI: レース一覧、予想詳細、統計ダッシュボード、馬券セット画面（/betting）'));
  blocks.push(bulletItem('API: 25エンドポイント（レース・予想・オッズ・統計・馬券管理）'));
  blocks.push(bulletItem('予想エンジン: XGBoost+CatBoostのアンサンブル → しょーさん理論でオーバーレイ'));
  blocks.push(bulletItem('パドック監視: YouTube Live音声 → Whisper文字起こし → LLM要約 → 発走7分前に予想再生成'));
  blocks.push(bulletItem('オッズ監視: 10秒間隔で急落検知 → 発走3分前に条件判定 → Slack通知'));
  blocks.push(bulletItem('馬券セット: ユーザー別買い目管理 → 合成オッズ計算 → 均等払い戻し配分'));

  blocks.push(heading2('システム全体図'));
  blocks.push(heading3('データ収集 → DB → 予想'));
  blocks.push(codeBlock(
`netkeiba ──Cheerio──→ レース/出走表/過去成績/オッズ ──→ ┐
                                                     │
YouTube Live ─yt-dlp→ ffmpeg → Whisper → パドック情報 ─→ ┤
                                                     ▼
                                              ┌──────────────┐
                                              │  Turso DB    │
                                              │  races       │
                                              │  entries     │
                                              │  predictions │
                                              │  bet_targets │
                                              │  odds_snaps  │
                                              └──────┬───────┘
                                                     │
                              ┌───────────────────────┤
                              ▼                       ▼
                       ┌────────────┐          ┌───────────┐
                       │ 予想エンジン  │          │ Web UI    │
                       │ XGBoost    │          │ (Vercel)  │
                       │ + CatBoost │          │ Next.js16 │
                       │ +しょーさん  │          └───────────┘
                       └────────────┘`, 'plain text'));

  blocks.push(heading3('レースデイ自動化 → 通知'));
  blocks.push(codeBlock(
`paddock-watcher.sh           odds-watcher.sh
  │                             │
  ├─ 60秒ごと音声文字起こし        ├─ 10秒ごとオッズ取得
  ├─ 発走7分前 → 予想再生成       ├─ T-30〜T-5分 スナップ保存
  └─ 変更あり → メール通知         ├─ 30%急落 → Slack通知
                                └─ T-3分 → bet-checker
                                           │
                                    条件クリア → Slack+メール
                                           │
                                           ▼
                                      ユーザー(3人)
                                      └→ IPATで購入

GitHub Actions (CI/CD)
  ├─ 毎朝 06:15  予想生成
  ├─ 毎夕 17:30  結果取得 + 精度計算
  ├─ 毎週日曜    モデル再学習
  └─ 毎日       Notion更新`, 'plain text'));

  blocks.push(heading2('レースデイの流れ'));
  blocks.push(codeBlock(
`時刻        イベント                         実行元
─────────────────────────────────────────────────────────
06:15  ┃  レース・出走表取得 → 予想生成          GitHub Actions
       ┃
09:00  ┃  paddock-watcher.sh 起動              ローカルMac
       ┃  ├─ 朝一しょーさん予想メール送信
       ┃  ├─ 朝一オッズスナップショット保存
       ┃  └─ odds-watcher.sh 起動（10秒間隔）
       ┃
       ┃  ┌─ 60秒ごと ─────────────────────┐
       ┃  │  YouTube音声取得 → Whisper文字起こし │
       ┃  └────────────────────────────────┘
       ┃
       ┃  ┌─ 10秒ごと ─────────────────────┐
       ┃  │  全レースオッズ取得                  │
       ┃  │  T-30/25/20/15/10/5分でスナップ保存  │
       ┃  │  30%以上急落 → Slack通知             │
       ┃  └────────────────────────────────┘
       ┃
T-7min ┃  発走7分前 ─────────────────────────
       ┃  ├─ 完走済みレース結果取得（馬場バイアス用）
       ┃  ├─ 該当レース予想を再生成
       ┃  └─ しょーさん予想変更あればメール通知
       ┃
T-3min ┃  発走3分前 ─────────────────────────
       ┃  ├─ bet_targets の合成オッズ計算
       ┃  ├─ 条件クリア → Slack + メール通知
       ┃  └─ ユーザーがIPATで購入
       ┃
17:00  ┃  paddock-watcher 自動終了
       ┃
17:30  ┃  全レース結果取得 → 精度計算            GitHub Actions
       ┃  └─ Notion ダッシュボード更新`, 'plain text'));
  blocks.push(divider());

  // ---- しょーさん予想の仕様 ----
  blocks.push(heading1('しょーさん予想'));
  blocks.push(heading2('理論1: 復調 + アゲ騎手乗り替わり'));
  blocks.push(bulletItem('必須: 前走4着以下 + アゲ騎手への乗り替わり + 先行力(1角1-2番手)2回以上'));
  blocks.push(bulletItem('スコア: 基本30 + 先行力回数(5-15) + 騎手ゾーン(5-20) = 最低45で採用'));
  blocks.push(heading2('理論2: 好調継続 + アゲ騎手乗り替わり'));
  blocks.push(bulletItem('必須: 前走3着以内 + 前走騎手がZone1-2/ルメ/川田 + アゲ騎手への乗り替わり'));
  blocks.push(bulletItem('スコア: 基本30 + 前走着順(5-15) + 乗替(10) + 前走一流(15) + ゾーン(5-20)'));
  blocks.push(heading2('アゲ騎手ゾーン'));
  blocks.push(tableBlock(
    ['Zone', '騎手', '特徴'],
    [
      ['1', '武豊, 松山, 横山武, 坂井', '長年好成績'],
      ['2', '岩田望, 鮫島駿, 荻野極', '直近好調（期待値最高）'],
      ['3', '菱田, 西塚, 石川, 浜中, 三浦, 斎藤, 田山', '先行意識高い'],
      ['4', '丹内, 佐々木', '一時的'],
    ],
  ));
  blocks.push(heading2('休養フィルタ'));
  blocks.push(bulletItem('0-27日（連戦）: バックテストROI 113-153%'));
  blocks.push(bulletItem('56-69日（短期放牧明け）: ROI 127-190%'));
  blocks.push(bulletItem('91-120日（休み明け一発）: ROI 184-321%'));
  blocks.push(divider());

  // ---- 成績 ----
  blocks.push(heading1('成績'));
  blocks.push(heading2('しょーさん予想（本番運用）'));
  blocks.push(tableBlock(
    ['指標', '理論1', '理論2', '全体'],
    [
      ['候補数', `${shoshanStats.theory1.count}`, `${shoshanStats.theory2.count}`, `${shoshanStats.total}`],
      ['1着率', `${shoshanStats.theory1.count > 0 ? (shoshanStats.theory1.wins / shoshanStats.theory1.count * 100).toFixed(1) : 0}%`, `${shoshanStats.theory2.count > 0 ? (shoshanStats.theory2.wins / shoshanStats.theory2.count * 100).toFixed(1) : 0}%`, `${shoshanStats.winRate}%`],
      ['3着内率', `${shoshanStats.theory1.count > 0 ? (shoshanStats.theory1.top3 / shoshanStats.theory1.count * 100).toFixed(1) : 0}%`, `${shoshanStats.theory2.count > 0 ? (shoshanStats.theory2.top3 / shoshanStats.theory2.count * 100).toFixed(1) : 0}%`, `${shoshanStats.top3Rate}%`],
      ['単勝ROI', `${shoshanStats.theory1.roi}%`, `${shoshanStats.theory2.roi}%`, `${shoshanStats.winRoi}%`],
    ],
  ));
  blocks.push(heading3('騎手ゾーン別'));

  const zoneRows = [1, 2, 3, 4].map(z => {
    const d = shoshanStats.byZone[z];
    if (!d || d.count === 0) return [`Zone${z}`, '0', '-', '-', '-'];
    return [
      `Zone${z}`,
      `${d.count}`,
      `${(d.wins / d.count * 100).toFixed(1)}%`,
      `${(d.top3 / d.count * 100).toFixed(1)}%`,
      `${(d.roi / d.count * 100).toFixed(0)}%`,
    ];
  });
  blocks.push(tableBlock(['Zone', '頭数', '1着率', '3着内率', '単勝ROI'], zoneRows));

  blocks.push(heading2('AI予想（Top-1 pick）'));
  blocks.push(tableBlock(
    ['指標', '値'],
    [
      ['総予想数', `${aiStats.total}`],
      ['単勝的中', `${aiStats.wins} (${aiStats.total > 0 ? (aiStats.wins / aiStats.total * 100).toFixed(1) : 0}%)`],
      ['複勝的中', `${aiStats.places} (${aiStats.total > 0 ? (aiStats.places / aiStats.total * 100).toFixed(1) : 0}%)`],
      ['単勝ROI', `${aiStats.roi}%`],
    ],
  ));
  blocks.push(divider());

  // ---- パターン仮説 ----
  blocks.push(heading1('パターン仮説（検証中）'));
  blocks.push(callout('191頭分析。500頭到達時（2026年6月頃）に再検証予定。', '🔬'));
  blocks.push(heading2('有望パターン'));
  blocks.push(bulletItem('理論1×3-5番人気: 44頭 ROI 142%（最も実用的）'));
  blocks.push(bulletItem('先行4回+: 19頭 ROI 208%'));
  blocks.push(bulletItem('matchScore 75+: 8頭 ROI 299%（少数）'));
  blocks.push(bulletItem('理論1×ダート: 87頭 ROI 119%'));
  blocks.push(bulletItem('スコア65+×Zone2: 26頭 ROI 135%'));
  blocks.push(heading2('除外すべきパターン'));
  blocks.push(bulletItem('10番人気以下: 32頭で1着ゼロ'));
  blocks.push(bulletItem('matchScore 45-54: 15頭で1着ゼロ'));
  blocks.push(bulletItem('Zone4（丹内・佐々木）: 27頭 ROI 26%'));
  blocks.push(bulletItem('過去に同騎手×同馬で4着以下のみ: 全滅'));
  blocks.push(divider());

  // ---- 今後の計画 ----
  blocks.push(heading1('今後の計画'));
  blocks.push(heading2('馬券セットシステム'));
  blocks.push(bulletItem('Phase 1（進行中）: 通知→手動IPAT購入。全券種オッズ取得済み'));
  blocks.push(bulletItem('Phase 2: Playwright でIPAT自動操作（Mac常時起動、1人検証）'));
  blocks.push(bulletItem('Phase 3: React Native アプリで3人同時自動購入'));
  blocks.push(heading2('予想改善'));
  blocks.push(heading3('v16.0: カテゴリ別オッズ重み最適化（2026-05-03）'));
  blocks.push(bulletItem('問題: AIの1位予測が1番人気と96.9%一致 → 市場のコピーでROI 77.6%'));
  blocks.push(bulletItem('対策: カテゴリごとにオッズ特徴量の影響度を最適化'));
  blocks.push(tableBlock(
    ['カテゴリ', 'オッズ重み', '方針'],
    [
      ['芝スプリント', '0.0（無視）', '追い切り・血統で勝負'],
      ['芝マイル', '1.0（全力）', '市場が最も正確な距離帯'],
      ['芝長距離', '0.3（参考）', '展開・持続力が重要'],
      ['ダート短距離', '0.0（無視）', '騎手力・仕上がりで勝負'],
      ['ダート長距離', '0.0（無視）', '前走・脚質・調教師で勝負'],
    ],
  ));
  blocks.push(bulletItem('結果: テストセットROI 77.6% → 89.0%（+11.4pt）'));
  blocks.push(bulletItem('新特徴量: jockeyChanged（乗り替わり）、earlyPositionRatio（一角確保率）'));
  blocks.push(heading3('次の施策'));
  blocks.push(bulletItem('EVフィルタ戦略: no-oddsモデル確率×オッズでバリューベット検出'));
  blocks.push(bulletItem('パターン仮説の蓄積・再検証（500頭到達目標: 2026年6月）'));
  blocks.push(bulletItem('馬券種の最適化（複勝・ワイドでのROI検証）'));
  blocks.push(divider());

  // ---- 変更履歴 ----
  blocks.push(heading1('変更履歴（直近）'));
  for (const line of gitLog) {
    blocks.push(bulletItem(line));
  }

  // Append blocks in chunks of 100
  for (let i = 0; i < blocks.length; i += 100) {
    const chunk = blocks.slice(i, i + 100);
    await notionRequest('PATCH', `/blocks/${PAGE_ID}/children`, { children: chunk });
  }

  console.log(`[notion] 完了! ${blocks.length}ブロック書き込み`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
