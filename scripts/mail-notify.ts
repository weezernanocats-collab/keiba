/**
 * しょーさん予想メール通知
 *
 * 予想再生成後に呼び出し、しょーさん候補がいるレースのみメール送信する。
 *
 * 使い方:
 *   npx tsx scripts/mail-notify.ts --date 2026-04-16 --race "1東京5"
 *   npx tsx scripts/mail-notify.ts --date 2026-04-16          # 当日の未発走全レース
 */
import { readFileSync } from 'fs';

// Load .env.local
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
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

// ==================== 型 ====================

interface ShosanCandidate {
  horseNumber: number;
  horseName: string;
  theory: 1 | 2;
  matchScore: number;
  jockeyZone: number;
  jockeyName: string;
  reasons: string[];
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
}

interface RaceRow {
  race_id: string;
  race_name: string;
  racecourse_name: string;
  race_number: number;
  time: string | null;
  analysis_json: string;
}

// ==================== CLI引数パース ====================

const args = process.argv.slice(2);
let date = '';
let raceFilter = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date' && args[i + 1]) date = args[++i];
  if (args[i] === '--race' && args[i + 1]) raceFilter = args[++i];
}

if (!date) {
  date = new Date().toISOString().slice(0, 10);
}

// ==================== メイン ====================

async function main() {
  await ensureInitialized();

  // 予想があるレースを取得
  let query = `
    SELECT r.id as race_id, r.name as race_name, r.racecourse_name,
           r.race_number, r.time, p.analysis_json
    FROM predictions p
    JOIN races r ON r.id = p.race_id
    WHERE r.date = ?
    ORDER BY r.time, r.racecourse_name, r.race_number
  `;
  const params: string[] = [date];

  const rows = await dbAll<RaceRow>(query, params);

  // --race フィルタ（"1東京5" のような形式）
  const filtered = raceFilter
    ? rows.filter(r => {
        const key = `${r.racecourse_name}${r.race_number}`;
        return key.includes(raceFilter) || r.race_id.includes(raceFilter);
      })
    : rows;

  // しょーさん候補があるレースだけ抽出
  const racesWithShoshan: { race: RaceRow; shoshan: ShosanPrediction }[] = [];

  for (const race of filtered) {
    try {
      const analysis = JSON.parse(race.analysis_json || '{}');
      const shoshan = analysis.shosanPrediction as ShosanPrediction | undefined;
      if (shoshan && shoshan.candidates && shoshan.candidates.length > 0) {
        racesWithShoshan.push({ race, shoshan });
      }
    } catch {
      // パース失敗は無視
    }
  }

  if (racesWithShoshan.length === 0) {
    console.log(`[mail] ${date} ${raceFilter || '全レース'}: しょーさん候補なし。メール送信スキップ`);
    return;
  }

  console.log(`[mail] ${racesWithShoshan.length}レースにしょーさん候補あり → メール送信`);

  // メール本文を組み立て
  const subject = `🐴 しょーさん予想通知 ${date} (${racesWithShoshan.length}レース)`;
  const html = buildMailHtml(date, racesWithShoshan);

  await transporter.sendMail({
    from: `KEIBA MASTER <${GMAIL_USER}>`,
    to: NOTIFY_EMAIL_TO,
    subject,
    html,
  });

  console.log(`[mail] 送信完了 → ${NOTIFY_EMAIL_TO}`);
}

// ==================== メール本文生成 ====================

function buildMailHtml(
  date: string,
  races: { race: RaceRow; shoshan: ShosanPrediction }[],
): string {
  const sections = races.map(({ race, shoshan }) => {
    const timeStr = race.time || '??:??';
    const header = `${race.racecourse_name} ${race.race_number}R ${race.race_name}（${timeStr}発走）`;

    const candidateRows = shoshan.candidates.map((c, i) => {
      const rank = ['◎', '○', '▲'][i] || '△';
      const theoryLabel = `理論${c.theory}`;
      const zoneLabel = `Z${c.jockeyZone} ${c.jockeyName}`;
      const scoreColor = c.matchScore >= 70 ? '#ea580c' : c.matchScore >= 55 ? '#ca8a04' : '#6b7280';

      // 1角確保スコア
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

    // 馬連推奨
    let umarenHtml = '';
    if (shoshan.umarenRecommendations.length > 0) {
      const recs = shoshan.umarenRecommendations.map(r => {
        const color = r.confidence === '高' ? '#ea580c' : r.confidence === '中' ? '#ca8a04' : '#6b7280';
        return `<span style="display:inline-block;margin:2px 4px;padding:4px 10px;border-radius:6px;border:1px solid ${color};font-weight:bold;font-size:13px;">${r.horses.join('-')} (${r.confidence})</span>`;
      }).join('');
      umarenHtml = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #fed7aa;"><strong style="font-size:13px;">馬連推奨:</strong> ${recs}</div>`;
    }

    // 警告
    const warningHtml = shoshan.warning
      ? `<div style="margin-bottom:8px;padding:6px 10px;background:#fef9c3;border:1px solid #facc15;border-radius:6px;font-size:12px;color:#854d0e;">⚠️ ${shoshan.warning}</div>`
      : '';

    return `
      <div style="margin-bottom:20px;padding:16px;border:2px solid #fb923c;border-radius:12px;background:#fff7ed;">
        <h2 style="margin:0 0 10px;font-size:16px;color:#9a3412;">🏇 ${header}</h2>
        ${warningHtml}
        <table style="width:100%;border-collapse:collapse;">
          ${candidateRows}
        </table>
        ${umarenHtml}
      </div>`;
  }).join('');

  return `
    <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;">
      <h1 style="font-size:20px;color:#9a3412;border-bottom:2px solid #fb923c;padding-bottom:8px;">
        🐴 しょーさん予想通知 — ${date}
      </h1>
      <p style="font-size:13px;color:#6b7280;margin-bottom:16px;">
        発走前再生成で検出された、しょーさん理論該当馬の通知です（${races.length}レース）
      </p>
      ${sections}
      <p style="font-size:11px;color:#9ca3af;margin-top:20px;text-align:center;">
        KEIBA MASTER — 先行力 × 乗り替わり × アゲ騎手
      </p>
    </div>`;
}

main().catch(e => {
  console.error('[mail] エラー:', e);
  process.exit(1);
});
