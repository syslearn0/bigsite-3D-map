"use client";

// サイドバーのログインの欄（任意）。ログインすると、印・メモ・「行った」をほかの端末と合わせる。
// サーバーがないとき（開発中など）は何も出さない
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { accountStore, initAccount, logout, renderLoginButton, ROLE_LABEL } from "@/lib/account";
import { syncStatusStore } from "@/lib/sync";

export function AccountBox({ compact }: { compact?: boolean }) {
  const acct = useSyncExternalStore(accountStore.subscribe, accountStore.get, accountStore.get);
  const sync = useSyncExternalStore(syncStatusStore.subscribe, syncStatusStore.get, syncStatusStore.get);
  const btn = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    initAccount();
  }, []);
  useEffect(() => {
    if (acct.available && !acct.me && btn.current) renderLoginButton(btn.current, setErr).catch((e) => setErr(e.message));
  }, [acct.available, acct.me]);
  if (!acct.ready || !acct.available) return null;
  const syncText = { off: "", syncing: "合わせています…", ok: "ほかの端末と合わせました", error: "合わせられませんでした（電波のある所でまた試します）" }[sync];
  return (
    <div>
      {acct.me ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: ".9rem" }}>
              {acct.me.name || acct.me.email}
              <span className="tag" style={{ marginLeft: 6 }}>
                {ROLE_LABEL[acct.me.role]}
              </span>
            </span>
            <button className="chip small" style={{ marginLeft: "auto" }} onClick={() => logout()}>
              ログアウト
            </button>
          </div>
          {!compact && syncText && <p style={{ color: sync === "error" ? "var(--danger)" : "var(--muted)", fontSize: ".75rem", margin: "4px 0 0" }}>{syncText}</p>}
          {acct.me.role === "admin" && (
            <p style={{ fontSize: ".8rem", margin: "6px 0 0" }}>
              <a href="/admin/">管理の画面</a>
            </p>
          )}
        </>
      ) : (
        <>
          {!compact && (
            <p style={{ color: "var(--muted)", fontSize: ".75rem", margin: "0 0 6px" }}>
              任意です。Google でログインすると、★・◆ の印・メモ・使う金額・「行った」を、スマホとパソコンなどほかの端末と合わせられます。
            </p>
          )}
          <div ref={btn} style={{ minHeight: 44 }} />
          {err && <p style={{ color: "var(--danger)", fontSize: ".75rem", margin: "4px 0 0" }}>{err}</p>}
        </>
      )}
    </div>
  );
}
