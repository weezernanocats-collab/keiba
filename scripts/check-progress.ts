/**
 * 読み取り専用: バルクインポート進捗チェッカー
 *
 * 使い方: npx tsx scripts/check-progress.ts
 *
 * - Turso DBを読み取り専用でクエリ
 * - 各フェーズの進捗を表示
 * - 書き込みは一切行わないのでコンフリクトの心配なし
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';

// Load .env.local manually
try {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  console.error('.env.local が見つかりません。TURSO_DATABASE_URL と TURSO_AUTH_TOKEN を環境変数で設定してください。');
  process.exit(1);
}

const TURSO_URL = process.env.TURSO_DATABASE_URL!;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN!;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

interface Row {
  [key: string]: unknown;
}

async function query(sql: string, args: unknown[] = []): Promise<Row[]> {
  const result = await db.execute({ sql, args: args as import('@libsql/client').InValue[] });
  return result.rows as unknown as Row[];
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     🏇 過去レース AI生成 進捗レポート       ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ===== 全体サマリー =====
  const [raceTotal] = await query('SELECT COUNT(*) as c FROM races');
  const [raceByStatus] = await query(
    `SELECT
       SUM(CASE WHEN status = '予定' THEN 1 ELSE 0 END) as pending,
       SUM(CASE WHEN status = '出走確定' THEN 1 ELSE 0 END) as confirmed,
       SUM(CASE WHEN status = '結果確定' THEN 1 ELSE 0 END) as finished,
       SUM(CASE WHEN status = '中止' THEN 1 ELSE 0 END) as cancelled
     FROM races`
  );
  const [predTotal] = await query('SELECT COUNT(*) as c FROM predictions');
  const [horseTotal] = await query('SELECT COUNT(*) as c FROM horses');
  const [entryTotal] = await query('SELECT COUNT(*) as c FROM race_entries');
  const [oddsTotal] = await query('SELECT COUNT(*) as c FROM odds');
  const [ppTotal] = await query('SELECT COUNT(*) as c FROM past_performances');

  console.log('📊 全体サマリー');
  console.log('─'.repeat(46));
  console.log(`  レース総数:     ${raceTotal.c}`);
  console.log(`    予定:         ${raceByStatus.pending}`);
  console.log(`    出走確定:     ${raceByStatus.confirmed}`);
  console.log(`    結果確定:     ${raceByStatus.finished}`);
  console.log(`    中止:         ${raceByStatus.cancelled}`);
  console.log(`  出走馬:         ${entryTotal.c}`);
  console.log(`  馬データ:       ${horseTotal.c}`);
  console.log(`  過去成績:       ${ppTotal.c}`);
  console.log(`  オッズ:         ${oddsTotal.c}`);
  console.log(`  AI予想:         ${predTotal.c}`);
  console.log('');

  // ===== 日付別の進捗 =====
  const dateProgress = await query(
    `SELECT
       r.date,
       COUNT(DISTINCT r.id) as race_count,
       COUNT(DISTINCT p.race_id) as pred_count,
       SUM(CASE WHEN r.status = '結果確定' THEN 1 ELSE 0 END) as finished_count,
       SUM(CASE WHEN r.status = '出走確定' THEN 1 ELSE 0 END) as confirmed_count,
       SUM(CASE WHEN r.status = '予定' THEN 1 ELSE 0 END) as pending_count
     FROM races r
     LEFT JOIN predictions p ON r.id = p.race_id
     GROUP BY r.date
     ORDER BY r.date DESC`
  );

  console.log('📅 日付別進捗');
  console.log('─'.repeat(76));
  console.log('  日付        | レース | 結果確定 | 出走確定 | 予定 | AI予想 | 進捗');
  console.log('  ' + '─'.repeat(72));

  for (const row of dateProgress) {
    const raceCount = Number(row.race_count);
    const predCount = Number(row.pred_count);
    const finishedCount = Number(row.finished_count);
    const confirmedCount = Number(row.confirmed_count);
    const pendingCount = Number(row.pending_count);
    const pct = raceCount > 0 ? Math.round((predCount / raceCount) * 100) : 0;
    const bar = progressBar(pct, 12);

    console.log(
      `  ${row.date}  |  ${pad(raceCount, 4)} |    ${pad(finishedCount, 4)} |    ${pad(confirmedCount, 4)} | ${pad(pendingCount, 4)} |  ${pad(predCount, 4)} | ${bar} ${pct}%`
    );
  }
  console.log('');

  // ===== フェーズ別の進捗推定 =====
  console.log('🔄 フェーズ別進捗');
  console.log('─'.repeat(46));

  // Phase 1: レース一覧取得 (dates phase)
  const [racesWithDetails] = await query(
    `SELECT COUNT(*) as c FROM races WHERE status != '予定' OR distance > 0`
  );
  const phase1Pct = Number(raceTotal.c) > 0 ? Math.round((Number(racesWithDetails.c) / Number(raceTotal.c)) * 100) : 0;
  console.log(`  1. レース一覧取得:     ${progressBar(100, 20)} 100% (${raceTotal.c}件)`);

  // Phase 2: 出馬表取得 (race_details phase)
  const [racesNotPending] = await query(
    `SELECT COUNT(*) as c FROM races WHERE status IN ('出走確定', '結果確定')`
  );
  const phase2Total = Number(raceTotal.c);
  const phase2Done = Number(racesNotPending.c);
  const phase2Pct = phase2Total > 0 ? Math.round((phase2Done / phase2Total) * 100) : 0;
  console.log(`  2. 出馬表取得:         ${progressBar(phase2Pct, 20)} ${phase2Pct}% (${phase2Done}/${phase2Total})`);

  // Phase 3: 馬詳細・過去成績 (horses phase)
  const [horsesWithBirth] = await query(
    `SELECT COUNT(*) as c FROM horses WHERE birth_date IS NOT NULL AND birth_date != 'FETCH_FAILED'`
  );
  const [horsesTotal] = await query('SELECT COUNT(*) as c FROM horses');
  const phase3Total = Number(horsesTotal.c);
  const phase3Done = Number(horsesWithBirth.c);
  const phase3Pct = phase3Total > 0 ? Math.round((phase3Done / phase3Total) * 100) : 0;
  console.log(`  3. 馬詳細・過去成績:   ${progressBar(phase3Pct, 20)} ${phase3Pct}% (${phase3Done}/${phase3Total})`);

  // Phase 4: レース結果取得 (results phase)
  const phase4Total = Number(raceTotal.c);
  const phase4Done = Number(raceByStatus.finished);
  const phase4Pct = phase4Total > 0 ? Math.round((phase4Done / phase4Total) * 100) : 0;
  console.log(`  4. レース結果取得:     ${progressBar(phase4Pct, 20)} ${phase4Pct}% (${phase4Done}/${phase4Total})`);

  // Phase 5: オッズ取得 (odds phase)
  const [racesWithOdds] = await query(
    `SELECT COUNT(DISTINCT race_id) as c FROM odds`
  );
  const phase5Total = Number(raceTotal.c);
  const phase5Done = Number(racesWithOdds.c);
  const phase5Pct = phase5Total > 0 ? Math.round((phase5Done / phase5Total) * 100) : 0;
  console.log(`  5. オッズ取得:         ${progressBar(phase5Pct, 20)} ${phase5Pct}% (${phase5Done}/${phase5Total})`);

  // Phase 6: AI予想生成 (predictions phase)
  const phase6Total = Number(raceTotal.c);
  const phase6Done = Number(predTotal.c);
  const phase6Pct = phase6Total > 0 ? Math.round((phase6Done / phase6Total) * 100) : 0;
  console.log(`  6. AI予想生成:         ${progressBar(phase6Pct, 20)} ${phase6Pct}% (${phase6Done}/${phase6Total})`);

  // Phase 7: 予想照合 (evaluate phase)
  const [evalTotal] = await query('SELECT COUNT(*) as c FROM prediction_results');
  console.log(`  7. 予想照合:           ${evalTotal.c}件照合済み`);
  console.log('');

  // ===== 最新の予想生成タイムスタンプ =====
  const [latestPred] = await query(
    `SELECT generated_at, race_id FROM predictions ORDER BY id DESC LIMIT 1`
  );
  if (latestPred) {
    console.log('⏱️  最新の予想生成');
    console.log('─'.repeat(46));
    console.log(`  タイムスタンプ: ${latestPred.generated_at}`);
    console.log(`  レースID:      ${latestPred.race_id}`);

    // 直近5分間の生成レート
    const [recentRate] = await query(
      `SELECT COUNT(*) as c FROM predictions
       WHERE generated_at >= datetime('now', '-5 minutes')`
    );
    if (Number(recentRate.c) > 0) {
      const rate = (Number(recentRate.c) / 5).toFixed(1);
      console.log(`  直近5分間:     ${recentRate.c}件生成 (${rate}件/分)`);

      // 残り時間の推定
      const remaining = phase6Total - phase6Done;
      if (remaining > 0 && Number(rate) > 0) {
        const eta = Math.ceil(remaining / Number(rate));
        const hours = Math.floor(eta / 60);
        const mins = eta % 60;
        console.log(`  残り推定:      約${hours > 0 ? `${hours}時間` : ''}${mins}分 (残り${remaining}件)`);
      }
    } else {
      console.log(`  直近5分間:     生成なし（完了 or 停止中）`);
    }
  }
  console.log('');

  // ===== scheduler_runs の最新ステータス =====
  const recentRuns = await query(
    `SELECT job_type, target_date, started_at, completed_at, status, detail
     FROM scheduler_runs
     ORDER BY id DESC
     LIMIT 5`
  );
  if (recentRuns.length > 0) {
    console.log('📋 最近のスケジューラ実行');
    console.log('─'.repeat(76));
    for (const run of recentRuns) {
      const statusIcon = run.status === 'completed' ? '✅' : run.status === 'running' ? '🔄' : '❌';
      console.log(`  ${statusIcon} ${run.job_type} (${run.target_date}) - ${run.status} [${run.started_at}]`);
      if (run.detail) {
        const detail = String(run.detail).substring(0, 80);
        console.log(`     ${detail}`);
      }
    }
  }

  console.log('\n✅ チェック完了（読み取り専用、DB変更なし）');
  db.close();
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

function pad(n: number, width: number): string {
  return String(n).padStart(width);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
