/**
 * サンプルデータ投入スクリプト (v3)
 *
 * 30頭の馬プロファイルから整合性のある過去成績を自動生成し、
 * 統計分析v3対応のAI予想を生成する。
 */

import { dbGet, dbAll, dbBatch } from './database';
import { RACECOURSES } from '@/types';
import {
  seedRacecourses, upsertHorse, upsertJockey, upsertRace,
  upsertRaceEntry, insertPastPerformance, upsertOdds,
  setHorseTraits, savePrediction, mapPastPerformance,
} from './queries';
import { generatePrediction, type HorseAnalysisInput } from './prediction-engine';
import { evaluateAllPendingRaces } from './accuracy-tracker';
import { generatePastPerformances } from './seed-helpers';
import { ALL_HORSES } from './seed-horses';
import { ALL_JOCKEYS, ALL_RACES, type RaceTemplate } from './seed-jockeys-races';
import { generatePastRaces } from './seed-race-generator';

// 手動定義レース + 自動生成50レースを結合
const COMBINED_RACES: RaceTemplate[] = [...ALL_RACES, ...generatePastRaces(50)];

// ==================== メインエントリ ====================

export async function seedAllData() {
  // 既にデータがあれば何もしない
  const row = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM horses');
  const count = row?.c ?? 0;
  if (count > 0) return;

  // 競馬場マスタ
  await seedRacecourses(RACECOURSES);

  // 馬データ + 過去成績
  await seedHorsesAndPerformances();

  // 騎手データ
  await seedJockeys();

  // レースデータ（過去＋未来）
  await seedRaces();

  // 生成レースの結果を過去成績DBにも反映 (予想の入力データを充実させる)
  await seedGeneratedRacePerformances();

  // オッズ
  await seedOdds();

  // AI予想生成（過去レース含む全レース）
  await seedPredictions();

  // 過去レースの予想 vs 実結果を自動照合（的中率ダッシュボード用）
  await evaluateAllPendingRaces();
}

// ==================== 馬 + 過去成績 ====================

async function seedHorsesAndPerformances() {
  for (const p of ALL_HORSES) {
    // 馬本体
    await upsertHorse({
      id: p.id,
      name: p.name,
      age: p.age,
      sex: p.sex,
      color: p.color,
      birthDate: p.birthDate,
      fatherName: p.fatherName,
      motherName: p.motherName,
      trainerName: p.trainerName,
      ownerName: p.ownerName,
      totalRaces: p.totalRaces,
      wins: p.wins,
      seconds: p.seconds,
      thirds: p.thirds,
      totalEarnings: p.totalEarnings,
      condition: {
        overall: '好調',
        weight: p.baseWeight,
        weightChange: 0,
        trainingComment: '調教の動きは良好',
      },
    });

    // 強み・弱み
    await setHorseTraits(p.id, p.strengths, p.weaknesses);

    // プロファイルから過去成績を自動生成
    const perfs = generatePastPerformances(p);
    for (const perf of perfs) {
      await insertPastPerformance(p.id, perf);
    }
  }
}

// ==================== 騎手 ====================

async function seedJockeys() {
  for (const j of ALL_JOCKEYS) {
    await upsertJockey(j);
  }
}

// ==================== レース ====================

async function seedRaces() {
  const now = Date.now();

  for (const tmpl of COMBINED_RACES) {
    const date = new Date(now + tmpl.daysFromNow * 86400000);
    const dateStr = date.toISOString().split('T')[0];

    await upsertRace({
      id: tmpl.id,
      name: tmpl.name,
      date: dateStr,
      racecourseId: tmpl.racecourseId,
      racecourseName: tmpl.racecourseName,
      raceNumber: tmpl.raceNumber,
      grade: tmpl.grade,
      trackType: tmpl.trackType,
      distance: tmpl.distance,
      trackCondition: tmpl.trackCondition,
      weather: tmpl.weather,
      status: tmpl.status,
    });

    // 出走馬を登録
    await seedRaceEntries(tmpl, dateStr);
  }
}

