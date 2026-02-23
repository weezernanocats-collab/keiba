/**
 * 自動レース生成器
 *
 * 30頭の馬プロファイルから50+の過去レースを自動生成する。
 * 各レースは10-16頭のフルフィールドで、能力値ベースの着順を付与。
 * 統計分析が全て有効になるデータ量を確保する。
 */

import type { HorseProfile } from './seed-helpers';
import { ALL_HORSES } from './seed-horses';
import { ALL_JOCKEYS, type RaceTemplate, type RaceEntryTemplate } from './seed-jockeys-races';

// ==================== 定数 ====================

interface CourseConfig {
  id: string;
  name: string;
  trackType: '芝' | 'ダート';
  distances: number[];
}

const CENTRAL_TURF_COURSES: CourseConfig[] = [
  { id: 'tokyo', name: '東京', trackType: '芝', distances: [1400, 1600, 1800, 2000, 2400] },
  { id: 'nakayama', name: '中山', trackType: '芝', distances: [1200, 1600, 1800, 2000, 2200, 2500] },
  { id: 'hanshin', name: '阪神', trackType: '芝', distances: [1400, 1600, 1800, 2000, 2200] },
  { id: 'kyoto', name: '京都', trackType: '芝', distances: [1400, 1600, 1800, 2000, 2200, 2400, 3200] },
  { id: 'kokura', name: '小倉', trackType: '芝', distances: [1200, 1800, 2000] },
  { id: 'chukyo', name: '中京', trackType: '芝', distances: [1200, 1400, 1600, 2000] },
  { id: 'niigata', name: '新潟', trackType: '芝', distances: [1200, 1400, 1600, 1800, 2000] },
  { id: 'sapporo', name: '札幌', trackType: '芝', distances: [1200, 1500, 1800, 2000] },
];

const CENTRAL_DIRT_COURSES: CourseConfig[] = [
  { id: 'tokyo', name: '東京', trackType: 'ダート', distances: [1400, 1600, 2100] },
  { id: 'nakayama', name: '中山', trackType: 'ダート', distances: [1200, 1800] },
  { id: 'hanshin', name: '阪神', trackType: 'ダート', distances: [1200, 1400, 1800, 2000] },
  { id: 'chukyo', name: '中京', trackType: 'ダート', distances: [1200, 1400, 1800] },
];

const LOCAL_DIRT_COURSES: CourseConfig[] = [
  { id: 'ooi', name: '大井', trackType: 'ダート', distances: [1200, 1400, 1600, 1800, 2000] },
  { id: 'funabashi', name: '船橋', trackType: 'ダート', distances: [1200, 1400, 1600, 1800] },
  { id: 'kawasaki', name: '川崎', trackType: 'ダート', distances: [1400, 1600, 2100] },
  { id: 'urawa', name: '浦和', trackType: 'ダート', distances: [1200, 1400, 1600, 2000] },
];

const CONDITIONS: ('良' | '稍重' | '重' | '不良')[] = ['良', '良', '良', '稍重', '稍重', '重', '不良'];
const WEATHERS: ('晴' | '曇' | '雨')[] = ['晴', '晴', '晴', '曇', '曇', '雨'];

const RACE_NAMES_TURF = [
  'サラ系3歳以上', 'サラ系3歳以上', '1勝クラス', '1勝クラス',
  '2勝クラス', '2勝クラス', '3勝クラス', 'オープン',
  'リステッド', 'ステークス', 'G3', 'G2',
];

const RACE_NAMES_DIRT = [
  'サラ系3歳以上', 'サラ系3歳以上', '1勝クラス', '1勝クラス',
  '2勝クラス', '2勝クラス', '3勝クラス', 'オープン',
  'ステークス', 'G3',
];

// ==================== シード付き乱数 ====================

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ==================== メイン生成関数 ====================

