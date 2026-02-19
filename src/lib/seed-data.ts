/**
 * サンプルデータ投入スクリプト
 * 開発・デモ用のリアルな競馬データを生成する
 */

import { getDatabase } from './database';
import { RACECOURSES, type RaceEntry, type PastPerformance } from '@/types';
import { seedRacecourses, upsertHorse, upsertJockey, upsertRace, upsertRaceEntry, insertPastPerformance, upsertOdds, setHorseTraits, savePrediction } from './queries';
import { generatePrediction, type HorseAnalysisInput } from './prediction-engine';

export function seedAllData() {
  const db = getDatabase();

  // 既にデータがあれば何もしない
  const count = (db.prepare('SELECT COUNT(*) as c FROM horses').get() as { c: number }).c;
  if (count > 0) return;

  // 競馬場マスタ
  seedRacecourses(RACECOURSES);

  // 馬データ
  seedHorses();

  // 騎手データ
  seedJockeys();

  // レースデータ（過去＋未来）
  seedRaces();

  // オッズ
  seedOdds();

  // AI予想生成
  seedPredictions();
}

function seedHorses() {
  const horses = [
    { id: 'h001', name: 'サンダーボルト', age: 4, sex: '牡' as const, color: '鹿毛', birthDate: '2022-03-15', fatherName: 'ディープインパクト', motherName: 'スターライト', trainerName: '藤沢和雄', ownerName: 'サンデーレーシング', totalRaces: 12, wins: 5, seconds: 3, thirds: 1, totalEarnings: 28500, strengths: ['芝の中距離で安定した成績', '先行力が高く好位から抜け出せる', '右回りコースが得意'], weaknesses: ['重馬場では成績が落ちる', '多頭数のレースでは揉まれ弱い'] },
    { id: 'h002', name: 'ミラクルクイーン', age: 4, sex: '牝' as const, color: '栗毛', birthDate: '2022-04-20', fatherName: 'キングカメハメハ', motherName: 'ビューティフルドリーム', trainerName: '国枝栄', ownerName: 'キャロットファーム', totalRaces: 10, wins: 4, seconds: 2, thirds: 2, totalEarnings: 22000, strengths: ['瞬発力に優れ、末脚が強烈', '東京コースの成績が抜群', '牝馬ながら牡馬相手にも善戦'], weaknesses: ['スタートが安定しない', '短距離は適性外'] },
    { id: 'h003', name: 'ゴールドラッシュ', age: 5, sex: '牡' as const, color: '黒鹿毛', birthDate: '2021-02-10', fatherName: 'ゴールドシップ', motherName: 'ダイヤモンドレディ', trainerName: '矢作芳人', ownerName: 'シルクレーシング', totalRaces: 18, wins: 6, seconds: 4, thirds: 3, totalEarnings: 45000, strengths: ['道悪の鬼、重馬場で本領発揮', '長距離戦に強い', 'G1実績あり'], weaknesses: ['良馬場のスプリントは苦手', '間隔が空くと調整が難しい'] },
    { id: 'h004', name: 'スピードスター', age: 3, sex: '牡' as const, color: '芦毛', birthDate: '2023-01-08', fatherName: 'ロードカナロア', motherName: 'フラッシュダンス', trainerName: '堀宣行', ownerName: 'ノーザンファーム', totalRaces: 6, wins: 3, seconds: 1, thirds: 1, totalEarnings: 12000, strengths: ['圧倒的なスピードの持ち主', 'ダートの短距離で無敵', 'ゲートの出が非常に良い'], weaknesses: ['芝は未経験', '距離延長に課題'] },
    { id: 'h005', name: 'フォレストウィンド', age: 5, sex: '牝' as const, color: '青鹿毛', birthDate: '2021-05-22', fatherName: 'ハーツクライ', motherName: 'グリーンブリーズ', trainerName: '友道康夫', ownerName: '社台レースホース', totalRaces: 15, wins: 4, seconds: 3, thirds: 2, totalEarnings: 31000, strengths: ['中山コースの鬼', '先行して粘り込む走りが持ち味', '冬場に成績が上がる'], weaknesses: ['左回りはやや苦手', '夏場は成績が落ちる'] },
    { id: 'h006', name: 'ダークナイト', age: 4, sex: '牡' as const, color: '青毛', birthDate: '2022-02-28', fatherName: 'エピファネイア', motherName: 'ナイトクイーン', trainerName: '池江泰寿', ownerName: 'サンデーレーシング', totalRaces: 11, wins: 3, seconds: 2, thirds: 3, totalEarnings: 19500, strengths: ['差し脚が鋭い', '大舞台で力を発揮するタイプ', '距離延長で成績向上'], weaknesses: ['前が塞がると脆い', '小回りコースが苦手'] },
    { id: 'h007', name: 'レインボーブリッジ', age: 3, sex: '牡' as const, color: '栗毛', birthDate: '2023-04-05', fatherName: 'サトノダイヤモンド', motherName: 'レインボーローズ', trainerName: '木村哲也', ownerName: 'キャロットファーム', totalRaces: 5, wins: 2, seconds: 2, thirds: 0, totalEarnings: 8500, strengths: ['末脚の破壊力が魅力', '広いコースで本領発揮', '成長途上で伸びしろ大'], weaknesses: ['経験不足', '揉まれ弱い面がある'] },
    { id: 'h008', name: 'サクラチヨノオー', age: 6, sex: '牡' as const, color: '鹿毛', birthDate: '2020-03-14', fatherName: 'オルフェーヴル', motherName: 'サクラプリンセス', trainerName: '手塚貴久', ownerName: '社台レースホース', totalRaces: 25, wins: 7, seconds: 5, thirds: 4, totalEarnings: 55000, strengths: ['重賞実績豊富なベテラン', '安定感抜群で大崩れしない', 'どの条件でもまとめる能力'], weaknesses: ['年齢的な衰え', '瞬発力勝負では分が悪い'] },
    { id: 'h009', name: 'ブレイブハート', age: 4, sex: '牡' as const, color: '黒鹿毛', birthDate: '2022-05-10', fatherName: 'モーリス', motherName: 'カレッジガール', trainerName: '中内田充正', ownerName: 'ノーザンファーム', totalRaces: 9, wins: 4, seconds: 1, thirds: 2, totalEarnings: 25000, strengths: ['芝・ダート兼用の万能型', 'どんなペースにも対応可能', '阪神コースが大得意'], weaknesses: ['福島・小倉など小回りはやや苦手', '休み明けは割引'] },
    { id: 'h010', name: 'フェニックス', age: 3, sex: '牝' as const, color: '栃栗毛', birthDate: '2023-02-18', fatherName: 'キタサンブラック', motherName: 'フェアリーテイル', trainerName: '藤原英昭', ownerName: 'シルクレーシング', totalRaces: 4, wins: 2, seconds: 1, thirds: 1, totalEarnings: 7000, strengths: ['驚異的な末脚の持ち主', '京都コースの相性抜群', '牝馬限定戦ではクラス上位'], weaknesses: ['キャリアが浅い', '馬体重の変動が大きい'] },
    // 地方競馬の馬
    { id: 'h011', name: 'オオイノチカラ', age: 5, sex: '牡' as const, color: '鹿毛', birthDate: '2021-04-01', fatherName: 'サウスヴィグラス', motherName: 'オオイノハナ', trainerName: '荒山勝徳', ownerName: '大井太郎', totalRaces: 22, wins: 8, seconds: 5, thirds: 3, totalEarnings: 18000, strengths: ['大井ダート1600mが庭', '先行押切りの競馬が持ち味', '南関東重賞で実績あり'], weaknesses: ['中央馬相手では力不足', '1800m以上は距離が長い'] },
    { id: 'h012', name: 'カワサキスプリント', age: 4, sex: '牝' as const, color: '栗毛', birthDate: '2022-03-25', fatherName: 'ホッコータルマエ', motherName: 'カワサキレディ', trainerName: '内田勝義', ownerName: '川崎次郎', totalRaces: 16, wins: 6, seconds: 3, thirds: 2, totalEarnings: 14000, strengths: ['短距離のスペシャリスト', 'ゲートセンス抜群', '川崎900mの女王'], weaknesses: ['1400m以上は距離が長い', '中央遠征は未経験'] },
  ];

  for (const h of horses) {
    upsertHorse({
      id: h.id,
      name: h.name,
      age: h.age,
      sex: h.sex,
      color: h.color,
      birthDate: h.birthDate,
      fatherName: h.fatherName,
      motherName: h.motherName,
      trainerName: h.trainerName,
      ownerName: h.ownerName,
      totalRaces: h.totalRaces,
      wins: h.wins,
      seconds: h.seconds,
      thirds: h.thirds,
      totalEarnings: h.totalEarnings,
      condition: { overall: '好調', weight: 480 + Math.random() * 40, weightChange: Math.floor(Math.random() * 10) - 5, trainingComment: '調教の動きは良好' },
    });
    setHorseTraits(h.id, h.strengths, h.weaknesses);
  }

  // 過去成績も投入
  seedPastPerformances();
}