async function seedRaceEntries(tmpl: RaceTemplate, _dateStr: string) {
  const horseMap = new Map(ALL_HORSES.map(h => [h.id, h]));

  for (let idx = 0; idx < tmpl.entries.length; idx++) {
    const e = tmpl.entries[idx];
    const horse = horseMap.get(e.horseId);
    if (!horse) continue;

    const jockey = ALL_JOCKEYS.find(j => j.id === e.jockeyId);
    const horseNumber = idx + 1;
    const postPosition = Math.min(8, Math.ceil(horseNumber / 2));

    await upsertRaceEntry(tmpl.id, {
      postPosition,
      horseNumber,
      horseId: horse.id,
      horseName: horse.name,
      age: horse.age,
      sex: horse.sex,
      jockeyId: e.jockeyId,
      jockeyName: jockey?.name || '',
      trainerName: horse.trainerName,
      handicapWeight: e.handicapWeight,
      result: e.resultPosition ? {
        position: e.resultPosition,
        time: generateResultTime(tmpl.trackType, tmpl.distance, e.resultPosition, tmpl.entries.length),
        margin: e.resultPosition === 1 ? '' : ['クビ', 'ハナ', 'アタマ', '1/2', '1', '1 1/2', '2'][Math.min(e.resultPosition - 2, 6)],
      } : undefined,
    });
  }
}

// ==================== 生成レース結果 → 過去成績変換 ====================

async function seedGeneratedRacePerformances() {
  const now = Date.now();
  const horseMap = new Map(ALL_HORSES.map(h => [h.id, h]));

  // 過去レースのみ、古い順にソート (古いレースの結果が先に past_performances に入る)
  const pastRaces = COMBINED_RACES
    .filter(r => r.status === '結果確定')
    .sort((a, b) => a.daysFromNow - b.daysFromNow); // daysFromNow は負の値 → 小さい方が古い

  for (const tmpl of pastRaces) {
    const date = new Date(now + tmpl.daysFromNow * 86400000);
    const dateStr = date.toISOString().split('T')[0];

    for (const e of tmpl.entries) {
      if (!e.resultPosition) continue;
      const horse = horseMap.get(e.horseId);
      if (!horse) continue;

      const jockey = ALL_JOCKEYS.find(j => j.id === e.jockeyId);
      const horseNumber = tmpl.entries.indexOf(e) + 1;
      const fieldSize = tmpl.entries.length;

      // 能力ベースの上がり3F
      const baseFurlong = tmpl.trackType === '芝' ? 34.5 : 36.5;
      const l3f = baseFurlong - (horse.ability - 70) * 0.1 + (e.resultPosition - 1) * 0.2
        + (horse.consistency * 5 * (Math.sin(tmpl.daysFromNow) * 0.5 + 0.5));

      // コーナー通過順位 (脚質ベース)
      const styleToCorner = { '逃げ': 1, '先行': 3, '差し': 6, '追込': 10 };
      const baseCorner = styleToCorner[horse.style] || 5;
      const corner = Math.min(fieldSize, Math.max(1, baseCorner + Math.floor(Math.sin(tmpl.daysFromNow * 7) * 2)));
      const cornerStr = `${corner}-${corner}-${Math.min(fieldSize, corner + 1)}-${e.resultPosition}`;

      await insertPastPerformance(e.horseId, {
        date: dateStr,
        raceName: tmpl.name,
        racecourseName: tmpl.racecourseName,
        trackType: tmpl.trackType,
        distance: tmpl.distance,
        trackCondition: tmpl.trackCondition || '良',
        weather: tmpl.weather || '晴',
        entries: fieldSize,
        postPosition: Math.min(8, Math.ceil(horseNumber / 2)),
        horseNumber,
        position: e.resultPosition,
        jockeyName: jockey?.name || '',
        handicapWeight: e.handicapWeight,
        weight: horse.baseWeight + Math.floor(Math.sin(tmpl.daysFromNow * 3) * 6),
        weightChange: Math.floor(Math.sin(tmpl.daysFromNow * 5) * 4),
        time: generateResultTime(tmpl.trackType, tmpl.distance, e.resultPosition, fieldSize),
        margin: e.resultPosition === 1 ? '' : ['クビ', 'ハナ', 'アタマ', '1/2', '1', '1 1/2', '2'][Math.min(e.resultPosition - 2, 6)],
        lastThreeFurlongs: l3f.toFixed(1),
        cornerPositions: cornerStr,
        odds: Math.max(1.1, 2 + (90 - horse.ability) * 0.5 + Math.abs(Math.sin(tmpl.daysFromNow * 11)) * 5),
        popularity: Math.min(fieldSize, Math.max(1, Math.ceil(fieldSize * (1 - horse.ability / 100)))),
        prize: e.resultPosition <= 3 ? (e.resultPosition === 1 ? 5000 : e.resultPosition === 2 ? 2000 : 1000) : 0,
      });
    }
  }
}

