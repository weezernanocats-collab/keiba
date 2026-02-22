/**
 * シードデータ生成ヘルパー
 * 馬プロファイルから整合性のある過去成績を自動生成する
 */

// ==================== プロファイル型 ====================

export interface HorseProfile {
  id: string;
  name: string;
  age: number;
  sex: '牡' | '牝' | 'セ';
  color: string;
  birthDate: string;
  fatherName: string;
  motherName: string;
  trainerName: string;
  ownerName: string;
  ability: number;          // 60-85: 総合能力
  preferredTrack: '芝' | 'ダート';
  bestDistance: number;      // ベスト距離 (m)
  distanceFlex: number;     // ±この範囲が適性距離
  style: '逃げ' | '先行' | '差し' | '追込';
  heavyBonus: number;       // -10〜+15: 道悪での補正
  consistency: number;      // 0.08〜0.25: 低いほど安定
  finishKick: number;       // 33.0〜37.0: 上がり3F基準値(低いほど速い)
  preferredCourses: string[];
  usualJockey: string;      // 主戦騎手名
  baseWeight: number;       // 馬体重ベース
  totalRaces: number;
  wins: number;
  seconds: number;
  thirds: number;
  totalEarnings: number;
  strengths: string[];
  weaknesses: string[];
  bestMonths?: number[];    // 得意月
}

export interface PerfData {
  date: string;
  raceName: string;
  racecourseName: string;
  trackType: '芝' | 'ダート';
  distance: number;
  trackCondition: '良' | '稍重' | '重' | '不良';
  weather: '晴' | '曇' | '雨';
  entries: number;
  postPosition: number;
  horseNumber: number;
  position: number;
  jockeyName: string;
  handicapWeight: number;
  weight: number;
  weightChange: number;
  time: string;
  margin: string;
  lastThreeFurlongs: string;
  cornerPositions: string;
  odds: number;
  popularity: number;
  prize: number;
}

// ==================== 定数 ====================

const CENTRAL_COURSES = ['東京', '中山', '阪神', '京都', '中京', '小倉', '新潟', '札幌', '函館', '福島'];
const LOCAL_COURSES = ['大井', '川崎', '船橋', '浦和'];
const JOCKEYS_CENTRAL = ['ルメール', '川田将雅', '横山武史', '戸崎圭太', '松山弘平', '坂井瑠星', '武豊', '岩田望来'];
const JOCKEYS_LOCAL = ['御神本訓史', '森泰斗', '笹川翼', '矢野貴之'];

const TURF_RACE_NAMES = [
  '東京新聞杯(G3)', '中山記念(G2)', '金鯱賞(G2)', '大阪杯(G1)', '天皇賞・秋(G1)',
  '毎日王冠(G2)', '京都記念(G2)', '小倉記念(G3)', '関屋記念(G3)', '新潟大賞典(G3)',
  '安田記念(G1)', 'マイルCS(G1)', '宝塚記念(G1)', '有馬記念(G1)', 'ジャパンカップ(G1)',
  '阪神カップ(G2)', '京王杯SC(G2)', '函館記念(G3)', 'ダービー卿CT(G3)',
  '3勝クラス', '2勝クラス', '1勝クラス', 'オープン特別',
];
const DIRT_RACE_NAMES = [
  'フェブラリーS(G1)', 'チャンピオンズC(G1)', '武蔵野S(G3)', 'プロキオンS(G3)',
  'シリウスS(G3)', 'ユニコーンS(G3)', 'レパードS(G3)',
  '東京大賞典(G1)', '帝王賞(G1)', '川崎記念(G1)', 'JBCクラシック(G1)',
  '大井記念', '東京シティ盃', '川崎マイラーズ',
  '3勝クラス', '2勝クラス', '1勝クラス', 'オープン特別',
];

const MARGINS = ['', 'ハナ', 'クビ', 'アタマ', '1/2', '3/4', '1', '1 1/2', '2', '3', '5', '大差'];

// ==================== 生成関数 ====================

