import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SwRegister } from "./SwRegister";

export const metadata: Metadata = {
  title: "即売会 3D マップ（見本）",
  description: "東京ビッグサイトの会場を 3D で見て、行きたいサークルの計画を立てる（コミックマーケット準備会・株式会社東京ビッグサイトとは関係のない非公式の試作）",
  // ブラウザのタブのアイコン（favicon）と、iPhone でホーム画面に追加したときのアイコン
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: { title: "3D マップ" },
  // X（Twitter）・LINE などでリンクを貼ったときに出るカード（画像・題・説明）
  metadataBase: new URL("https://sokubai3d.textetc.net"),
  openGraph: {
    type: "website",
    locale: "ja_JP",
    siteName: "即売会 3D マップ",
    title: "即売会 3D マップ",
    description: "東京ビッグサイトを立体で見て・歩いて、行きたいサークルを探せる地図（非公式の試作）",
    url: "/",
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "即売会 3D マップ：東京ビッグサイトの立体の地図" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "即売会 3D マップ",
    description: "東京ビッグサイトを立体で見て・歩いて、行きたいサークルを探せる地図（非公式の試作）",
    images: ["/og.jpg"],
  },
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
