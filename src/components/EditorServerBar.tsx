"use client";

// 島のエディタの、サーバーとのやりとりの帯。協力者は作品・キャラをサーバーに保存し、ほかの協力者の分を読み込む。
// 保存は「前にサーバーから読んだとき」との差だけを送る（ほかの人が同じ時に別の机を入れても消さない）。
// 作者は、配置をサーバーに置ける（公開は管理の画面で）
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { accountStore, api, ApiError, refreshMe } from "@/lib/account";
import { toLayoutFile, type LayoutFeatures, type Line } from "@/lib/layout";
import { DAYS, parseTagsFile, toTagsFile, type SpaceTag, type Tags } from "@/lib/tags";
import { AccountBox } from "./AccountBox";

const BASE_KEY = "comiket3d:tags-server-base"; // 前にサーバーから読んだときの作品・キャラ（差を出すため）

const norm = (t: SpaceTag | undefined) => (t && (t.genre || t.works?.length) ? JSON.stringify({ genre: t.genre, works: t.works, chars: t.chars }) : "");
function fromServer(days: unknown): Tags {
  return parseTagsFile({ format: "comiket3d-tags", days }) ?? {};
}
function readBase(): Tags | null {
  try {
    return parseTagsFile(JSON.parse(localStorage.getItem(BASE_KEY) ?? "null"));
  } catch {
    return null;
  }
}
function writeBase(t: Tags) {
  try {
    localStorage.setItem(BASE_KEY, JSON.stringify(toTagsFile(t)));
  } catch {}
}

