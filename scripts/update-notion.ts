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

async function notionRequest(method: string, path: string, body?: unknown, attempt = 0): Promise<any> {
  const MAX_RETRIES = 3;
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return res.json();
  // 5xx/429 はリトライ (指数バックオフ: 1秒 → 2秒 → 4秒)
  if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
    const delayMs = 1000 * Math.pow(2, attempt);
    console.error(`[notion] ${res.status} エラー、${delayMs}ms 待機後 retry (${attempt + 1}/${MAX_RETRIES})`);
    await new Promise(r => setTimeout(r, delayMs));
    return notionRequest(method, path, body, attempt + 1);
  }
  const text = await res.text();
  throw new Error(`Notion API ${res.status}: ${text}`);
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

07:30  全レースの予想自動生成（しょーさん予想 + AI）
09:00  per-race スケジューラ起動
       ↓ 全レースの morning baseline odds を一括取得
       ↓
    各レース発走20分前: 中間オッズ snapshot
    各レース発走 7分前: 直前オッズ取得
                       → 朝→直前で +30%以上上昇した馬を除外
                       → IPAT自動投票（単勝 + 馬連ボックス）
                       ↓
17:30  スケジューラ自動停止
18:00  結果取得 → Notion自動更新
`, 'plain text'));
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
  // 戦略バックテスト
  // ============================================================
  blocks.push(heading1('戦略バックテスト'));

  blocks.push(callout('2025年通年109日 + 2026年7日のデータで複数戦略を検証。下の数字は単独戦略のROI。', '\u{1F4CA}'));

  blocks.push(heading2('単独戦略（2025年フル）'));
  blocks.push(tableBlock(
    ['戦略', '件数', 'ベット', '払戻', '収支', 'ROI', '的中率'],
    [
      ['単勝 × 休養F理論1（全閾値）',     '521', '52,100',  '77,360',  '+25,260', '148.5%', '13.2%'],
      ['単勝 × 休養F全候補（matchScore≥65）','31', '3,100', '8,410',   '+5,310',  '271.3%', '16.1%'],
      ['単勝 × 全候補（理論1+2、閾値なし）','1,056','105,600','118,560','+12,960', '112.3%', '12.3%'],
      ['ワイド × 全候補（matchScore≥55）', '280', '924,100','881,980', '-42,120', '95.4%',  '13.7%'],
      ['馬連 × 全候補（matchScore≥55）',  '280', '924,100','766,180', '-157,920','82.9%',  '5.5%'],
    ],
  ));
  blocks.push(paragraph('単勝×休養F理論1がROI 148.5%で最有力。ワイド・馬連はROI 100%未満。'));

  blocks.push(heading2('採用施策の効果（2026年7日, 76レース）'));
  blocks.push(tableBlock(
    ['施策', 'ROI', '効果'],
    [
      ['ベースライン（ワイド+単勝、フィルタなし）',  '152%', '基準'],
      ['+30%上昇馬を除外（直前オッズフィルタ）',  '166%', '+13pt'],
      ['単勝にscore別重み（>=65: 200円, <65: 100円）','182%', '+30pt'],
      ['ワイドのboxにscore別重みは効果なし', '-', '不採用'],
      ['直前下落馬の単勝買い増し（10%以上下落）',  '127%', '逆効果 −25pt → 不採用'],
    ],
  ));
  blocks.push(paragraph('直前下落馬は3着内率高いが配当が薄く期待値マイナス（市場が既に織り込み済み）。'));

  blocks.push(heading2('平場 vs 特別レース（2025+2026）'));
  blocks.push(tableBlock(
    ['カテゴリ', 'ベット', '払戻', 'ROI', '収支'],
    [
      ['平場（未勝利・1勝・2勝・3勝クラス）',  '122,800', '107,950', '87.9%',  '-14,850'],
      ['特別レース（冠名つき・グレード）',     '138,300', '151,610', '109.6%', '+13,310'],
    ],
  ));
  blocks.push(paragraph('特別レースの方が一貫してROI高い。平場ワイド(67.8%)が足を引っ張る。'));

  blocks.push(heading2('2026-05実戦結果（参考）'));
  blocks.push(tableBlock(
    ['日付', 'ベット', '払戻', '収支', 'ROI'],
    [
      ['5/9 (土)',  '8,200',  '1,610',  '-6,590', '19.6%'],
      ['5/10 (日)', '9,400',  '11,800', '+2,400', '125.5%'],
      ['2日合算',   '17,600', '13,410', '-4,190', '76.2%'],
    ],
  ));
  blocks.push(paragraph('5/10新潟8Rワイド9-12-14が当たり日。2日サンプルではブレ大。これに +30%上昇除外フィルタを適用すると ROI 124.2%、score重みで更に +6pt 改善見込み。'));
  blocks.push(divider());

  // ============================================================
  // 3. 自動投票システム
  // ============================================================
  blocks.push(heading1('自動投票システム'));

  blocks.push(callout('レース単位スケジューラが直前オッズフィルタを掛けて IPAT 自動投票（2026-05-28 構成）。', '\u{1F3B0}'));

  blocks.push(heading2('戦略'));
  blocks.push(tableBlock(
    ['戦略', '内容', '金額'],
    [
      ['単勝', '理論1 × 前走から50日以上空いた馬', 'matchScore≥65: 200円 / <65: 100円'],
      ['馬連ボックス', 'しょーさん候補(matchScore≥55) ∪ オッズ1〜3人気 を全頭ボックス', 'レース重みで按分 (1点100円〜)'],
    ],
  ));
  blocks.push(paragraph('単勝は休養日数フィルタを「50日以上」に一本化（旧: 0-27/56-69/91-120の好走ゾーン）。馬連は候補と人気を全部混ぜてボックス展開。'));

  blocks.push(heading2('直前オッズフィルタ'));
  blocks.push(bulletItem('朝→直前で +30%以上オッズが上昇した馬は買い目から除外'));
  blocks.push(bulletItem('2,795頭のバックテストで +30%以上上昇馬の3着内率は3.8%（vs 横ばい24%）'));
  blocks.push(bulletItem('5/9-5/10検証で ROI 76.2% → 124.2% に改善'));

  blocks.push(heading2('レース重み（中堅クラス厚め）'));
  blocks.push(tableBlock(
    ['クラス', '重み倍率'],
    [
      ['1勝クラス', '1.4'],
      ['2勝クラス', '1.5'],
      ['3勝クラス', '1.3'],
      ['未勝利', '1.0'],
      ['リステッド/OP', '1.0'],
      ['G3 / G2 / G1', '0.9 / 0.8 / 0.7'],
      ['3歳限定', '× 0.5'],
    ],
  ));
  blocks.push(paragraph('最終重み = レース番号 × age_mult × grade_mult。重い順に予算配分。'));

  blocks.push(heading2('予算配分（1日7,000円）'));
  blocks.push(bulletItem('単勝・馬連とも 各bet の (基準額 × レース重み) で比例配分'));
  blocks.push(bulletItem('100円単位丸め・最低100円、予算超過時は低weightレースから自動カット'));
  blocks.push(bulletItem('馬連boxは点数が多い(1日50点超)ため予算7,000円で全点カバー'));

  blocks.push(heading2('レース単位スケジューラ'));
  blocks.push(codeBlock(
`09:00 JST  scripts/ipat-race-scheduler.ts 起動（launchd）
            ↓ 全レースの morning baseline odds を一括 fetch & 記録
            ↓ ポーリングループ (30秒間隔)
各レース発走20分前  中間スナップショット (時系列観察用)
各レース発走 7分前  直前オッズ取得 → 朝対比フィルタ
                   → IPAT 自動投票（ヘッドレス Chromium）
17:30 JST  スケジューラ自動停止`, 'plain text'));
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

  blocks.push(heading2('休養日数別ROI（理論1）'));
  blocks.push(tableBlock(
    ['休養日数', 'ROI', 'メモ'],
    [
      ['0-27日（連戦）', '123.5%', '好調継続'],
      ['28-49日', '60-104%', '中途半端ゾーン（赤字寄り）'],
      ['56-69日（短期放牧明け）', '127.4%', 'リフレッシュ効果'],
      ['91-120日（休み明け一発）', '214.8%', '狙って仕上げ'],
    ],
  ));
  blocks.push(paragraph('単勝の実運用は「50日以上」で一本化（ユーザー指示）。ROI 130.0%（旧好走ゾーン版141.3%から-11pt）。50-55日帯は弱いが、シンプルさ優先。'));

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
