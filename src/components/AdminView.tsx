"use client";

import Link from "next/link";
// 作者の管理の画面：協力者の承認・停止、協力者の変更をまとめて戻す、サークルの登録の確認、地図に出すデータの公開
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { accountStore, api, initAccount, ROLE_LABEL, type Role } from "@/lib/account";
import { AccountBox } from "./AccountBox";

type User = { id: number; name: string; email: string; role: Role; created_at: number; last_login: number; edits: number };
type CircleRow = {
  id: number; day: number; codes: string[]; name: string; works: string[]; chars: Record<string, string[]>; x_account: string; url: string; image: string;
  status: "pending" | "approved" | "rejected"; note: string; user_name: string; user_email: string; updated_at: number;
};
type Hist = { id: number; day: number; code: string; before_data: string | null; after_data: string | null; user_name: string; created_at: number; reverted: number };
type Tab = "users" | "circles" | "history" | "publish";
const when = (t: number) => (t ? new Date(t * 1000).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" }) : "—");
const short = (d: string | null) => {
  if (!d) return "（なし）";
  try {
    const t = JSON.parse(d);
    return [t.genre, (t.works ?? []).join("・"), Object.values(t.chars ?? {}).flat().join("・")].filter(Boolean).join(" ／ ");
  } catch {
    return d;
  }
};

export function AdminView() {
  const acct = useSyncExternalStore(accountStore.subscribe, accountStore.get, accountStore.get);
  const [tab, setTab] = useState<Tab>("users");
  const [msg, setMsg] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [circles, setCircles] = useState<CircleRow[]>([]);
  const [hist, setHist] = useState<Hist[]>([]);
  const [histUser, setHistUser] = useState<number | null>(null);
  const [pub, setPub] = useState<{ published: Record<string, number | null>; hasLayout: boolean } | null>(null);
  const admin = acct.me?.role === "admin";
  useEffect(() => {
    initAccount();
  }, []);

  const reload = useCallback(async () => {
    try {
      if (tab === "users") setUsers((await api<{ users: User[] }>("admin.php?what=users")).users);
      if (tab === "circles") setCircles((await api<{ circles: CircleRow[] }>("admin.php?what=circles")).circles);
      if (tab === "history") setHist((await api<{ history: Hist[] }>(`admin.php?what=history${histUser ? `&user=${histUser}` : ""}`)).history);
      if (tab === "publish") setPub(await api("admin.php?what=published"));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "読み込めませんでした");
    }
  }, [tab, histUser]);
  useEffect(() => {
    // reload は、サーバーの返事を待ってから画面を変える（すぐには変えない）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (admin) reload();
  }, [admin, reload]);

  const post = async (body: Record<string, unknown>, done: string) => {
    try {
      const r = await api<Record<string, unknown>>("admin.php", { body });
      setMsg(typeof done === "string" ? done + ("reverted" in r ? `（戻した ${r.reverted}・あとでほかの人が変えていたので戻さなかった ${r.skipped}）` : "") : "");
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "できませんでした");
    }
  };

  const publish = (part: "tags" | "circles" | "layout", on: boolean) => {
    const name = { tags: "作品・キャラ", circles: "サークルの登録", layout: "配置" }[part];
    if (!confirm(on ? `${name}を公開しますか？だれでも見られるようになります（準備会の許可が要るデータは、許可が出てから）` : `${name}の公開をやめますか？`)) return;
    post({ action: "publish", parts: { [part]: on } }, on ? `${name}を公開しました` : `${name}の公開をやめました`);
  };

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "16px 16px 60px" }}>
      <h1 style={{ fontSize: "1.3rem", margin: "0 0 4px" }}>管理の画面</h1>
      <p style={{ margin: "0 0 12px" }}>
        <Link href="/">地図へ</Link>
      </p>
      <AccountBox compact />
      {acct.ready && !acct.available && <p>サーバーにつながりません（この画面は sokubai3d.textetc.net で開いてください）</p>}
      {acct.me && !admin && <p>この画面は作者だけが使えます。</p>}
      {admin && (
        <>
          <div className="seg" role="group" aria-label="画面" style={{ display: "flex", margin: "14px 0 10px", flexWrap: "wrap" }}>
            {(
              [
                ["users", "協力者・利用者"],
                ["circles", "サークルの登録"],
                ["history", "変更の履歴"],
                ["publish", "公開"],
              ] as const
            ).map(([t, l]) => (
              <button key={t} aria-pressed={tab === t} onClick={() => (setMsg(""), setTab(t))}>
                {l}
              </button>
            ))}
          </div>
          {msg && <p className="soft" style={{ padding: "6px 10px", borderRadius: 6 }}>{msg}</p>}

          {tab === "users" && (
            <div style={{ overflowX: "auto" }}>
              <table className="admin">
                <thead>
                  <tr>
                    <th>名前</th>
                    <th>メール</th>
                    <th>役わり</th>
                    <th>変更</th>
                    <th>最後のログイン</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name}</td>
                      <td style={{ fontSize: ".8rem" }}>{u.email}</td>
                      <td>{ROLE_LABEL[u.role]}</td>
                      <td>
                        {u.edits > 0 ? (
                          <button className="chip small" onClick={() => (setHistUser(u.id), setTab("history"))}>
                            {u.edits} 件
                          </button>
                        ) : (
                          0
                        )}
                      </td>
                      <td style={{ fontSize: ".8rem" }}>{when(u.last_login)}</td>
                      <td style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {u.role !== "admin" && (
                          <>
                            {u.role !== "collab" && u.role !== "banned" && (
                              <button className="chip small" onClick={() => post({ action: "role", id: u.id, role: "collab" }, `${u.name} を協力者にしました`)}>
                                協力者にする
                              </button>
                            )}
                            {u.role === "collab" && (
                              <button className="chip small" onClick={() => post({ action: "role", id: u.id, role: "user" }, `${u.name} を利用者に戻しました`)}>
                                協力者をやめる
                              </button>
                            )}
                            {u.role !== "banned" ? (
                              <button
                                className="chip small"
                                onClick={() => confirm(`${u.name} を止めますか？ログインできなくなります`) && post({ action: "role", id: u.id, role: "banned" }, `${u.name} を止めました`)}
                              >
                                止める
                              </button>
                            ) : (
                              <button className="chip small" onClick={() => post({ action: "role", id: u.id, role: "user" }, `${u.name} の停止を解きました`)}>
                                停止を解く
                              </button>
                            )}
                            {u.edits > 0 && (
                              <button
                                className="chip small"
                                onClick={() =>
                                  confirm(`${u.name} の変更（${u.edits} 件）をまとめて戻しますか？`) && post({ action: "revert_user", id: u.id }, `${u.name} の変更を戻しました`)
                                }
                              >
                                変更をまとめて戻す
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === "circles" && (
            <div style={{ display: "grid", gap: 10 }}>
              {!circles.length && <p>まだ登録はありません。</p>}
              {circles.map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 12, padding: 10, border: "1px solid var(--line)", borderRadius: 8, background: c.status === "pending" ? "color-mix(in srgb, #f2b400 16%, var(--card))" : "var(--card)" }}>
                  {c.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/image.php?id=${c.id}`} alt="" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 6, flex: "none", background: "#eee" }} />
                  ) : (
                    <div style={{ width: 96, height: 96, borderRadius: 6, background: "#eee", flex: "none", display: "grid", placeItems: "center", color: "var(--muted)", fontSize: ".8rem" }}>
                      画像なし
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0, fontSize: ".9rem" }}>
                    <div>
                      <strong>{c.name}</strong>　{c.day}日目　{c.codes.join("・")}
                      <span className="tag" style={{ marginLeft: 6 }}>
                        {{ pending: "出ている", approved: "出ている", rejected: "止めた" }[c.status]}
                      </span>
                    </div>
                    <div>作品：{c.works.join("・") || "—"}</div>
                    {Object.keys(c.chars).length > 0 && <div>キャラ：{Object.values(c.chars).flat().join("・")}</div>}
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {c.x_account && (
                        <a href={`https://x.com/${c.x_account}`} target="_blank" rel="noopener noreferrer">
                          @{c.x_account}
                        </a>
                      )}
                      {c.url && (
                        <a href={c.url} target="_blank" rel="noopener noreferrer">
                          {c.url}
                        </a>
                      )}
                    </div>
                    <div style={{ color: "var(--muted)", fontSize: ".8rem" }}>
                      登録した人：{c.user_name}（{c.user_email}）・{when(c.updated_at)}
                      {c.note && `・メモ：${c.note}`}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      {c.status !== "approved" && (
                        <button className="chip small" onClick={() => post({ action: "circle", id: c.id, status: "approved" }, `${c.name} を地図に出しました（サークルの登録を公開中のとき）`)}>
                          出す
                        </button>
                      )}
                      <button
                        className="chip small"
                        onClick={() =>
                          confirm(`${c.name}（${c.codes.join("・")}）の登録を消しますか？消すと、同じ配置番号をほかの人が登録できるようになります（もとに戻せません）`) &&
                          post({ action: "delete_circle", id: c.id }, `${c.name} の登録を消しました`)
                        }
                      >
                        消す
                      </button>
                      {c.status !== "rejected" && (
                        <button
                          className="chip small"
                          onClick={() => {
                            const note = prompt("止める理由（本人に見えます。空でもよい）", "");
                            if (note !== null) post({ action: "circle", id: c.id, status: "rejected", note }, `${c.name} を止めました（地図から外しました）`);
                          }}
                        >
                          止める
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "history" && (
            <>
              {histUser && (
                <p>
                  1 人の変更だけを出しています。
                  <button className="chip small" onClick={() => setHistUser(null)}>
                    全員の変更を出す
                  </button>
                </p>
              )}
              <div style={{ overflowX: "auto" }}>
                <table className="admin">
                  <thead>
                    <tr>
                      <th>時刻</th>
                      <th>人</th>
                      <th>日</th>
                      <th>配置番号</th>
                      <th>前</th>
                      <th>後</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hist.map((h) => (
                      <tr key={h.id} style={h.reverted ? { color: "var(--muted)", textDecoration: "line-through" } : undefined}>
                        <td style={{ fontSize: ".8rem" }}>{when(h.created_at)}</td>
                        <td>{h.user_name}</td>
                        <td>{h.day}</td>
                        <td>{h.code}</td>
                        <td style={{ fontSize: ".8rem" }}>{short(h.before_data)}</td>
                        <td style={{ fontSize: ".8rem" }}>{short(h.after_data)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === "publish" && pub && (
            <div style={{ display: "grid", gap: 10 }}>
              <p style={{ color: "var(--muted)", fontSize: ".85rem", margin: 0 }}>
                公開すると、地図（だれでも見られる）が読むファイルを書き出します。協力者があとで変えた分は、もう一度「公開」を押すまで地図に出ません。サークルの登録は、公開中なら、送られるとすぐに地図に出ます（止めたものをのぞく）。
              </p>
              {(
                [
                  ["tags", "作品・キャラ（協力者が入れたもの）"],
                  ["circles", "サークルの登録（止めたものをのぞく）"],
                  ["layout", "配置（エディタの「配置をサーバーに置く」で置いたもの）"],
                ] as const
              ).map(([p, label]) => (
                <div key={p} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: 10, border: "1px solid var(--line)", borderRadius: 8 }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <strong>{label}</strong>
                    <div style={{ fontSize: ".8rem", color: "var(--muted)" }}>
                      {pub.published[p] ? `公開中（${when(pub.published[p]!)} に書き出し）` : "公開していません"}
                      {p === "layout" && !pub.hasLayout && "・サーバーに配置がまだありません"}
                    </div>
                  </div>
                  <button className="chip" disabled={p === "layout" && !pub.hasLayout} onClick={() => publish(p, true)}>
                    {pub.published[p] ? "いまの内容で公開しなおす" : "公開する"}
                  </button>
                  {pub.published[p] && (
                    <button className="chip" onClick={() => publish(p, false)}>
                      公開をやめる
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
