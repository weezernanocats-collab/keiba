/**
 * しょーさん予想メール通知
 *
 * モード:
 *   朝一通知:   npx tsx scripts/mail-notify.ts --date 2026-04-19
 *               → 全レースのしょーさん候補を1レース1通で送信 + スナップショット保存
 *
 *   7分前通知:  npx tsx scripts/mail-notify.ts --date 2026-04-19 --race "福島3" --diff
 *               → 再生成後、朝のスナップショットと比較して変更があれば送信
 *
 *   スナップショットのみ: npx tsx scripts/mail-notify.ts --date 2026-04-19 --snapshot-only
 *               → メール送信せずスナップショットだけ保存
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { mkdirSync } from 'fs';

// Load .env.local
if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

import { createTransport } from 'nodemailer';
import { ensureInitialized, dbAll } from '../src/lib/database';

// ==================== 設定 ====================

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAIL_TO = process.env.NOTIFY_EMAIL_TO;

if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !NOTIFY_EMAIL_TO) {
  console.log('[mail] GMAIL_USER / GMAIL_APP_PASSWORD / NOTIFY_EMAIL_TO が未設定。スキップ');
  process.exit(0);
}

const transporter = createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

const SNAPSHOT_DIR = '/tmp/shoshan_snapshots';

// ==================== 型 ====================

interface ShosanCandidate {
  horseNumber: number;
  horseName: string;
  theory: 1 | 2;
  matchScore: number;
  jockeyZone: number;
  jockeyName: string;
  reasons: string[];
  restDays?: number;
}

interface EarlySpeedEntry {
  earlyPacePer200m: number;
  earlyPaceRelative: number;
  firstCornerScore: number;
  firstCornerFactors: string[];
}

interface ShosanPrediction {
  candidates: ShosanCandidate[];
  umarenRecommendations: { horses: number[]; confidence: string }[];
  warning?: string;
  earlySpeedData?: Record<number, EarlySpeedEntry>;
  restFilteredCandidates?: ShosanCandidate[];
  restFilteredUmarenRecommendations?: { horses: number[]; confidence: string }[];
}

interface RaceRow {
  race_id: string;
  race_name: string;
  racecourse_name: string;
  race_number: number;
  time: string | null;
  analysis_json: string;
}

// ==================== スナップショット ====================

/** しょーさん候補のフィンガープリント（馬番+理論のソート済み文字列。スコア変動では通知しない） */
function fingerprint(shoshan: ShosanPrediction): string {
  return shoshan.candidates
    .map(c => `${c.horseNumber}:T${c.theory}`)
    .sort()
    .join('|');
}

function snapshotPath(date: string): string {
  return `${SNAPSHOT_DIR}/${date}.json`;
}

function loadSnapshot(date: string): Record<string, string> {
  const p = snapshotPath(date);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSnapshot(date: string, data: Record<string, string>) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(snapshotPath(date), JSON.stringify(data, null, 2));
}

// ==================== CLI引数パース ====================

const args = process.argv.slice(2);
let date = '';
let raceFilter = '';
let diffMode = false;
let snapshotOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date' && args[i + 1]) date = args[++i];
  if (args[i] === '--race' && args[i + 1]) raceFilter = args[++i];
  if (args[i] === '--diff') diffMode = true;
  if (args[i] === '--snapshot-only') snapshotOnly = true;
}

if (!date) {
  date = new Date().toISOString().slice(0, 10);
}

// ==================== メイン ====================

