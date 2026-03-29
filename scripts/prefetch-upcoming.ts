/**
 * ローカル実行スクリプト: 今後2週間のレースデータを事前取得
 *
 * 使い方: npx tsx scripts/prefetch-upcoming.ts [--days 14]
 *
 * - 今日から N 日先までのレース一覧を netkeiba から取得
 * - 出馬表が公開済みのレース（枠順確定＝発走3-4日前）はカード情報も取得
 * - 新しい馬の詳細・過去成績をスクレイプ
 * - 既にDBにあるレース/馬はスキップ（差分取り込み）
 * - 並列3・800ms間隔で netkeiba への負荷を軽減
 */
import { createClient, type Client } from '@libsql/client';
import * as cheerio from 'cheerio';
import { readFileSync } from 'fs';

// Load .env.local manually
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

const TURSO_URL = process.env.TURSO_DATABASE_URL!;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN!;
const RACE_BASE_URL = 'https://race.netkeiba.com';
const DB_BASE_URL = 'https://db.netkeiba.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const CONCURRENCY = 3;
const RATE_LIMIT_MS = 800;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in .env.local');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ==================== CLI args ====================

function parseDaysArg(): number {
  const idx = process.argv.indexOf('--days');
  if (idx >= 0 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1]) || 14;
  }
  return 14;
}

// ==================== Fetch HTML ====================

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        if (res.status === 429 || res.status === 400) {
          console.log(`  Rate limited (${res.status}), waiting...`);
          await sleep(5000 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const buffer = await res.arrayBuffer();
      const encoding = detectEncoding(url, buffer);
      return new TextDecoder(encoding).decode(buffer);
    } catch (e) {
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
      } else {
        throw e;
      }
    }
  }
  throw new Error('Failed after retries');
}

function detectEncoding(url: string, buffer: ArrayBuffer): string {
  if (url.includes('race_list_sub.html')) return 'utf-8';
  const preview = new TextDecoder('ascii').decode(buffer.slice(0, 1024));
  if (preview.includes('charset="UTF-8"') || preview.includes('charset=utf-8')) return 'utf-8';
  return 'euc-jp';
}

// ==================== Racecourse Helpers ====================

const RACECOURSE_CODE_MAP: Record<string, string> = {
  '01': 'sapporo', '02': 'hakodate', '03': 'fukushima', '04': 'niigata',
  '05': 'tokyo', '06': 'nakayama', '07': 'chukyo', '08': 'kyoto',
  '09': 'hanshin', '10': 'kokura',
  '30': 'monbetsu', '35': 'morioka', '36': 'mizusawa',
  '42': 'urawa', '43': 'funabashi', '44': 'ooi', '45': 'kawasaki',
  '46': 'kanazawa', '48': 'kasamatsu', '50': 'nagoya',
  '51': 'sonoda', '54': 'kochi', '55': 'saga',
};

const RACECOURSE_NAME_MAP: Record<string, string> = {
  sapporo: '札幌', hakodate: '函館', fukushima: '福島', niigata: '新潟',
  tokyo: '東京', nakayama: '中山', chukyo: '中京', kyoto: '京都',
  hanshin: '阪神', kokura: '小倉',
  monbetsu: '門別', morioka: '盛岡', mizusawa: '水沢',
  urawa: '浦和', funabashi: '船橋', ooi: '大井', kawasaki: '川崎',
  kanazawa: '金沢', kasamatsu: '笠松', nagoya: '名古屋',
  sonoda: '園田', kochi: '高知', saga: '佐賀',
};

function inferRacecourseId(raceId: string): string {
  return RACECOURSE_CODE_MAP[raceId.substring(4, 6)] || 'unknown';
}

function inferRacecourseName(racecourseId: string): string {
  return RACECOURSE_NAME_MAP[racecourseId] || '不明';
}

// ==================== Scrape Race List ====================

interface RaceListItem {
  id: string;
  raceNumber: number;
  name: string;
  racecourseName: string;
  date: string;
}

