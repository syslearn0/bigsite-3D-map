"use client";

import dynamic from "next/dynamic";

// 島のエディタ。端末の保存（localStorage）と canvas を使うので、ブラウザだけで描く
export default dynamic(() => import("@/components/IslandEditor").then((m) => m.IslandEditor), { ssr: false });
