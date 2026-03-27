export default function PredictionLoading() {
  return (
    <div className="space-y-6 animate-fadeIn">
      {/* ヘッダースケルトン */}
      <div className="bg-gradient-to-r from-primary to-primary-light rounded-2xl p-6 h-32" />

      {/* ナビスケルトン */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-8 w-20 bg-gray-200 dark:bg-gray-700 rounded-full animate-pulse flex-shrink-0" />
        ))}
      </div>

      {/* メインコンテンツスケルトン */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card-bg border border-card-border rounded-xl p-4 h-48 animate-pulse" />
        ))}
      </div>

      {/* テーブルスケルトン */}
      <div className="bg-card-bg border border-card-border rounded-xl p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-12 bg-gray-100 dark:bg-gray-800 rounded mb-2 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
