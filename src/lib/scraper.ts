/**
 * 競馬データスクレイピングモジュール
 *
 * netkeiba.com からレース情報、出馬表、オッズ、結果を取得する。
 * 注意: スクレイピングは利用規約を確認の上、適切な間隔をあけて実行すること。
 */
import * as cheerio from 'cheerio';
import * as iconv from 'iconv-lite';

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
      const encoding = detectEncoding(url, buffer);
      // iconv-lite で確実にデコード（Vercel環境の TextDecoder は EUC-JP 非対応）
      const nodeBuffer = Buffer.from(buffer);
      return iconv.decode(nodeBuffer, encoding);
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
  // race_list_sub.html は明示的にUTF-8
  if (url.includes('race_list_sub.html')) return 'utf-8';

  // HTMLの先頭部分で charset を確認（ASCII互換バイトのみ読む、大文字小文字区別なし）
  const preview = Buffer.from(buffer.slice(0, 2048)).toString('ascii').toLowerCase();
  if (preview.includes('charset=utf-8') || preview.includes('charset="utf-8"')) {
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
  // netkeiba uses abbreviated forms: ダ for ダート, 障 for 障害, 稍 for 稍重
  const distMatch = raceInfo.match(/(芝|ダート|ダ|障害|障)(\d+)m/);
  const condMatch = raceInfo.match(/(良|稍重|稍|重|不良|不)/);
  // Normalize abbreviated track condition
  const normalizedCond = condMatch?.[1] === '稍' ? '稍重' : condMatch?.[1] === '不' ? '不良' : condMatch?.[1];
  const weatherMatch = raceInfo.match(/(晴|曇|小雨|雨|小雪|雪)/);
  const timeMatch = raceInfo.match(/(\d{1,2}:\d{2})/);

  // Grade detection: netkeiba uses CSS classes (Icon_GradeType1=G1, etc.) or text
  // Icon_GradeType の番号体系:
  //   1=G1, 2=G2, 3=G3, 5=リステッド, 10=オープン,
  //   15=3勝クラス, 16=2勝クラス, 17=1勝クラス, 18=未勝利, 19=新馬
  const gradeText = $('span.RaceGrade, span.Icon_GradeType').text().trim();
  const gradeClassList = $('span.Icon_GradeType').map((_, el) => $(el).attr('class') || '').get();
  // 個別クラスに分割して正確にマッチ（Icon_GradeType1 が Icon_GradeType10 等にマッチしないよう）
  const allClasses = gradeClassList.flatMap(c => c.split(/\s+/));
  const hasGradeClass = (suffix: string) => allClasses.includes(`Icon_GradeType${suffix}`);
  let grade: string | undefined;
  if (gradeText.includes('G1') || gradeText.includes('Ｇ１') || hasGradeClass('1')) grade = 'G1';
  else if (gradeText.includes('G2') || gradeText.includes('Ｇ２') || hasGradeClass('2')) grade = 'G2';
  else if (gradeText.includes('G3') || gradeText.includes('Ｇ３') || hasGradeClass('3')) grade = 'G3';
  else if (hasGradeClass('5')) grade = 'リステッド';
  else if (hasGradeClass('10')) grade = 'オープン';
  else if (hasGradeClass('15')) grade = '3勝クラス';
  else if (hasGradeClass('16')) grade = '2勝クラス';
  else if (hasGradeClass('17')) grade = '1勝クラス';
  else if (hasGradeClass('18')) grade = '未勝利';
  else if (hasGradeClass('19')) grade = '新馬';

  // RaceData02 からクラス情報を補完（CSS クラスで検出できなかった場合）
  if (!grade) {
    const raceData02 = $('div.RaceData02, span.RaceData02').text().trim();
    const raceTitleFull = raceName + ' ' + raceData02;
    if (raceTitleFull.includes('新馬')) grade = '新馬';
    else if (raceTitleFull.includes('未勝利')) grade = '未勝利';
    else if (raceTitleFull.includes('1勝クラス')) grade = '1勝クラス';
    else if (raceTitleFull.includes('2勝クラス')) grade = '2勝クラス';
    else if (raceTitleFull.includes('3勝クラス')) grade = '3勝クラス';
    else if (raceTitleFull.includes('オープン')) grade = 'オープン';
  }

  // G1/G2/G3でない場合、RaceData02 span[4] からクラス情報を取得
  // 例: 「オープン」「３勝クラス」「２勝クラス」「１勝クラス」「未勝利」「新馬」
  if (!grade) {
    const raceData02Spans = $('div.RaceData02 span');
    let classText = '';
    raceData02Spans.each((i, el) => {
      if (i === 4) classText = $(el).text().trim();
    });
    const normalized = classText.replace(/３/g, '3').replace(/２/g, '2').replace(/１/g, '1');
    if (normalized.includes('3勝クラス')) grade = '3勝クラス';
    else if (normalized.includes('2勝クラス')) grade = '2勝クラス';
    else if (normalized.includes('1勝クラス')) grade = '1勝クラス';
    else if (normalized.includes('オープン')) grade = 'オープン';
    else if (normalized.includes('リステッド') || normalized.includes('Listed')) grade = 'リステッド';
    else if (normalized.includes('新馬')) grade = '新馬';
    else if (normalized.includes('未勝利')) grade = '未勝利';
  }

  // フォールバック: レース名からクラスを推定
  if (!grade) {
    if (raceName.includes('新馬')) grade = '新馬';
    else if (raceName.includes('未勝利')) grade = '未勝利';
    else if (raceName.includes('1勝クラス') || raceName.includes('1勝')) grade = '1勝クラス';
    else if (raceName.includes('2勝クラス') || raceName.includes('2勝')) grade = '2勝クラス';
    else if (raceName.includes('3勝クラス') || raceName.includes('3勝')) grade = '3勝クラス';
    else if (raceName.includes('オープン')) grade = 'オープン';
  }

  // 出走馬
  // netkeiba の出馬表テーブルは各馬行に class="HorseList" を付与。
  // 列は td のクラス名で特定（インデックスに依存しない）:
  //   Waku* Txt_C → 枠番, Umaban* Txt_C → 馬番, HorseInfo → 馬名,
  //   Barei → 性齢, Jockey → 騎手, Trainer → 調教師
  //   斤量は Barei の次の Txt_C (class に Waku/Umaban/Popular を含まないもの)
  const entries: ScrapedEntry[] = [];
  $('table.Shutuba_Table tr.HorseList').each((_, tr) => {
    const $tr = $(tr);

    // 枠番: td[class*="Waku"] (Waku1, Waku2, ... Waku8)
    const postPosition = parseInt($tr.find('td[class*="Waku"]').first().text().trim()) || 0;

    // 馬番: td[class*="Umaban"] (Umaban1, Umaban2, ...)
    const horseNumber = parseInt($tr.find('td[class*="Umaban"]').first().text().trim()) || 0;

    // 馬名: td.HorseInfo 内の a タグ
    const horseInfoTd = $tr.find('td.HorseInfo');
    const horseName = horseInfoTd.find('a').first().text().trim();
    const horseLink = horseInfoTd.find('a').first().attr('href') || '';
    const horseIdMatch = horseLink.match(/horse\/(\w+)/);

    // 性齢: td.Barei
    const ageSex = $tr.find('td.Barei').text().trim();

    // 斤量: Barei でも Waku でも Umaban でも Popular でもない Txt_C
    let handicapWeight = 0;
    $tr.find('td.Txt_C').each((_, td) => {
      const cls = $(td).attr('class') || '';
      if (cls.includes('Waku') || cls.includes('Umaban') || cls.includes('Popular')) return;
      const val = parseFloat($(td).text().trim());
      if (val > 0 && handicapWeight === 0) handicapWeight = val;
    });

    // 騎手: td.Jockey 内の a タグ
    const jockeyTd = $tr.find('td.Jockey');
    const jockeyName = jockeyTd.find('a').first().text().trim();
    const jockeyLink = jockeyTd.find('a').first().attr('href') || '';
    const jockeyIdMatch = jockeyLink.match(/jockey\/(?:result\/recent\/)?(\w+)/);

    // 調教師: td.Trainer 内の a タグ
    const trainerName = $tr.find('td.Trainer').find('a').first().text().trim();

    // フォールバック: クラスベースで取得できなかった場合はインデックスベースで試行
    if (!horseName) {
      const tds = $tr.find('td');
      if (tds.length >= 8) {
        const fbHorseName = $(tds[3]).find('a').text().trim();
        if (fbHorseName) {
          const fbHorseLink = $(tds[3]).find('a').attr('href') || '';
          const fbHorseIdMatch = fbHorseLink.match(/horse\/(\w+)/);
          const fbAgeSex = $(tds[4]).text().trim();
          const fbHandicapWeight = parseFloat($(tds[5]).text().trim()) || 0;
          const fbJockeyName = $(tds[6]).find('a').text().trim();
          const fbJockeyLink = $(tds[6]).find('a').attr('href') || '';
          const fbJockeyIdMatch = fbJockeyLink.match(/jockey\/(?:result\/recent\/)?(\w+)/);
          const fbTrainerName = $(tds[7]).find('a').text().trim();
          entries.push({
            postPosition: parseInt($(tds[0]).text().trim()) || 0,
            horseNumber: parseInt($(tds[1]).text().trim()) || 0,
            horseId: fbHorseIdMatch ? fbHorseIdMatch[1] : `h_${parseInt($(tds[1]).text().trim()) || 0}`,
            horseName: fbHorseName,
            age: parseInt(fbAgeSex.replace(/[^\d]/g, '')) || 0,
            sex: (fbAgeSex.match(/(牡|牝|セ)/)?.[1] || '牡') as '牡' | '牝' | 'セ',
            jockeyId: fbJockeyIdMatch ? fbJockeyIdMatch[1] : `j_${fbJockeyName}`,
            jockeyName: fbJockeyName,
            trainerName: fbTrainerName,
            handicapWeight: fbHandicapWeight,
          });
          return; // next tr
        }
      }
      return; // skip row with no horse name
    }

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
  });

  // Shutuba_Table tr.HorseList で取得できなかった場合のフォールバック
  // (テーブルクラス名が変わった場合に備える)
  if (entries.length === 0) {
    $('table.Shutuba_Table tbody tr, table.ShutubaTable tbody tr, table.RaceTable01 tbody tr').each((_, tr) => {
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

      if (horseName && horseNumber > 0) {
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
  }

  // 馬番未確定（枠順発表前）の場合、全馬がhorseNumber=0になる。
  // ON CONFLICT(race_id, horse_number) で全馬が上書きされるのを防ぐため、
  // 仮馬番（1-indexed）を割り当てる。枠順確定後の再スクレイプで正式番号に更新される。
  const allZero = entries.length > 1 && entries.every(e => e.horseNumber === 0);
  if (allZero) {
    for (let i = 0; i < entries.length; i++) {
      entries[i] = { ...entries[i], horseNumber: i + 1, postPosition: 0 };
    }
  }

  // 競馬場ID推定
  const racecourseId = inferRacecourseId(raceId);

  return {
    id: raceId,
    name: raceName,
    racecourseName: inferRacecourseName(racecourseId),
    racecourseId,
    trackType: (distMatch?.[1] === 'ダ' ? 'ダート' : distMatch?.[1] === '障' ? '障害' : distMatch?.[1] || 'ダート') as '芝' | 'ダート' | '障害',
    distance: parseInt(distMatch?.[2] || '0'),
    trackCondition: normalizedCond as '良' | '稍重' | '重' | '不良' | undefined,
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
  // action=init: 未発走レースの前売りオッズも取得可能にする
  const apiUrl = `${BASE_URL}/api/api_get_jra_odds.html?race_id=${raceId}&type=1&action=init&compress=0`;
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

  // status=result (確定後) or status=middle (前売り) どちらもオッズを取得
  if (!data.data || typeof data.data !== 'object' || !data.data.odds) {
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
export interface ScrapedResultWithLaps {
  results: ScrapedResult[];
  lapTimes: number[];   // 200mごとのラップタイム (秒)
}

export async function scrapeRaceResult(raceId: string): Promise<ScrapedResult[]> {
  const data = await scrapeRaceResultWithLaps(raceId);
  return data.results;
}

export async function scrapeRaceResultWithLaps(raceId: string): Promise<ScrapedResultWithLaps> {
  const url = `${BASE_URL}/race/result.html?race_id=${raceId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const results: ScrapedResult[] = [];

  // RaceTable01 列マッピング (2026年時点):
  // [0]着順 [1]枠 [2]馬番 [3]馬名 [4]性齢 [5]斤量 [6]騎手
  // [7]タイム [8]着差 [9]人気 [10]単勝オッズ [11]後3F
  // [12]コーナー通過順 [13]厩舎 [14]馬体重(増減)
  $('table.RaceTable01 tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 12) return;

    const position = parseInt($(tds[0]).text().trim()) || 0;
    const horseNumber = parseInt($(tds[2]).text().trim()) || 0;
    const horseName = $(tds[3]).find('a').text().trim();
    const time = $(tds[7]).text().trim();
    const margin = $(tds[8]).text().trim();
    const popularity = parseInt($(tds[9]).text().trim()) || 0;
    const odds = parseFloat($(tds[10]).text().trim()) || 0;
    const lastThreeFurlongs = $(tds[11]).text().trim();
    const cornerPositions = $(tds[12]).text().trim();

    if (position > 0) {
      results.push({
        position,
        horseNumber,
        horseName,
        time,
        margin,
        lastThreeFurlongs,
        cornerPositions,
        odds,
        popularity,
      });
    }
  });

  // ラップタイム抽出
  // netkeiba result.html: <span class="RapLap">...</span> or
  // <div class="Race_HaronTime">...</div> にラップタイムが表示される
  const lapTimes: number[] = [];
  const lapSelectors = [
    '.RapLap',
    '.Race_HaronTime',
    '.HaronTime',
    'td.Header:contains("ラップ")',
  ];

  for (const selector of lapSelectors) {
    const lapEl = $(selector);
    if (lapEl.length > 0) {
      const lapText = lapEl.text().trim();
      // パターン: "12.2 - 11.8 - 12.1 - ..." or "12.2-11.8-12.1-..."
      const matches = lapText.match(/\d{1,2}\.\d/g);
      if (matches && matches.length >= 3) {
        for (const m of matches) {
          lapTimes.push(parseFloat(m));
        }
        break;
      }
    }
  }

  // テーブルベースのフォールバック
  if (lapTimes.length === 0) {
    $('table').each((_, table) => {
      const headerText = $(table).find('th, td.Header').first().text().trim();
      if (headerText.includes('ラップ') || headerText.includes('Lap')) {
        $(table).find('td').each((__, td) => {
          const text = $(td).text().trim();
          const val = parseFloat(text);
          if (val >= 9.0 && val <= 15.0) {
            lapTimes.push(val);
          }
        });
      }
    });
  }

  return { results, lapTimes };
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

      // netkeiba db_h_race_results テーブルの列マッピング (2026年時点):
      // [0]日付 [1]開催 [2]天気 [3]R [4]レース名 [5]映像 [6]頭数 [7]枠番
      // [8]馬番 [9]オッズ [10]人気 [11]着順 [12]騎手 [13]斤量 [14]距離
      // [15]水分量 [16]馬場 [17]馬場指数 [18]タイム [19]着差
      // [20]タイム指数 [21]通過 [22]ペース [23]上り [24]馬体重
      // [25]厩舎コメント [26]備考 [27]勝ち馬 [28]賞金
      const date = $r(tds[0]).find('a').text().trim();
      const racecourseName = $r(tds[1]).text().trim();
      const raceName = $r(tds[4]).find('a').text().trim();
      const entries = parseInt($r(tds[6]).text().trim()) || 0;
      const postPosition = parseInt($r(tds[7]).text().trim()) || 0;
      const horseNumber = parseInt($r(tds[8]).text().trim()) || 0;
      const odds = parseFloat($r(tds[9]).text().trim()) || 0;
      const popularity = parseInt($r(tds[10]).text().trim()) || 0;
      const position = parseInt($r(tds[11]).text().trim()) || 99;
      const jockeyName = $r(tds[12]).find('a').text().trim();
      const handicapWeight = parseFloat($r(tds[13]).text().trim()) || 0;
      const distText = $r(tds[14]).text().trim();
      const trackMatch = distText.match(/(芝|ダート|ダ|障害|障)(\d+)/);
      const condText = $r(tds[16]).text().trim();
      const trackIndexRaw = parseFloat($r(tds[17]).text().trim()) || null;
      const time = $r(tds[18]).text().trim();
      const margin = $r(tds[19]).text().trim();
      const timeIndexRaw = parseFloat($r(tds[20]).text().trim()) || null;
      const cornerPositions = $r(tds[21]).text().trim();
      const lastThreeFurlongs = $r(tds[23]).text().trim();
      const weightText = $r(tds[24]).text().trim();
      const weightMatch = weightText.match(/(\d+)\(([+-]?\d+)\)/);

      if (date) {
        pastPerformances.push({
          date: date.replace(/\//g, '-'),
          racecourseName,
          raceName,
          trackType: (trackMatch?.[1] === '障' || trackMatch?.[1] === '障害' ? '障害' : trackMatch?.[1] === 'ダ' || trackMatch?.[1] === 'ダート' ? 'ダート' : trackMatch?.[1] || 'ダート') as '芝' | 'ダート' | '障害',
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
          timeIndex: timeIndexRaw,
          trackIndex: trackIndexRaw,
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
  odds: number;
  popularity: number;
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
  timeIndex: number | null;
  trackIndex: number | null;
}

// ==================== デバッグ用 ====================

/**
 * 出馬表ページの生のHTML構造を解析して診断情報を返す。
 */
export async function debugScrapeRaceCard(raceId: string): Promise<Record<string, unknown>> {
  const url = `${BASE_URL}/race/shutuba.html?race_id=${raceId}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.9',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const buffer = await response.arrayBuffer();
  const encoding = detectEncoding(url, buffer);
  const html = new TextDecoder(encoding).decode(buffer);
  const $ = cheerio.load(html);

  // charset情報
  const charsetMeta = $('meta[charset]').attr('charset') || '';
  const contentTypeMeta = $('meta[http-equiv="Content-Type"]').attr('content') || '';

  // テーブル情報
  const tables = $('table').map((_, el) => ({
    class: $(el).attr('class') || '(no class)',
    id: $(el).attr('id') || '',
    trCount: $(el).find('tr').length,
  })).get();

  // Shutuba_Table の行情報
  const shutubaRows: Record<string, unknown>[] = [];
  $('table.Shutuba_Table tr').each((i, tr) => {
    const $tr = $(tr);
    const trClass = $tr.attr('class') || '(no class)';
    const tds = $tr.find('td');
    const tdClasses = tds.map((_, td) => $(td).attr('class') || '').get();
    const tdTexts = tds.map((_, td) => $(td).text().trim().substring(0, 30)).get();
    shutubaRows.push({ index: i, trClass, tdCount: tds.length, tdClasses, tdTexts });
  });

  // HorseList 行
  const horseListRows: Record<string, unknown>[] = [];
  $('tr.HorseList').each((i, tr) => {
    const $tr = $(tr);
    const tds = $tr.find('td');
    horseListRows.push({
      index: i,
      waku: $tr.find('td[class*="Waku"]').first().text().trim(),
      umaban: $tr.find('td[class*="Umaban"]').first().text().trim(),
      horseName: $tr.find('td.HorseInfo a').first().text().trim(),
      barei: $tr.find('td.Barei').text().trim(),
      jockey: $tr.find('td.Jockey a').first().text().trim(),
      trainer: $tr.find('td.Trainer a').first().text().trim(),
      tdCount: tds.length,
      tdClasses: tds.map((_, td) => $(td).attr('class') || '').get(),
    });
  });

  // 通常パース結果
  const result = await scrapeRaceCard(raceId);

  return {
    url,
    httpStatus: response.status,
    encoding,
    charsetMeta,
    contentTypeMeta,
    htmlLength: html.length,
    title: $('title').text().trim().substring(0, 100),
    raceName: $('h1.RaceName').text().trim(),
    tablesFound: tables,
    shutubaTableExists: $('table.Shutuba_Table').length > 0,
    shutubaRowCount: shutubaRows.length,
    shutubaRows: shutubaRows.slice(0, 5),
    horseListRowCount: horseListRows.length,
    horseListRows: horseListRows.slice(0, 5),
    parsedEntries: result.entries.length,
    parsedEntriesSample: result.entries.slice(0, 3),
  };
}
