/**
 * しょーさん予想: 先行力 × 乗り替わり × アゲ騎手 の理論
 *
 * 理論1: 前走4着以下 + 先行力3回以上(10走JRA) + アゲ騎手乗替
 *         バックテスト: 641件 ROI 140.6%（現行比+29pt）
 * 理論2: 前走好走(好騎手騎乗) + アゲ騎手が乗り替わり（好調継続）
 */

// ==================== アゲ騎手定義 ====================

export interface JockeyZone {
  id: string;
  name: string;
  zone: 1 | 2 | 3 | 4 | 5;
}

// Zone 5は地方競馬場のみ有効
const LOCAL_VENUES = ['札幌', '函館', '福島', '新潟', '中京', '小倉'];

const AGE_JOCKEYS: JockeyZone[] = [
  // Zone 1: 先行意識が高く、長年好成績、良い馬が回ってくる
  { id: '00666', name: '武豊', zone: 1 },
  { id: '01126', name: '松山', zone: 1 },
  { id: '01170', name: '横山武', zone: 1 },
  { id: '01163', name: '坂井', zone: 1 },
  // Zone 2: 先行意識が高く、直近で非常に調子が良い、期待値最高
  { id: '01174', name: '岩田望', zone: 2 },
  { id: '01157', name: '鮫島駿', zone: 2 },
  { id: '01160', name: '荻野極', zone: 2 },
  // Zone 3: 先行意識が高いが、Zone 2より信頼度低い
  { id: '01075', name: '田辺', zone: 3 },
  { id: '01144', name: '菱田', zone: 3 },
  { id: '01200', name: '西塚', zone: 3 },
  { id: '01150', name: '石川', zone: 3 },
  { id: '01115', name: '浜中', zone: 3 },
  { id: '01122', name: '三浦', zone: 3 },
  { id: '01178', name: '斎藤', zone: 3 },
  { id: '01220', name: '田山', zone: 3 },
  // Zone 4: 一時期Zone 2だったが移行できなかった
  { id: '01091', name: '丹内', zone: 4 },
  { id: '01197', name: '佐々木', zone: 4 },
  // Zone 5: 地方のみZone 3
  { id: '01127', name: '丸山', zone: 5 },
  // 杉山はDBにないためスキップ
];

export function getJockeyZone(jockeyId: string, venue?: string): JockeyZone | null {
  const j = AGE_JOCKEYS.find(a => a.id === jockeyId);
  if (!j) return null;
  if (j.zone === 5) {
    // Zone 5は地方開催のみ有効
    if (venue && LOCAL_VENUES.includes(venue)) {
      return { ...j, zone: 3 }; // 地方ではZone 3扱い
    }
    return null; // 中央主場では対象外
  }
  return j;
}

// ==================== 入力データ型 ====================

export interface HorseEntry {
  horseNumber: number;
  horseName: string;
  horseId: string;
  jockeyId: string;
  jockeyName: string;
}

export interface PastPerf {
  date: string;
  position: number;       // 着順
  cornerPositions: string; // "2-2-3-4" or "1-1" 等
  jockeyId?: string;       // 前走の騎手ID（race_entriesから）
  jockeyName?: string;
  entries: number;          // 出走頭数
  racecourseName?: string;  // 競馬場名（JRA/地方判定用）
}

// JRA 10場
const JRA_VENUES = ['中京', '中山', '京都', '函館', '小倉', '新潟', '札幌', '東京', '福島', '阪神'];

/**
 * 競馬場名がJRA（中央競馬）かどうか
 * racecourse_nameは "1中京1" のような形式なので部分一致で判定
 */
function isJraVenue(racecourseName?: string): boolean {
  if (!racecourseName) return false;
  return JRA_VENUES.some(v => racecourseName.includes(v));
}

// ==================== 評価結果 ====================

export interface ShosanCandidate {
  horseNumber: number;
  horseName: string;
  theory: 1 | 2;
  matchScore: number;    // 0-100%
  jockeyZone: number;
  jockeyName: string;
  prevJockeyName?: string;
  reasons: string[];     // 選出理由
}

export interface ShosanResult {
  candidates: ShosanCandidate[];
  umarenRecommendations: { horses: number[]; confidence: string }[];
  warning?: string;  // 適用注意（未勝利戦・3歳限定戦等）
}

// ==================== 先行力判定 ====================

function getFirstCornerPosition(cornerPositions: string): number | null {
  if (!cornerPositions || cornerPositions === '**' || cornerPositions === '') return null;
  const parts = cornerPositions.split('-').map(s => parseInt(s.trim()));
  return parts[0] > 0 ? parts[0] : null;
}

/**
 * 先行力判定: 直近10走以内のJRA（中央）レースで1角1-2番手を取った回数
 * 地方競馬の先行実績はカウントしない
 *
 * 理論1: 3回以上が条件（バックテスト: 3回+でROI 140.6%, 1回だと赤字）
 */
