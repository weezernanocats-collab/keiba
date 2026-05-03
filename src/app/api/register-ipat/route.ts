import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@libsql/client';
import { createCipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
}

function encryptCredentials(data: { inetId: string; memberNo: string; password: string; parsNo: string }) {
  const keyHex = process.env.IPAT_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('IPAT_ENCRYPTION_KEY is not configured');
  }
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(data);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return { encrypted, iv: iv.toString('hex'), authTag };
}

// GET: トークン検証
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'トークンが必要です' }, { status: 400 });
  }

  const db = getDb();
  try {
    const rows = await db.execute({
      sql: 'SELECT user_id, display_name, used FROM ipat_invite_tokens WHERE token = ?',
      args: [token],
    });

    if (rows.rows.length === 0) {
      return NextResponse.json({ error: '無効なトークンです' }, { status: 404 });
    }

    const row = rows.rows[0];
    if (Number(row.used) === 1) {
      return NextResponse.json({ error: 'このトークンは既に使用済みです' }, { status: 410 });
    }

    return NextResponse.json({
      userId: row.user_id,
      displayName: row.display_name,
    });
  } finally {
    db.close();
  }
}

// POST: 認証情報登録
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { token, inetId, memberNo, password, parsNo } = body;

  if (!token || !inetId || !memberNo || !password || !parsNo) {
    return NextResponse.json({ error: '全項目の入力が必要です' }, { status: 400 });
  }

  const db = getDb();
  try {
    // トークン検証
    const tokenRows = await db.execute({
      sql: 'SELECT user_id, display_name, used FROM ipat_invite_tokens WHERE token = ?',
      args: [token],
    });

    if (tokenRows.rows.length === 0) {
      return NextResponse.json({ error: '無効なトークンです' }, { status: 404 });
    }

    const tokenRow = tokenRows.rows[0];
    if (Number(tokenRow.used) === 1) {
      return NextResponse.json({ error: 'このトークンは既に使用済みです' }, { status: 410 });
    }

    const userId = String(tokenRow.user_id);
    const displayName = String(tokenRow.display_name);

    // 暗号化
    const { encrypted, iv, authTag } = encryptCredentials({ inetId, memberNo, password, parsNo });

    // 保存（既存があれば上書き）
    const now = new Date().toISOString();
    const existing = await db.execute({
      sql: 'SELECT id FROM ipat_users WHERE id = ?',
      args: [userId],
    });

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

    // トークンを使用済みに
    await db.execute({
      sql: 'UPDATE ipat_invite_tokens SET used = 1, used_at = ? WHERE token = ?',
      args: [now, token],
    });

    return NextResponse.json({ success: true, message: `${displayName}さんの登録が完了しました` });
  } finally {
    db.close();
  }
}
