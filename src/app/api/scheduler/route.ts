import { NextRequest, NextResponse } from 'next/server';
import {
  getSchedulerStatus,
  startScheduler,
  stopScheduler,
  updateSchedulerConfig,
  runSchedulerJob,
} from '@/lib/scheduler';

function isAuthorized(request: NextRequest): boolean {
  const syncKey = process.env.SYNC_KEY;
  if (!syncKey) return true;
  const provided = request.headers.get('x-sync-key');
  return provided === syncKey;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: '認証エラー' }, { status: 401 });
  }
  return NextResponse.json(getSchedulerStatus());
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: '認証エラー' }, { status: 401 });
  }

  let body: { action: string; config?: Record<string, unknown>; job?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON形式で送信してください' }, { status: 400 });
  }

  const { action, config, job } = body;

  switch (action) {
    case 'start':
      startScheduler(config as Parameters<typeof startScheduler>[0]);
      return NextResponse.json({ message: 'スケジューラーを開始しました', status: getSchedulerStatus() });

    case 'stop':
      stopScheduler();
      return NextResponse.json({ message: 'スケジューラーを停止しました', status: getSchedulerStatus() });

    case 'update_config':
      if (config) updateSchedulerConfig(config as Parameters<typeof updateSchedulerConfig>[0]);
      return NextResponse.json({ message: '設定を更新しました', status: getSchedulerStatus() });

    case 'run_job':
      if (!job || !['morning', 'odds', 'results', 'night'].includes(job)) {
        return NextResponse.json({ error: '有効なjob: morning, odds, results, night' }, { status: 400 });
      }
      runSchedulerJob(job as 'morning' | 'odds' | 'results' | 'night').catch(err => {
        console.error('スケジューラージョブエラー:', err);
      });
      return NextResponse.json({ message: `ジョブ "${job}" を開始しました`, status: getSchedulerStatus() });

    default:
      return NextResponse.json({ error: '有効なaction: start, stop, update_config, run_job' }, { status: 400 });
  }
}
