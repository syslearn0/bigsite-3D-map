"use client";

// 端末の保存（localStorage）を読む画面は、ブラウザだけで描く
import dynamic from "next/dynamic";

export const CirclePage = dynamic(() => import("./CircleForm").then((m) => m.CircleForm), { ssr: false });
export const AdminPage = dynamic(() => import("./AdminView").then((m) => m.AdminView), { ssr: false });
