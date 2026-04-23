'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';

const PROFILE_KEY = 'keiba-active-profile';

export default function Header() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeProfile, setActiveProfile] = useState<string | null>(null);

  useEffect(() => {
    const profile = localStorage.getItem(PROFILE_KEY);
    setActiveProfile(profile);
  }, []);

  const navItems = [
    { href: '/', label: 'トップ' },
    { href: '/races', label: 'レース一覧' },
    { href: '/horses', label: '馬情報' },
    { href: '/jockeys', label: '騎手情報' },
    { href: '/predictions', label: 'AI予想' },
    { href: '/stats', label: '的中率分析' },
    { href: '/betting', label: '馬券セット' },
    { href: '/favorites', label: 'お気に入り' },
    { href: '/calendar', label: 'カレンダー' },
  ];

  return (
    <header className="bg-primary text-white shadow-lg sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="flex items-center gap-2 font-bold text-xl">
            <span className="text-2xl">🏇</span>
            <span>KEIBA MASTER</span>
          </Link>

          {/* デスクトップナビ */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const isActive = item.href === '/'
                ? pathname === '/'
                : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-4 py-2 rounded-lg transition-colors text-sm font-medium ${
                    isActive
                      ? 'bg-white/20 text-white'
                      : 'hover:bg-white/10 text-white/75'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {activeProfile && (
              <span className="ml-2 px-2 py-1 bg-white/15 rounded text-xs font-medium">
                {activeProfile}
              </span>
            )}
          </nav>

          {/* モバイルメニューボタン */}
          <button
            className="md:hidden p-2 rounded-lg hover:bg-white/10"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="メニュー"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>

        {/* モバイルナビ */}
        {menuOpen && (
          <nav className="md:hidden pb-4 animate-fadeIn">
            {navItems.map((item) => {
              const isActive = item.href === '/'
                ? pathname === '/'
                : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`block px-4 py-3 rounded-lg transition-colors ${
                    isActive ? 'bg-white/20 font-bold' : 'hover:bg-white/10 text-white/75'
                  }`}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </Link>
              );
            })}
            {activeProfile && (
              <div className="px-4 py-2 text-xs text-white/70">
                プロフィール: {activeProfile}
              </div>
            )}
          </nav>
        )}
      </div>
    </header>
  );
}
