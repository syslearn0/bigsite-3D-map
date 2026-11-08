import type { Metadata } from "next";
import { CirclePage } from "@/components/ClientPages";

export const metadata: Metadata = { title: "サークルの登録 | 即売会 3D マップ", description: "サークルの方が、配置番号・サークル名・作品・画像を登録する画面です" };

export default function Page() {
  return <CirclePage />;
}
