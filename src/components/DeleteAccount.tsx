"use client";

// プライバシーポリシーのページの「アカウントを消す」
import { useEffect, useState, useSyncExternalStore } from "react";
import { accountStore, api, initAccount, logout } from "@/lib/account";
import { AccountBox } from "./AccountBox";

export function DeleteAccount() {
  const acct = useSyncExternalStore(accountStore.subscribe, accountStore.get, accountStore.get);
  const [done, setDone] = useState("");
  useEffect(() => {
    initAccount();
  }, []);
  if (!acct.ready || !acct.available) return null;
  if (done) return <p className="soft" style={{ padding: "6px 10px", borderRadius: 6 }}>{done}</p>;
  return (
    <div style={{ marginTop: 6 }}>
      <AccountBox compact />
      {acct.me && acct.me.role !== "admin" && (
        <button
          style={{ marginTop: 8, color: "var(--danger)" }}
          onClick={async () => {
            if (!confirm("アカウントを消しますか？サーバーの印・メモ・サークルの登録が消えます（もとに戻せません）")) return;
            try {
              await api("me.php", { method: "DELETE" });
              await logout();
              setDone("アカウントを消しました");
            } catch (e) {
              setDone(e instanceof Error ? e.message : "消せませんでした");
            }
          }}
        >
          アカウントを消す
        </button>
      )}
    </div>
  );
}