function generateResultTime(trackType: string, distance: number, position: number, fieldSize: number): string {
  const basePace = trackType === '芝' ? 16.5 : 15.8;
  let totalSec = distance / basePace;
  totalSec += (position / fieldSize) * 2.0;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) {
    return `${min}:${sec.toFixed(1).padStart(4, '0')}`;
  }
  return sec.toFixed(1);
}

// ==================== オッズ ====================

async function seedOdds() {
  // 出走確定レースにのみオッズを設定
  const confirmedRaces = COMBINED_RACES.filter(r => r.status === '出走確定');

  for (const race of confirmedRaces) {
    const horseMap = new Map(ALL_HORSES.map(h => [h.id, h]));

    // 能力値に基づいてオッズを算出
    const abilities = race.entries.map(e => {
      const horse = horseMap.get(e.horseId);
      return { horseNumber: race.entries.indexOf(e) + 1, ability: horse?.ability || 65 };
    });

    // 能力が高いほどオッズが低い
    const maxAbility = Math.max(...abilities.map(a => a.ability));
    for (const a of abilities) {
      const diff = maxAbility - a.ability;
      const odds = Math.round((2.0 + diff * 0.8 + Math.random() * 3) * 10) / 10;
      await upsertOdds(race.id, '単勝', [a.horseNumber], odds);
      await upsertOdds(race.id, '複勝', [a.horseNumber], odds * 0.4, odds * 0.3, odds * 0.5);
    }
  }
}

// ==================== AI予想 ====================

async function seedPredictions() {
  // 全レースに対してAI予想を生成（過去レースも含めて的中率検証を可能にする）
  const confirmedRaces = COMBINED_RACES.filter(r => r.status === '出走確定' || r.status === '結果確定');

  for (const tmpl of confirmedRaces) {
    const now = Date.now();
    const dateStr = new Date(now + tmpl.daysFromNow * 86400000).toISOString().split('T')[0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = await dbAll<any>('SELECT * FROM race_entries WHERE race_id = ?', [tmpl.id]);
    if (entries.length === 0) continue;

    const horseInputs: HorseAnalysisInput[] = [];

    for (const e of entries) {
      const ppRows = await dbAll(
        'SELECT * FROM past_performances WHERE horse_id = ? ORDER BY date DESC LIMIT 100',
        [e.horse_id as string]
      );
      const pp = ppRows.map(mapPastPerformance);

      const jockey = await dbGet<{ win_rate: number; place_rate: number }>(
        'SELECT * FROM jockeys WHERE id = ?',
        [e.jockey_id as string]
      );

      // 馬テーブルから父名を取得 (統計分析v3で必要)
      const horse = await dbGet<{ father_name: string }>(
        'SELECT father_name FROM horses WHERE id = ?',
        [e.horse_id as string]
      );

      horseInputs.push({
        entry: {
          postPosition: e.post_position as number,
          horseNumber: e.horse_number as number,
          horseId: e.horse_id as string,
          horseName: e.horse_name as string,
          age: e.age as number,
          sex: (e.sex as string || '牡') as '牡' | '牝' | 'セ',
          jockeyId: e.jockey_id as string || '',
          jockeyName: e.jockey_name as string,
          trainerName: e.trainer_name as string || '',
          handicapWeight: e.handicap_weight as number,
          odds: undefined,
          popularity: undefined,
        },
        pastPerformances: pp,
        jockeyWinRate: jockey?.win_rate || 0.10,
        jockeyPlaceRate: jockey?.place_rate || 0.30,
        fatherName: horse?.father_name || '',
      });
    }

    if (horseInputs.length > 0) {
      const prediction = await generatePrediction(
        tmpl.id, tmpl.name, dateStr,
        tmpl.trackType, tmpl.distance, tmpl.trackCondition || '良',
        tmpl.racecourseName, tmpl.grade, horseInputs,
      );
      await savePrediction(prediction);
    }
  }
}
