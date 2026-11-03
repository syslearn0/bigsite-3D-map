"use client";

import { useEffect } from "react";

// この画面がこれまでに読み込んだ JS・CSS を、端末に持つようサービスワーカーに頼む（あとから読み込んだ 3D の部品も）
function cacheLoadedFiles() {
  navigator.serviceWorker.ready
    .then((reg) => {
      const urls = performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .filter((u) => u.includes("/_next/static/"));
      reg.active?.postMessage({ type: "cache-urls", urls: [...urls, location.pathname] });
    })
    .catch(() => {});
}

// サービスワーカーを登録し、この画面が読み込んだ JS・CSS を端末に持たせる（電波がなくても開けるように）。
// 開発中は登録しない（作り直した画面が古いまま出ないように）
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        cacheLoadedFiles();
        // 3D の部品が届いたころに、もう一度
        setTimeout(cacheLoadedFiles, 5000);
      })
      .catch(() => {});
  }, []);
  return null;
}
