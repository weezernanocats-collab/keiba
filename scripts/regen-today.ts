/**
 * 当日の予想再生成スクリプト
 * 最新オッズで予想を更新する
 *
 * 使い方: npx tsx -r tsconfig-paths/register scripts/regen-today.ts
 */
import { readFileSync } from 'fs';

// Load .env.local
const envContent = readFileSync('.env.local', 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^(\w+)="?([^"]*)"?$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}

import { ensureInitialized } from '../src/lib/database';
import { regenerateTodayPredictions } from '../src/lib/scheduler';

async function main() {
  await ensureInitialized();

  // JST の今日の日付
  const now = new Date();
  const jstOffset = 9 * 60 * 60_000;
  const today = new Date(now.getTime() + jstOffset).toISOString().split('T')[0];

  console.log(`当日予想再生成: ${today}`);
  const { regenerated, total } = await regenerateTodayPredictions(today, 300_000); // 5分バジェット
  console.log(`完了: ${regenerated}/${total}件 再生成`);
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
