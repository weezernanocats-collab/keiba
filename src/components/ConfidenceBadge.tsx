/**
 * AI信頼度バッジ
 * 予想の信頼度をカラーコードで表示するバッジコンポーネント
 */

interface ConfidenceBadgeProps {
  value: number | null;
  /** nullの場合に表示するプレースホルダー (デフォルト: "---") */
  placeholder?: string;
}

export default function ConfidenceBadge({ value, placeholder = '---' }: ConfidenceBadgeProps) {
  if (value == null) {
    return <span className="text-xs text-muted">{placeholder}</span>;
  }

  const color =
    value >= 70
      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
      : value >= 50
        ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
        : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';

  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${color}`}>
      {value}%
    </span>
  );
}
