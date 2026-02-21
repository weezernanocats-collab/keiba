import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3はネイティブモジュールなのでサーバーサイドのみ使用
  serverExternalPackages: ['better-sqlite3'],
  // Docker用のstandalone出力
  output: 'standalone',
};

export default nextConfig;
