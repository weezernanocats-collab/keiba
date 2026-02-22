/**
 * 騎手データ & レーステンプレート
 *
 * 日付は相対日数 (daysFromNow) で管理し、seed-data.ts で実日付に変換する。
 */

// ==================== 騎手 ====================

export interface JockeyProfile {
  id: string;
  name: string;
  age: number;
  region: '中央' | '地方';
  belongsTo: string;
  totalRaces: number;
  wins: number;
  winRate: number;
  placeRate: number;
  showRate: number;
  totalEarnings: number;
}

export const ALL_JOCKEYS: JockeyProfile[] = [
  // 中央
  { id: 'j001', name: 'ルメール', age: 45, region: '中央', belongsTo: '美浦', totalRaces: 800, wins: 180, winRate: 0.225, placeRate: 0.38, showRate: 0.52, totalEarnings: 120000 },
  { id: 'j002', name: '川田将雅', age: 39, region: '中央', belongsTo: '栗東', totalRaces: 750, wins: 165, winRate: 0.22, placeRate: 0.37, showRate: 0.50, totalEarnings: 110000 },
  { id: 'j003', name: '横山武史', age: 25, region: '中央', belongsTo: '美浦', totalRaces: 600, wins: 100, winRate: 0.167, placeRate: 0.30, showRate: 0.42, totalEarnings: 65000 },
  { id: 'j004', name: '戸崎圭太', age: 43, region: '中央', belongsTo: '美浦', totalRaces: 900, wins: 170, winRate: 0.189, placeRate: 0.33, showRate: 0.46, totalEarnings: 100000 },
  { id: 'j005', name: '松山弘平', age: 33, region: '中央', belongsTo: '栗東', totalRaces: 700, wins: 115, winRate: 0.164, placeRate: 0.29, showRate: 0.41, totalEarnings: 70000 },
  { id: 'j006', name: '坂井瑠星', age: 25, region: '中央', belongsTo: '栗東', totalRaces: 500, wins: 85, winRate: 0.170, placeRate: 0.31, showRate: 0.43, totalEarnings: 52000 },
  { id: 'j009', name: '武豊', age: 57, region: '中央', belongsTo: '栗東', totalRaces: 1200, wins: 260, winRate: 0.217, placeRate: 0.35, showRate: 0.48, totalEarnings: 180000 },
  { id: 'j010', name: '岩田望来', age: 23, region: '中央', belongsTo: '栗東', totalRaces: 450, wins: 63, winRate: 0.140, placeRate: 0.27, showRate: 0.38, totalEarnings: 38000 },
  // 地方
  { id: 'j007', name: '御神本訓史', age: 43, region: '地方', belongsTo: '大井', totalRaces: 1200, wins: 350, winRate: 0.292, placeRate: 0.45, showRate: 0.58, totalEarnings: 85000 },
  { id: 'j008', name: '森泰斗', age: 38, region: '地方', belongsTo: '船橋', totalRaces: 1100, wins: 320, winRate: 0.291, placeRate: 0.44, showRate: 0.57, totalEarnings: 78000 },
  { id: 'j011', name: '笹川翼', age: 30, region: '地方', belongsTo: '船橋', totalRaces: 900, wins: 225, winRate: 0.250, placeRate: 0.40, showRate: 0.53, totalEarnings: 55000 },
  { id: 'j012', name: '矢野貴之', age: 35, region: '地方', belongsTo: '大井', totalRaces: 1000, wins: 240, winRate: 0.240, placeRate: 0.39, showRate: 0.52, totalEarnings: 60000 },
];

// ==================== レーステンプレート ====================

export interface RaceTemplate {
  id: string;
  name: string;
  daysFromNow: number; // 正=未来, 負=過去
  racecourseId: string;
  racecourseName: string;
  raceNumber: number;
  grade?: 'G1' | 'G2' | 'G3';
  trackType: '芝' | 'ダート';
  distance: number;
  trackCondition?: '良' | '稍重' | '重' | '不良';
  weather?: '晴' | '曇' | '雨';
  status: '予定' | '出走確定' | '結果確定';
  /** 出走馬情報。horseId → { jockeyId, handicapWeight, resultPosition? } */
  entries: RaceEntryTemplate[];
}

