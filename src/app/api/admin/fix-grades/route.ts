import { NextResponse } from 'next/server';
import { dbAll, dbRun } from '@/lib/database';

/**
 * 既存DBのレースグレードを再分類する。
 * 旧スクレイパーの Icon_GradeType1 部分一致バグにより
 * オープン/勝クラス/未勝利/新馬がすべてG1に誤分類されていた問題を修正。
 *
 * POST /api/admin/fix-grades
 */
export async function POST() {
  try {
    // G1に分類されているが、レース名から明らかにG1でないものを検出
    const g1Races = await dbAll<{
      id: string;
      name: string;
      grade: string;
    }>(`SELECT id, name, grade FROM races WHERE grade = 'G1'`);

    // 実際のG1レース名リスト（JRA G1）
    const knownG1Names = [
      'フェブラリーステークス', 'フェブラリーS',
      '高松宮記念',
      '大阪杯',
      '桜花賞',
      '皐月賞',
      '天皇賞', // 天皇賞・春、天皇賞・秋
      'NHKマイルカップ', 'NHKマイルC',
      'ヴィクトリアマイル',
      'オークス', '優駿牝馬',
      'ダービー', '東京優駿', '日本ダービー',
      '安田記念',
      '宝塚記念',
      'スプリンターズステークス', 'スプリンターズS',
      '秋華賞',
      '菊花賞',
      'エリザベス女王杯',
      'マイルチャンピオンシップ', 'マイルCS',
      'ジャパンカップ', 'ジャパンＣ',
      'チャンピオンズカップ', 'チャンピオンズC',
      '阪神ジュベナイルフィリーズ', '阪神JF',
      '朝日杯フューチュリティステークス', '朝日杯FS',
      '有馬記念',
      'ホープフルステークス', 'ホープフルS',
      // 地方G1
      '川崎記念', '帝王賞', 'ジャパンダートダービー', 'JBCクラシック',
      'JBCスプリント', 'JBCレディスクラシック', 'JBCダートクラシック',
      'チャンピオンズカップ', '東京大賞典',
      'かしわ記念', 'さきたま杯', 'マイルチャンピオンシップ南部杯',
      'JBCターフ', '全日本2歳優駿',
      '東京スプリント', 'クラスターカップ',
    ];

    const fixes: { id: string; oldGrade: string; newGrade: string; name: string }[] = [];

    for (const race of g1Races) {
      // レース名にG1レース名が含まれているか確認
      const isRealG1 = knownG1Names.some(g1 => race.name.includes(g1));
      if (isRealG1) continue;

      // レース名からクラスを推定
      let newGrade: string | null = null;
      if (race.name.includes('新馬')) newGrade = '新馬';
      else if (race.name.includes('未勝利')) newGrade = '未勝利';
      else if (race.name.includes('1勝クラス') || race.name.includes('1勝')) newGrade = '1勝クラス';
      else if (race.name.includes('2勝クラス') || race.name.includes('2勝')) newGrade = '2勝クラス';
      else if (race.name.includes('3勝クラス') || race.name.includes('3勝')) newGrade = '3勝クラス';
      else if (race.name.includes('リステッド') || race.name.includes('Listed')) newGrade = 'リステッド';
      // レース名にクラス情報がない場合、特別レース（ステークス/カップ/賞）はオープンとする
      else if (race.name.includes('ステークス') || race.name.includes('カップ') || race.name.includes('賞')) newGrade = 'オープン';
      else newGrade = null; // gradeをNULLにリセット（不明）

      fixes.push({
        id: race.id,
        oldGrade: race.grade,
        newGrade: newGrade || 'その他',
        name: race.name,
      });

      await dbRun(
        `UPDATE races SET grade = ? WHERE id = ?`,
        [newGrade, race.id],
      );
    }

    // NULLグレードのレースも名前ベースで分類
    const nullGradeRaces = await dbAll<{
      id: string;
      name: string;
    }>(`SELECT id, name FROM races WHERE grade IS NULL`);

    let nullFixed = 0;
    for (const race of nullGradeRaces) {
      let newGrade: string | null = null;
      if (race.name.includes('新馬')) newGrade = '新馬';
      else if (race.name.includes('未勝利')) newGrade = '未勝利';
      else if (race.name.includes('1勝クラス') || race.name.includes('1勝')) newGrade = '1勝クラス';
      else if (race.name.includes('2勝クラス') || race.name.includes('2勝')) newGrade = '2勝クラス';
      else if (race.name.includes('3勝クラス') || race.name.includes('3勝')) newGrade = '3勝クラス';

      if (newGrade) {
        await dbRun(`UPDATE races SET grade = ? WHERE id = ?`, [newGrade, race.id]);
        nullFixed++;
      }
    }

    return NextResponse.json({
      success: true,
      totalG1Before: g1Races.length,
      fixed: fixes.length,
      remainingG1: g1Races.length - fixes.length,
      nullGradeFixed: nullFixed,
      details: fixes.slice(0, 50), // 最大50件の詳細を返す
    });
  } catch (err) {
    console.error('グレード修正エラー:', err);
    return NextResponse.json({ error: 'グレード修正に失敗しました' }, { status: 500 });
  }
}
