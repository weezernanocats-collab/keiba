export default function LoadingSpinner({ message = '読み込み中...' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
      <p className="mt-4 text-muted text-sm">{message}</p>
    </div>
  );
}