export interface RaceEntryTemplate {
  horseId: string;
  jockeyId: string;
  handicapWeight: number;
  resultPosition?: number; // 過去レースの場合
}

// ── 過去レース (結果確定) ─────────────────

const pastRaces: RaceTemplate[] = [
  {
    id: 'r_past_01', name: '東京優駿（日本ダービー）', daysFromNow: -270,
    racecourseId: 'tokyo', racecourseName: '東京', raceNumber: 11,
    grade: 'G1', trackType: '芝', distance: 2400,
    trackCondition: '良', weather: '晴', status: '結果確定',
    entries: [
      { horseId: 'h007', jockeyId: 'j006', handicapWeight: 57, resultPosition: 1 },
      { horseId: 'h001', jockeyId: 'j001', handicapWeight: 57, resultPosition: 2 },
      { horseId: 'h006', jockeyId: 'j004', handicapWeight: 57, resultPosition: 3 },
      { horseId: 'h013', jockeyId: 'j003', handicapWeight: 57, resultPosition: 5 },
      { horseId: 'h024', jockeyId: 'j005', handicapWeight: 57, resultPosition: 8 },
    ],
  },
  {
    id: 'r_past_02', name: '宝塚記念', daysFromNow: -240,
    racecourseId: 'hanshin', racecourseName: '阪神', raceNumber: 11,
    grade: 'G1', trackType: '芝', distance: 2200,
    trackCondition: '良', weather: '曇', status: '結果確定',
    entries: [
      { horseId: 'h003', jockeyId: 'j002', handicapWeight: 58, resultPosition: 1 },
      { horseId: 'h009', jockeyId: 'j001', handicapWeight: 58, resultPosition: 2 },
      { horseId: 'h008', jockeyId: 'j009', handicapWeight: 58, resultPosition: 3 },
      { horseId: 'h014', jockeyId: 'j005', handicapWeight: 58, resultPosition: 4 },
      { horseId: 'h023', jockeyId: 'j004', handicapWeight: 58, resultPosition: 6 },
    ],
  },
  {
    id: 'r_past_03', name: '帝王賞', daysFromNow: -240,
    racecourseId: 'ooi', racecourseName: '大井', raceNumber: 11,
    grade: 'G1', trackType: 'ダート', distance: 2000,
    trackCondition: '良', weather: '晴', status: '結果確定',
    entries: [
      { horseId: 'h018', jockeyId: 'j004', handicapWeight: 57, resultPosition: 1 },
      { horseId: 'h011', jockeyId: 'j007', handicapWeight: 57, resultPosition: 2 },
      { horseId: 'h029', jockeyId: 'j012', handicapWeight: 57, resultPosition: 4 },
    ],
  },
  {
    id: 'r_past_04', name: '天皇賞・秋', daysFromNow: -120,
    racecourseId: 'tokyo', racecourseName: '東京', raceNumber: 11,
    grade: 'G1', trackType: '芝', distance: 2000,
    trackCondition: '良', weather: '晴', status: '結果確定',
    entries: [
      { horseId: 'h009', jockeyId: 'j002', handicapWeight: 58, resultPosition: 1 },
      { horseId: 'h001', jockeyId: 'j001', handicapWeight: 58, resultPosition: 3 },
      { horseId: 'h006', jockeyId: 'j004', handicapWeight: 58, resultPosition: 4 },
      { horseId: 'h013', jockeyId: 'j003', handicapWeight: 58, resultPosition: 2 },
      { horseId: 'h019', jockeyId: 'j010', handicapWeight: 58, resultPosition: 7 },
    ],
  },
  {
    id: 'r_past_05', name: 'チャンピオンズカップ', daysFromNow: -85,
    racecourseId: 'chukyo', racecourseName: '中京', raceNumber: 11,
    grade: 'G1', trackType: 'ダート', distance: 1800,
    trackCondition: '稍重', weather: '曇', status: '結果確定',
    entries: [
      { horseId: 'h018', jockeyId: 'j004', handicapWeight: 57, resultPosition: 1 },
      { horseId: 'h004', jockeyId: 'j001', handicapWeight: 55, resultPosition: 2 },
      { horseId: 'h021', jockeyId: 'j003', handicapWeight: 57, resultPosition: 3 },
      { horseId: 'h027', jockeyId: 'j005', handicapWeight: 57, resultPosition: 6 },
    ],
  },
  {
    id: 'r_past_06', name: '有馬記念', daysFromNow: -60,
    racecourseId: 'nakayama', racecourseName: '中山', raceNumber: 11,
    grade: 'G1', trackType: '芝', distance: 2500,
    trackCondition: '良', weather: '晴', status: '結果確定',
    entries: [
      { horseId: 'h003', jockeyId: 'j002', handicapWeight: 57, resultPosition: 2 },
      { horseId: 'h008', jockeyId: 'j009', handicapWeight: 57, resultPosition: 1 },
      { horseId: 'h009', jockeyId: 'j001', handicapWeight: 57, resultPosition: 3 },
      { horseId: 'h014', jockeyId: 'j005', handicapWeight: 57, resultPosition: 5 },
      { horseId: 'h020', jockeyId: 'j006', handicapWeight: 57, resultPosition: 4 },
    ],
  },
  {
    id: 'r_past_07', name: '東京大賞典', daysFromNow: -55,
    racecourseId: 'ooi', racecourseName: '大井', raceNumber: 11,
    grade: 'G1', trackType: 'ダート', distance: 2000,
    trackCondition: '良', weather: '晴', status: '結果確定',
    entries: [
      { horseId: 'h018', jockeyId: 'j004', handicapWeight: 57, resultPosition: 2 },
      { horseId: 'h011', jockeyId: 'j007', handicapWeight: 57, resultPosition: 1 },
      { horseId: 'h029', jockeyId: 'j012', handicapWeight: 57, resultPosition: 3 },
      { horseId: 'h030', jockeyId: 'j008', handicapWeight: 57, resultPosition: 5 },
    ],
  },
  {
    id: 'r_past_08', name: 'AJCC', daysFromNow: -28,
    racecourseId: 'nakayama', racecourseName: '中山', raceNumber: 11,
    grade: 'G2', trackType: '芝', distance: 2200,
    trackCondition: '良', weather: '曇', status: '結果確定',
    entries: [
      { horseId: 'h005', jockeyId: 'j005', handicapWeight: 55, resultPosition: 1 },
      { horseId: 'h023', jockeyId: 'j004', handicapWeight: 56, resultPosition: 2 },
      { horseId: 'h020', jockeyId: 'j009', handicapWeight: 56, resultPosition: 3 },
      { horseId: 'h019', jockeyId: 'j010', handicapWeight: 56, resultPosition: 5 },
    ],
  },
];

