'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, Suspense } from 'react';

function RegisterForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [status, setStatus] = useState<'loading' | 'ready' | 'submitting' | 'done' | 'error'>('loading');
  const [displayName, setDisplayName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [inetId, setInetId] = useState('');
  const [memberNo, setMemberNo] = useState('');
  const [password, setPassword] = useState('');
  const [parsNo, setParsNo] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrorMsg('招待トークンが必要です。管理者からURLを受け取ってください。');
      return;
    }
    fetch(`/api/register-ipat?token=${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setStatus('error');
          setErrorMsg(data.error);
        } else {
          setDisplayName(data.displayName);
          setStatus('ready');
        }
      })
      .catch(() => {
        setStatus('error');
        setErrorMsg('通信エラー');
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inetId || !memberNo || !password || !parsNo) {
      setErrorMsg('全項目を入力してください');
      return;
    }
    setStatus('submitting');
    setErrorMsg('');

    try {
      const res = await fetch('/api/register-ipat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, inetId, memberNo, password, parsNo }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus('done');
        // フォームの値をクリア（メモリから消す）
        setInetId('');
        setMemberNo('');
        setPassword('');
        setParsNo('');
      } else {
        setStatus('ready');
        setErrorMsg(data.error || '登録に失敗しました');
      }
    } catch {
      setStatus('ready');
      setErrorMsg('通信エラー');
    }
  };

  if (status === 'loading') {
    return <div className="text-center py-20 text-gray-500">読み込み中...</div>;
  }

  if (status === 'error') {
    return (
      <div className="max-w-md mx-auto mt-16 p-6 bg-red-50 border border-red-200 rounded-lg">
        <h2 className="text-lg font-bold text-red-700 mb-2">エラー</h2>
        <p className="text-red-600">{errorMsg}</p>
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="max-w-md mx-auto mt-16 p-6 bg-green-50 border border-green-200 rounded-lg text-center">
        <h2 className="text-xl font-bold text-green-700 mb-2">登録完了</h2>
        <p className="text-green-600">{displayName}さんのIPAT情報が安全に保存されました。</p>
        <p className="text-sm text-gray-500 mt-4">このページを閉じてください。</p>
        <p className="text-xs text-gray-400 mt-2">認証情報はAES-256-GCMで暗号化されています。</p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto mt-10 p-6">
      <h1 className="text-xl font-bold mb-2">IPAT認証情報の登録</h1>
      <p className="text-sm text-gray-600 mb-1">{displayName}さん用の登録フォームです。</p>
      <p className="text-xs text-gray-400 mb-6">
        入力された情報はAES-256-GCMで暗号化されてサーバーに保存されます。平文は保存されません。
      </p>

      {errorMsg && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-600 text-sm">
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">INET-ID（8桁英数字）</label>
          <input
            type="text"
            value={inetId}
            onChange={e => setInetId(e.target.value)}
            maxLength={8}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="例: AB123456"
            autoComplete="off"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">加入者番号（8桁）</label>
          <input
            type="text"
            value={memberNo}
            onChange={e => setMemberNo(e.target.value)}
            maxLength={8}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="例: 12345678"
            autoComplete="off"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">暗証番号（4桁）</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            maxLength={4}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="****"
            autoComplete="off"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">P-ARS番号（4桁）</label>
          <input
            type="password"
            value={parsNo}
            onChange={e => setParsNo(e.target.value)}
            maxLength={4}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="****"
            autoComplete="off"
          />
        </div>

        <button
          type="submit"
          disabled={status === 'submitting'}
          className="w-full py-2 px-4 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {status === 'submitting' ? '登録中...' : '登録する'}
        </button>
      </form>

      <p className="text-xs text-gray-400 mt-6 text-center">
        このリンクは1回のみ有効です。
      </p>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="text-center py-20 text-gray-500">読み込み中...</div>}>
      <RegisterForm />
    </Suspense>
  );
}
