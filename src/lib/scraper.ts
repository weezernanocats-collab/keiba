/**
 * 競馬データスクレイピングモジュール
 *
 * netkeiba.com からレース情報、出馬表、オッズ、結果を取得する。
 * 注意: スクレイピングは利用規約を確認の上、適切な間隔をあけて実行すること。
 */
import * as cheerio from 'cheerio';

const BASE_URL = 'https://race.netkeiba.com';
const DB_BASE_URL = 'https://db.netkeiba.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 1500;
const FETCH_TIMEOUT_MS = 10000;

async function fetchHtml(url: string): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja,en;q=0.9',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      // 4xx errors: 400/429 are retryable (netkeiba returns 400 for rate limiting)
      if (!response.ok) {
        if (response.status === 400 || response.status === 429 || response.status >= 500) {
          throw new Error(`HTTP ${response.status}: ${url}`);
        }
        throw new PermanentError(`HTTP ${response.status}: ${url}`);
      }

      const buffer = await response.arrayBuffer();
      // race_list_sub.html はUTF-8、その他のnetkeiba ページは EUC-JP
      const encoding = detectEncoding(url, buffer);
      const decoder = new TextDecoder(encoding);
      return decoder.decode(buffer);
    } catch (error) {
      if (error instanceof PermanentError) throw error;

      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error(`Failed after ${MAX_RETRIES} retries: ${url}`);
}

/** URLとHTMLの先頭バイトからエンコーディングを判定 */
function detectEncoding(url: string, buffer: ArrayBuffer): string {
  // race_list_sub.html は UTF-8
  if (url.includes('race_list_sub.html')) return 'utf-8';

  // HTMLの先頭部分で charset を確認
  const preview = new TextDecoder('ascii').decode(buffer.slice(0, 1024));
  if (preview.includes('charset="UTF-8"') || preview.includes('charset=utf-8')) {
    return 'utf-8';
  }

  // デフォルトはEUC-JP (netkeiba の多くのページ)
  return 'euc-jp';
}

class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