async function scrapeRaceList(date: string): Promise<RaceListItem[]> {
  const dateStr = date.replace(/-/g, '');
  const url = `${RACE_BASE_URL}/top/race_list_sub.html?kaisai_date=${dateStr}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const races: RaceListItem[] = [];

  $('li a[href*="race_id="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (href.includes('movie.html')) return;

    const raceIdMatch = href.match(/race_id=(\d+)/);
    if (!raceIdMatch) return;

    const raceId = raceIdMatch[1];
    const raceText = $(a).text().trim();
    const raceNumMatch = raceText.match(/(\d+)R/);
    const namePart = raceText
      .replace(/\d+R\s*/, '')
      .replace(/\d{2}:\d{2}/, '')
      .replace(/[芝ダ障]\d+m/, '')
      .replace(/\d+頭/, '')
      .trim();

    const racecourseId = inferRacecourseId(raceId);

    races.push({
      id: raceId,
      raceNumber: raceNumMatch ? parseInt(raceNumMatch[1]) : 0,
      name: namePart || `${raceNumMatch?.[1] || ''}R`,
      racecourseName: inferRacecourseName(racecourseId),
      date,
    });
  });

  return races;
}

// ==================== Scrape Race Card ====================

interface RaceDetail {
  id: string;
  name: string;
  racecourseName: string;
  racecourseId: string;
  trackType: string;
  distance: number;
  trackCondition: string | null;
  weather: string | null;
  time: string | null;
  grade: string | null;
  entries: EntryData[];
}

interface EntryData {
  postPosition: number;
  horseNumber: number;
  horseId: string;
  horseName: string;
  age: number;
  sex: string;
  jockeyId: string;
  jockeyName: string;
  trainerName: string;
  handicapWeight: number;
}

async function scrapeRaceCard(raceId: string): Promise<RaceDetail | null> {
  try {
    const url = `${RACE_BASE_URL}/race/shutuba.html?race_id=${raceId}`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const raceInfo = $('div.RaceData01').text().trim();
    const raceName = $('h1.RaceName').text().trim();
    const distMatch = raceInfo.match(/(芝|ダート|ダ|障害|障)(\d+)m/);
    const condMatch = raceInfo.match(/(良|稍重|稍|重|不良|不)/);
    const normalizedCond = condMatch?.[1] === '稍' ? '稍重' : condMatch?.[1] === '不' ? '不良' : condMatch?.[1] || null;
    const weatherMatch = raceInfo.match(/(晴|曇|小雨|雨|小雪|雪)/);
    const timeMatch = raceInfo.match(/(\d{1,2}:\d{2})/);

    const gradeText = $('span.RaceGrade, span.Icon_GradeType').text().trim();
    const gradeClassList = $('span.Icon_GradeType').map((_, el) => $(el).attr('class') || '').get();
    const allClasses = gradeClassList.flatMap((c: string) => c.split(/\s+/));
    const hasGradeClass = (suffix: string) => allClasses.includes(`Icon_GradeType${suffix}`);
    let grade: string | null = null;
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

    // RaceData02 からクラス情報を補完
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

    const entries: EntryData[] = [];
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
          sex: (ageSex.match(/(牡|牝|セ)/)?.[1] || '牡'),
          jockeyId: jockeyIdMatch ? jockeyIdMatch[1] : `j_${jockeyName}`,
          jockeyName,
          trainerName,
          handicapWeight,
        });
      }
    });

    const racecourseId = inferRacecourseId(raceId);
    let trackType = distMatch?.[1] || 'ダート';
    if (trackType === 'ダ') trackType = 'ダート';
    if (trackType === '障') trackType = '障害';

    return {
      id: raceId,
      name: raceName,
      racecourseName: inferRacecourseName(racecourseId),
      racecourseId,
      trackType,
      distance: parseInt(distMatch?.[2] || '0'),
      trackCondition: normalizedCond,
      weather: weatherMatch?.[1] || null,
      time: timeMatch?.[1] || null,
      grade,
      entries,
    };
  } catch (e) {
    console.error(`  Error scraping card for ${raceId}:`, (e as Error).message);
    return null;
  }
}

// ==================== Scrape Horse ====================

interface HorseData {
  id: string;
  name: string;
  birthDate: string | null;
  fatherName: string;
  motherName: string;
  trainerName: string;
  ownerName: string;
  pastPerformances: PastPerf[];
}

interface PastPerf {
  date: string;
  racecourseName: string;
  raceName: string;
  trackType: string;
  distance: number;
  trackCondition: string;
  entries: number;
  postPosition: number;
  horseNumber: number;
  odds: number;
  popularity: number;
  position: number;
  jockeyName: string;
  handicapWeight: number;
  weight: number;
  weightChange: number;
  time: string;
  margin: string;
  lastThreeFurlongs: string;
  cornerPositions: string;
  prize: number;
}

async function scrapeHorse(horseId: string): Promise<HorseData | null> {
  try {
    const profileHtml = await fetchHtml(`${DB_BASE_URL}/horse/${horseId}`);
    const $ = cheerio.load(profileHtml);

    const name = $('.horse_title h1').text().trim().split('\n')[0]
      || $('h1').first().text().trim().split('\n')[0];
    if (!name) return null;

    const profileTable = $('table.db_prof_table');
    const birthDate = profileTable.find('tr').eq(0).find('td').text().trim() || null;
    const trainerName = profileTable.find('tr').eq(4).find('td a').text().trim();
    const ownerName = profileTable.find('tr').eq(5).find('td a').text().trim();
    const fatherName = $('a[href*="/horse/ped/"]').eq(0).text().trim();
    const motherName = $('a[href*="/horse/ped/"]').eq(1).text().trim();

    await sleep(RATE_LIMIT_MS);
    const resultHtml = await fetchHtml(`${DB_BASE_URL}/horse/result/${horseId}`);
    const $r = cheerio.load(resultHtml);

    const pastPerformances: PastPerf[] = [];
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
      if (!date) return;

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
      const trackIndexRaw = parseFloat($r(tds[17])?.text().trim()) || null;
      const time = $r(tds[18]).text().trim();
      const margin = $r(tds[19]).text().trim();
      const timeIndexRaw = parseFloat($r(tds[20])?.text().trim()) || null;
      const cornerPositions = $r(tds[21])?.text().trim() || '';
      const lastThreeFurlongs = $r(tds[23])?.text().trim() || '';
      const weightText = $r(tds[24])?.text().trim() || '';
      const weightMatch = weightText.match(/(\d+)\(([+-]?\d+)\)/);
      const prizeText = $r(tds[28])?.text().trim() || '0';
      const prize = parseFloat(prizeText.replace(/,/g, '')) || 0;

      let trackType = trackMatch?.[1] || 'ダート';
      if (trackType === 'ダ') trackType = 'ダート';
      if (trackType === '障') trackType = '障害';

      pastPerformances.push({
        date: date.replace(/\//g, '-'),
        racecourseName,
        raceName,
        trackType,
        distance: parseInt(trackMatch?.[2] || '0'),
        trackCondition: condText || '良',
        entries,
        postPosition,
        horseNumber,
        odds,
        popularity,
        position,
        jockeyName,
        handicapWeight,
        weight: weightMatch ? parseInt(weightMatch[1]) : 0,
        weightChange: weightMatch ? parseInt(weightMatch[2]) : 0,
        time,
        margin,
        lastThreeFurlongs,
        cornerPositions,
        prize,
        timeIndex: timeIndexRaw,
        trackIndex: trackIndexRaw,
      });
    });

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
  } catch (e) {
    console.error(`  Error scraping horse ${horseId}:`, (e as Error).message);
    return null;
  }
}

// ==================== DB Write ====================

async function writeRaceToDB(
  turso: Client,
  raceListItem: RaceListItem,
  detail: RaceDetail,
): Promise<number> {
  const racecourseId = detail.racecourseId;

  await turso.execute({
    sql: `INSERT INTO races (id, name, date, time, racecourse_id, racecourse_name, race_number, grade, track_type, distance, track_condition, weather, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = COALESCE(NULLIF(excluded.name, ''), races.name),
            date = COALESCE(NULLIF(excluded.date, ''), races.date),
            time = COALESCE(excluded.time, races.time),
            racecourse_id = COALESCE(NULLIF(excluded.racecourse_id, ''), races.racecourse_id),
            racecourse_name = COALESCE(NULLIF(excluded.racecourse_name, ''), races.racecourse_name),
            race_number = CASE WHEN excluded.race_number > 0 THEN excluded.race_number ELSE races.race_number END,
            grade = COALESCE(excluded.grade, races.grade),
            track_type = COALESCE(NULLIF(excluded.track_type, ''), races.track_type),
            distance = CASE WHEN excluded.distance > 0 THEN excluded.distance ELSE races.distance END,
            track_condition = COALESCE(excluded.track_condition, races.track_condition),
            weather = COALESCE(excluded.weather, races.weather),
            status = CASE WHEN races.status = '結果確定' THEN races.status ELSE excluded.status END`,
    args: [
      detail.id, detail.name, raceListItem.date, detail.time,
      racecourseId, detail.racecourseName, raceListItem.raceNumber,
      detail.grade, detail.trackType, detail.distance,
      detail.trackCondition, detail.weather,
      detail.entries.length > 0 ? '出走確定' : '予定',
    ],
  });

  let entryCount = 0;
  for (const entry of detail.entries) {
    await turso.execute({
      sql: "INSERT OR IGNORE INTO horses (id, name, age, sex) VALUES (?, ?, ?, ?)",
      args: [entry.horseId, entry.horseName, entry.age, entry.sex],
    });

    const existing = await turso.execute({
      sql: 'SELECT id FROM race_entries WHERE race_id = ? AND horse_number = ?',
      args: [detail.id, entry.horseNumber],
    });

    if (existing.rows.length > 0) {
      await turso.execute({
        sql: `UPDATE race_entries SET
                post_position = COALESCE(?, post_position),
                horse_id = COALESCE(NULLIF(?, ''), horse_id),
                horse_name = COALESCE(NULLIF(?, ''), horse_name),
                age = COALESCE(?, age),
                sex = COALESCE(?, sex),
                jockey_id = COALESCE(NULLIF(?, ''), jockey_id),
                jockey_name = COALESCE(NULLIF(?, ''), jockey_name),
                trainer_name = COALESCE(NULLIF(?, ''), trainer_name),
                handicap_weight = COALESCE(?, handicap_weight)
              WHERE race_id = ? AND horse_number = ?`,
        args: [
          entry.postPosition, entry.horseId, entry.horseName,
          entry.age, entry.sex, entry.jockeyId, entry.jockeyName,
          entry.trainerName, entry.handicapWeight,
          detail.id, entry.horseNumber,
        ],
      });
    } else {
      await turso.execute({
        sql: `INSERT INTO race_entries (
                race_id, post_position, horse_number, horse_id, horse_name, age, sex,
                jockey_id, jockey_name, trainer_name, handicap_weight
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          detail.id, entry.postPosition, entry.horseNumber,
          entry.horseId, entry.horseName, entry.age, entry.sex,
          entry.jockeyId, entry.jockeyName, entry.trainerName,
          entry.handicapWeight,
        ],
      });
    }

    entryCount++;
  }

  return entryCount;
}

