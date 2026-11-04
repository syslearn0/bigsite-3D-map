import type { MetadataRoute } from "next";

// ホーム画面に追加したアプリとしての設定
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "コミケ 3D マップ（見本）",
    short_name: "3D マップ",
    description: "東京ビッグサイトの会場を 3D で見て、行きたいサークルの計画を立てる（コミックマーケット準備会とは関係のない非公式の試作）",
    start_url: "/",
    display: "standalone",
    background_color: "#e9ece9",
    theme_color: "#1f3f7a",
    lang: "ja",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