async function main() {
  await ensureInitialized();

  const rows = await dbAll<RaceRow>(`
    SELECT r.id as race_id, r.name as race_name, r.racecourse_name,
           r.race_number, r.time, p.analysis_json
    FROM predictions p
    JOIN races r ON r.id = p.race_id
    WHERE r.date = ?
    ORDER BY r.time, r.racecourse_name, r.race_number
  `, [date]);

  // --race フィルタ（完全一致）
  const filtered = raceFilter
    ? rows.filter(r => {
        const key = `${r.racecourse_name}${r.race_number}`;
        return key === raceFilter || r.race_id === raceFilter;
      })
    : rows;

  // 現在のしょーさんデータを取得
  const currentFingerprints: Record<string, string> = {};
  const racesWithShoshan: { race: RaceRow; shoshan: ShosanPrediction }[] = [];

  for (const race of filtered) {
    try {
      const analysis = JSON.parse(race.analysis_json || '{}');
      const shoshan = analysis.shosanPrediction as ShosanPrediction | undefined;
      const raceKey = `${race.racecourse_name}${race.race_number}`;

      if (shoshan && shoshan.candidates && shoshan.candidates.length > 0) {
        currentFingerprints[raceKey] = fingerprint(shoshan);
        racesWithShoshan.push({ race, shoshan });
      } else {
        currentFingerprints[raceKey] = '';
      }
    } catch {
      // パース失敗は無視
    }
  }

  // --snapshot-only: スナップショット保存のみ
  if (snapshotOnly) {
    // 全レースのフィンガープリントを保存（フィルタなしで再取得）
    const allRows = await dbAll<RaceRow>(`
      SELECT r.id as race_id, r.name as race_name, r.racecourse_name,
             r.race_number, r.time, p.analysis_json
      FROM predictions p
      JOIN races r ON r.id = p.race_id
      WHERE r.date = ?
    `, [date]);
    const allFp: Record<string, string> = {};
    for (const race of allRows) {
      try {
        const analysis = JSON.parse(race.analysis_json || '{}');
        const shoshan = analysis.shosanPrediction as ShosanPrediction | undefined;
        const key = `${race.racecourse_name}${race.race_number}`;
        allFp[key] = (shoshan?.candidates?.length) ? fingerprint(shoshan) : '';
      } catch { /* ignore */ }
    }
    saveSnapshot(date, allFp);
    console.log(`[mail] スナップショット保存完了 (${Object.keys(allFp).length}レース)`);
    return;
  }

  // --diff: スナップショットと比較して変更があるレースのみ送信
  if (diffMode) {
    const snapshot = loadSnapshot(date);
    let sentCount = 0;

    for (const { race, shoshan } of racesWithShoshan) {
      const raceKey = `${race.racecourse_name}${race.race_number}`;
      const oldFp = snapshot[raceKey] || '';
      const newFp = currentFingerprints[raceKey] || '';

      if (oldFp === newFp) {
        console.log(`[mail] ${raceKey}: 変更なし。スキップ`);
        continue;
      }

      const raceLabel = `${race.racecourse_name}${race.race_number}R ${race.race_name}`;
      const changeNote = oldFp === '' ? '新規' : '更新';
      const subject = `🔄 しょーさん予想${changeNote}: ${raceLabel}（${race.time || '??:??'}発走）`;
      const html = buildMailHtml(date, race, shoshan, changeNote);

      await transporter.sendMail({
        from: `KEIBA MASTER <${GMAIL_USER}>`,
        to: NOTIFY_EMAIL_TO,
        subject,
        html,
      });

      console.log(`[mail] ${changeNote}送信: ${raceLabel} → ${NOTIFY_EMAIL_TO}`);
      sentCount++;
    }

    // 新しいスナップショットで上書き
    const fullSnapshot = { ...snapshot, ...currentFingerprints };
    saveSnapshot(date, fullSnapshot);

    if (sentCount === 0) {
      console.log(`[mail] ${date} ${raceFilter || '全レース'}: しょーさん予想に変更なし`);
    }
    return;
  }

  // デフォルト: 朝一通知（全レースを1通にまとめて送信 + スナップショット保存）
  if (racesWithShoshan.length === 0) {
    console.log(`[mail] ${date}: しょーさん候補なし。メール送信スキップ`);
  } else {
    const subject = `🐴 しょーさん予想一覧 ${date}（${racesWithShoshan.length}レース）`;
    const html = buildMorningSummaryHtml(date, racesWithShoshan);

    await transporter.sendMail({
      from: `KEIBA MASTER <${GMAIL_USER}>`,
      to: NOTIFY_EMAIL_TO,
      subject,
      html,
    });

    console.log(`[mail] 朝一通知送信完了: ${racesWithShoshan.length}レース → ${NOTIFY_EMAIL_TO}`);

    // スナップショット保存
    const allRows = raceFilter ? await dbAll<RaceRow>(`
      SELECT r.id as race_id, r.name as race_name, r.racecourse_name,
             r.race_number, r.time, p.analysis_json
      FROM predictions p JOIN races r ON r.id = p.race_id WHERE r.date = ?
    `, [date]) : rows;
    const allFp: Record<string, string> = {};
    for (const race of allRows) {
      try {
        const analysis = JSON.parse(race.analysis_json || '{}');
        const shoshan = analysis.shosanPrediction as ShosanPrediction | undefined;
        const key = `${race.racecourse_name}${race.race_number}`;
        allFp[key] = (shoshan?.candidates?.length) ? fingerprint(shoshan) : '';
      } catch { /* ignore */ }
    }
    saveSnapshot(date, allFp);
    console.log(`[mail] スナップショット保存完了 (${Object.keys(allFp).length}レース記録)`);
  }
}

// ==================== メール本文生成 ====================