async function writeRaceListOnlyToDB(
  turso: Client,
  raceListItem: RaceListItem,
): Promise<void> {
  const racecourseId = inferRacecourseId(raceListItem.id);

  await turso.execute({
    sql: `INSERT INTO races (id, name, date, racecourse_id, racecourse_name, race_number, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = COALESCE(NULLIF(excluded.name, ''), races.name),
            racecourse_name = COALESCE(NULLIF(excluded.racecourse_name, ''), races.racecourse_name),
            race_number = CASE WHEN excluded.race_number > 0 THEN excluded.race_number ELSE races.race_number END`,
    args: [
      raceListItem.id, raceListItem.name, raceListItem.date,
      racecourseId, raceListItem.racecourseName, raceListItem.raceNumber,
      '予定',
    ],
  });
}

async function writeHorseToDB(horse: HorseData): Promise<number> {
  let age = 0;
  if (horse.birthDate) {
    const m = horse.birthDate.match(/(\d{4})/);
    if (m) {
      age = new Date().getFullYear() - parseInt(m[1]);
    }
  }

  await db.execute({
    sql: `INSERT INTO horses (id, name, birth_date, father_name, mother_name, trainer_name, owner_name, age, sex, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '牡', datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN excluded.name != '' AND excluded.name != '取得失敗' THEN excluded.name ELSE horses.name END,
            birth_date = COALESCE(NULLIF(excluded.birth_date, ''), horses.birth_date),
            father_name = COALESCE(NULLIF(excluded.father_name, ''), horses.father_name),
            mother_name = COALESCE(NULLIF(excluded.mother_name, ''), horses.mother_name),
            trainer_name = COALESCE(NULLIF(excluded.trainer_name, ''), horses.trainer_name),
            owner_name = COALESCE(NULLIF(excluded.owner_name, ''), horses.owner_name),
            age = CASE WHEN excluded.age > 0 THEN excluded.age ELSE horses.age END,
            total_races = ?,
            wins = ?,
            updated_at = datetime('now')`,
    args: [
      horse.id, horse.name, horse.birthDate, horse.fatherName,
      horse.motherName, horse.trainerName, horse.ownerName, age,
      horse.pastPerformances.length,
      horse.pastPerformances.filter(p => p.position === 1).length,
    ],
  });

  await db.execute({ sql: 'DELETE FROM past_performances WHERE horse_id = ?', args: [horse.id] });

  if (horse.pastPerformances.length > 0) {
    for (let i = 0; i < horse.pastPerformances.length; i += 20) {
      const batch = horse.pastPerformances.slice(i, i + 20);
      const stmts = batch.map(pp => ({
        sql: `INSERT INTO past_performances (horse_id, date, race_name, racecourse_name, track_type, distance, track_condition, weather, entries, post_position, horse_number, position, jockey_name, handicap_weight, weight, weight_change, time, margin, last_three_furlongs, corner_positions, odds, popularity, prize, time_index, track_index)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          horse.id, pp.date, pp.raceName, pp.racecourseName, pp.trackType,
          pp.distance, pp.trackCondition, pp.entries, pp.postPosition,
          pp.horseNumber, pp.position, pp.jockeyName, pp.handicapWeight,
          pp.weight, pp.weightChange, pp.time, pp.margin,
          pp.lastThreeFurlongs, pp.cornerPositions, pp.odds, pp.popularity, pp.prize,
          pp.timeIndex ?? null, pp.trackIndex ?? null,
        ],
      }));
      await db.batch(stmts, 'write');
    }
  }

  return horse.pastPerformances.length;
}

// ==================== Date Helpers ====================

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function generateFutureDateRange(days: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let i = 0; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(formatDate(d));
  }
  return dates;
}

// ==================== Main ====================

async function main() {
  const days = parseDaysArg();
  console.log(`=== Prefetch Upcoming Races (next ${days} days) ===\n`);
  console.log(`Turso: ${TURSO_URL.substring(0, 30)}...`);

  const dates = generateFutureDateRange(days);

  // Check which races already have full data (entries scraped)
  const existingRaces = await db.execute(
    `SELECT r.id, r.status, COUNT(re.id) as entry_count
     FROM races r
     LEFT JOIN race_entries re ON r.id = re.race_id
     WHERE r.date >= ?
     GROUP BY r.id`,
    [dates[0]]
  );
  const existingRaceMap = new Map(
    existingRaces.rows.map(r => [r.id as string, { status: r.status as string, entries: r.entry_count as number }])
  );

  // Check which horses already have past performances
  const existingHorses = await db.execute(
    `SELECT DISTINCT horse_id FROM past_performances`
  );
  const existingHorseSet = new Set(existingHorses.rows.map(r => r.horse_id as string));

  let totalRaces = 0;
  let totalEntries = 0;
  let totalRaceListOnly = 0;
  let newHorsesScraped = 0;
  let totalPerfs = 0;
  let totalErrors = 0;
  const startTime = Date.now();

  // ====== Phase 1: Scan all dates for race lists ======
  console.log('\n--- Phase 1: レース一覧取得 ---');
  const allRacesForDates = new Map<string, RaceListItem[]>();

  for (const date of dates) {
    try {
      const raceList = await scrapeRaceList(date);
      if (raceList.length > 0) {
        allRacesForDates.set(date, raceList);
        console.log(`  ${date}: ${raceList.length} races found`);
      }
      await sleep(RATE_LIMIT_MS);
    } catch (e) {
      console.log(`  ${date}: Failed - ${(e as Error).message}`);
      totalErrors++;
    }
  }

  const totalDatesWithRaces = allRacesForDates.size;
  const totalRacesFound = [...allRacesForDates.values()].reduce((sum, r) => sum + r.length, 0);
  console.log(`\n  ${totalDatesWithRaces} days with races, ${totalRacesFound} total races found`);

  // ====== Phase 2: Scrape race cards for each date ======
  console.log('\n--- Phase 2: 出馬表取得 ---');

  const newHorseIds = new Set<string>();

  for (const [date, raceList] of allRacesForDates) {
    // Filter to races that need card data
    const racesToScrape = raceList.filter(r => {
      const existing = existingRaceMap.get(r.id);
      // Skip if already has entries and is fully scraped
      if (existing && existing.entries > 0) return false;
      return true;
    });

    const racesToSkip = raceList.filter(r => {
      const existing = existingRaceMap.get(r.id);
      return existing && existing.entries > 0;
    });

    if (racesToSkip.length > 0) {
      console.log(`  ${date}: ${racesToSkip.length} races already have entries (skipped)`);
    }

    if (racesToScrape.length === 0) continue;

    console.log(`  ${date}: scraping ${racesToScrape.length} race cards...`);

    for (let i = 0; i < racesToScrape.length; i += CONCURRENCY) {
      const batch = racesToScrape.slice(i, i + CONCURRENCY);

      const batchResults = await Promise.all(
        batch.map(async (race) => {
          try {
            const detail = await scrapeRaceCard(race.id);
            if (!detail) {
              // Card not available yet; save race list info only
              await writeRaceListOnlyToDB(db, race);
              return { race, ok: true, entries: 0, cardAvailable: false };
            }

            if (detail.entries.length === 0) {
              // Card page exists but no entries yet (pre-entry stage)
              await writeRaceListOnlyToDB(db, race);
              return { race, ok: true, entries: 0, cardAvailable: false };
            }

            // Full card available
            const entryCount = await writeRaceToDB(db, race, detail);

            // Collect new horse IDs for Phase 3
            for (const entry of detail.entries) {
              if (!existingHorseSet.has(entry.horseId)) {
                newHorseIds.add(entry.horseId);
              }
            }

            return { race, ok: true, entries: entryCount, cardAvailable: true };
          } catch (e) {
            // On failure, still save basic race info
            try { await writeRaceListOnlyToDB(db, race); } catch { /* skip */ }
            return { race, ok: false, entries: 0, cardAvailable: false, error: (e as Error).message };
          }
        })
      );

      for (const r of batchResults) {
        if (r.ok) {
          if (r.cardAvailable) {
            totalRaces++;
            totalEntries += r.entries;
          } else {
            totalRaceListOnly++;
          }
        } else {
          totalErrors++;
        }
      }

      if (i + CONCURRENCY < racesToScrape.length) {
        await sleep(RATE_LIMIT_MS);
      }
    }
  }

  console.log(`\n  Cards scraped: ${totalRaces} (${totalEntries} entries)`);
  console.log(`  Race list only (no entries yet): ${totalRaceListOnly}`);

  // ====== Phase 3: Scrape horse details for new horses ======
  if (newHorseIds.size > 0) {
    console.log(`\n--- Phase 3: 馬詳細取得 (${newHorseIds.size} new horses) ---`);

    const horseIdList = [...newHorseIds];
    let completed = 0;

    for (let i = 0; i < horseIdList.length; i += CONCURRENCY) {
      const batch = horseIdList.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (horseId) => {
          const horse = await scrapeHorse(horseId);
          if (horse) {
            const perfCount = await writeHorseToDB(horse);
            return { horseId, name: horse.name, perfs: perfCount, ok: true };
          }
          return { horseId, name: '?', perfs: 0, ok: false };
        })
      );

      for (const r of results) {
        completed++;
        if (r.ok) {
          newHorsesScraped++;
          totalPerfs += r.perfs;
          process.stdout.write(`\r  [${completed}/${horseIdList.length}] ${r.name} (${r.perfs} races)    `);
        } else {
          totalErrors++;
          process.stdout.write(`\r  [${completed}/${horseIdList.length}] ${r.horseId} FAILED    `);
        }
      }

      if (i + CONCURRENCY < horseIdList.length) {
        await sleep(RATE_LIMIT_MS);
      }
    }

    console.log(''); // newline after progress
  } else {
    console.log('\n--- Phase 3: 全馬の詳細は取得済み (skip) ---');
  }

  // ====== Summary ======
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Done in ${elapsed}s ===`);
  console.log(`  Dates scanned: ${dates.length}`);
  console.log(`  Races with full cards: ${totalRaces} (${totalEntries} entries)`);
  console.log(`  Races listed (no entries yet): ${totalRaceListOnly}`);
  console.log(`  New horses scraped: ${newHorsesScraped} (${totalPerfs} past performances)`);
  console.log(`  Errors: ${totalErrors}`);

  // Verify final counts
  const raceCount = await db.execute('SELECT COUNT(*) as c FROM races WHERE date >= ?', [dates[0]]);
  const entryCount = await db.execute(
    `SELECT COUNT(*) as c FROM race_entries re
     JOIN races r ON re.race_id = r.id
     WHERE r.date >= ?`,
    [dates[0]]
  );
  console.log(`\n  DB future races: ${raceCount.rows[0].c}, entries: ${entryCount.rows[0].c}`);

  db.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
