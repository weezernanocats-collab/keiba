/**
 * 当日馬場バイアス分析モジュール
 *
 * 同日・同競馬場の完走済みレースから枠順バイアスと脚質バイアスを推定し、
 * 午後のレースの予想精度を向上させる。
 */
import { dbAll } from './database';

// ==================== 型定義 ====================

export interface TodayTrackBias {
  /** 内枠有利度: -1(外有利) 〜 +1(内有利) */
  innerAdvantage: number;
  /** 先行有利度: -1(差し追込有利) 〜 +1(逃げ先行有利) */
  frontRunnerAdvantage: number;
  /** サンプルレース数 */
  sampleRaces: number;
  /** 信頼度 0〜1 (サンプル数ベース) */
  confidence: number;
  /** 分析詳細テキスト */
  summary: string;
}

interface CompletedRaceEntry {
  race_id: string;
  post_position: number;
  horse_number: number;
  result_position: number;
  field_size: number;
  result_corner_positions: string | null;
}

// ==================== メイン関数 ====================

/**
 * 当日の馬場バイアスを算出する。
 *
 * 同じ競馬場・同日の完走レースが3レース以上あれば有効なバイアスを返す。
 * 3レース未満の場合は null（バイアス不明）。
 */
export async function calculateTodayTrackBias(
  racecourseName: string,
  date: string,
  trackType?: string,
): Promise<TodayTrackBias | null> {
  const params: (string | number)[] = [racecourseName, date];
  let trackTypeFilter = '';
  if (trackType) {
    trackTypeFilter = 'AND r.track_type = ?';
    params.push(trackType);
  }

  const rows = await dbAll<CompletedRaceEntry>(
    `SELECT
       re.race_id,
       re.post_position,
       re.horse_number,
       re.result_position,
       fs.field_size,
       re.result_corner_positions
     FROM race_entries re
     JOIN races r ON re.race_id = r.id
     JOIN (
       SELECT race_id, COUNT(*) as field_size FROM race_entries GROUP BY race_id
     ) fs ON fs.race_id = re.race_id
     WHERE r.racecourse_name = ?
       AND r.date = ?
       AND r.status = '結果確定'
       ${trackTypeFilter}
       AND re.result_position IS NOT NULL
       AND re.result_position > 0
     ORDER BY re.race_id, re.result_position`,
    params,
  );

  if (rows.length === 0) return null;

  // レースごとにグループ化
  const raceMap = new Map<string, CompletedRaceEntry[]>();
  for (const row of rows) {
    const entries = raceMap.get(row.race_id) || [];
    entries.push(row);
    raceMap.set(row.race_id, entries);
  }

  const sampleRaces = raceMap.size;
  if (sampleRaces < 3) return null;

  // ---------- 枠順バイアス分析 ----------
  const innerAdvantage = analyzePostPositionBias(raceMap);

  // ---------- 脚質バイアス分析 ----------
  const frontRunnerAdvantage = analyzeRunningStyleBias(raceMap);

  // 信頼度: 3レース→0.3, 5レース→0.6, 8+レース→1.0
  const confidence = Math.min(1.0, sampleRaces / 8);

  const summaryParts: string[] = [];
  if (Math.abs(innerAdvantage) > 0.2) {
    summaryParts.push(innerAdvantage > 0 ? '内枠有利傾向' : '外枠有利傾向');
  }
  if (Math.abs(frontRunnerAdvantage) > 0.2) {
    summaryParts.push(frontRunnerAdvantage > 0 ? '先行有利傾向' : '差し追込有利傾向');
  }
  const summary = summaryParts.length > 0
    ? `本日${racecourseName}: ${summaryParts.join('・')}（${sampleRaces}R分析）`
    : `本日${racecourseName}: バイアス中立（${sampleRaces}R分析）`;

  return { innerAdvantage, frontRunnerAdvantage, sampleRaces, confidence, summary };
}

// ==================== 枠順バイアス分析 ====================

function analyzePostPositionBias(raceMap: Map<string, CompletedRaceEntry[]>): number {
  let innerTopCount = 0;
  let outerTopCount = 0;
  let totalRaces = 0;

  for (const entries of raceMap.values()) {
    const fieldSize = entries[0]?.field_size || entries.length;
    if (fieldSize < 6) continue; // 少頭数は除外

    const midPoint = Math.ceil(fieldSize / 2);
    totalRaces++;

    // 上位3着以内の枠番を分析
    const topFinishers = entries.filter(e => e.result_position <= 3);
    for (const e of topFinishers) {
      if (e.post_position <= midPoint) {
        innerTopCount++;
      } else {
        outerTopCount++;
      }
    }
  }

  if (totalRaces === 0) return 0;

  const total = innerTopCount + outerTopCount;
  if (total === 0) return 0;

  // 内枠の複勝率 - 期待値(0.5)を正規化
  // innerRatio > 0.5 → 内有利, < 0.5 → 外有利
  const innerRatio = innerTopCount / total;
  // -1 〜 +1 にスケール（0.5基準）
  return Math.max(-1, Math.min(1, (innerRatio - 0.5) * 2.5));
}

// ==================== 脚質バイアス分析 ====================

function analyzeRunningStyleBias(raceMap: Map<string, CompletedRaceEntry[]>): number {
  let frontRunnerWins = 0;
  let closerWins = 0;
  let analyzedRaces = 0;

  for (const entries of raceMap.values()) {
    const fieldSize = entries[0]?.field_size || entries.length;
    if (fieldSize < 6) continue;

    const winner = entries.find(e => e.result_position === 1);
    if (!winner) continue;

    analyzedRaces++;

    // コーナー通過順があればそこから判定
    const cornerStr = winner.result_corner_positions;
    if (cornerStr && cornerStr.length > 0) {
      const firstCorner = parseFirstCornerPosition(cornerStr);
      if (firstCorner > 0) {
        const relativePosition = firstCorner / fieldSize;
        if (relativePosition <= 0.35) {
          frontRunnerWins++; // 逃げ・先行
        } else if (relativePosition > 0.55) {
          closerWins++; // 差し・追込
        }
        // 中団は中立としてカウントしない
        continue;
      }
    }

    // コーナー通過順がない場合: 馬番と枠の位置関係で簡易推定
    // (勝ち馬が内枠＋上位フィニッシュ → 先行有利の傾向があるが、精度は低い)
    // この場合はスキップ（ノイズになるため）
  }

  if (analyzedRaces === 0 || (frontRunnerWins + closerWins) === 0) return 0;

  const total = frontRunnerWins + closerWins;
  const frontRatio = frontRunnerWins / total;
  return Math.max(-1, Math.min(1, (frontRatio - 0.5) * 2.5));
}

/**
 * コーナー通過順文字列から第1コーナーの位置を抽出
 * 形式: "3-3-2-1" or "03-03-02-01" or "5.7" (ドット区切り)
 */
function parseFirstCornerPosition(cornerStr: string): number {
  // ハイフン区切り: "3-3-2-1"
  if (cornerStr.includes('-')) {
    const first = parseInt(cornerStr.split('-')[0]);
    return isNaN(first) ? 0 : first;
  }
  // ドット区切り: "5.7" → 第1コーナー = 5
  if (cornerStr.includes('.')) {
    const first = parseInt(cornerStr.split('.')[0]);
    return isNaN(first) ? 0 : first;
  }
  // 単一数字
  const val = parseInt(cornerStr);
  return isNaN(val) ? 0 : val;
}
