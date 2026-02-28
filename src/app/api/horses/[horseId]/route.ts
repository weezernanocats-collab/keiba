import { NextRequest, NextResponse } from 'next/server';
import { getHorseById, getHorsePastPerformances } from '@/lib/queries';
import { dbGet, dbAll } from '@/lib/database';
import { seedAllData } from '@/lib/seed-data';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HorseData = Record<string, any>;

function buildPartialHorse(entry: Record<string, unknown>): HorseData {
  return {
    id: entry.horse_id as string,
    name: entry.horse_name as string,
    name_en: null,
    age: (entry.age as number) || 0,
    sex: (entry.sex as string) || '牡',
    color: '',
    birth_date: null,
    father_name: '',
    mother_name: '',
    trainer_name: (entry.trainer_name as string) || '',
    owner_name: '',
    total_races: 0,
    wins: 0,
    seconds: 0,
    thirds: 0,
    total_earnings: 0,
    condition_overall: '不明',
    condition_weight: null,
    condition_weight_change: null,
    training_comment: null,
    strengths: [],
    weaknesses: [],
    _partial: true,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ horseId: string }> }
) {
  try {
    await seedAllData();
    const { horseId } = await params;
    let horse: HorseData | null = await getHorseById(horseId);

    if (!horse) {
      // horses テーブルにないが race_entries に存在する場合のフォールバック
      const entry = await dbGet<Record<string, unknown>>(
        `SELECT horse_id, horse_name, jockey_name, trainer_name, age, sex
         FROM race_entries WHERE horse_id = ? LIMIT 1`,
        [horseId]
      );
      if (!entry) {
        return NextResponse.json({ error: '馬が見つかりません' }, { status: 404 });
      }
      horse = buildPartialHorse(entry);
    }

    // 馬名が '取得失敗' の場合、race_entries から正しい名前を取得
    if (horse.name === '取得失敗' || !horse.name) {
      const entry = await dbGet<{ horse_name: string }>(
        `SELECT horse_name FROM race_entries WHERE horse_id = ? AND horse_name != '' LIMIT 1`,
        [horseId]
      );
      if (entry?.horse_name) {
        horse = { ...horse, name: entry.horse_name };
      }
    }

    // birth_date が FETCH_FAILED の場合、表示用に null に変換
    if (horse.birth_date === 'FETCH_FAILED') {
      horse = { ...horse, birth_date: null };
    }

    const pastPerformances = await getHorsePastPerformances(horseId, 20);

    // race_entries から直近の出走情報を補完（過去成績がない場合）
    let raceEntries: Record<string, unknown>[] = [];
    if (pastPerformances.length === 0) {
      raceEntries = await dbAll<Record<string, unknown>>(
        `SELECT re.horse_number, re.jockey_name, re.handicap_weight,
                re.result_position, re.result_time, re.result_last_three_furlongs,
                re.result_weight, re.result_weight_change, re.odds, re.popularity,
                r.name as race_name, r.date, r.racecourse_name, r.track_type,
                r.distance, r.track_condition
         FROM race_entries re
         JOIN races r ON re.race_id = r.id
         WHERE re.horse_id = ?
         ORDER BY r.date DESC
         LIMIT 20`,
        [horseId]
      );
    }

    return NextResponse.json({ horse, pastPerformances, raceEntries });
  } catch (error) {
    console.error('馬詳細API エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
