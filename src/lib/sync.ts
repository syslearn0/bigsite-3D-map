// 印・メモ・「行った」を、ログインした人の端末のあいだで合わせる。
// 項目ごと（「m|1|東A-01a」= 1 日目のその机の印、n = メモ、v = 行った、p = 使う金額（円））に、この端末で最後に変えた時刻を覚えておき、
// サーバーと比べて新しいほうを残す。端末の保存がいつも先（電波がなくても使える）。サーバーへは少し待ってからまとめて送る
import { useEffect, useRef, useSyncExternalStore } from "react";
import { accountStore, api } from "./account";
import { DAYS, type Day } from "./tags";

export type Flat = Record<string, string>;
type ByDay<T> = Record<Day, Record<string, T>>;
// user：最後に合わせたアカウント。t：項目ごとに、この端末で最後に変えた時刻
type Meta = { t: Record<string, number>; last: Flat; user?: number };
const META_KEY = "comiket3d:sync";
// この版が知っている項目の種類。サーバーは、ここにない種類の項目を返さず、書きこみも受けない
// （前の版のままの端末が、知らない項目（使う金額など）を「消した」と送って、ほかの端末の分まで消さないように）
const KINDS = "mnvp";

export function flatten(marks: ByDay<string>, notes: ByDay<string>, visited: ByDay<number>, budgets?: ByDay<number>): Flat {
  const f: Flat = {};
  for (const d of DAYS) {
    for (const [c, v] of Object.entries(marks[d])) f[`m|${d}|${c}`] = v;
    for (const [c, v] of Object.entries(notes[d])) if (v) f[`n|${d}|${c}`] = v;
    for (const [c, v] of Object.entries(visited[d])) f[`v|${d}|${c}`] = String(v);
    for (const [c, v] of Object.entries(budgets?.[d] ?? {})) if (v > 0) f[`p|${d}|${c}`] = String(v);
  }
  return f;
}

export function unflatten(f: Flat) {
  const e = <T,>(): ByDay<T> => ({ 1: {}, 2: {}, 3: {} });
  const marks = e<"want" | "maybe">(), notes = e<string>(), visited = e<number>(), budgets = e<number>();
  for (const [k, v] of Object.entries(f)) {
    const [kind, ds, code] = k.split("|");
    const d = Number(ds) as Day;
    if (!DAYS.includes(d) || !code) continue;
    if (kind === "m" && (v === "want" || v === "maybe")) marks[d][code] = v;
    else if (kind === "n") notes[d][code] = v;
    else if (kind === "v" && Number(v) > 0) visited[d][code] = Number(v);
    else if (kind === "p" && Number(v) > 0) budgets[d][code] = Math.round(Number(v));
  }
  return { marks, notes, visited, budgets };
}

function readMeta(): Meta | null {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY) ?? "null");
    if (m && typeof m.t === "object" && typeof m.last === "object") return m;
  } catch {}
  return null;
}
function writeMeta(m: Meta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(m));
  } catch {}
}

// 端末で変わった項目に、変えた時刻をつける。最初の 1 回は、いまある項目を「変えた」とはしない
// （まだ合わせていない端末の古い印が、ほかの端末で消したものを、新しい時刻で生き返らせないように）
export function noteLocal(flat: Flat) {
  const old = readMeta();
  if (!old) return writeMeta({ t: {}, last: flat });
  const now = Date.now();
  let changed = false;
  for (const k of new Set([...Object.keys(flat), ...Object.keys(old.last)]))
    if (flat[k] !== old.last[k]) {
      old.t[k] = now;
      changed = true;
    }
  if (changed) writeMeta({ ...old, last: flat });
}

