// 競馬場
export interface Racecourse {
  id: string;
  name: string;
  region: '中央' | '地方';
  prefecture: string;
  trackTypes: TrackType[];
}

// 馬場種別
export type TrackType = '芝' | 'ダート' | '障害';

// 馬場状態
export type TrackCondition = '良' | '稍重' | '重' | '不良';

// 天候
export type Weather = '晴' | '曇' | '小雨' | '雨' | '小雪' | '雪';

// 馬
export interface Horse {
  id: string;
  name: string;
  nameEn?: string;
  age: number;
  sex: '牡' | '牝' | 'セ';
  color: string;
  birthDate: string;
  fatherId?: string;
  fatherName: string;
  motherId?: string;
  motherName: string;
  trainerName: string;
  ownerName: string;
  totalRaces: number;
  wins: number;
  seconds: number;
  thirds: number;
  totalEarnings: number;
  recentForm: string; // 直近5走の着順 e.g. "1-3-2-5-1"
  condition: HorseCondition;
  weaknesses: string[];
  strengths: string[];
}

// 馬のコンディション
export interface HorseCondition {
  overall: '絶好調' | '好調' | '普通' | '不調' | '絶不調';
  weight: number;
  weightChange: number;
  lastTrainingDate?: string;
  trainingComment?: string;
}

// 騎手
export interface Jockey {
  id: string;
  name: string;
  nameEn?: string;
  age: number;
  region: '中央' | '地方';
  belongsTo: string;
  totalRaces: number;
  wins: number;
  winRate: number;
  placeRate: number;
  showRate: number;
  totalEarnings: number;
  recentForm: JockeyRecentForm;
}

// 騎手の直近成績
export interface JockeyRecentForm {
  last30Days: { races: number; wins: number; seconds: number; thirds: number };
  thisYear: { races: number; wins: number; seconds: number; thirds: number };
  lastYear: { races: number; wins: number; seconds: number; thirds: number };
}

// レース
export interface Race {
  id: string;
  name: string;
  date: string;
  time?: string;
  racecourseId: string;
  racecourseName: string;
  raceNumber: number;
  grade?: 'G1' | 'G2' | 'G3' | 'リステッド' | 'オープン' | '3勝クラス' | '2勝クラス' | '1勝クラス' | '未勝利' | '新馬';
  trackType: TrackType;
  distance: number;
  trackCondition?: TrackCondition;
  weather?: Weather;
  entries: RaceEntry[];
  status: '予定' | '出走確定' | '結果確定' | '中止';
}

// 出走馬
export interface RaceEntry {
  postPosition: number; // 枠番
  horseNumber: number; // 馬番
  horseId: string;
  horseName: string;
  age: number;
  sex: '牡' | '牝' | 'セ';
  weight?: number;
  jockeyId: string;
  jockeyName: string;
  trainerName: string;
  handicapWeight: number; // 斤量
  odds?: number;
  popularity?: number;
  result?: RaceResult;
}

// レース結果
export interface RaceResult {
  position: number;
  time?: string;
  margin?: string; // 着差
  lastThreeFurlongs?: string; // 上がり3ハロン
  cornerPositions?: string; // 通過順
  weight?: number;
  weightChange?: number;
}

// オッズ
export interface Odds {
  raceId: string;
  updatedAt: string;
  win: { horseNumber: number; odds: number }[]; // 単勝
  place: { horseNumber: number; minOdds: number; maxOdds: number }[]; // 複勝
  exacta?: { first: number; second: number; odds: number }[]; // 馬単
  quinella?: { horse1: number; horse2: number; odds: number }[]; // 馬連
  wide?: { horse1: number; horse2: number; minOdds: number; maxOdds: number }[]; // ワイド
  trio?: { horse1: number; horse2: number; horse3: number; odds: number }[]; // 三連複
  trifecta?: { first: number; second: number; third: number; odds: number }[]; // 三連単
}

// AI予想
export interface Prediction {
  raceId: string;
  raceName: string;
  date: string;
  generatedAt: string;
  confidence: number; // 0-100
  summary: string;
  topPicks: PredictionPick[];
  analysis: RaceAnalysis;
  recommendedBets: RecommendedBet[];
}

export interface PredictionPick {
  rank: number;
  horseId?: string;
  horseNumber: number;
  horseName: string;
  score: number;
  reasons: string[];
  runningStyle?: string;
  escapeRate?: number;  // 逃げ率 (0-100)
}

export interface MarketAnalysisEntry {
  modelProb: number;
  marketProb: number;
  blendedProb: number;
  disagreement: number;
  isValue: boolean;
}

export interface RaceAnalysis {
  trackBias: string;
  paceAnalysis: string;
  keyFactors: string[];
  riskFactors: string[];
  bettingStrategy?: BettingStrategy;
  marketAnalysis?: Record<number, MarketAnalysisEntry>;
  valueHorses?: number[];
  overround?: number;
  winProbabilities?: Record<number, number>;
}

