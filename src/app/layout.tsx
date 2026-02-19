import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "競馬予想AI - KEIBA MASTER",
  description: "AI搭載の競馬総合情報サイト。中央競馬・地方競馬のレース予定、出馬表、オッズ、過去成績、AI予想を提供します。",
  keywords: "競馬, 予想, AI, 中央競馬, 地方競馬, 出馬表, オッズ, 東京競馬",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
