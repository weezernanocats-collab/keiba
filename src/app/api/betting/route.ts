import { NextRequest, NextResponse } from 'next/server';
import { dbAll, dbRun, dbGet } from '@/lib/database';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const date = searchParams.get('date');
    const userId = searchParams.get('userId') || 'default';
    const status = searchParams.get('status');

    let sql = 'SELECT * FROM bet_targets WHERE user_id = ?';
    const args: unknown[] = [userId];

    if (date) {
      sql += ' AND date = ?';
      args.push(date);
    }
    if (status) {
      sql += ' AND status = ?';
      args.push(status);
    }

    sql += ' ORDER BY date DESC, created_at DESC';

    const rows = await dbAll(sql, args);
    const targets = (rows as Record<string, unknown>[]).map(row => ({
      ...row,
      combinations: JSON.parse(row.combinations as string),
      resultJson: row.result_json ? JSON.parse(row.result_json as string) : null,
    }));

    return NextResponse.json({ targets });
  } catch (error) {
    console.error('買い目取得エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      userId = 'default',
      date,
      raceId,
      raceLabel,
      betType,
      combinations,
      budget,
      minSyntheticOdds = 2.5,
      autoDistribute = true,
    } = body;

    if (!date || !raceLabel || !betType || !combinations || !budget) {
      return NextResponse.json(
        { error: 'date, raceLabel, betType, combinations, budget は必須です' },
        { status: 400 },
      );
    }

    await dbRun(
      `INSERT INTO bet_targets (user_id, date, race_id, race_label, bet_type, combinations, budget, min_synthetic_odds, auto_distribute)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, date, raceId || null, raceLabel, betType, JSON.stringify(combinations), budget, minSyntheticOdds, autoDistribute ? 1 : 0],
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('買い目登録エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'id は必須です' }, { status: 400 });
    }

    const setClauses: string[] = [];
    const args: unknown[] = [];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      args.push(updates.status);
    }
    if (updates.combinations !== undefined) {
      setClauses.push('combinations = ?');
      args.push(JSON.stringify(updates.combinations));
    }
    if (updates.budget !== undefined) {
      setClauses.push('budget = ?');
      args.push(updates.budget);
    }
    if (updates.minSyntheticOdds !== undefined) {
      setClauses.push('min_synthetic_odds = ?');
      args.push(updates.minSyntheticOdds);
    }
    if (updates.resultJson !== undefined) {
      setClauses.push('result_json = ?');
      args.push(JSON.stringify(updates.resultJson));
    }

    setClauses.push("updated_at = datetime('now')");
    args.push(id);

    await dbRun(
      `UPDATE bet_targets SET ${setClauses.join(', ')} WHERE id = ?`,
      args,
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('買い目更新エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id は必須です' }, { status: 400 });
    }

    await dbRun('DELETE FROM bet_targets WHERE id = ?', [parseInt(id)]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('買い目削除エラー:', error);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
