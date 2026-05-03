/**
 * IPAT ユーザー登録CLI
 *
 * 友人がIPAT認証情報を暗号化してTursoに保存するためのツール。
 * 平文はメモリ上のみで処理し、ディスクに書き出さない。
 *
 * 使い方:
 *   npx tsx scripts/register-ipat-user.ts
 *   npx tsx scripts/register-ipat-user.ts --list          # 登録済みユーザー一覧
 *   npx tsx scripts/register-ipat-user.ts --delete user1  # ユーザー削除
 *   npx tsx scripts/register-ipat-user.ts --verify user1  # 復号テスト
 */
import { readFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';

if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

import { createClient } from '@libsql/client';
import { encrypt, decrypt } from '../src/lib/credential-store';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

async function listUsers() {
  const rows = await db.execute('SELECT id, display_name, created_at, updated_at FROM ipat_users ORDER BY created_at');
  if (rows.rows.length === 0) {
    console.log('登録ユーザーなし');
    return;
  }
  console.log('\n登録済みユーザー:');
  for (const row of rows.rows) {
    console.log(`  ${row.id} (${row.display_name}) - 登録: ${row.created_at} / 更新: ${row.updated_at}`);
  }
  console.log('');
}

async function deleteUser(userId: string) {
  const existing = await db.execute({ sql: 'SELECT id FROM ipat_users WHERE id = ?', args: [userId] });
  if (existing.rows.length === 0) {
    console.log(`ユーザー "${userId}" は見つかりません`);
    return;
  }
  const confirm = await ask(`"${userId}" を削除しますか？ (yes/no): `);
  if (confirm !== 'yes') {
    console.log('キャンセル');
    return;
  }
  await db.execute({ sql: 'DELETE FROM ipat_users WHERE id = ?', args: [userId] });
  console.log(`"${userId}" を削除しました`);
}

async function verifyUser(userId: string) {
  const rows = await db.execute({
    sql: 'SELECT encrypted_credentials, iv, auth_tag FROM ipat_users WHERE id = ?',
    args: [userId],
  });
  if (rows.rows.length === 0) {
    console.log(`ユーザー "${userId}" は見つかりません`);
    return;
  }
  const row = rows.rows[0];
  try {
    const creds = decrypt(
      String(row.encrypted_credentials),
      String(row.iv),
      String(row.auth_tag),
    );
    console.log(`復号成功:`);
    console.log(`  INET-ID: ${creds.inetId.slice(0, 2)}***${creds.inetId.slice(-2)}`);
    console.log(`  加入者番号: ${creds.memberNo.slice(0, 2)}***${creds.memberNo.slice(-2)}`);
    console.log(`  暗証番号: ****`);
    console.log(`  P-ARS: ****`);
  } catch (e) {
    console.error('復号失敗:', e instanceof Error ? e.message : e);
    console.error('暗号化キーが変更された可能性があります');
  }
}

async function registerUser() {
  console.log('\n=== IPAT ユーザー登録 ===');
  console.log('入力された情報は暗号化されてDBに保存されます。');
  console.log('平文はどこにも保存されません。\n');

  const userId = await ask('ユーザーID（英数字、例: naoto）: ');
  if (!userId.match(/^[a-zA-Z0-9_-]+$/)) {
    console.log('ユーザーIDは英数字・ハイフン・アンダースコアのみ');
    return;
  }

  const existing = await db.execute({ sql: 'SELECT id FROM ipat_users WHERE id = ?', args: [userId] });
  if (existing.rows.length > 0) {
    const overwrite = await ask(`"${userId}" は既に登録済みです。上書きしますか？ (yes/no): `);
    if (overwrite !== 'yes') {
      console.log('キャンセル');
      return;
    }
  }

  const displayName = await ask('表示名（例: なおと）: ');
  console.log('\n--- IPAT認証情報 ---');
  const inetId = await ask('INET-ID（8桁）: ');
  const memberNo = await ask('加入者番号（8桁）: ');
  const password = await ask('暗証番号（4桁）: ');
  const parsNo = await ask('P-ARS番号（4桁）: ');

  // バリデーション
  if (!inetId || !memberNo || !password || !parsNo) {
    console.log('全項目の入力が必要です');
    return;
  }

  // 暗号化
  const { encrypted, iv, authTag } = encrypt({ inetId, memberNo, password, parsNo });

  // 保存
  const now = new Date().toISOString();
  if (existing.rows.length > 0) {
    await db.execute({
      sql: 'UPDATE ipat_users SET display_name = ?, encrypted_credentials = ?, iv = ?, auth_tag = ?, updated_at = ? WHERE id = ?',
      args: [displayName, encrypted, iv, authTag, now, userId],
    });
  } else {
    await db.execute({
      sql: 'INSERT INTO ipat_users (id, display_name, encrypted_credentials, iv, auth_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [userId, displayName, encrypted, iv, authTag, now, now],
    });
  }

  console.log(`\n✅ "${userId}" (${displayName}) を登録しました`);
  console.log('認証情報はAES-256-GCMで暗号化されています');

  // 復号テスト
  const creds = decrypt(encrypted, iv, authTag);
  console.log(`復号テスト: INET-ID=${creds.inetId.slice(0, 2)}*** → OK`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    await listUsers();
  } else if (args.includes('--delete')) {
    const idx = args.indexOf('--delete');
    const userId = args[idx + 1];
    if (!userId) { console.log('--delete <userId> を指定してください'); return; }
    await deleteUser(userId);
  } else if (args.includes('--verify')) {
    const idx = args.indexOf('--verify');
    const userId = args[idx + 1];
    if (!userId) { console.log('--verify <userId> を指定してください'); return; }
    await verifyUser(userId);
  } else {
    await registerUser();
  }

  rl.close();
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
