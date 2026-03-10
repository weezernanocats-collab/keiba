'use client';

import { useState, useRef, useEffect } from 'react';
import { PROFILES, type Profile } from '@/lib/use-favorites';

interface FavoriteProfilePopoverProps {
  /** 各プロフィールでお気に入り済みかチェックする関数 */
  checkFavorite: (profile: Profile) => boolean;
  /** 指定プロフィールでトグルする関数 */
  onToggle: (profile: Profile) => void;
  size?: 'sm' | 'md';
}

export default function FavoriteProfilePopover({
  checkFavorite,
  onToggle,
  size = 'md',
}: FavoriteProfilePopoverProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const anyFavorite = PROFILES.some(p => checkFavorite(p));

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const sizeClass = size === 'sm'
    ? 'px-2 py-1 text-sm gap-1'
    : 'px-3 py-1.5 text-base gap-1.5';

  return (
    <div className="relative inline-block" ref={popoverRef}>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(prev => !prev);
        }}
        className={`${sizeClass} inline-flex items-center rounded-lg border font-medium transition-all hover:scale-105 ${
          anyFavorite
            ? 'bg-yellow-50 border-yellow-400 text-yellow-600 dark:bg-yellow-900/20 dark:border-yellow-600 dark:text-yellow-400'
            : 'bg-gray-50 border-gray-300 text-gray-400 hover:border-yellow-400 hover:text-yellow-500 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-500'
        }`}
        aria-label="お気に入り登録"
        title="お気に入り登録"
      >
        <span>{anyFavorite ? '\u2605' : '\u2606'}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 min-w-[140px]">
          <div className="px-3 py-1.5 text-xs text-muted border-b border-gray-100 dark:border-gray-700">
            プロフィール選択
          </div>
          {PROFILES.map(p => {
            const checked = checkFavorite(p);
            return (
              <button
                key={p}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle(p);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
              >
                <span className={`w-4 h-4 flex items-center justify-center rounded border text-xs ${
                  checked
                    ? 'bg-yellow-400 border-yellow-500 text-white dark:bg-yellow-500'
                    : 'border-gray-300 dark:border-gray-600'
                }`}>
                  {checked ? '\u2713' : ''}
                </span>
                <span className={checked ? 'font-medium' : ''}>{p}</span>
                {checked && (
                  <span className="ml-auto text-yellow-500 text-xs">{'\u2605'}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
