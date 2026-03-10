interface GradeBadgeProps {
  grade?: string | null;
  size?: 'sm' | 'md';
}

export default function GradeBadge({ grade, size = 'md' }: GradeBadgeProps) {
  if (!grade) return null;

  const sizeClass = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-sm px-2 py-1';

  let colorClass = 'bg-gray-200 text-gray-700';
  if (grade === 'G1') colorClass = 'grade-g1';
  else if (grade === 'G2') colorClass = 'grade-g2';
  else if (grade === 'G3') colorClass = 'grade-g3';
  else if (grade === 'リステッド') colorClass = 'bg-purple-100 text-purple-800';
  else if (grade === 'オープン') colorClass = 'bg-blue-100 text-blue-800';
  else if (grade === '3勝クラス') colorClass = 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300';
  else if (grade === '2勝クラス') colorClass = 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300';
  else if (grade === '1勝クラス') colorClass = 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300';
  else if (grade === '未勝利') colorClass = 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  else if (grade === '新馬') colorClass = 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300';

  return (
    <span className={`inline-block rounded ${sizeClass} ${colorClass}`}>
      {grade}
    </span>
  );
}