/** 簡易ハッシュベース乱数 (再現可能) */
function seededRand(seed: number): number {
  let t = (seed + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** プロファイルから過去成績を生成 */
export function generatePastPerformances(p: HorseProfile): PerfData[] {
  const perfs: PerfData[] = [];
  const numPerfs = Math.min(p.totalRaces, 50);
  const isLocal = LOCAL_COURSES.some(c => p.preferredCourses.includes(c));
  const coursePool = isLocal ? LOCAL_COURSES : CENTRAL_COURSES;
  const jockeyPool = isLocal ? JOCKEYS_LOCAL : JOCKEYS_CENTRAL;
  const raceNamePool = p.preferredTrack === 'ダート' ? DIRT_RACE_NAMES : TURF_RACE_NAMES;

  let daysBack = 28;

  for (let i = 0; i < numPerfs; i++) {
    const seed = hashCode(p.id) * 1000 + i;
    const r = (offset: number) => seededRand(seed + offset);

    // 日付
    daysBack += 25 + Math.floor(r(0) * 30);
    if (i > 0 && i % 5 === 0) daysBack += 50; // 休養挟む
    const date = new Date(Date.now() - daysBack * 86400000);
    const dateStr = date.toISOString().split('T')[0];

    // コース (70% preferredCourses, 30% ランダム)
    const course = r(1) < 0.7 && p.preferredCourses.length > 0
      ? p.preferredCourses[Math.floor(r(2) * p.preferredCourses.length)]
      : coursePool[Math.floor(r(3) * coursePool.length)];

    // 馬場
    const trackType = r(4) < 0.85 ? p.preferredTrack : (p.preferredTrack === '芝' ? 'ダート' : '芝');

    // 距離
    const distOffset = (r(5) - 0.5) * p.distanceFlex * 2;
    const distance = Math.round((p.bestDistance + distOffset) / 100) * 100;
    const clampedDist = Math.max(1000, Math.min(3200, distance));

    // 馬場状態
    const condRand = r(6);
    const trackCondition: PerfData['trackCondition'] = condRand < 0.60 ? '良' : condRand < 0.78 ? '稍重' : condRand < 0.92 ? '重' : '不良';

    // 出走頭数
    const entries = 10 + Math.floor(r(7) * 8);

    // ポジション計算
    const position = calcPosition(p, trackType, clampedDist, course, trackCondition, entries, r(8), r(9));

    // タイム
    const time = calcTime(clampedDist, trackType, trackCondition, position, entries, r(10));

    // 上がり3F
    const l3f = calcLast3F(p, trackType, position, entries, r(11));

    // コーナー通過順
    const corners = calcCorners(p.style, position, entries, r(12), r(13), r(14), r(15));

    // 騎手
    const jockey = r(16) < 0.6 ? p.usualJockey : jockeyPool[Math.floor(r(17) * jockeyPool.length)];

    // レース名
    const raceName = pickRaceName(raceNamePool, p.ability, i, r(18));

    // オッズ
    const posRatio = position / entries;
    const baseOdds = posRatio < 0.15 ? 2 + r(19) * 5 : posRatio < 0.3 ? 5 + r(19) * 10 : 10 + r(19) * 40;

    const postPosition = Math.min(8, 1 + Math.floor(r(20) * 8));
    const horseNumber = 1 + Math.floor(r(21) * entries);

    perfs.push({
      date: dateStr,
      raceName,
      racecourseName: course,
      trackType: trackType as '芝' | 'ダート',
      distance: clampedDist,
      trackCondition,
      weather: condRand < 0.6 ? '晴' : condRand < 0.8 ? '曇' : '雨',
      entries,
      postPosition,
      horseNumber,
      position,
      jockeyName: jockey,
      handicapWeight: p.sex === '牝' ? 54 : 56 + (p.ability > 75 ? 1 : 0),
      weight: p.baseWeight + Math.floor((r(22) - 0.5) * 12),
      weightChange: Math.floor((r(23) - 0.5) * 10),
      time,
      margin: position === 1 ? '' : MARGINS[Math.min(position - 1, MARGINS.length - 1)],
      lastThreeFurlongs: l3f,
      cornerPositions: corners,
      odds: Math.round(baseOdds * 10) / 10,
      popularity: Math.max(1, Math.min(entries, Math.ceil(posRatio * entries * (0.8 + r(24) * 0.4)))),
      prize: position <= 5 ? [10000, 4000, 2500, 1500, 1000][position - 1] : 0,
    });
  }

  return perfs;
}

// ==================== 内部ヘルパー ====================

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function calcPosition(
  p: HorseProfile, trackType: string, distance: number, course: string,
  condition: string, entries: number, rand1: number, rand2: number,
): number {
  // ベース期待着順比率 (ability 85→0.12, 70→0.29, 60→0.37)
  let ratio = (100 - p.ability) / 100 * 0.8 + 0.05;

  // トラック不一致ペナルティ
  if (trackType !== p.preferredTrack) ratio += 0.18;

  // 距離不一致ペナルティ
  const distDiff = Math.abs(distance - p.bestDistance);
  if (distDiff > p.distanceFlex) ratio += 0.12;
  else if (distDiff > p.distanceFlex * 0.5) ratio += 0.05;

  // コース不一致
  if (!p.preferredCourses.includes(course)) ratio += 0.04;

  // 道悪補正
  if (condition === '重' || condition === '不良') {
    ratio -= p.heavyBonus / 100;
  }

  // ランダムバラつき (consistency)
  ratio += (rand1 - 0.5) * p.consistency * 2;

  // たまに大敗
  if (rand2 < 0.08) ratio += 0.25;

  ratio = Math.max(0.03, Math.min(0.95, ratio));
  return Math.max(1, Math.ceil(ratio * entries));
}

function calcTime(
  distance: number, trackType: string, condition: string,
  position: number, entries: number, rand: number,
): string {
  // 標準タイム (秒)
  const basePace = trackType === '芝' ? 16.5 : 15.8;
  let totalSec = distance / basePace;

  // 馬場状態補正
  if (condition === '重') totalSec *= 1.015;
  if (condition === '不良') totalSec *= 1.025;
  if (condition === '稍重') totalSec *= 1.005;

  // 着順補正 (勝ち馬が速い)
  const posAdj = (position / entries) * 3.0;
  totalSec += posAdj;

  // ランダム
  totalSec += (rand - 0.5) * 1.5;

  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) {
    return `${min}:${sec.toFixed(1).padStart(4, '0')}`;
  }
  return sec.toFixed(1);
}

function calcLast3F(
  p: HorseProfile, trackType: string, position: number, entries: number, rand: number,
): string {
  let base = p.finishKick;
  if (trackType === 'ダート' && p.preferredTrack === '芝') base += 1.5;
  if (trackType === '芝' && p.preferredTrack === 'ダート') base += 0.5;

  // 好走時は上がりも速い
  const posRatio = position / entries;
  if (posRatio <= 0.15) base -= 0.5;
  else if (posRatio >= 0.6) base += 0.8;

  base += (rand - 0.5) * 1.2;
  return Math.max(32.0, Math.min(39.0, base)).toFixed(1);
}

function calcCorners(
  style: string, position: number, entries: number,
  r1: number, r2: number, r3: number, r4: number,
): string {
  let c1: number, c2: number, c3: number, c4: number;

  switch (style) {
    case '逃げ':
      c1 = 1 + Math.floor(r1 * 1.5);
      c2 = 1 + Math.floor(r2 * 1.5);
      c3 = 1 + Math.floor(r3 * 2);
      c4 = Math.min(position + 1, 1 + Math.floor(r4 * 3));
      break;
    case '先行':
      c1 = 2 + Math.floor(r1 * 3);
      c2 = 2 + Math.floor(r2 * 3);
      c3 = 2 + Math.floor(r3 * 3);
      c4 = Math.max(1, Math.min(position + 2, 2 + Math.floor(r4 * 4)));
      break;
    case '差し':
      c1 = Math.floor(entries * 0.35) + Math.floor(r1 * entries * 0.25);
      c2 = Math.floor(entries * 0.30) + Math.floor(r2 * entries * 0.25);
      c3 = Math.floor(entries * 0.25) + Math.floor(r3 * entries * 0.20);
      c4 = Math.max(1, position + Math.floor(r4 * 3));
      break;
    case '追込':
      c1 = Math.floor(entries * 0.65) + Math.floor(r1 * entries * 0.30);
      c2 = Math.floor(entries * 0.55) + Math.floor(r2 * entries * 0.30);
      c3 = Math.floor(entries * 0.40) + Math.floor(r3 * entries * 0.30);
      c4 = Math.max(1, position + Math.floor(r4 * 5));
      break;
    default:
      c1 = Math.floor(entries * 0.4 * r1) + 2;
      c2 = Math.floor(entries * 0.4 * r2) + 2;
      c3 = Math.floor(entries * 0.35 * r3) + 2;
      c4 = Math.max(1, position + Math.floor(r4 * 3));
  }

  const clamp = (v: number) => Math.max(1, Math.min(entries, Math.round(v)));
  return `${clamp(c1)}-${clamp(c2)}-${clamp(c3)}-${clamp(c4)}`;
}

function pickRaceName(pool: string[], ability: number, raceIdx: number, rand: number): string {
  // 能力が高い馬は重賞名のレースにも出る
  if (ability >= 75 && raceIdx < 5 && rand < 0.6) {
    // G1/G2/G3を含むレース名を選ぶ
    const graded = pool.filter(n => n.includes('G') || n.includes('賞') || n.includes('S'));
    if (graded.length > 0) return graded[Math.floor(rand * graded.length)];
  }
  return pool[Math.floor(rand * pool.length)];
}