export function EditorServerBar({
  tags,
  setTags,
  lines,
  features,
  setLayout,
}: {
  tags: Tags;
  setTags: (t: Tags) => void;
  lines: Line[];
  features: LayoutFeatures | null;
  setLayout: (json: unknown) => void;
}) {
  const acct = useSyncExternalStore(accountStore.subscribe, accountStore.get, accountStore.get);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const role = acct.me?.role;
  const can = role === "collab" || role === "admin";
  const loadedOnce = useRef(false);

  // 変えた机の数（前にサーバーから読んだときとの差）
  const base = readBase();
  let pending = 0;
  if (base) for (const d of DAYS) for (const code of new Set([...Object.keys(tags[d] ?? {}), ...Object.keys(base[d] ?? {})])) if (norm(tags[d]?.[code]) !== norm(base[d]?.[code])) pending++;

  const load = async (quiet = false) => {
    setBusy(true);
    try {
      const r = await api<{ days: unknown }>("tags.php");
      const server = fromServer(r.days);
      // 手元でまだ送っていない変更は残して、ほかは サーバーのものにする
      const b = readBase() ?? {};
      const merged: Tags = {};
      for (const d of DAYS) {
        merged[d] = { ...(server[d] ?? {}) };
        for (const code of new Set([...Object.keys(tags[d] ?? {}), ...Object.keys(b[d] ?? {})]))
          if (norm(tags[d]?.[code]) !== norm(b[d]?.[code])) {
            if (tags[d]?.[code]) merged[d][code] = tags[d][code];
            else delete merged[d][code];
          }
      }
      writeBase(server);
      setTags(merged);
      const n = DAYS.reduce((a, d) => a + Object.keys(server[d] ?? {}).length, 0);
      if (!quiet) setMsg(`サーバーの作品・キャラを読み込みました（${n} スペース）`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "読み込めませんでした");
    }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      const latest = fromServer((await api<{ days: unknown }>("tags.php")).days);
      const b = readBase() ?? {};
      let saved = 0, clash = 0;
      const next: Tags = {};
      for (const d of DAYS) {
        const changes: Record<string, SpaceTag | null> = {};
        next[d] = { ...(latest[d] ?? {}) };
        for (const code of new Set([...Object.keys(tags[d] ?? {}), ...Object.keys(b[d] ?? {})])) {
          const mine = norm(tags[d]?.[code]);
          if (mine === norm(b[d]?.[code])) continue;
          if (norm(latest[d]?.[code]) !== norm(b[d]?.[code]) && norm(latest[d]?.[code]) !== mine) clash++; // ほかの人も同じ机を変えていた（こちらの変更で上書き）
          changes[code] = tags[d]?.[code] ?? null;
          if (tags[d]?.[code]) next[d][code] = tags[d][code];
          else delete next[d][code];
        }
        const keys = Object.keys(changes);
        for (let i = 0; i < keys.length; i += 2000) {
          const part = Object.fromEntries(keys.slice(i, i + 2000).map((k) => [k, changes[k]]));
          saved += (await api<{ saved: number }>("tags.php", { body: { day: d, changes: part } })).saved;
        }
      }
      writeBase(next);
      setTags(next);
      setMsg(`サーバーに保存しました（${saved} スペース）${clash ? `。${clash} スペースは、ほかの協力者も変えていたので、こちらの内容にしました` : ""}。ほかの協力者が入れた分も読み込みました`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存できませんでした");
    }
    setBusy(false);
  };

  // 協力者でログインしたら、最初に 1 回サーバーの分を読み込む
  useEffect(() => {
    if (can && !loadedOnce.current) {
      loadedOnce.current = true;
      load(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can]);

  const apply = async () => {
    try {
      await api("me.php", { body: { apply: true } });
      await refreshMe();
      setMsg("協力者に申しこみました。作者が承認すると、サーバーに保存できるようになります");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "申しこめませんでした");
    }
  };

  const loadLayout = async () => {
    setBusy(true);
    try {
      const r = await api<{ layout: unknown }>("tags.php?layout=1");
      if (!r.layout) setMsg("サーバーにはまだ配置がありません");
      else {
        setLayout(r.layout);
        setMsg("サーバーの配置を読み込みました");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "読み込めませんでした");
    }
    setBusy(false);
  };
  const putLayout = async () => {
    if (!confirm("いまの配置をサーバーに置きますか？（協力者が読む配置になります。地図に出すのは管理の画面の「公開」）")) return;
    setBusy(true);
    try {
      const r = await api<{ lines: number }>("admin.php", { body: { action: "layout", layout: toLayoutFile(lines, features) } });
      setMsg(`配置をサーバーに置きました（列 ${r.lines} 本）`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "置けませんでした");
    }
    setBusy(false);
  };

  if (!acct.ready || !acct.available) return null;
  return (
    <div className="soft" style={{ padding: "6px 12px", borderBottom: "1px solid var(--line)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: ".85rem" }}>
      <div style={{ minWidth: 220 }}>
        <AccountBox compact />
      </div>
      {acct.me && role === "user" && (
        <button className="chip" onClick={apply}>
          協力者に申しこむ
        </button>
      )}
      {role === "pending" && <span style={{ color: "var(--muted)" }}>協力者の申しこみ中です。作者が承認すると、サーバーに保存できます</span>}
      {role === "banned" && <span style={{ color: "var(--danger)" }}>このアカウントは止められています</span>}
      {can && (
        <>
          <button className="chip" disabled={busy} onClick={() => load()}>
            サーバーから読み込む
          </button>
          <button className="chip" disabled={busy || !pending} onClick={save} style={pending ? { fontWeight: 700 } : undefined}>
            サーバーに保存{pending ? `（${pending}）` : ""}
          </button>
          <button className="chip" disabled={busy} onClick={loadLayout}>
            配置を読み込む
          </button>
        </>
      )}
      {role === "admin" && (
        <>
          <button className="chip" disabled={busy} onClick={putLayout}>
            配置をサーバーに置く
          </button>
          <a href="/admin/">管理の画面</a>
        </>
      )}
      {msg && <span style={{ color: "var(--muted)" }}>{msg}</span>}
    </div>
  );
}
