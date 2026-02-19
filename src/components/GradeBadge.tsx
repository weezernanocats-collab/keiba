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

  return (
    <span className={`inline-block rounded ${sizeClass} ${colorClass}`}>
      {grade}
    </span>
  );
}
