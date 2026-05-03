import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@libsql/client';

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
}

export interface BetConfig {
  userId: string;
  dailyBudget: number;
  betTypes: {
    tansho: boolean;
    umaren: boolean;
    wide: boolean;
    umatan: boolean;
    sanrenpuku: boolean;
    sanrentan: boolean;
  };
  strategies: {
    shoshan: boolean;
    ai: boolean;
    shoshan_ai: boolean;
  };
  strategyWeights: Record<string, number>;
  minOdds: number | null;
  maxOdds: number | null;
  active: boolean;
}

// GET: ユーザーの買い目設定を取得
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId');
  if (!userId) {
    return NextResponse.json({ error: 'userId が必要です' }, { status: 400 });
  }

  // userId が ipat_users に存在するか確認（認証済みユーザーのみ）
  const db = getDb();
  try {
    const userRows = await db.execute({
      sql: 'SELECT id, display_name FROM ipat_users WHERE id = ?',
      args: [userId],
    });
    if (userRows.rows.length === 0) {
      return NextResponse.json({ error: 'ユーザーが見つかりません。先にIPAT認証情報を登録してください。' }, { status: 404 });
    }

    const displayName = String(userRows.rows[0].display_name);

    const rows = await db.execute({
      sql: 'SELECT * FROM user_bet_configs WHERE user_id = ?',
      args: [userId],
    });

    if (rows.rows.length === 0) {
      // デフォルト設定を返す
      return NextResponse.json({
        displayName,
        config: {
          userId,
          dailyBudget: 3000,
          betTypes: { tansho: true, umaren: false, wide: false, umatan: false, sanrenpuku: false, sanrentan: false },
          strategies: { shoshan: true, ai: true, shoshan_ai: false },
          strategyWeights: { shoshan: 50, ai: 50 },
          minOdds: null,
          maxOdds: null,
          active: true,
        },
        isDefault: true,
      });
    }

    const row = rows.rows[0];
    return NextResponse.json({
      displayName,
      config: {
        userId: row.user_id,
        dailyBudget: Number(row.daily_budget),
        betTypes: JSON.parse(String(row.bet_types)),
        strategies: JSON.parse(String(row.strategies)),
        strategyWeights: JSON.parse(String(row.strategy_weights)),
        minOdds: row.min_odds != null ? Number(row.min_odds) : null,
        maxOdds: row.max_odds != null ? Number(row.max_odds) : null,
        active: Number(row.active) === 1,
      },
      isDefault: false,
    });
  } finally {
    db.close();
  }
}

// POST: 買い目設定を保存
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { userId, dailyBudget, betTypes, strategies, strategyWeights, minOdds, maxOdds, active } = body;

  if (!userId) {
    return NextResponse.json({ error: 'userId が必要です' }, { status: 400 });
  }
  if (!dailyBudget || dailyBudget < 100) {
    return NextResponse.json({ error: '予算は100円以上で設定してください' }, { status: 400 });
  }

  // 少なくとも1つの券種がON
  const typeValues = Object.values(betTypes || {});
  if (typeValues.length === 0 || !typeValues.some(v => v)) {
    return NextResponse.json({ error: '少なくとも1つの券種を選択してください' }, { status: 400 });
  }

  // 少なくとも1つの戦略がON
  const stratValues = Object.values(strategies || {});
  if (stratValues.length === 0 || !stratValues.some(v => v)) {
    return NextResponse.json({ error: '少なくとも1つの戦略を選択してください' }, { status: 400 });
  }

  const db = getDb();
  try {
    // ユーザー存在確認
    const userRows = await db.execute({
      sql: 'SELECT id FROM ipat_users WHERE id = ?',
      args: [userId],
    });
    if (userRows.rows.length === 0) {
      return NextResponse.json({ error: 'ユーザーが見つかりません' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const betTypesJson = JSON.stringify(betTypes);
    const strategiesJson = JSON.stringify(strategies);
    const weightsJson = JSON.stringify(strategyWeights || {});

    // UPSERT
    const existing = await db.execute({
      sql: 'SELECT user_id FROM user_bet_configs WHERE user_id = ?',
      args: [userId],
    });

    if (existing.rows.length > 0) {
      await db.execute({
        sql: `UPDATE user_bet_configs SET
          daily_budget = ?, bet_types = ?, strategies = ?, strategy_weights = ?,
          min_odds = ?, max_odds = ?, active = ?, updated_at = ?
          WHERE user_id = ?`,
        args: [dailyBudget, betTypesJson, strategiesJson, weightsJson, minOdds, maxOdds, active ? 1 : 0, now, userId],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO user_bet_configs (user_id, daily_budget, bet_types, strategies, strategy_weights, min_odds, max_odds, active, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [userId, dailyBudget, betTypesJson, strategiesJson, weightsJson, minOdds, maxOdds, active ? 1 : 0, now],
      });
    }

    return NextResponse.json({ success: true, message: '設定を保存しました' });
  } finally {
    db.close();
  }
}