// レース一覧を取得（日付指定）
export async function scrapeRaceList(date: string): Promise<ScrapedRace[]> {
  const dateStr = date.replace(/-/g, '');
  // netkeiba はレース一覧を race_list_sub.html で提供（メインページはAJAX動的読み込み）
  const url = `${BASE_URL}/top/race_list_sub.html?kaisai_date=${dateStr}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const races: ScrapedRace[] = [];

  // race_list_sub.html は <li><a href="...?race_id=XXXX">1R レース名 時刻 距離 頭数</a></li> 形式
  $('li a[href*="race_id="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    // 動画リンク (race/movie.html) は除外
    if (href.includes('movie.html')) return;

    const raceIdMatch = href.match(/race_id=(\d+)/);
    if (!raceIdMatch) return;

    const raceId = raceIdMatch[1];
    const raceText = $(a).text().trim();
    const raceNumMatch = raceText.match(/(\d+)R/);

    // レース名: "1R 2歳未勝利 09:50 ダ1200m 16頭" からレース名部分を抽出
    const namePart = raceText
      .replace(/\d+R\s*/, '')      // レース番号除去
      .replace(/\d{2}:\d{2}/, '')  // 時刻除去
      .replace(/[芝ダ障]\d+m/, '') // 距離除去
      .replace(/\d+頭/, '')        // 頭数除去
      .trim();

    // 競馬場名はraceIdから推定
    const racecourseId = inferRacecourseId(raceId);
    const racecourseName = inferRacecourseName(racecourseId);

    races.push({
      id: raceId,
      raceNumber: raceNumMatch ? parseInt(raceNumMatch[1]) : 0,
      name: namePart || `${raceNumMatch?.[1] || ''}R`,
      racecourseName,
      date,
    });
  });

  return races;
}

// 出馬表を取得
export async function scrapeRaceCard(raceId: string): Promise<ScrapedRaceDetail> {
  const url = `${BASE_URL}/race/shutuba.html?race_id=${raceId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // レース情報
  const raceInfo = $('div.RaceData01').text().trim();
  const raceName = $('h1.RaceName').text().trim();
  const distMatch = raceInfo.match(/(芝|ダート|障害)(\d+)m/);
  const condMatch = raceInfo.match(/(良|稍重|重|不良)/);
  const weatherMatch = raceInfo.match(/(晴|曇|小雨|雨|小雪|雪)/);
  const timeMatch = raceInfo.match(/(\d{1,2}:\d{2})/);

  const gradeText = $('span.RaceGrade, span.Icon_GradeType').text().trim();
  let grade: string | undefined;
  if (gradeText.includes('G1') || gradeText.includes('Ｇ１')) grade = 'G1';
  else if (gradeText.includes('G2') || gradeText.includes('Ｇ２')) grade = 'G2';
  else if (gradeText.includes('G3') || gradeText.includes('Ｇ３')) grade = 'G3';

  // 出走馬
  const entries: ScrapedEntry[] = [];
  $('table.Shutuba_Table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 8) return;

    const postPosition = parseInt($(tds[0]).text().trim()) || 0;
    const horseNumber = parseInt($(tds[1]).text().trim()) || 0;
    const horseName = $(tds[3]).find('a').text().trim();
    const horseLink = $(tds[3]).find('a').attr('href') || '';
    const horseIdMatch = horseLink.match(/horse\/(\w+)/);
    const ageSex = $(tds[4]).text().trim();
    const handicapWeight = parseFloat($(tds[5]).text().trim()) || 0;
    const jockeyName = $(tds[6]).find('a').text().trim();
    const jockeyLink = $(tds[6]).find('a').attr('href') || '';
    const jockeyIdMatch = jockeyLink.match(/jockey\/(?:result\/recent\/)?(\w+)/);
    const trainerName = $(tds[7]).find('a').text().trim();

    if (horseName) {
      entries.push({
        postPosition,
        horseNumber,
        horseId: horseIdMatch ? horseIdMatch[1] : `h_${horseNumber}`,
        horseName,
        age: parseInt(ageSex.replace(/[^\d]/g, '')) || 0,
        sex: (ageSex.match(/(牡|牝|セ)/)?.[1] || '牡') as '牡' | '牝' | 'セ',
        jockeyId: jockeyIdMatch ? jockeyIdMatch[1] : `j_${jockeyName}`,
        jockeyName,
        trainerName,
        handicapWeight,
      });
    }
  });

  // 競馬場ID推定
  const racecourseId = inferRacecourseId(raceId);

  return {
    id: raceId,
    name: raceName,
    racecourseName: inferRacecourseName(racecourseId),
    racecourseId,
    trackType: (distMatch?.[1] || 'ダート') as '芝' | 'ダート' | '障害',
    distance: parseInt(distMatch?.[2] || '0'),
    trackCondition: condMatch?.[1] as '良' | '稍重' | '重' | '不良' | undefined,
    weather: weatherMatch?.[1] as '晴' | '曇' | '小雨' | '雨' | '小雪' | '雪' | undefined,
    time: timeMatch?.[1],
    grade,
    entries,
  };
}

// オッズ取得（単勝・複勝）- JSON APIを使用
export async function scrapeOdds(raceId: string): Promise<ScrapedOdds> {
  const win: { horseNumber: number; odds: number }[] = [];
  const place: { horseNumber: number; minOdds: number; maxOdds: number }[] = [];

  // netkeiba JSON API: type=1 で単勝・複勝を取得
  const apiUrl = `${BASE_URL}/api/api_get_jra_odds.html?race_id=${raceId}&type=1`;
  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return { raceId, win, place };
  }

  const data = await response.json() as {
    status: string;
    data?: {
      odds?: {
        '1'?: Record<string, [string, string, string]>; // 単勝: [odds, "", popularity]
        '2'?: Record<string, [string, string, string]>; // 複勝: [minOdds, maxOdds, popularity]
      };
    };
  };

  if (data.status !== 'result' || !data.data?.odds) {
    return { raceId, win, place };
  }

  // 単勝 (type "1")
  const winOdds = data.data.odds['1'];
  if (winOdds) {
    for (const [numStr, values] of Object.entries(winOdds)) {
      const horseNumber = parseInt(numStr);
      const odds = parseFloat(values[0]);
      if (horseNumber > 0 && odds > 0) {
        win.push({ horseNumber, odds });
      }
    }
  }

  // 複勝 (type "2")
  const placeOdds = data.data.odds['2'];
  if (placeOdds) {
    for (const [numStr, values] of Object.entries(placeOdds)) {
      const horseNumber = parseInt(numStr);
      const minOdds = parseFloat(values[0]);
      const maxOdds = parseFloat(values[1]);
      if (horseNumber > 0 && minOdds > 0) {
        place.push({ horseNumber, minOdds, maxOdds });
      }
    }
  }

  return { raceId, win, place };
}