function hasFrontRunningAbility(pastPerfs: PastPerf[]): { has: boolean; frontCount: number; totalRaces: number } {
  let frontCount = 0;
  let totalRaces = 0;
  // 直近10走のみ
  const recent = pastPerfs.slice(0, 10);
  for (const pp of recent) {
    // JRA（中央競馬）のレースのみカウント
    if (!isJraVenue(pp.racecourseName)) continue;
    const pos = getFirstCornerPosition(pp.cornerPositions);
    if (pos === null) continue;
    totalRaces++;
    if (pos <= 2) frontCount++;
  }
  return { has: frontCount >= 3, frontCount, totalRaces };
}

/**
 * 近走で先行できていないか（直近N走で1角3番手以降）
 */
function recentlyNotFrontRunning(recentPerfs: PastPerf[], n: number = 3): boolean {
  const recent = recentPerfs.slice(0, n);
  if (recent.length === 0) return false;
  return recent.every(pp => {
    const pos = getFirstCornerPosition(pp.cornerPositions);
    return pos === null || pos >= 3;
  });
}

/**
 * 休養期間の計算（日数）
 */
function restDays(raceDate: string, lastPerfDate: string): number {
  const d1 = new Date(raceDate);
  const d2 = new Date(lastPerfDate);
  return Math.floor((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * 近走で好走しているか
 */
function recentGoodResult(recentPerfs: PastPerf[], n: number = 1): boolean {
  const recent = recentPerfs.slice(0, n);
  return recent.some(pp => pp.position <= 3);
}

// ==================== 理論評価 ====================

/**
 * しょーさん理論が通用しにくいレース条件を判定
 * - 未勝利戦/新馬戦: 経験不足の馬が多く理論が機能しにくい
 * - 3歳/2歳限定戦: 若駒同士の比較で休養明け効果が見えにくい（3歳以上戦は対象）
 *
 * 該当する場合は注意書きを返す（候補は通常通り評価）
 */
function getRaceWarning(raceName: string): string | undefined {
  if (!raceName) return undefined;
  if (raceName.includes('新馬')) return '新馬戦は経験データなしのため理論精度低（参考扱い）';
  if (raceName.includes('未勝利')) return '未勝利戦は理論精度低（休養明け効果が出にくい）';
  if (raceName.includes('2歳')) return '2歳限定戦は理論精度低（経験不足）';
  if (raceName.includes('3歳') && !raceName.includes('3歳以上')) {
    return '3歳限定戦は理論精度低（休養明け効果が出にくい）';
  }
  return undefined;
}

export function evaluateShosanTheory(
  raceDate: string,
  venue: string,
  entries: HorseEntry[],
  pastPerfsMap: Map<string, PastPerf[]>,   // horseId -> past performances (desc by date)
  prevJockeyMap: Map<string, string>,       // horseId -> 前走のjockey_id
  raceName?: string,                         // レース名（未勝利戦・3歳戦判定用）
): ShosanResult {
  const warning = raceName ? getRaceWarning(raceName) : undefined;

  const candidates: ShosanCandidate[] = [];

  for (const entry of entries) {
    const pastPerfs = pastPerfsMap.get(entry.horseId) || [];
    if (pastPerfs.length < 2) continue;

    // 前提: 先行力があること
    const frontAbility = hasFrontRunningAbility(pastPerfs);
    if (!frontAbility.has) continue;

    // アゲ騎手チェック
    const currentJockeyZone = getJockeyZone(entry.jockeyId, venue);
    if (!currentJockeyZone) continue;

    // 前走の騎手
    const prevJockeyId = prevJockeyMap.get(entry.horseId) || '';
    const isJockeyChange = prevJockeyId !== '' && prevJockeyId !== entry.jockeyId;

    // 最終レースからの休養日数
    const rest = restDays(raceDate, pastPerfs[0].date);

    // ==================== 理論1: 復調 + アゲ騎手乗り替わり ====================
    const theory1 = evaluateTheory1(
      entry, pastPerfs, currentJockeyZone, isJockeyChange, prevJockeyId, rest
    );
    if (theory1) candidates.push(theory1);

    // ==================== 理論2: 好調継続 + アゲ騎手 ====================
    const theory2 = evaluateTheory2(
      entry, pastPerfs, currentJockeyZone, isJockeyChange, prevJockeyId, rest, venue
    );
    if (theory2) candidates.push(theory2);
  }

  // スコア順にソート、上位3頭
  candidates.sort((a, b) => b.matchScore - a.matchScore);
  const top = candidates.slice(0, 3);

  // 馬連推奨
  const umarenRecommendations = generateUmarenRecommendations(top);

  return { candidates: top, umarenRecommendations, warning };
}

function evaluateTheory1(
  entry: HorseEntry,
  pastPerfs: PastPerf[],
  jockeyZone: JockeyZone,
  isJockeyChange: boolean,
  prevJockeyId: string,
  restFromLastRace: number,
): ShosanCandidate | null {
  const reasons: string[] = [];
  let score = 0;

  // 必須: 乗り替わり（アゲ騎手への交代）
  // バックテスト: 乗替ROI 140.6% vs 継続98.5%
  if (!isJockeyChange) return null;
  reasons.push(`乗り替わり→${jockeyZone.name}(Z${jockeyZone.zone})`);

  // 必須: 前走4着以下
  if (pastPerfs[0].position <= 3) return null;
  reasons.push(`前走${pastPerfs[0].position}着`);

  // 先行力回数でスコア加算（3回以上は前提条件でクリア済み）
  const frontAbility = hasFrontRunningAbility(pastPerfs);
  score += 30; // 基本スコア
  if (frontAbility.frontCount >= 5) {
    score += 15;
    reasons.push(`先行力${frontAbility.frontCount}回/10走(強)`);
  } else if (frontAbility.frontCount >= 4) {
    score += 10;
    reasons.push(`先行力${frontAbility.frontCount}回/10走`);
  } else {
    score += 5;
    reasons.push(`先行力${frontAbility.frontCount}回/10走`);
  }

  // ゾーンボーナス
  if (jockeyZone.zone === 1) score += 15;
  else if (jockeyZone.zone === 2) score += 20; // Zone 2が最も期待値高い
  else if (jockeyZone.zone === 3) score += 10;
  else if (jockeyZone.zone === 4) score += 5;

  // 休養: バックテストで42-90日はROI 87.8%(赤字)のためボーナス削除
  // 短間隔(0-41日)172.7%, 長休養(91日+)194.2% → 休養日数はスコアに影響させない

  if (score < 45) return null;

  return {
    horseNumber: entry.horseNumber,
    horseName: entry.horseName,
    theory: 1,
    matchScore: Math.min(100, score),
    jockeyZone: jockeyZone.zone,
    jockeyName: jockeyZone.name,
    prevJockeyName: undefined,
    reasons,
  };
}

function evaluateTheory2(
  entry: HorseEntry,
  pastPerfs: PastPerf[],
  jockeyZone: JockeyZone,
  isJockeyChange: boolean,
  prevJockeyId: string,
  rest: number,
  venue: string,
): ShosanCandidate | null {
  const reasons: string[] = [];
  let score = 0;

  // 必須: 乗り替わり（継続騎乗はROI低いため除外）
  // バックテスト: 乗替ROI 127% vs 継続騎乗ROI 67%
  if (!isJockeyChange) return null;

  // 必須: 前走が好走（3着以内）
  if (!recentGoodResult(pastPerfs, 1)) return null;
  reasons.push(`前走${pastPerfs[0].position}着`);

  // 必須: 前走の騎手がZone 1-2 or ルメール・川田等の一流
  const prevZone = prevJockeyId ? getJockeyZone(prevJockeyId, venue) : null;
  const topOverpopularIds = ['00660', '00733']; // ルメール、川田（過剰人気）
  const isPrevTopOverpopular = topOverpopularIds.includes(prevJockeyId);
  const prevIsGoodJockey = (prevZone && prevZone.zone <= 2) || isPrevTopOverpopular;
  if (!prevIsGoodJockey) return null;
  reasons.push(`前走:${isPrevTopOverpopular ? 'ルメ川田' : prevZone?.name}→乗替`);

  // 現在の騎手はAGE騎手（ルメール・川田は既にgetJockeyZoneで除外済み）
  reasons.push(`今走:${jockeyZone.name}(Z${jockeyZone.zone})`);

  // 好調継続（3戦以内）
  if (rest > 90) return null; // 長期休養は除外
  if (pastPerfs.length >= 3 && pastPerfs.slice(0, 3).every(p => p.position > 5)) return null;

  // スコア計算
  score += 30;

  // 前走着順ボーナス
  if (pastPerfs[0].position === 1) score += 15;
  else if (pastPerfs[0].position === 2) score += 10;
  else if (pastPerfs[0].position === 3) score += 5;

  // 乗り替わりボーナス（必須化したので常に加算）
  score += 10;

  // 前走がルメール・川田だった場合は大ボーナス（バックテストROI 649%）
  if (isPrevTopOverpopular) {
    score += 15;
    reasons.push('★一流→AGE');
  }

  // ゾーンボーナス（Zone1はROI 65%で赤字のため減点、Zone2-3が有力）
  if (jockeyZone.zone === 1) score += 5;   // 過剰人気になりがち
  else if (jockeyZone.zone === 2) score += 15;
  else if (jockeyZone.zone === 3) score += 20; // バックテストROI 270%
  else if (jockeyZone.zone === 4) score += 5;

  if (score < 45) return null;

  return {
    horseNumber: entry.horseNumber,
    horseName: entry.horseName,
    theory: 2,
    matchScore: Math.min(100, score),
    jockeyZone: jockeyZone.zone,
    jockeyName: jockeyZone.name,
    reasons,
  };
}

// ==================== 馬連推奨 ====================

function generateUmarenRecommendations(
  candidates: ShosanCandidate[]
): { horses: number[]; confidence: string }[] {
  if (candidates.length < 2) return [];

  const recs: { horses: number[]; confidence: string }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const avgScore = (candidates[i].matchScore + candidates[j].matchScore) / 2;
      const confidence = avgScore >= 70 ? '高' : avgScore >= 50 ? '中' : '低';
      recs.push({
        horses: [candidates[i].horseNumber, candidates[j].horseNumber].sort((a, b) => a - b),
        confidence,
      });
    }
  }
  return recs;
}
