'use client';

interface FavoriteButtonProps {
  isFavorite: boolean;
  onToggle: () => void;
  size?: 'sm' | 'md';
  showLabel?: boolean;
}

export default function FavoriteButton({ isFavorite, onToggle, size = 'md', showLabel = false }: FavoriteButtonProps) {
  const sizeClass = size === 'sm'
    ? 'px-2 py-1 text-sm gap-1'
    : 'px-3 py-1.5 text-base gap-1.5';

  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={`${sizeClass} inline-flex items-center rounded-lg border font-medium transition-all hover:scale-105 ${
        isFavorite
          ? 'bg-yellow-50 border-yellow-400 text-yellow-600 dark:bg-yellow-900/20 dark:border-yellow-600 dark:text-yellow-400'
          : 'bg-gray-50 border-gray-300 text-gray-400 hover:border-yellow-400 hover:text-yellow-500 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-500'
      }`}
      aria-label={isFavorite ? 'お気に入り解除' : 'お気に入り登録'}
      title={isFavorite ? 'お気に入り解除' : 'お気に入り登録'}
    >
      <span>{isFavorite ? '\u2605' : '\u2606'}</span>
      {showLabel && (
        <span className="text-xs">{isFavorite ? '登録済み' : 'お気に入り'}</span>
      )}
    </button>
  );
}