export type RacePattern = '一強' | '二強' | '三つ巴' | '混戦' | '大混戦';

export interface BettingStrategy {
  pattern: RacePattern;
  patternLabel: string;        // 例: "◎が抜けた一強レース"
  recommendation: string;      // メイン戦略テキスト
  riskLevel: 'low' | 'medium' | 'high';
  primaryBets: string[];       // 推奨券種（優先順）
  avoidBets: string[];         // 非推奨券種
  budgetAdvice: string;        // 資金配分アドバイス
}

export interface RecommendedBet {
  type: '単勝' | '複勝' | '馬連' | 'ワイド' | '馬単' | '三連複' | '三連単';
  selections: number[];
  reasoning: string;
  expectedValue: number;
  odds?: number;
  kellyFraction?: number;    // Kelly Criterion: 最適賭け率 (0-1)
  valueEdge?: number;        // バリューエッジ: (prob × odds) - 1
  recommendedStake?: number; // 推奨賭け率 (fractional Kelly f*/4, 0-0.25)
}

// 過去成績
export interface PastPerformance {
  raceId: string;
  date: string;
  raceName: string;
  racecourseName: string;
  trackType: TrackType;
  distance: number;
  trackCondition: TrackCondition;
  weather: Weather;
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

// 競馬場一覧
export const RACECOURSES: Racecourse[] = [
  // 中央競馬
  { id: 'tokyo', name: '東京', region: '中央', prefecture: '東京都', trackTypes: ['芝', 'ダート', '障害'] },
  { id: 'nakayama', name: '中山', region: '中央', prefecture: '千葉県', trackTypes: ['芝', 'ダート', '障害'] },
  { id: 'hanshin', name: '阪神', region: '中央', prefecture: '兵庫県', trackTypes: ['芝', 'ダート', '障害'] },
  { id: 'kyoto', name: '京都', region: '中央', prefecture: '京都府', trackTypes: ['芝', 'ダート', '障害'] },
  { id: 'chukyo', name: '中京', region: '中央', prefecture: '愛知県', trackTypes: ['芝', 'ダート', '障害'] },
  { id: 'kokura', name: '小倉', region: '中央', prefecture: '福岡県', trackTypes: ['芝', 'ダート', '障害'] },
  { id: 'niigata', name: '新潟', region: '中央', prefecture: '新潟県', trackTypes: ['芝', 'ダート', '障害'] },
  { id: 'sapporo', name: '札幌', region: '中央', prefecture: '北海道', trackTypes: ['芝', 'ダート', '障害'] },
  { id: 'hakodate', name: '函館', region: '中央', prefecture: '北海道', trackTypes: ['芝', 'ダート', '障害'] },
  { id: 'fukushima', name: '福島', region: '中央', prefecture: '福島県', trackTypes: ['芝', 'ダート', '障害'] },
  // 地方競馬
  { id: 'ooi', name: '大井', region: '地方', prefecture: '東京都', trackTypes: ['ダート'] },
  { id: 'kawasaki', name: '川崎', region: '地方', prefecture: '神奈川県', trackTypes: ['ダート'] },
  { id: 'funabashi', name: '船橋', region: '地方', prefecture: '千葉県', trackTypes: ['ダート'] },
  { id: 'urawa', name: '浦和', region: '地方', prefecture: '埼玉県', trackTypes: ['ダート'] },
  { id: 'monbetsu', name: '門別', region: '地方', prefecture: '北海道', trackTypes: ['ダート'] },
  { id: 'morioka', name: '盛岡', region: '地方', prefecture: '岩手県', trackTypes: ['芝', 'ダート'] },
  { id: 'mizusawa', name: '水沢', region: '地方', prefecture: '岩手県', trackTypes: ['ダート'] },
  { id: 'kanazawa', name: '金沢', region: '地方', prefecture: '石川県', trackTypes: ['ダート'] },
  { id: 'kasamatsu', name: '笠松', region: '地方', prefecture: '岐阜県', trackTypes: ['ダート'] },
  { id: 'nagoya', name: '名古屋', region: '地方', prefecture: '愛知県', trackTypes: ['ダート'] },
  { id: 'sonoda', name: '園田', region: '地方', prefecture: '兵庫県', trackTypes: ['ダート'] },
  { id: 'himeji', name: '姫路', region: '地方', prefecture: '兵庫県', trackTypes: ['ダート'] },
  { id: 'kochi', name: '高知', region: '地方', prefecture: '高知県', trackTypes: ['ダート'] },
  { id: 'saga', name: '佐賀', region: '地方', prefecture: '佐賀県', trackTypes: ['ダート'] },
  // フォールバック（不明な競馬場コード用）
  { id: 'unknown', name: '不明', region: '地方', prefecture: '不明', trackTypes: ['芝', 'ダート'] },
];
