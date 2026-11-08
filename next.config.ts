import type { NextConfig } from "next";

// 全部のページを最初に作っておく作りなので、ふつうのファイルとして書き出す（out/）。
// Xserver（Node なし）にそのまま置ける。Vercel もこのまま動く。
// trailingSlash：/editor を editor/index.html にする（Apache で /editor/ が開けるように）
const nextConfig: NextConfig = { output: "export", trailingSlash: true };

export default nextConfig;
