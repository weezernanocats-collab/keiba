export default function PredictionsLoading() {
  return (
    <div className="space-y-6 animate-fadeIn">
      {/* ヘッダー+タブスケルトン */}
      <div>
        <div className="h-8 w-32 bg-gray-200 dark:bg-gray-700 rounded mb-4 animate-pulse" />
        <div className="flex gap-4 border-b border-card-border pb-2">
          <div className="h-6 w-20 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
          <div className="h-6 w-20 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
        </div>
      </div>

      {/* レースカードスケルトン */}
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="bg-card-bg border border-card-border rounded-xl p-4 h-16 animate-pulse" />
      ))}
    </div>
  );
}
