/**
 * 追い切り評価スクレイパー
 *
 * レースごとの追い切り評価（A/B/C/D）を取得し、JSONに保存する。
 * BAN対策: 1バッチ2,400リクエスト上限、1.5秒間隔
 *
 * Usage:
 *   npx tsx scripts/scrape-oikiri.ts              # 未取得分を2,400件まで
 *   npx tsx scripts/scrape-oikiri.ts --limit 100  # 100件だけ（テスト用）
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const OUTPUT_FILE = join(__dirname, '..', 'model', 'oikiri_data.json');
const TRAINING_DATA = join(__dirname, '..', 'model', 'training_data.json');
const RATE_LIMIT_MS = 1500;
const DEFAULT_BATCH_LIMIT = 2400;

interface OikiriEntry {
  horseNumber: string;
  rank: string;  // A, B, C, D
  comment: string;
}

interface OikiriRace {
  raceId: string;
  entries: OikiriEntry[];
  scrapedAt: string;
}

type OikiriData = Record<string, OikiriRace>;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchOikiri(raceId: string): Promise<OikiriEntry[]> {
  const url = `https://race.netkeiba.com/race/oikiri.html?race_id=${raceId}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${raceId}`);
  }

  const buffer = await res.arrayBuffer();
  // Try EUC-JP first, fallback to UTF-8
  let text: string;
  try {
    text = new TextDecoder('euc-jp').decode(buffer);
  } catch {
    text = new TextDecoder('utf-8').decode(buffer);
  }

  const entries: OikiriEntry[] = [];

  // Extract horse numbers (Umaban class)
  const umabanRegex = /class="Umaban">(\d+)</g;
  const umabans: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = umabanRegex.exec(text)) !== null) {
    umabans.push(m[1]);
  }

  // Extract ranks and comments
  const rankRegex = /class="Training_Critic">([^<]*)<\/td>\s*<td[^>]*class="Rank_[^"]*">([A-D])/g;
  const ranks: { comment: string; rank: string }[] = [];
  while ((m = rankRegex.exec(text)) !== null) {
    ranks.push({ comment: m[1].trim(), rank: m[2] });
  }

  // Match them up
  if (umabans.length === ranks.length) {
    for (let i = 0; i < umabans.length; i++) {
      entries.push({
        horseNumber: umabans[i],
        rank: ranks[i].rank,
        comment: ranks[i].comment,
      });
    }
  }

  return entries;
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const batchLimit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : DEFAULT_BATCH_LIMIT;

  // Load existing data
  let existing: OikiriData = {};
  if (existsSync(OUTPUT_FILE)) {
    existing = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
    console.log(`既存データ: ${Object.keys(existing).length}レース分`);
  }

  // Load all race IDs from training data
  console.log('学習データからレースID読み込み中...');
  const trainingData = JSON.parse(readFileSync(TRAINING_DATA, 'utf-8'));
  const allRaceIds = [...new Set<string>(trainingData.rows.map((r: any) => r.race_id))].sort();
  console.log(`全レース: ${allRaceIds.length}件`);

  // Filter out already scraped
  const remaining = allRaceIds.filter(id => !existing[id]);
  console.log(`未取得: ${remaining.length}件`);

  const toFetch = remaining.slice(0, batchLimit);
  console.log(`今回取得: ${toFetch.length}件 (上限: ${batchLimit})`);
  console.log(`推定時間: ${Math.ceil(toFetch.length * RATE_LIMIT_MS / 1000 / 60)}分\n`);

  let success = 0;
  let empty = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < toFetch.length; i++) {
    const raceId = toFetch[i];

    try {
      const entries = await fetchOikiri(raceId);

      if (entries.length > 0) {
        existing[raceId] = {
          raceId,
          entries,
          scrapedAt: new Date().toISOString(),
        };
        success++;
      } else {
        // No data (maybe too old or no oikiri for this race)
        existing[raceId] = {
          raceId,
          entries: [],
          scrapedAt: new Date().toISOString(),
        };
        empty++;
      }
    } catch (e: any) {
      errors++;
      if (e.message?.includes('400') || e.message?.includes('429') || e.message?.includes('403')) {
        console.error(`\n⚠ Rate limited or banned at request ${i + 1}. Saving progress and stopping.`);
        break;
      }
    }

    // Progress every 100 requests
    if ((i + 1) % 100 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = (toFetch.length - i - 1) / rate / 60;
      console.log(`  ${i + 1}/${toFetch.length} (${success}成功, ${empty}空, ${errors}エラー) ETA: ${eta.toFixed(0)}分`);

      // Save progress every 100
      writeFileSync(OUTPUT_FILE, JSON.stringify(existing, null, 2));
    }

    await sleep(RATE_LIMIT_MS);
  }

  // Final save
  writeFileSync(OUTPUT_FILE, JSON.stringify(existing, null, 2));

  const totalTime = (Date.now() - startTime) / 1000 / 60;
  console.log(`\n=== 完了 ===`);
  console.log(`取得済み合計: ${Object.keys(existing).length}/${allRaceIds.length}レース`);
  console.log(`今回: ${success}成功, ${empty}空, ${errors}エラー (${totalTime.toFixed(1)}分)`);

  const remainingCount = allRaceIds.filter(id => !existing[id]).length;
  if (remainingCount > 0) {
    console.log(`残り: ${remainingCount}件 → 12時間後に再実行してください`);
  } else {
    console.log('全レースの取得完了!');
  }
}

main().catch(console.error);
