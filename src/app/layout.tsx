import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SwRegister } from "./SwRegister";

export const metadata: Metadata = {
  title: "コミケ 3D マップ（見本）",
  description: "東京ビッグサイトの会場を 3D で見て、行きたいサークルの計画を立てる（コミックマーケット準備会とは関係のない非公式の試作）",
  // iPhone でホーム画面に追加したときのアイコン
  icons: { apple: "/apple-touch-icon.png" },
  appleWebApp: { title: "3D マップ" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1f3f7a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
