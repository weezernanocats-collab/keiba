'use client';

interface FavoriteButtonProps {
  isFavorite: boolean;
  onToggle: () => void;
  size?: 'sm' | 'md';
}

export default function FavoriteButton({ isFavorite, onToggle, size = 'md' }: FavoriteButtonProps) {
  const sizeClass = size === 'sm' ? 'w-6 h-6 text-sm' : 'w-8 h-8 text-lg';

  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={`${sizeClass} flex items-center justify-center rounded-full transition-all hover:scale-110 ${
        isFavorite
          ? 'text-yellow-500'
          : 'text-gray-300 hover:text-yellow-400 dark:text-gray-600'
      }`}
      aria-label={isFavorite ? 'お気に入り解除' : 'お気に入り登録'}
      title={isFavorite ? 'お気に入り解除' : 'お気に入り登録'}
    >
      {isFavorite ? '\u2605' : '\u2606'}
    </button>
  );
}
