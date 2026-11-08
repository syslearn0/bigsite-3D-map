import type { Metadata } from "next";
import { AdminPage } from "@/components/ClientPages";

export const metadata: Metadata = { title: "管理 | 即売会 3D マップ", robots: { index: false, follow: false } };

export default function Page() {
  return <AdminPage />;
}