// レース結果取得
export async function scrapeRaceResult(raceId: string): Promise<ScrapedResult[]> {
  const url = `${BASE_URL}/race/result.html?race_id=${raceId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const results: ScrapedResult[] = [];

  $('table.RaceTable01 tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 12) return;

    const position = parseInt($(tds[0]).text().trim()) || 0;
    const horseNumber = parseInt($(tds[2]).text().trim()) || 0;
    const horseName = $(tds[3]).find('a').text().trim();
    const time = $(tds[7]).text().trim();
    const margin = $(tds[8]).text().trim();
    const lastThreeFurlongs = $(tds[11]).text().trim();
    const cornerPositions = $(tds[10]).text().trim();

    if (position > 0) {
      results.push({
        position,
        horseNumber,
        horseName,
        time,
        margin,
        lastThreeFurlongs,
        cornerPositions,
      });
    }
  });

  return results;
}

// 馬の詳細情報取得
export async function scrapeHorseDetail(horseId: string): Promise<ScrapedHorseDetail | null> {
  // プロフィールページ
  const profileUrl = `${DB_BASE_URL}/horse/${horseId}`;
  const profileHtml = await fetchHtml(profileUrl);
  const $ = cheerio.load(profileHtml);

  // 馬名: <div class="horse_title"><h1>馬名</h1></div>
  const name = $('.horse_title h1').text().trim().split('\n')[0]
    || $('h1').first().text().trim().split('\n')[0];
  if (!name) return null;

  const profileTable = $('table.db_prof_table');
  const birthDate = profileTable.find('tr').eq(0).find('td').text().trim();
  const trainerName = profileTable.find('tr').eq(4).find('td a').text().trim();
  const ownerName = profileTable.find('tr').eq(5).find('td a').text().trim();
  const fatherName = $('a[href*="/horse/ped/"]').eq(0).text().trim();
  const motherName = $('a[href*="/horse/ped/"]').eq(1).text().trim();

  // 過去成績: /horse/result/{id} から取得（メインページはAJAX読み込みのため）
  const pastPerformances: ScrapedPastPerformance[] = [];
  try {
    const resultUrl = `${DB_BASE_URL}/horse/result/${horseId}`;
    const resultHtml = await fetchHtml(resultUrl);
    const $r = cheerio.load(resultHtml);

    $r('table.db_h_race_results tbody tr').each((_, tr) => {
      const tds = $r(tr).find('td');
      if (tds.length < 20) return;

      const date = $r(tds[0]).find('a').text().trim();
      const racecourseName = $r(tds[1]).text().trim();
      const raceName = $r(tds[4]).find('a').text().trim();
      const entries = parseInt($r(tds[7]).text().trim()) || 0;
      const postPosition = parseInt($r(tds[8]).text().trim()) || 0;
      const horseNumber = parseInt($r(tds[9]).text().trim()) || 0;
      const odds = parseFloat($r(tds[10]).text().trim()) || 0;
      const popularity = parseInt($r(tds[11]).text().trim()) || 0;
      const position = parseInt($r(tds[12]).text().trim()) || 99;
      const jockeyName = $r(tds[13]).find('a').text().trim();
      const handicapWeight = parseFloat($r(tds[14]).text().trim()) || 0;
      const distText = $r(tds[15]).text().trim();
      const trackMatch = distText.match(/(芝|ダート|障)(\d+)/);
      const condText = $r(tds[16]).text().trim();
      const time = $r(tds[17]).text().trim();
      const margin = $r(tds[18]).text().trim();
      const lastThreeFurlongs = $r(tds[22]).text().trim();
      const cornerPositions = $r(tds[21]).text().trim();
      const weightText = $r(tds[23]).text().trim();
      const weightMatch = weightText.match(/(\d+)\(([+-]?\d+)\)/);

      if (date) {
        pastPerformances.push({
          date: date.replace(/\//g, '-'),
          racecourseName,
          raceName,
          trackType: (trackMatch?.[1] === '障' ? '障害' : trackMatch?.[1] || 'ダート') as '芝' | 'ダート' | '障害',
          distance: parseInt(trackMatch?.[2] || '0'),
          trackCondition: (condText || '良') as '良' | '稍重' | '重' | '不良',
          entries,
          postPosition,
          horseNumber,
          position,
          jockeyName,
          handicapWeight,
          weight: weightMatch ? parseInt(weightMatch[1]) : 0,
          weightChange: weightMatch ? parseInt(weightMatch[2]) : 0,
          time,
          margin,
          lastThreeFurlongs,
          cornerPositions,
          odds,
          popularity,
        });
      }
    });
  } catch {
    // 過去成績取得失敗はスキップ（プロフィールだけでも保存する）
  }

  return {
    id: horseId,
    name,
    birthDate,
    fatherName,
    motherName,
    trainerName,
    ownerName,
    pastPerformances,
  };
}

// ==================== ヘルパー ====================

function inferRacecourseId(raceId: string): string {
  // netkeiba IDの3-4桁目が競馬場コード
  const codeMap: Record<string, string> = {
    '01': 'sapporo', '02': 'hakodate', '03': 'fukushima', '04': 'niigata',
    '05': 'tokyo', '06': 'nakayama', '07': 'chukyo', '08': 'kyoto',
    '09': 'hanshin', '10': 'kokura',
    '30': 'monbetsu', '35': 'morioka', '36': 'mizusawa',
    '42': 'urawa', '43': 'funabashi', '44': 'ooi', '45': 'kawasaki',
    '46': 'kanazawa', '48': 'kasamatsu', '50': 'nagoya',
    '51': 'sonoda', '54': 'kochi', '55': 'saga',
  };
  const code = raceId.substring(4, 6);
  return codeMap[code] || 'unknown';
}

function inferRacecourseName(racecourseId: string): string {
  const nameMap: Record<string, string> = {
    sapporo: '札幌', hakodate: '函館', fukushima: '福島', niigata: '新潟',
    tokyo: '東京', nakayama: '中山', chukyo: '中京', kyoto: '京都',
    hanshin: '阪神', kokura: '小倉',
    monbetsu: '門別', morioka: '盛岡', mizusawa: '水沢',
    urawa: '浦和', funabashi: '船橋', ooi: '大井', kawasaki: '川崎',
    kanazawa: '金沢', kasamatsu: '笠松', nagoya: '名古屋',
    sonoda: '園田', kochi: '高知', saga: '佐賀',
  };
  return nameMap[racecourseId] || '不明';
}

// ==================== 型定義 ====================

export interface ScrapedRace {
  id: string;
  raceNumber: number;
  name: string;
  racecourseName: string;
  date: string;
}

export interface ScrapedRaceDetail {
  id: string;
  name: string;
  racecourseName: string;
  racecourseId: string;
  trackType: '芝' | 'ダート' | '障害';
  distance: number;
  trackCondition?: '良' | '稍重' | '重' | '不良';
  weather?: '晴' | '曇' | '小雨' | '雨' | '小雪' | '雪';
  time?: string;
  grade?: string;
  entries: ScrapedEntry[];
}

export interface ScrapedEntry {
  postPosition: number;
  horseNumber: number;
  horseId: string;
  horseName: string;
  age: number;
  sex: '牡' | '牝' | 'セ';
  jockeyId: string;
  jockeyName: string;
  trainerName: string;
  handicapWeight: number;
}

export interface ScrapedOdds {
  raceId: string;
  win: { horseNumber: number; odds: number }[];
  place: { horseNumber: number; minOdds: number; maxOdds: number }[];
}

export interface ScrapedResult {
  position: number;
  horseNumber: number;
  horseName: string;
  time: string;
  margin: string;
  lastThreeFurlongs: string;
  cornerPositions: string;
}

export interface ScrapedHorseDetail {
  id: string;
  name: string;
  birthDate: string;
  fatherName: string;
  motherName: string;
  trainerName: string;
  ownerName: string;
  pastPerformances: ScrapedPastPerformance[];
}

export interface ScrapedPastPerformance {
  date: string;
  racecourseName: string;
  raceName: string;
  trackType: '芝' | 'ダート' | '障害';
  distance: number;
  trackCondition: '良' | '稍重' | '重' | '不良';
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
}
