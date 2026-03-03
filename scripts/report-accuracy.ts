/**
 * 本番DB的中率レポート（読み取り専用・省リード版）
 *
 * prediction_results テーブルの集約クエリのみ実行。
 * Turso バッチAPIで全クエリを1回のHTTPリクエストにまとめ、
 * リード消費を最小化する。
 *
 * 使い方: npx tsx -r tsconfig-paths/register scripts/report-accuracy.ts
 */

import { createClient } from '@libsql/client';

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    console.error('TURSO_DATABASE_URL / TURSO_AUTH_TOKEN が未設定です');
    process.exit(1);
  }

  const client = createClient({ url, authToken });

  // ── 全クエリを1回のバッチで送信（Turso HTTP 1リクエスト） ──
  const results = await client.batch([
    // [0] 照合済み合計件数
    `SELECT COUNT(*) as total FROM prediction_results`,

    // [1] 全体集約
    `SELECT
       ROUND(AVG(win_hit) * 100, 1) as win_rate,
       ROUND(AVG(place_hit) * 100, 1) as place_rate,
       ROUND(AVG(CAST(top3_picks_hit AS REAL) / 3.0) * 100, 1) as top3_coverage,
       SUM(bet_investment) as total_invested,
       SUM(bet_return) as total_returned,
       CASE WHEN SUM(bet_investment) > 0
         THEN ROUND(SUM(bet_return) / SUM(bet_investment) * 100, 1)
         ELSE 0 END as overall_roi
     FROM prediction_results`,

    // [2] 信頼度帯別
    `SELECT
       CASE
         WHEN predicted_confidence >= 80 THEN '80-100'
         WHEN predicted_confidence >= 60 THEN '60-79'
         WHEN predicted_confidence >= 40 THEN '40-59'
         ELSE '15-39'
       END as range_label,
       COUNT(*) as cnt,
       ROUND(AVG(win_hit) * 100, 1) as win_rate,
       ROUND(AVG(place_hit) * 100, 1) as place_rate,
       CASE WHEN SUM(bet_investment) > 0
         THEN ROUND(SUM(bet_return) / SUM(bet_investment) * 100, 1)
         ELSE 0 END as roi
     FROM prediction_results
     GROUP BY range_label
     ORDER BY range_label DESC`,

    // [3] 直近30件トレンド
    `SELECT COUNT(*) as cnt,
       ROUND(AVG(win_hit) * 100, 1) as win_rate,
       ROUND(AVG(place_hit) * 100, 1) as place_rate,
       CASE WHEN SUM(bet_investment) > 0
         THEN ROUND(SUM(bet_return) / SUM(bet_investment) * 100, 1)
         ELSE 0 END as roi
     FROM (SELECT * FROM prediction_results ORDER BY evaluated_at DESC LIMIT 30)`,

    // [4] 直近100件トレンド
    `SELECT COUNT(*) as cnt,
       ROUND(AVG(win_hit) * 100, 1) as win_rate,
       ROUND(AVG(place_hit) * 100, 1) as place_rate,
       CASE WHEN SUM(bet_investment) > 0
         THEN ROUND(SUM(bet_return) / SUM(bet_investment) * 100, 1)
         ELSE 0 END as roi
     FROM (SELECT * FROM prediction_results ORDER BY evaluated_at DESC LIMIT 100)`,

    // [5] 月別推移（直近6ヶ月）
    `SELECT
       strftime('%Y-%m', r.date) as month,
       COUNT(*) as cnt,
       ROUND(AVG(pr.win_hit) * 100, 1) as win_rate,
       ROUND(AVG(pr.place_hit) * 100, 1) as place_rate,
       CASE WHEN SUM(pr.bet_investment) > 0
         THEN ROUND(SUM(pr.bet_return) / SUM(pr.bet_investment) * 100, 1)
         ELSE 0 END as roi
     FROM prediction_results pr
     JOIN races r ON pr.race_id = r.id
     GROUP BY month
     ORDER BY month DESC
     LIMIT 6`,

    // [6] データ量サマリ（レース・予想・照合の件数のみ）
    `SELECT
       (SELECT COUNT(*) FROM races WHERE status = '結果確定') as settled_races,
       (SELECT COUNT(*) FROM predictions) as total_predictions,
       (SELECT COUNT(*) FROM prediction_results) as total_evaluated`,
  ], 'read');

  // ── 結果を整形して出力 ──
  const total = Number(results[0].rows[0]?.total ?? 0);
  const agg = results[1].rows[0];
  const calibration = results[2].rows;
  const trend30 = results[3].rows[0];
  const trend100 = results[4].rows[0];
  const monthly = results[5].rows;
  const dataSummary = results[6].rows[0];

  console.log('================================================');
  console.log('   競馬AI予想システム 的中率レポート（本番DB）');
  console.log('================================================\n');

  console.log(`結果確定レース: ${dataSummary?.settled_races ?? 0}件`);
  console.log(`AI予想数: ${dataSummary?.total_predictions ?? 0}件`);
  console.log(`照合済み: ${dataSummary?.total_evaluated ?? 0}件\n`);

  if (total === 0) {
    console.log('照合済みデータがありません。');
    console.log('daily-results パイプラインでレース結果を取り込んでください。');
    client.close();
    return;
  }

  console.log('--- 全体的中率 ---');
  console.log(`  単勝的中率（本命が1着）:       ${agg?.win_rate ?? 0}%`);
  console.log(`  複勝的中率（本命が3着以内）:   ${agg?.place_rate ?? 0}%`);
  console.log(`  Top3カバー率:                  ${agg?.top3_coverage ?? 0}%`);
  console.log(`  回収率（ROI）:                 ${agg?.overall_roi ?? 0}%`);

  const invested = Number(agg?.total_invested ?? 0);
  const returned = Number(agg?.total_returned ?? 0);
  if (invested > 0) {
    console.log(`  投資総額: ${invested.toLocaleString()}円`);
    console.log(`  回収総額: ${returned.toLocaleString()}円`);
  }

  // 信頼度帯別
  if (calibration.length > 0) {
    console.log('\n--- 信頼度帯別的中率 ---');
    console.log('  信頼度帯    | レース数 | 単勝的中 | 複勝的中 | ROI');
    console.log('  ------------|----------|---------|---------|------');
    for (const c of calibration) {
      const label = String(c.range_label ?? '').padEnd(12);
      const cnt = String(c.cnt ?? 0).padStart(6);
      const wr = String(c.win_rate ?? 0).padStart(6);
      const pr = String(c.place_rate ?? 0).padStart(6);
      const roi = String(c.roi ?? 0).padStart(5);
      console.log(`  ${label}| ${cnt}件 | ${wr}% | ${pr}% | ${roi}%`);
    }
  }

  // トレンド
  console.log('\n--- トレンド分析 ---');
  const t30 = trend30;
  const t100 = trend100;
  if (Number(t30?.cnt ?? 0) > 0) {
    console.log(`  直近30件:  ${t30!.cnt}件 → 単勝${t30!.win_rate}%, 複勝${t30!.place_rate}%, ROI ${t30!.roi}%`);
  }
  if (Number(t100?.cnt ?? 0) > 0) {
    console.log(`  直近100件: ${t100!.cnt}件 → 単勝${t100!.win_rate}%, 複勝${t100!.place_rate}%, ROI ${t100!.roi}%`);
  }
  console.log(`  全期間:    ${total}件 → 単勝${agg?.win_rate}%, 複勝${agg?.place_rate}%, ROI ${agg?.overall_roi}%`);

  // 月別推移
  if (monthly.length > 0) {
    console.log('\n--- 月別推移 ---');
    console.log('  年月     | レース数 | 単勝的中 | 複勝的中 | ROI');
    console.log('  ---------|----------|---------|---------|------');
    for (const m of [...monthly].reverse()) {
      const month = String(m.month ?? '').padEnd(9);
      const cnt = String(m.cnt ?? 0).padStart(6);
      const wr = String(m.win_rate ?? 0).padStart(6);
      const pr = String(m.place_rate ?? 0).padStart(6);
      const roi = String(m.roi ?? 0).padStart(5);
      console.log(`  ${month}| ${cnt}件 | ${wr}% | ${pr}% | ${roi}%`);
    }
  }

  // GitHub Actions Summary 用のマークダウン出力
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { writeFileSync } = await import('fs');
    const summary = [
      `## 競馬AI予想 的中率レポート`,
      ``,
      `| 指標 | 値 |`,
      `|------|-----|`,
      `| 照合済みレース | ${total}件 |`,
      `| 単勝的中率 | ${agg?.win_rate ?? 0}% |`,
      `| 複勝的中率 | ${agg?.place_rate ?? 0}% |`,
      `| Top3カバー率 | ${agg?.top3_coverage ?? 0}% |`,
      `| ROI | ${agg?.overall_roi ?? 0}% |`,
    ];
    if (invested > 0) {
      summary.push(`| 投資総額 | ${invested.toLocaleString()}円 |`);
      summary.push(`| 回収総額 | ${returned.toLocaleString()}円 |`);
    }

    if (monthly.length > 0) {
      summary.push('', '### 月別推移', '', '| 年月 | 件数 | 単勝 | 複勝 | ROI |', '|------|------|------|------|-----|');
      for (const m of [...monthly].reverse()) {
        summary.push(`| ${m.month} | ${m.cnt} | ${m.win_rate}% | ${m.place_rate}% | ${m.roi}% |`);
      }
    }

    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n'), { flag: 'a' });
  }

  console.log('\n================================================');
  console.log('   レポート完了（バッチ1回・読み取り専用）');
  console.log('================================================');

  client.close();
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
