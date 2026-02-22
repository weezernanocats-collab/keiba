/**
 * サンプルデータ投入スクリプト (v3)
 *
 * 30頭の馬プロファイルから整合性のある過去成績を自動生成し、
 * 統計分析v3対応のAI予想を生成する。
 */

import { getDatabase } from './database';
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

// ==================== メインエントリ ====================

export function seedAllData() {
  const db = getDatabase();

  // 既にデータがあれば何もしない
  const count = (db.prepare('SELECT COUNT(*) as c FROM horses').get() as { c: number }).c;
  if (count > 0) return;

  // 競馬場マスタ
  seedRacecourses(RACECOURSES);

  // 馬データ + 過去成績
  seedHorsesAndPerformances();

  // 騎手データ
  seedJockeys();

  // レースデータ（過去＋未来）
  seedRaces();

  // オッズ
  seedOdds();

  // AI予想生成（過去レース含む全レース）
  seedPredictions();

  // 過去レースの予想 vs 実結果を自動照合（的中率ダッシュボード用）
  evaluateAllPendingRaces();
}

// ==================== 馬 + 過去成績 ====================

function seedHorsesAndPerformances() {
  for (const p of ALL_HORSES) {
    // 馬本体
    upsertHorse({
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
    setHorseTraits(p.id, p.strengths, p.weaknesses);

    // プロファイルから過去成績を自動生成
    const perfs = generatePastPerformances(p);
    for (const perf of perfs) {
      insertPastPerformance(p.id, perf);
    }
  }
}

// ==================== 騎手 ====================

function seedJockeys() {
  for (const j of ALL_JOCKEYS) {
    upsertJockey(j);
  }
}

// ==================== レース ====================

function seedRaces() {
  const now = Date.now();

  for (const tmpl of ALL_RACES) {
    const date = new Date(now + tmpl.daysFromNow * 86400000);
    const dateStr = date.toISOString().split('T')[0];

    upsertRace({
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
    seedRaceEntries(tmpl, dateStr);
  }
}

function seedRaceEntries(tmpl: RaceTemplate, _dateStr: string) {
  const horseMap = new Map(ALL_HORSES.map(h => [h.id, h]));

  tmpl.entries.forEach((e, idx) => {
    const horse = horseMap.get(e.horseId);
    if (!horse) return;

    const jockey = ALL_JOCKEYS.find(j => j.id === e.jockeyId);
    const horseNumber = idx + 1;
    const postPosition = Math.min(8, Math.ceil(horseNumber / 2));

    upsertRaceEntry(tmpl.id, {
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
  });
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

function seedOdds() {
  // 出走確定レースにのみオッズを設定
  const confirmedRaces = ALL_RACES.filter(r => r.status === '出走確定');

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
      upsertOdds(race.id, '単勝', [a.horseNumber], odds);
      upsertOdds(race.id, '複勝', [a.horseNumber], odds * 0.4, odds * 0.3, odds * 0.5);
    }
  }
}

// ==================== AI予想 ====================

function seedPredictions() {
  const db = getDatabase();

  // 全レースに対してAI予想を生成（過去レースも含めて的中率検証を可能にする）
  const confirmedRaces = ALL_RACES.filter(r => r.status === '出走確定' || r.status === '結果確定');

  for (const tmpl of confirmedRaces) {
    const now = Date.now();
    const dateStr = new Date(now + tmpl.daysFromNow * 86400000).toISOString().split('T')[0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = db.prepare('SELECT * FROM race_entries WHERE race_id = ?').all(tmpl.id) as any[];
    if (entries.length === 0) continue;

    const horseInputs: HorseAnalysisInput[] = entries.map((e: Record<string, unknown>) => {
      const ppRows = db.prepare(
        'SELECT * FROM past_performances WHERE horse_id = ? ORDER BY date DESC LIMIT 100'
      ).all(e.horse_id as string);
      const pp = ppRows.map(mapPastPerformance);

      const jockey = db.prepare('SELECT * FROM jockeys WHERE id = ?').get(e.jockey_id as string) as
        { win_rate: number; place_rate: number } | undefined;

      // 馬テーブルから父名を取得 (統計分析v3で必要)
      const horse = db.prepare('SELECT father_name FROM horses WHERE id = ?').get(e.horse_id as string) as
        { father_name: string } | undefined;

      return {
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
      };
    });

    if (horseInputs.length > 0) {
      const prediction = generatePrediction(
        tmpl.id, tmpl.name, dateStr,
        tmpl.trackType, tmpl.distance, tmpl.trackCondition || '良',
        tmpl.racecourseName, tmpl.grade, horseInputs,
      );
      savePrediction(prediction);
    }
  }
}