const MONTH = 30 * 86400_000;
// サーバーと合わせる。変わったときは、合わせたあとの全部を返す
export async function syncWith(flat: Flat, user: number): Promise<Flat | null> {
  noteLocal(flat);
  let m = readMeta()!;
  if (m.user === undefined) {
    // この端末で初めて合わせる：時刻のついていない手元の項目は、いちばん古い時刻（1）で送る。サーバーにない印は足され、
    // サーバーにある（消したものも）ほうが勝つ
    for (const k of Object.keys(flat)) m.t[k] ??= 1;
    m.user = user;
  } else if (m.user !== user) {
    // ちがうアカウントでログインした：手元の印は送らず、そのアカウントのサーバーの分を読むだけ
    m = { t: {}, last: flat, user };
  }
  // 消した項目の記録は、1 か月より古ければ忘れる（送る数がふえつづけないように）
  const now = Date.now();
  for (const [k, t] of Object.entries(m.t)) if (flat[k] === undefined && t > 1 && now - t > MONTH) delete m.t[k];
  writeMeta(m);
  const entries: Record<string, { v: string | null; t: number }> = {};
  for (const [k, t] of Object.entries(m.t)) entries[k] = { v: flat[k] ?? null, t };
  const r = await api<{ entries: Record<string, { v: string | null; t: number }> }>("sync.php", { body: { entries, kinds: KINDS } });
  const next: Flat = { ...flat };
  for (const [k, e] of Object.entries(r.entries)) {
    if (e.t < (m.t[k] ?? 0)) continue;
    if (e.v === null) delete next[k];
    else next[k] = e.v;
    m.t[k] = e.t;
  }
  writeMeta({ t: m.t, last: next, user });
  const same = Object.keys(next).length === Object.keys(flat).length && Object.entries(next).every(([k, v]) => flat[k] === v);
  return same ? null : next;
}

export type SyncStatus = "off" | "syncing" | "ok" | "error";
let status: SyncStatus = "off";
let lastAt = 0;
const subs = new Set<() => void>();
const setStatus = (s: SyncStatus) => {
  status = s;
  if (s === "ok") lastAt = Date.now();
  subs.forEach((f) => f());
};
export const syncStatusStore = {
  subscribe(f: () => void) {
    subs.add(f);
    return () => subs.delete(f);
  },
  get: () => status,
  lastAt: () => lastAt,
};

// ログインしているあいだ、端末の印などをサーバーと合わせる。apply：サーバーの方が新しかったときに、合わせた全部を画面に入れる
export function useAccountSync(flat: Flat, apply: (f: Flat) => void) {
  const acct = useSyncExternalStore(accountStore.subscribe, accountStore.get, accountStore.get);
  const me = acct.me && acct.me.role !== "banned" ? acct.me.id : null;
  const flatRef = useRef(flat);
  const applyRef = useRef(apply);
  const run = useRef<() => void>(() => {});
  useEffect(() => {
    flatRef.current = flat;
    applyRef.current = apply;
  });
  useEffect(() => noteLocal(flat), [flat]);

  useEffect(() => {
    if (!me) {
      setStatus("off");
      return;
    }
    let busy = false, again = false, dead = false;
    const go = async () => {
      if (busy) {
        again = true;
        return;
      }
      if (!navigator.onLine) return;
      busy = true;
      setStatus("syncing");
      try {
        const next = await syncWith(flatRef.current, me);
        if (!dead && next) applyRef.current(next);
        if (!dead) setStatus("ok");
      } catch {
        if (!dead) setStatus("error");
      }
      busy = false;
      if (again && !dead) {
        again = false;
        go();
      }
    };
    run.current = go;
    go();
    const vis = () => document.visibilityState === "visible" && go();
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("online", go);
    const iv = setInterval(go, 90_000);
    return () => {
      dead = true;
      run.current = () => {};
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("online", go);
      clearInterval(iv);
    };
  }, [me]);

  // 端末で変えたら、2 秒待ってから送る（続けて押したときはまとめて）
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => run.current(), 2000);
    return () => clearTimeout(t);
  }, [flat]);
}
