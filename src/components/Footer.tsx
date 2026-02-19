import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="bg-primary text-white/80 mt-12">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div>
            <h3 className="font-bold text-white text-lg mb-3">🏇 KEIBA MASTER</h3>
            <p className="text-sm leading-relaxed">
              AI搭載の競馬総合情報サイト。中央競馬・地方競馬の最新情報と
              高精度予想をお届けします。
            </p>
          </div>
          <div>
            <h4 className="font-bold text-white mb-3">コンテンツ</h4>
            <ul className="space-y-2 text-sm">
              <li><Link href="/races" className="hover:text-white transition-colors">レース一覧</Link></li>
              <li><Link href="/horses" className="hover:text-white transition-colors">馬情報</Link></li>
              <li><Link href="/jockeys" className="hover:text-white transition-colors">騎手情報</Link></li>
              <li><Link href="/predictions" className="hover:text-white transition-colors">AI予想</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-white mb-3">ご注意</h4>
            <p className="text-sm leading-relaxed">
              本サイトの予想は過去データに基づくAI分析結果です。
              馬券の購入は自己責任でお願いいたします。
              ギャンブル依存症にご注意ください。
            </p>
          </div>
        </div>
        <div className="border-t border-white/20 mt-8 pt-4 text-center text-sm">
          <p>&copy; 2026 KEIBA MASTER. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
