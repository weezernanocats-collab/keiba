/**
 * IPAT招待トークン生成
 *
 * 使い方:
 *   npx tsx scripts/generate-invite.ts murakoshi 村越
 *   npx tsx scripts/generate-invite.ts ohinata 大日向
 *   npx tsx scripts/generate-invite.ts kimura 木村
 */
import { readFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function main() {
  const [userId, displayName] = process.argv.slice(2);
  if (!userId || !displayName) {
    console.log('使い方: npx tsx scripts/generate-invite.ts <userId> <表示名>');
    console.log('例: npx tsx scripts/generate-invite.ts murakoshi 村越');
    process.exit(1);
  }

  const token = randomBytes(24).toString('hex'); // 48文字のランダムトークン
  const now = new Date().toISOString();

  await db.execute({
    sql: 'INSERT INTO ipat_invite_tokens (token, user_id, display_name, used, created_at) VALUES (?, ?, ?, 0, ?)',
    args: [token, userId, displayName, now],
  });

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://keiba-rose.vercel.app';
  const url = `${baseUrl}/register?token=${token}`;

  console.log(`\n招待トークン生成完了:`);
  console.log(`  ユーザー: ${userId} (${displayName})`);
  console.log(`  トークン: ${token}`);
  console.log(`\n📱 このURLを友人に送ってください:`);
  console.log(`  ${url}`);
  console.log(`\n※ 1回使用すると無効になります`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