export function generatePastRaces(count: number = 50): RaceTemplate[] {
  const rand = seededRandom(20260222);
  const races: RaceTemplate[] = [];

  const turfHorses = ALL_HORSES.filter(h => h.preferredTrack === '芝');
  const dirtHorses = ALL_HORSES.filter(h => h.preferredTrack === 'ダート');
  const localHorses = ALL_HORSES.filter(h =>
    h.preferredCourses.some(c => ['大井', '船橋', '川崎', '浦和'].includes(c))
  );

  // 月ごとに分散させる (過去12ヶ月)
  for (let i = 0; i < count; i++) {
    const daysAgo = Math.floor(rand() * 365) + 14; // 14-379日前
    const month = new Date(Date.now() - daysAgo * 86400000).getMonth() + 1;

    // レースカテゴリをバランスよく配分
    let course: CourseConfig;
    let candidateHorses: HorseProfile[];

    const category = rand();
    if (category < 0.50) {
      // 中央芝 (50%)
      course = CENTRAL_TURF_COURSES[Math.floor(rand() * CENTRAL_TURF_COURSES.length)];
      candidateHorses = [...turfHorses];
    } else if (category < 0.75) {
      // 中央ダート (25%)
      course = CENTRAL_DIRT_COURSES[Math.floor(rand() * CENTRAL_DIRT_COURSES.length)];
      candidateHorses = [...dirtHorses];
      // 芝馬も稀にダートに出走
      if (rand() < 0.3) {
        const extraTurf = turfHorses.filter(() => rand() < 0.15);
        candidateHorses.push(...extraTurf);
      }
    } else {
      // 地方ダート (25%)
      course = LOCAL_DIRT_COURSES[Math.floor(rand() * LOCAL_DIRT_COURSES.length)];
      candidateHorses = [...localHorses, ...dirtHorses.filter(() => rand() < 0.5)];
    }

    const distance = course.distances[Math.floor(rand() * course.distances.length)];
    const condition = CONDITIONS[Math.floor(rand() * CONDITIONS.length)];
    const weather = WEATHERS[Math.floor(rand() * WEATHERS.length)];

    // エントリーする馬を選ぶ (10-16頭)
    const fieldSize = Math.min(candidateHorses.length, 10 + Math.floor(rand() * 7));
    const shuffled = [...candidateHorses].sort(() => rand() - 0.5);

    // 距離適性と好走コースで優先度をつける
    const scored = shuffled.map(h => {
      let priority = rand() * 20;
      // 距離が合う馬を優先
      if (Math.abs(h.bestDistance - distance) <= h.distanceFlex) priority += 30;
      else if (Math.abs(h.bestDistance - distance) <= h.distanceFlex * 2) priority += 15;
      // 好走コースの馬を優先
      if (h.preferredCourses.includes(course.name)) priority += 20;
      // トラック適性
      if (h.preferredTrack === course.trackType) priority += 10;
      return { horse: h, priority };
    });
    scored.sort((a, b) => b.priority - a.priority);

    const entryHorses = scored.slice(0, fieldSize).map(s => s.horse);
    if (entryHorses.length < 6) continue; // 少なすぎたらスキップ

    // 着順を能力値ベースで決定
    const entries = assignResults(entryHorses, distance, course, condition, month, rand);

    // レース名とグレード
    const namePool = course.trackType === '芝' ? RACE_NAMES_TURF : RACE_NAMES_DIRT;
    const classIdx = Math.min(namePool.length - 1, Math.floor(rand() * namePool.length));
    const baseName = namePool[classIdx];
    let grade: 'G1' | 'G2' | 'G3' | undefined;
    if (baseName === 'G3') grade = 'G3';
    else if (baseName === 'G2') grade = 'G2';
    const raceName = grade
      ? `${course.name}${distance}m${grade}`
      : `${course.name}${distance}m ${baseName}`;

    races.push({
      id: `r_gen_${String(i + 1).padStart(3, '0')}`,
      name: raceName,
      daysFromNow: -daysAgo,
      racecourseId: course.id,
      racecourseName: course.name,
      raceNumber: 5 + Math.floor(rand() * 7), // 5-11R
      grade,
      trackType: course.trackType,
      distance,
      trackCondition: condition,
      weather,
      status: '結果確定' as const,
      entries,
    });
  }

  return races;
}

// ==================== 着順決定 ====================

function assignResults(
  horses: HorseProfile[],
  distance: number,
  course: CourseConfig,
  condition: '良' | '稍重' | '重' | '不良',
  month: number,
  rand: () => number,
): RaceEntryTemplate[] {
  const jockeys = ALL_JOCKEYS;

  // 各馬のレース適性スコアを算出
  const horseScores = horses.map(h => {
    let score = h.ability;

    // 距離適性
    const distDiff = Math.abs(h.bestDistance - distance);
    if (distDiff <= 100) score += 5;
    else if (distDiff <= h.distanceFlex) score += 2;
    else if (distDiff <= h.distanceFlex * 1.5) score -= 3;
    else score -= 8;

    // コース適性
    if (h.preferredCourses.includes(course.name)) score += 4;

    // トラック適性
    if (h.preferredTrack !== course.trackType) score -= 10;

    // 馬場状態
    if (condition === '重' || condition === '不良') score += h.heavyBonus;

    // 季節適性
    if (h.bestMonths?.includes(month)) score += 3;

    // ランダム変動 (実力差を完全にはひっくり返さない程度)
    score += (rand() - 0.5) * h.consistency * 100;

    // 番狂わせ (5%の確率で大幅変動)
    if (rand() < 0.05) score += (rand() - 0.4) * 25;

    return { horse: h, score };
  });

  // スコア順にソート (高い = 好着順)
  horseScores.sort((a, b) => b.score - a.score);

  // 騎手を割り当て
  const usedJockeys = new Set<string>();

  return horseScores.map((hs, idx) => {
    // 通常の騎手 or ランダム割り当て
    let jockey = jockeys.find(j => j.name === hs.horse.usualJockey && !usedJockeys.has(j.id));
    if (!jockey) {
      const region = course.name === '大井' || course.name === '船橋' || course.name === '川崎' || course.name === '浦和'
        ? '地方' : '中央';
      const available = jockeys.filter(j => j.region === region && !usedJockeys.has(j.id));
      jockey = available[Math.floor(rand() * available.length)] || jockeys[Math.floor(rand() * jockeys.length)];
    }
    usedJockeys.add(jockey.id);

    // 斤量
    const baseWeight = hs.horse.sex === '牝' ? 55 : 57;
    const handicapWeight = baseWeight + (hs.horse.age >= 5 ? 1 : 0);

    return {
      horseId: hs.horse.id,
      jockeyId: jockey.id,
      handicapWeight,
      resultPosition: idx + 1,
    };
  });
}
