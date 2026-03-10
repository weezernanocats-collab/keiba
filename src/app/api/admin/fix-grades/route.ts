import { NextRequest, NextResponse } from 'next/server';
import { dbAll, dbRun } from '@/lib/database';

/** 現在のグレード分布を確認 */
export async function GET() {
  try {
    const rows = await dbAll<{ grade: string | null; cnt: number }>(
      `SELECT grade, COUNT(*) as cnt FROM races GROUP BY grade ORDER BY cnt DESC`
    );
    return NextResponse.json({ distribution: rows });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// 実際のG1レース名パターン
const KNOWN_G1_PATTERNS = [
  'フェブラリーステークス', 'フェブラリーS',
  '高松宮記念', '大阪杯', '桜花賞', '皐月賞', '天皇賞',
  'NHKマイルカップ', 'NHKマイルC', 'ヴィクトリアマイル',
  'オークス', '優駿牝馬', 'ダービー', '東京優駿', '日本ダービー',
  '安田記念', '宝塚記念',
  'スプリンターズステークス', 'スプリンターズS',
  '秋華賞', '菊花賞', 'エリザベス女王杯',
  'マイルチャンピオンシップ', 'マイルCS',
  'ジャパンカップ', 'ジャパンＣ',
  'チャンピオンズカップ', 'チャンピオンズC',
  '阪神ジュベナイルフィリーズ', '阪神JF',
  '朝日杯フューチュリティステークス', '朝日杯FS',
  '有馬記念', 'ホープフルステークス', 'ホープフルS',
  '川崎記念', '帝王賞', 'ジャパンダートダービー',
  'JBCクラシック', 'JBCスプリント', 'JBCレディスクラシック',
  'JBCダートクラシック', '東京大賞典',
  'かしわ記念', 'さきたま杯', 'マイルチャンピオンシップ南部杯',
  'JBCターフ', '全日本2歳優駿', '東京スプリント', 'クラスターカップ',
];

function classifyByName(name: string): string | null {
  if (name.includes('新馬')) return '新馬';
  if (name.includes('未勝利')) return '未勝利';
  if (name.includes('1勝クラス') || name.includes('1勝')) return '1勝クラス';
  if (name.includes('2勝クラス') || name.includes('2勝')) return '2勝クラス';
  if (name.includes('3勝クラス') || name.includes('3勝')) return '3勝クラス';
  if (name.includes('リステッド') || name.includes('Listed')) return 'リステッド';
  if (name.includes('ステークス') || name.includes('カップ') || name.includes('賞')) return 'オープン';
  return null;
}

/**
 * 既存DBのレースグレードを再分類する（バッチ処理版）。
 * POST /api/admin/fix-grades
 */
export async function POST(_request: NextRequest) {
  try {
    // 1) G1の誤分類を修正 — SQLで一括UPDATE
    // レース名に既知のG1パターンが含まれないものを対象にする
    const g1CountBefore = await dbAll<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM races WHERE grade = 'G1'`
    );

    // 一括でレース名ベースのUPDATE（各クラスごとに1クエリ）
    const classPatterns: { grade: string; likes: string[] }[] = [
      { grade: '新馬', likes: ['%新馬%'] },
      { grade: '未勝利', likes: ['%未勝利%'] },
      { grade: '1勝クラス', likes: ['%1勝クラス%', '%1勝%'] },
      { grade: '2勝クラス', likes: ['%2勝クラス%', '%2勝%'] },
      { grade: '3勝クラス', likes: ['%3勝クラス%', '%3勝%'] },
      { grade: 'リステッド', likes: ['%リステッド%', '%Listed%'] },
    ];

    // G1のうち、既知G1名にマッチしないものの NOT LIKE 条件を構築
    const g1NotLikeClauses = KNOWN_G1_PATTERNS.map(() => 'name NOT LIKE ?').join(' AND ');
    const g1NotLikeArgs = KNOWN_G1_PATTERNS.map(p => `%${p}%`);

    let totalFixed = 0;

    for (const cp of classPatterns) {
      const likeClause = cp.likes.map(() => 'name LIKE ?').join(' OR ');
      const result = await dbRun(
        `UPDATE races SET grade = ?
         WHERE grade = 'G1'
         AND ${g1NotLikeClauses}
         AND (${likeClause})`,
        [cp.grade, ...g1NotLikeArgs, ...cp.likes],
      );
      totalFixed += result.rowsAffected;
    }

    // 残りの非G1（ステークス/カップ/賞を含む）→ オープン
    const openResult = await dbRun(
      `UPDATE races SET grade = 'オープン'
       WHERE grade = 'G1'
       AND ${g1NotLikeClauses}
       AND (name LIKE '%ステークス%' OR name LIKE '%カップ%' OR name LIKE '%賞%')`,
      [...g1NotLikeArgs],
    );
    totalFixed += openResult.rowsAffected;

    // まだG1のまま残っている非G1 → NULLにリセット
    const nullResult = await dbRun(
      `UPDATE races SET grade = NULL
       WHERE grade = 'G1'
       AND ${g1NotLikeClauses}`,
      [...g1NotLikeArgs],
    );
    totalFixed += nullResult.rowsAffected;

    // 2) NULLグレードのレースも名前ベースで分類
    let nullFixed = 0;
    for (const cp of classPatterns) {
      const likeClause = cp.likes.map(() => 'name LIKE ?').join(' OR ');
      const result = await dbRun(
        `UPDATE races SET grade = ?
         WHERE grade IS NULL AND (${likeClause})`,
        [cp.grade, ...cp.likes],
      );
      nullFixed += result.rowsAffected;
    }

    // 3) 修正後のG1数を確認
    const g1CountAfter = await dbAll<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM races WHERE grade = 'G1'`
    );

    // 4) 修正後の分布
    const distribution = await dbAll<{ grade: string | null; cnt: number }>(
      `SELECT grade, COUNT(*) as cnt FROM races GROUP BY grade ORDER BY cnt DESC`
    );

    return NextResponse.json({
      success: true,
      g1Before: g1CountBefore[0]?.cnt || 0,
      g1After: g1CountAfter[0]?.cnt || 0,
      g1Fixed: totalFixed,
      nullGradeFixed: nullFixed,
      distribution,
    });
  } catch (err) {
    console.error('グレード修正エラー:', err);
    return NextResponse.json({ error: `グレード修正に失敗: ${String(err)}` }, { status: 500 });
  }
}