// ── 未来レース (出走確定 or 予定) ─────────────────

const upcomingRaces: RaceTemplate[] = [
  {
    id: 'r2026_tokyo_01_11', name: 'フェブラリーステークス', daysFromNow: 0,
    racecourseId: 'tokyo', racecourseName: '東京', raceNumber: 11,
    grade: 'G1', trackType: 'ダート', distance: 1600, status: '出走確定',
    entries: [
      { horseId: 'h004', jockeyId: 'j001', handicapWeight: 57 },
      { horseId: 'h018', jockeyId: 'j004', handicapWeight: 57 },
      { horseId: 'h021', jockeyId: 'j003', handicapWeight: 57 },
      { horseId: 'h003', jockeyId: 'j002', handicapWeight: 57 },
      { horseId: 'h027', jockeyId: 'j005', handicapWeight: 57 },
      { horseId: 'h011', jockeyId: 'j007', handicapWeight: 57 },
      { horseId: 'h009', jockeyId: 'j006', handicapWeight: 57 },
      { horseId: 'h026', jockeyId: 'j010', handicapWeight: 55 },
    ],
  },
  {
    id: 'r2026_tokyo_01_01', name: '3歳未勝利', daysFromNow: 0,
    racecourseId: 'tokyo', racecourseName: '東京', raceNumber: 1,
    trackType: '芝', distance: 1600, status: '出走確定',
    entries: [
      { horseId: 'h024', jockeyId: 'j006', handicapWeight: 56 },
      { horseId: 'h015', jockeyId: 'j003', handicapWeight: 54 },
    ],
  },
  {
    id: 'r2026_tokyo_01_05', name: '4歳以上1勝クラス', daysFromNow: 0,
    racecourseId: 'tokyo', racecourseName: '東京', raceNumber: 5,
    trackType: 'ダート', distance: 1400, status: '出走確定',
    entries: [
      { horseId: 'h010', jockeyId: 'j006', handicapWeight: 54 },
      { horseId: 'h026', jockeyId: 'j010', handicapWeight: 56 },
    ],
  },
  {
    id: 'r2026_nakayama_01_11', name: '中山記念', daysFromNow: 0,
    racecourseId: 'nakayama', racecourseName: '中山', raceNumber: 11,
    grade: 'G2', trackType: '芝', distance: 1800, status: '出走確定',
    entries: [
      { horseId: 'h001', jockeyId: 'j001', handicapWeight: 56 },
      { horseId: 'h002', jockeyId: 'j003', handicapWeight: 54 },
      { horseId: 'h005', jockeyId: 'j005', handicapWeight: 54 },
      { horseId: 'h006', jockeyId: 'j004', handicapWeight: 56 },
      { horseId: 'h008', jockeyId: 'j009', handicapWeight: 57 },
      { horseId: 'h009', jockeyId: 'j002', handicapWeight: 56 },
      { horseId: 'h013', jockeyId: 'j006', handicapWeight: 56 },
      { horseId: 'h016', jockeyId: 'j010', handicapWeight: 54 },
    ],
  },
  {
    id: 'r2026_hanshin_01_11', name: '阪急杯', daysFromNow: 7,
    racecourseId: 'hanshin', racecourseName: '阪神', raceNumber: 11,
    grade: 'G3', trackType: '芝', distance: 1400, status: '予定',
    entries: [
      { horseId: 'h015', jockeyId: 'j003', handicapWeight: 53 },
      { horseId: 'h016', jockeyId: 'j002', handicapWeight: 54 },
      { horseId: 'h017', jockeyId: 'j010', handicapWeight: 57 },
      { horseId: 'h025', jockeyId: 'j005', handicapWeight: 56 },
    ],
  },
  {
    id: 'r2026_nakayama_02_11', name: '弥生賞', daysFromNow: 14,
    racecourseId: 'nakayama', racecourseName: '中山', raceNumber: 11,
    grade: 'G2', trackType: '芝', distance: 2000, status: '予定',
    entries: [
      { horseId: 'h007', jockeyId: 'j006', handicapWeight: 56 },
      { horseId: 'h024', jockeyId: 'j001', handicapWeight: 56 },
    ],
  },
  {
    id: 'r2026_hanshin_02_11', name: '大阪杯', daysFromNow: 42,
    racecourseId: 'hanshin', racecourseName: '阪神', raceNumber: 11,
    grade: 'G1', trackType: '芝', distance: 2000, status: '予定',
    entries: [
      { horseId: 'h009', jockeyId: 'j002', handicapWeight: 58 },
      { horseId: 'h001', jockeyId: 'j001', handicapWeight: 58 },
      { horseId: 'h014', jockeyId: 'j005', handicapWeight: 58 },
      { horseId: 'h006', jockeyId: 'j004', handicapWeight: 58 },
      { horseId: 'h023', jockeyId: 'j003', handicapWeight: 58 },
    ],
  },
  {
    id: 'r2026_ooi_01_11', name: '東京シティ盃', daysFromNow: 3,
    racecourseId: 'ooi', racecourseName: '大井', raceNumber: 11,
    trackType: 'ダート', distance: 1200, status: '出走確定',
    entries: [
      { horseId: 'h011', jockeyId: 'j007', handicapWeight: 56 },
      { horseId: 'h012', jockeyId: 'j008', handicapWeight: 54 },
      { horseId: 'h022', jockeyId: 'j011', handicapWeight: 56 },
      { horseId: 'h030', jockeyId: 'j012', handicapWeight: 56 },
    ],
  },
  {
    id: 'r2026_kawasaki_01_11', name: '川崎記念', daysFromNow: 10,
    racecourseId: 'kawasaki', racecourseName: '川崎', raceNumber: 11,
    grade: 'G1', trackType: 'ダート', distance: 2100, status: '予定',
    entries: [
      { horseId: 'h018', jockeyId: 'j004', handicapWeight: 57 },
      { horseId: 'h011', jockeyId: 'j007', handicapWeight: 57 },
      { horseId: 'h029', jockeyId: 'j012', handicapWeight: 57 },
    ],
  },
];

export const ALL_RACES: RaceTemplate[] = [...pastRaces, ...upcomingRaces];