/** 1レース分のHTMLセクションを生成（朝一まとめ・7分前単体の両方で使う） */
function buildRaceSection(race: RaceRow, shoshan: ShosanPrediction): string {
  const timeStr = race.time || '??:??';
  const header = `${race.racecourse_name} ${race.race_number}R ${race.race_name}（${timeStr}発走）`;

  const candidateRows = shoshan.candidates.map((c, i) => {
    const rank = ['◎', '○', '▲'][i] || '△';
    const theoryLabel = `理論${c.theory}`;
    const zoneLabel = `Z${c.jockeyZone} ${c.jockeyName}`;
    const scoreColor = c.matchScore >= 70 ? '#ea580c' : c.matchScore >= 55 ? '#ca8a04' : '#6b7280';

    let earlySpeedHtml = '';
    if (shoshan.earlySpeedData?.[c.horseNumber]) {
      const es = shoshan.earlySpeedData[c.horseNumber];
      const fcColor = es.firstCornerScore >= 65 ? '#16a34a'
        : es.firstCornerScore >= 45 ? '#ca8a04' : '#dc2626';
      earlySpeedHtml = `
        <div style="margin-top:4px;font-size:12px;">
          ${es.earlyPacePer200m > 0 ? `<span style="color:#2563eb;">テン ${es.earlyPacePer200m.toFixed(2)}s/200m (${es.earlyPaceRelative >= 0 ? '+' : ''}${es.earlyPaceRelative.toFixed(2)})</span> ` : ''}
          <span style="color:${fcColor};font-weight:bold;">1角確保 ${es.firstCornerScore}点</span>
          ${es.firstCornerFactors.length > 0 ? `<span style="color:#6b7280;"> ${es.firstCornerFactors.join(' / ')}</span>` : ''}
        </div>`;
    }

    return `
      <tr>
        <td style="padding:6px 8px;font-size:18px;font-weight:bold;color:${scoreColor};text-align:center;">${rank}</td>
        <td style="padding:6px 8px;">
          <strong>${c.horseNumber}番 ${c.horseName}</strong>
          <span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:bold;background:${c.theory === 1 ? '#dbeafe' : '#ede9fe'};color:${c.theory === 1 ? '#1d4ed8' : '#6d28d9'};">${theoryLabel}</span>
          <span style="margin-left:4px;font-size:12px;color:#6b7280;">${zoneLabel}</span>
          <div style="margin-top:4px;">
            <span style="font-weight:bold;color:${scoreColor};">${c.matchScore}%</span>
            <span style="font-size:12px;color:#6b7280;margin-left:8px;">${c.reasons.join(' / ')}</span>
          </div>
          ${earlySpeedHtml}
        </td>
      </tr>`;
  }).join('');

  let umarenHtml = '';
  if (shoshan.umarenRecommendations.length > 0) {
    const recs = shoshan.umarenRecommendations.map(r => {
      const color = r.confidence === '高' ? '#ea580c' : r.confidence === '中' ? '#ca8a04' : '#6b7280';
      return `<span style="display:inline-block;margin:2px 4px;padding:4px 10px;border-radius:6px;border:1px solid ${color};font-weight:bold;font-size:13px;">${r.horses.join('-')} (${r.confidence})</span>`;
    }).join('');
    umarenHtml = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #fed7aa;"><strong style="font-size:13px;">馬連推奨:</strong> ${recs}</div>`;
  }

  const warningHtml = shoshan.warning
    ? `<div style="margin-bottom:8px;padding:6px 10px;background:#fef9c3;border:1px solid #facc15;border-radius:6px;font-size:12px;color:#854d0e;">⚠️ ${shoshan.warning}</div>`
    : '';

  return `
    <div style="margin-bottom:16px;padding:12px;border:2px solid #fb923c;border-radius:12px;background:#fff7ed;">
      <h2 style="margin:0 0 8px;font-size:15px;color:#9a3412;">🏇 ${header}</h2>
      ${warningHtml}
      <table style="width:100%;border-collapse:collapse;">
        ${candidateRows}
      </table>
      ${umarenHtml}
    </div>`;
}

/** 朝一まとめメール（全レースを1通に） */
function buildMorningSummaryHtml(
  date: string,
  races: { race: RaceRow; shoshan: ShosanPrediction }[],
): string {
  const sections = races.map(({ race, shoshan }) => buildRaceSection(race, shoshan)).join('');

  return `
    <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;">
      <h1 style="font-size:20px;color:#9a3412;border-bottom:2px solid #fb923c;padding-bottom:8px;">
        🐴 しょーさん予想一覧 — ${date}
      </h1>
      <p style="font-size:13px;color:#6b7280;margin-bottom:16px;">
        本日のしょーさん理論該当馬（${races.length}レース）
      </p>
      ${sections}
      <p style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center;">
        KEIBA MASTER — 先行力 × 乗り替わり × アゲ騎手
      </p>
    </div>`;
}

/** 7分前更新メール（1レース単体） */
function buildMailHtml(
  date: string,
  race: RaceRow,
  shoshan: ShosanPrediction,
  changeNote: string,
): string {
  const timeStr = race.time || '??:??';
  const header = `${race.racecourse_name} ${race.race_number}R ${race.race_name}（${timeStr}発走）`;
  const section = buildRaceSection(race, shoshan);

  return `
    <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;">
      <h1 style="font-size:18px;color:#9a3412;border-bottom:2px solid #fb923c;padding-bottom:8px;">
        🔄 ${header}
      </h1>
      <p style="font-size:12px;color:#6b7280;margin-bottom:12px;">${date} 発走前再生成で予想が${changeNote}されました</p>
      ${section}
      <p style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center;">
        KEIBA MASTER — 先行力 × 乗り替わり × アゲ騎手
      </p>
    </div>`;
}

main().catch(e => {
  console.error('[mail] エラー:', e);
  process.exit(1);
});