function seedPastPerformances() {
  const racecourses = ['東京', '中山', '阪神', '京都', '中京', '小倉', '新潟'];
  const trackTypes: ('芝' | 'ダート')[] = ['芝', 'ダート'];
  const conditions: ('良' | '稍重' | '重')[] = ['良', '良', '良', '稍重', '重'];
  const weathers: ('晴' | '曇' | '雨')[] = ['晴', '晴', '曇', '雨'];
  const distances = [1200, 1400, 1600, 1800, 2000, 2200, 2400];

  const horseIds = ['h001', 'h002', 'h003', 'h004', 'h005', 'h006', 'h007', 'h008', 'h009', 'h010', 'h011', 'h012'];
  const jockeys = ['ルメール', '川田将雅', '横山武史', '戸崎圭太', '福永祐一', '松山弘平'];

  for (const horseId of horseIds) {
    const numRaces = 5 + Math.floor(Math.random() * 10);
    for (let i = 0; i < numRaces; i++) {
      const daysAgo = 30 + i * (20 + Math.floor(Math.random() * 30));
      const date = new Date(Date.now() - daysAgo * 86400000);
      const dateStr = date.toISOString().split('T')[0];
      const entries = 10 + Math.floor(Math.random() * 8);
      const position = 1 + Math.floor(Math.random() * entries);
      const dist = distances[Math.floor(Math.random() * distances.length)];
      const trackType = horseId === 'h004' || horseId === 'h011' || horseId === 'h012'
        ? 'ダート'
        : trackTypes[Math.floor(Math.random() * trackTypes.length)];
      const baseTime = trackType === '芝' ? dist / 16.5 : dist / 15.8;
      const timeVariation = (Math.random() - 0.5) * 2;
      const totalSeconds = baseTime + timeVariation;
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const timeStr = minutes > 0
        ? `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
        : seconds.toFixed(1);

      insertPastPerformance(horseId, {
        date: dateStr,
        raceName: `第${Math.floor(Math.random() * 50) + 1}回 ${racecourses[Math.floor(Math.random() * racecourses.length)]}ステークス`,
        racecourseName: racecourses[Math.floor(Math.random() * racecourses.length)],
        trackType,
        distance: dist,
        trackCondition: conditions[Math.floor(Math.random() * conditions.length)],
        weather: weathers[Math.floor(Math.random() * weathers.length)],
        entries,
        postPosition: 1 + Math.floor(Math.random() * 8),
        horseNumber: 1 + Math.floor(Math.random() * entries),
        position,
        jockeyName: jockeys[Math.floor(Math.random() * jockeys.length)],
        handicapWeight: 54 + Math.floor(Math.random() * 6),
        weight: 460 + Math.floor(Math.random() * 40),
        weightChange: Math.floor(Math.random() * 10) - 5,
        time: timeStr,
        margin: position === 1 ? '' : ['クビ', 'ハナ', 'アタマ', '1/2', '1', '1 1/2', '2', '3', '大差'][Math.min(position - 2, 8)],
        lastThreeFurlongs: (33 + Math.random() * 4).toFixed(1),
        cornerPositions: `${Math.ceil(Math.random() * entries)}-${Math.ceil(Math.random() * entries)}-${Math.ceil(Math.random() * entries)}-${Math.ceil(Math.random() * entries)}`,
        odds: 1.5 + Math.random() * 50,
        popularity: position <= 3 ? Math.ceil(Math.random() * 5) : Math.ceil(Math.random() * entries),
        prize: position <= 5 ? [10000, 4000, 2500, 1500, 1000][position - 1] : 0,
      });
    }
  }
}

function seedJockeys() {
  const jockeys = [
    { id: 'j001', name: 'ルメール', age: 45, region: '中央' as const, belongsTo: '美浦', totalRaces: 800, wins: 180, winRate: 0.225, placeRate: 0.38, showRate: 0.52, totalEarnings: 120000 },
    { id: 'j002', name: '川田将雅', age: 39, region: '中央' as const, belongsTo: '栗東', totalRaces: 750, wins: 165, winRate: 0.22, placeRate: 0.37, showRate: 0.50, totalEarnings: 110000 },
    { id: 'j003', name: '横山武史', age: 25, region: '中央' as const, belongsTo: '美浦', totalRaces: 600, wins: 100, winRate: 0.167, placeRate: 0.30, showRate: 0.42, totalEarnings: 65000 },
    { id: 'j004', name: '戸崎圭太', age: 43, region: '中央' as const, belongsTo: '美浦', totalRaces: 900, wins: 170, winRate: 0.189, placeRate: 0.33, showRate: 0.46, totalEarnings: 100000 },
    { id: 'j005', name: '松山弘平', age: 33, region: '中央' as const, belongsTo: '栗東', totalRaces: 700, wins: 115, winRate: 0.164, placeRate: 0.29, showRate: 0.41, totalEarnings: 70000 },
    { id: 'j006', name: '福永祐一', age: 47, region: '中央' as const, belongsTo: '栗東', totalRaces: 1000, wins: 200, winRate: 0.20, placeRate: 0.35, showRate: 0.48, totalEarnings: 150000 },
    { id: 'j007', name: '御神本訓史', age: 43, region: '地方' as const, belongsTo: '大井', totalRaces: 1200, wins: 350, winRate: 0.292, placeRate: 0.45, showRate: 0.58, totalEarnings: 85000 },
    { id: 'j008', name: '森泰斗', age: 38, region: '地方' as const, belongsTo: '船橋', totalRaces: 1100, wins: 320, winRate: 0.291, placeRate: 0.44, showRate: 0.57, totalEarnings: 78000 },
  ];

  for (const j of jockeys) {
    upsertJockey(j);
  }
}

function seedRaces() {
  // 過去のレース
  const pastRaces = [
    { id: 'r2025_tokyo_11', name: '東京優駿（日本ダービー）', date: '2025-05-25', racecourseId: 'tokyo', racecourseName: '東京', raceNumber: 11, grade: 'G1' as const, trackType: '芝' as const, distance: 2400, trackCondition: '良' as const, weather: '晴' as const, status: '結果確定' as const },
    { id: 'r2025_hanshin_11', name: '宝塚記念', date: '2025-06-29', racecourseId: 'hanshin', racecourseName: '阪神', raceNumber: 11, grade: 'G1' as const, trackType: '芝' as const, distance: 2200, trackCondition: '良' as const, weather: '曇' as const, status: '結果確定' as const },
    { id: 'r2025_ooi_11', name: '東京大賞典', date: '2025-12-29', racecourseId: 'ooi', racecourseName: '大井', raceNumber: 11, grade: 'G1' as const, trackType: 'ダート' as const, distance: 2000, trackCondition: '良' as const, weather: '晴' as const, status: '結果確定' as const },
  ];

  // 未来のレース
  const upcomingRaces = [
    { id: 'r2026_tokyo_01_11', name: 'フェブラリーステークス', date: '2026-02-22', racecourseId: 'tokyo', racecourseName: '東京', raceNumber: 11, grade: 'G1' as const, trackType: 'ダート' as const, distance: 1600, status: '出走確定' as const },
    { id: 'r2026_tokyo_01_01', name: '3歳未勝利', date: '2026-02-22', racecourseId: 'tokyo', racecourseName: '東京', raceNumber: 1, trackType: '芝' as const, distance: 1600, status: '出走確定' as const },
    { id: 'r2026_tokyo_01_05', name: '4歳以上1勝クラス', date: '2026-02-22', racecourseId: 'tokyo', racecourseName: '東京', raceNumber: 5, trackType: 'ダート' as const, distance: 1400, status: '出走確定' as const },
    { id: 'r2026_nakayama_01_11', name: '中山記念', date: '2026-02-22', racecourseId: 'nakayama', racecourseName: '中山', raceNumber: 11, grade: 'G2' as const, trackType: '芝' as const, distance: 1800, status: '出走確定' as const },
    { id: 'r2026_hanshin_01_11', name: '阪急杯', date: '2026-03-01', racecourseId: 'hanshin', racecourseName: '阪神', raceNumber: 11, grade: 'G3' as const, trackType: '芝' as const, distance: 1400, status: '予定' as const },
    { id: 'r2026_nakayama_02_11', name: '弥生賞', date: '2026-03-08', racecourseId: 'nakayama', racecourseName: '中山', raceNumber: 11, grade: 'G2' as const, trackType: '芝' as const, distance: 2000, status: '予定' as const },
    { id: 'r2026_hanshin_02_11', name: '大阪杯', date: '2026-04-05', racecourseId: 'hanshin', racecourseName: '阪神', raceNumber: 11, grade: 'G1' as const, trackType: '芝' as const, distance: 2000, status: '予定' as const },
    { id: 'r2026_ooi_01_11', name: '東京シティ盃', date: '2026-02-25', racecourseId: 'ooi', racecourseName: '大井', raceNumber: 11, trackType: 'ダート' as const, distance: 1200, status: '出走確定' as const },
    { id: 'r2026_kawasaki_01_11', name: '川崎記念', date: '2026-03-04', racecourseId: 'kawasaki', racecourseName: '川崎', raceNumber: 11, grade: 'G1' as const, trackType: 'ダート' as const, distance: 2100, status: '予定' as const },
  ];

  for (const r of [...pastRaces, ...upcomingRaces]) {
    upsertRace(r);
  }

  // 出走馬を登録
  seedRaceEntries();
}

function seedRaceEntries() {
  const raceEntries: Record<string, { horseNumber: number; postPosition: number; horseId: string; horseName: string; age: number; sex: '牡' | '牝' | 'セ'; jockeyId: string; jockeyName: string; trainerName: string; handicapWeight: number; resultPosition?: number }[]> = {
    'r2026_tokyo_01_11': [
      { horseNumber: 1, postPosition: 1, horseId: 'h004', horseName: 'スピードスター', age: 3, sex: '牡', jockeyId: 'j001', jockeyName: 'ルメール', trainerName: '堀宣行', handicapWeight: 57 },
      { horseNumber: 2, postPosition: 1, horseId: 'h003', horseName: 'ゴールドラッシュ', age: 5, sex: '牡', jockeyId: 'j002', jockeyName: '川田将雅', trainerName: '矢作芳人', handicapWeight: 57 },
      { horseNumber: 3, postPosition: 2, horseId: 'h009', horseName: 'ブレイブハート', age: 4, sex: '牡', jockeyId: 'j003', jockeyName: '横山武史', trainerName: '中内田充正', handicapWeight: 57 },
      { horseNumber: 4, postPosition: 2, horseId: 'h006', horseName: 'ダークナイト', age: 4, sex: '牡', jockeyId: 'j004', jockeyName: '戸崎圭太', trainerName: '池江泰寿', handicapWeight: 57 },
      { horseNumber: 5, postPosition: 3, horseId: 'h001', horseName: 'サンダーボルト', age: 4, sex: '牡', jockeyId: 'j005', jockeyName: '松山弘平', trainerName: '藤沢和雄', handicapWeight: 57 },
      { horseNumber: 6, postPosition: 3, horseId: 'h008', horseName: 'サクラチヨノオー', age: 6, sex: '牡', jockeyId: 'j006', jockeyName: '福永祐一', trainerName: '手塚貴久', handicapWeight: 57 },
      { horseNumber: 7, postPosition: 4, horseId: 'h011', horseName: 'オオイノチカラ', age: 5, sex: '牡', jockeyId: 'j007', jockeyName: '御神本訓史', trainerName: '荒山勝徳', handicapWeight: 57 },
      { horseNumber: 8, postPosition: 4, horseId: 'h012', horseName: 'カワサキスプリント', age: 4, sex: '牝', jockeyId: 'j008', jockeyName: '森泰斗', trainerName: '内田勝義', handicapWeight: 55 },
    ],
    'r2026_nakayama_01_11': [
      { horseNumber: 1, postPosition: 1, horseId: 'h001', horseName: 'サンダーボルト', age: 4, sex: '牡', jockeyId: 'j001', jockeyName: 'ルメール', trainerName: '藤沢和雄', handicapWeight: 56 },
      { horseNumber: 2, postPosition: 2, horseId: 'h002', horseName: 'ミラクルクイーン', age: 4, sex: '牝', jockeyId: 'j003', jockeyName: '横山武史', trainerName: '国枝栄', handicapWeight: 54 },
      { horseNumber: 3, postPosition: 3, horseId: 'h005', horseName: 'フォレストウィンド', age: 5, sex: '牝', jockeyId: 'j005', jockeyName: '松山弘平', trainerName: '友道康夫', handicapWeight: 54 },
      { horseNumber: 4, postPosition: 4, horseId: 'h006', horseName: 'ダークナイト', age: 4, sex: '牡', jockeyId: 'j004', jockeyName: '戸崎圭太', trainerName: '池江泰寿', handicapWeight: 56 },
      { horseNumber: 5, postPosition: 5, horseId: 'h008', horseName: 'サクラチヨノオー', age: 6, sex: '牡', jockeyId: 'j006', jockeyName: '福永祐一', trainerName: '手塚貴久', handicapWeight: 57 },
      { horseNumber: 6, postPosition: 6, horseId: 'h009', horseName: 'ブレイブハート', age: 4, sex: '牡', jockeyId: 'j002', jockeyName: '川田将雅', trainerName: '中内田充正', handicapWeight: 56 },
    ],
    'r2026_ooi_01_11': [
      { horseNumber: 1, postPosition: 1, horseId: 'h011', horseName: 'オオイノチカラ', age: 5, sex: '牡', jockeyId: 'j007', jockeyName: '御神本訓史', trainerName: '荒山勝徳', handicapWeight: 56 },
      { horseNumber: 2, postPosition: 2, horseId: 'h012', horseName: 'カワサキスプリント', age: 4, sex: '牝', jockeyId: 'j008', jockeyName: '森泰斗', trainerName: '内田勝義', handicapWeight: 54 },
      { horseNumber: 3, postPosition: 3, horseId: 'h004', horseName: 'スピードスター', age: 3, sex: '牡', jockeyId: 'j001', jockeyName: 'ルメール', trainerName: '堀宣行', handicapWeight: 55 },
    ],
  };

  // 過去レースの結果
  const pastEntries: Record<string, typeof raceEntries[string]> = {
    'r2025_tokyo_11': [
      { horseNumber: 1, postPosition: 1, horseId: 'h001', horseName: 'サンダーボルト', age: 3, sex: '牡', jockeyId: 'j001', jockeyName: 'ルメール', trainerName: '藤沢和雄', handicapWeight: 57, resultPosition: 2 },
      { horseNumber: 2, postPosition: 2, horseId: 'h007', horseName: 'レインボーブリッジ', age: 2, sex: '牡', jockeyId: 'j003', jockeyName: '横山武史', trainerName: '木村哲也', handicapWeight: 57, resultPosition: 1 },
      { horseNumber: 3, postPosition: 3, horseId: 'h006', horseName: 'ダークナイト', age: 3, sex: '牡', jockeyId: 'j004', jockeyName: '戸崎圭太', trainerName: '池江泰寿', handicapWeight: 57, resultPosition: 3 },
    ],
  };

  for (const [raceId, entries] of Object.entries({ ...raceEntries, ...pastEntries })) {
    for (const e of entries) {
      upsertRaceEntry(raceId, {
        ...e,
        result: e.resultPosition ? { position: e.resultPosition, time: '2:24.5', margin: e.resultPosition === 1 ? '' : 'クビ' } : undefined,
      });
    }
  }
}

function seedOdds() {
  // フェブラリーS のオッズ
  const febOdds = [
    { hn: 1, odds: 3.5 }, { hn: 2, odds: 4.2 }, { hn: 3, odds: 5.8 },
    { hn: 4, odds: 8.5 }, { hn: 5, odds: 12.0 }, { hn: 6, odds: 15.3 },
    { hn: 7, odds: 22.0 }, { hn: 8, odds: 35.0 },
  ];
  for (const o of febOdds) {
    upsertOdds('r2026_tokyo_01_11', '単勝', [o.hn], o.odds);
    upsertOdds('r2026_tokyo_01_11', '複勝', [o.hn], o.odds * 0.4, o.odds * 0.3, o.odds * 0.5);
  }

  // 中山記念のオッズ
  const nakayamaOdds = [
    { hn: 1, odds: 2.8 }, { hn: 2, odds: 5.0 }, { hn: 3, odds: 6.5 },
    { hn: 4, odds: 7.2 }, { hn: 5, odds: 4.5 }, { hn: 6, odds: 3.8 },
  ];
  for (const o of nakayamaOdds) {
    upsertOdds('r2026_nakayama_01_11', '単勝', [o.hn], o.odds);
    upsertOdds('r2026_nakayama_01_11', '複勝', [o.hn], o.odds * 0.4, o.odds * 0.3, o.odds * 0.5);
  }

  // 大井のオッズ
  const ooiOdds = [
    { hn: 1, odds: 1.8 }, { hn: 2, odds: 4.5 }, { hn: 3, odds: 2.5 },
  ];
  for (const o of ooiOdds) {
    upsertOdds('r2026_ooi_01_11', '単勝', [o.hn], o.odds);
    upsertOdds('r2026_ooi_01_11', '複勝', [o.hn], o.odds * 0.4, o.odds * 0.3, o.odds * 0.5);
  }
}

function seedPredictions() {
  // 出走確定レースのAI予想を生成
  const raceConfigs = [
    { raceId: 'r2026_tokyo_01_11', raceName: 'フェブラリーステークス', date: '2026-02-22', trackType: 'ダート' as const, distance: 1600, racecourseName: '東京', grade: 'G1' },
    { raceId: 'r2026_nakayama_01_11', raceName: '中山記念', date: '2026-02-22', trackType: '芝' as const, distance: 1800, racecourseName: '中山', grade: 'G2' },
    { raceId: 'r2026_ooi_01_11', raceName: '東京シティ盃', date: '2026-02-25', trackType: 'ダート' as const, distance: 1200, racecourseName: '大井', grade: undefined },
  ];

  const db = getDatabase();

  for (const config of raceConfigs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = db.prepare('SELECT * FROM race_entries WHERE race_id = ?').all(config.raceId) as any[];
    const horseInputs: HorseAnalysisInput[] = entries.map((e: Record<string, unknown>) => {
      const pp = db.prepare('SELECT * FROM past_performances WHERE horse_id = ? ORDER BY date DESC LIMIT 10').all(e.horse_id as string) as PastPerformance[];
      const jockey = db.prepare('SELECT * FROM jockeys WHERE id = ?').get(e.jockey_id as string) as { win_rate: number; place_rate: number } | undefined;

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
      };
    });

    if (horseInputs.length > 0) {
      const prediction = generatePrediction(
        config.raceId, config.raceName, config.date,
        config.trackType, config.distance, '良',
        config.racecourseName, config.grade, horseInputs,
      );
      savePrediction(prediction);
    }
  }
}
