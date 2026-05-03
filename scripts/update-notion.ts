/**
 * Notion ページ自動更新スクリプト
 *
 * KEIBA MASTER プロジェクトの情報をNotionページに同期する。
 * - アーキテクチャ、仕様、変更履歴、しょーさん予想成績、今後の計���
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

function callout(text: string, emoji = '\u{1F4CC}') {
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

  // 日付プロパティに最終更新日時を設定（JST = +09:00）
  const isoDate = jstNow.toISOString().replace('Z', '+09:00').replace(/\.\d{3}/, '');
  await notionRequest('PATCH', `/pages/${PAGE_ID}`, {
    properties: {
      '\u65E5\u4ED8': { date: { start: isoDate } },
    },
  });

  // 既存ブロック削除
  await clearPageBlocks();

  // ブロック構築
  const blocks: unknown[] = [];

  blocks.push(callout(`最終更新: ${updatedAt}`, '\u{1F552}'));
  blocks.push(divider());

  // ============================================================
  // 1. 全体像
  // ============================================================
  blocks.push(heading1('KEIBA MASTER \u2014 全体像'));
  blocks.push(paragraph('競馬予想の自動化プロジェクト。AI予想 \u00D7 しょーさん理論の2軸で予想し、IPAT経由で自動購入まで完結。'));
  blocks.push(codeBlock(
`【毎週の流れ】

月曜  モデル自動再学習（最新レースデータで精度維持）
金曜  出走馬データ自動取得 → 予想生成

【レース当日】

06:15  全レースの予想を自動���成
09:00  パドック中継の文字起こし開始
09:03  開催日判定 → 自動投票Bot起動
       ���
    各レース発走7分前に予想を最新情報で更新
    オッズ急落検知 → Slack通知
       ↓
    Slackで「予算 5000」→ 自動投票実行 → 完了通知
       ↓
17:00  Bot自動停止
17:30  結果取得 → 成績集計`, 'plain text'));
  blocks.push(divider());

  // ============================================================
  // 2. 成績
  // ============================================================
  blocks.push(heading1('成績'));

  blocks.push(heading2('AI予想の実績'));
  blocks.push(tableBlock(
    ['指標', '値'],
    [
      ['総予想レース数', `${aiStats.total}`],
      ['単勝的中', `${aiStats.wins} (${aiStats.total > 0 ? (aiStats.wins / aiStats.total * 100).toFixed(1) : 0}%)`],
      ['複勝的中', `${aiStats.places} (${aiStats.total > 0 ? (aiStats.places / aiStats.total * 100).toFixed(1) : 0}%)`],
      ['単勝ROI', `${aiStats.roi}%`],
    ],
  ));
  blocks.push(paragraph('※ ROI 100%が損益分岐点。テストセット(997R)でのROIは89.0%。'));

  blocks.push(heading2('しょーさん予想の実績'));
  blocks.push(tableBlock(
    ['指標', '理論1', '理論2', '全体'],
    [
      ['候補数', `${shoshanStats.theory1.count}`, `${shoshanStats.theory2.count}`, `${shoshanStats.total}`],
      ['1着率', `${shoshanStats.theory1.count > 0 ? (shoshanStats.theory1.wins / shoshanStats.theory1.count * 100).toFixed(1) : 0}%`, `${shoshanStats.theory2.count > 0 ? (shoshanStats.theory2.wins / shoshanStats.theory2.count * 100).toFixed(1) : 0}%`, `${shoshanStats.winRate}%`],
      ['3着内率', `${shoshanStats.theory1.count > 0 ? (shoshanStats.theory1.top3 / shoshanStats.theory1.count * 100).toFixed(1) : 0}%`, `${shoshanStats.theory2.count > 0 ? (shoshanStats.theory2.top3 / shoshanStats.theory2.count * 100).toFixed(1) : 0}%`, `${shoshanStats.top3Rate}%`],
      ['単勝ROI', `${shoshanStats.theory1.roi}%`, `${shoshanStats.theory2.roi}%`, `${shoshanStats.winRoi}%`],
    ],
  ));

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
  blocks.push(heading3('騎手ゾーン別'));
  blocks.push(tableBlock(['Zone', '頭数', '1着率', '3着内率', '単勝ROI'], zoneRows));
  blocks.push(divider());

  // ============================================================
  // 3. 自動投票システム
  // ============================================================
  blocks.push(heading1('自動投票システム'));

  blocks.push(callout('Slack → 買い目自動生成 → IPAT自動購入 → Slack通知。マルチユーザー対応。', '\u{1F3B0}'));

  blocks.push(heading2('仕組み'));
  blocks.push(codeBlock(
`Slack「予算 5000」
     ���
しょーさん予想 + AI予想から買い目を自動生成
（ユーザーごとの券種・戦略・予算設定に基づ���）
     ↓
CSV → Playwright → JRA IPAT で自動投票
     ↓
Slack「投票完了! 17点 2,900円」+ スクリーンショット`, 'plain text'));

  blocks.push(heading2('買い目の戦略（3種類）'));
  blocks.push(tableBlock(
    ['戦略', '内容', '狙い'],
    [
      ['しょーさん予想', '先行力×休養×アゲ騎手理論', '穴馬の復活・好調継続'],
      ['AI予想', 'XGBoost+CatBoostの上位馬', 'データに基づく確率予測'],
      ['しょーさん×AI', '両方が一致した馬', '二つの根拠が揃った堅い軸'],
    ],
  ));

  blocks.push(heading2('対応券種'));
  blocks.push(bulletItem('単勝 / 馬連 / ワイド / 馬単 / 三連複 / 三連単'));
  blocks.push(paragraph('ユーザーごとに好きな券種・戦略・配分をWebで設定可能。'));

  blocks.push(heading2('マルチユーザー対応'));
  blocks.push(tableBlock(
    ['項目', '内容'],
    [
      ['ユーザー登録', 'スマホでURLを開いてIPAT情報を入力（1回のみ）'],
      ['認証情報の保管', 'AES-256-GCM暗号化。平文はサーバーに残らない'],
      ['買い方の設定', 'Webページで券種・戦略・予算・オッズフィルタを設定'],
      ['投票の指示', 'Slack「予算 5000 ユーザー名」で個別投票'],
      ['設定変��', 'いつでもWebから変更OK。次の開催日から反映'],
    ],
  ));

  blocks.push(heading2('開催日の自動起動'));
  blocks.push(bulletItem('毎朝9時にcronがDB確認 → その日にレースがあればBot自動起動'));
  blocks.push(bulletItem('最終レース+30分後にBot自動停止'));
  blocks.push(bulletItem('Slackで起動・停止を通知'));
  blocks.push(divider());

  // ============================================================
  // 4. AIモデルの仕組み
  // ============================================================
  blocks.push(heading1('AIモデルの仕組み'));

  blocks.push(heading2('予測の流れ'));
  blocks.push(codeBlock(
`出走馬データ（過去成績・騎手・調教師・血統・追い切り…）
     ↓
35個の特徴量に変換
     ↓
レースのカ���ゴリを判定（芝/ダート × 距離）
     ↓
カテゴリに合ったモデルで勝率を予測
     ↓
Top-1を単勝ピック、Top-3を複勝ピック`, 'plain text'));

  blocks.push(heading2('カテゴリ別オッズ重み'));
  blocks.push(paragraph('AIが市場オッズ（人気順）をどれだけ参考にするかをカ��ゴリごとに最適化。'));
  blocks.push(tableBlock(
    ['カテゴリ', 'オッズ重み', '何で勝負するか'],
    [
      ['芝スプリント', '0.0（無視）', '追い切り評価・血統・騎手力'],
      ['芝マイル', '1.0（全力活��）', '市場が正確。オッズに従う'],
      ['芝長距離', '0.3（少し参考）', '展開予測・持続力・脚質'],
      ['ダート短距離', '0.0（無視）', '騎手力・仕上がり・前走成績'],
      ['ダート長距離', '0.0（無視）', '前走・��質・調教師'],
    ],
  ));
  blocks.push(richParagraph([
    { text: '結果: ROI 77.6% → 89.0%', bold: true },
    { text: '（+11.4pt）' },
  ]));

  blocks.push(heading2('主な特徴量（35個）'));
  blocks.push(tableBlock(
    ['分類', '内容'],
    [
      ['オッズ', '対数変換オッズ（カテゴリで重み調整）'],
      ['騎手', '騎手能力値・直近勝率・乗り替わり'],
      ['調教師', '距離カテゴリ別勝率・直近勝率'],
      ['血統', '父の競馬場別勝率'],
      ['近走成績', '前走着順・直近3走勝率・連勝数'],
      ['スピード', 'スピード指数・基準タイム偏差・上がり3F'],
      ['脚質・展開', '脚質・コーナー通過順位変動・逃げ馬数'],
      ['距離適性', '距離適性・前走からの距離変更'],
      ['休養', '前走からの日数'],
      ['その他', '年齢・性別・枠順・斤量・馬体重・追い切り評価'],
    ],
  ));
  blocks.push(divider());

  // ============================================================
  // 5. しょーさん予想の仕組み
  // ============================================================
  blocks.push(heading1('しょーさん予想の仕組み'));

  blocks.push(heading2('理論1: 復調 + アゲ騎手'));
  blocks.push(bulletItem('前走4着以下の凡走 + アゲ騎手への乗り替わり + 先行力あり'));
  blocks.push(bulletItem('→ 実力馬が上手い騎手で復活するパターン'));

  blocks.push(heading2('理論2: 好調継続 + アゲ騎手'));
  blocks.push(bulletItem('前走3着以内の好走 + さらに良い騎手への乗り替わり'));
  blocks.push(bulletItem('→ 好調馬の上積みを狙うパターン'));

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

  blocks.push(heading2('休養フィルタ（効くパターン）'));
  blocks.push(tableBlock(
    ['休養日数', 'ROI', '狙い方'],
    [
      ['0-27日（連戦）', '113-153%', '好調時は走り続ける'],
      ['56-69日（短期放牧明け）', '127-190%', 'リフレッシュ効果'],
      ['91-120日（休み明け一発）', '184-321%', '狙って仕上げてくる'],
    ],
  ));

  blocks.push(heading3('狙い目パターン（191頭分析）'));
  blocks.push(tableBlock(
    ['パターン', '頭数', 'ROI', '備考'],
    [
      ['理論1 × 3-5番人気', '44', '142%', '最も実用的'],
      ['先行4回+', '19', '208%', '先行力の裏付けが強い'],
      ['理論1 × ダート', '87', '119%', 'ダートとの相性良好'],
      ['スコア65+ × Zone2', '26', '135%', '好調騎手×高スコ���'],
    ],
  ));
  blocks.push(heading3('避けるべき'));
  blocks.push(bulletItem('10番人気以下: 32頭で1着ゼロ'));
  blocks.push(bulletItem('Zone4（丹内・佐々木）: 27頭 ROI 26%'));
  blocks.push(paragraph('※ 500頭到達（2026年6月頃）で再検証予定。'));
  blocks.push(divider());

  // ============================================================
  // 6. パドック自動解説
  // ============================================================
  blocks.push(heading1('パドック自動解説'));
  blocks.push(paragraph('レース当日、YouTube Liveのパドック中継をリアルタイムで文字起こし → AIが要約して予想ページに表示。'));
  blocks.push(codeBlock(
`YouTube Live パドック中継
     ↓  60秒ごとに音声キャプチャ
Whisper large-v3 で文字起こし
     ↓
Claude AI が各馬のコンディション要約
     ↓
予想ページに反映（馬体・歩様・気配の評価）
     ↓
発走7分前にパドック情報込みで予想を自動更新`, 'plain text'));
  blocks.push(divider());

  // ============================================================
  // 7. 今後の計画
  // ============================================================
  blocks.push(heading1('今後の計画'));

  blocks.push(heading2('AI予想の改善'));
  blocks.push(bulletItem('EVフィルタ戦略: AIの確率予測 × オッズの乖離からバリューベット（期待値>1の馬）を自動検出'));
  blocks.push(bulletItem('パターン仮説の500頭再検証（2026年6月目標）'));
  blocks.push(bulletItem('no-oddsモデル強化: オッズに依存しない独自予測の精度向上'));

  blocks.push(heading2('自動投票の拡張'));
  blocks.push(bulletItem('友人向けマルチユーザー運用開始（Web登録→設定→自動投票）'));
  blocks.push(bulletItem('全ユーザー一括自動投票モード（開催日に全active設定を順次実行）'));
  blocks.push(bulletItem('投票結果のユーザー別レポート'));
  blocks.push(divider());

  // ============================================================
  // 8. システム構成
  // ============================================================
  blocks.push(heading1('システム構成'));
  blocks.push(tableBlock(
    ['分類', '技術'],
    [
      ['フレームワーク', 'Next.js 16 (React 19, App Router)'],
      ['言語', 'TypeScript 5.9 / Python 3'],
      ['DB', 'Turso (libsql, HTTPS接続)'],
      ['ホスティング', 'Vercel'],
      ['MLモデル', 'CatBoost YetiRank + XGBoost LambdaMART (35特徴量, 週次再学習)'],
      ['自動投票', 'Playwright (Chromium) → JRA IPAT'],
      ['スクレイピング', 'Cheerio (netkeiba) + yt-dlp + Whisper (パドック)'],
      ['通知', 'Gmail + Slack Bot'],
      ['認証情報暗号化', 'AES-256-GCM (鍵はローカルMacのみ)'],
      ['CI/CD', 'GitHub Actions (予想生成/結果取得/モデル再学習)'],
    ],
  ));
  blocks.push(divider());

  // ============================================================
  // 9. 変更履歴
  // ============================================================
  blocks.push(heading1('変更履歴'));
  for (const line of gitLog) {
    blocks.push(bulletItem(line));
  }

  // Append blocks in chunks of 100
  for (let i = 0; i < blocks.length; i += 100) {
    const chunk = blocks.slice(i, i + 100);
    await notionRequest('PATCH', `/blocks/${PAGE_ID}/children`, { children: chunk });
  }

  console.log(`[notion] 完了! ${blocks.length}ブロッ��書き込み`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
