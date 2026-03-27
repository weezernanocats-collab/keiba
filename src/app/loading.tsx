export default function HomeLoading() {
  return (
    <div className="space-y-8 animate-fadeIn">
      {/* ヒーロースケルトン */}
      <div className="bg-gradient-to-r from-primary to-primary-light rounded-2xl p-8 h-48" />

      {/* 統計スケルトン */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-card-bg border border-card-border rounded-xl p-4 h-24 animate-pulse" />
        ))}
      </div>

      {/* テーブルスケルトン */}
      <div className="bg-card-bg border border-card-border rounded-xl p-4">
        <div className="h-5 w-40 bg-gray-200 dark:bg-gray-700 rounded mb-4 animate-pulse" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 bg-gray-100 dark:bg-gray-800 rounded mb-2 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
