// 作者が管理の画面で「公開」したデータ（/data/layout.json・tags.json・circles.json）。
// 地図はこれを端末に取っておき（電波がなくても使える）、開いたときに新しいものがあれば取り直して、1 回だけ読みなおす。
// 使う順：島のエディタで「3D で確かめる」を押した配置（その端末だけ）＞ 公開のデータ ＞ 見本
import { DAYS, type Day } from "./tags";

export const PUB_KEYS = { layout: "comiket3d:pub-layout", tags: "comiket3d:pub-tags", circles: "comiket3d:pub-circles" } as const;
type Part = keyof typeof PUB_KEYS;
const RELOAD_KEY = "comiket3d:pub-reloaded";

export type Circle = { day: Day; codes: string[]; name: string; works: string[]; chars: Record<string, string[]>; x: string; url: string; image: string; thumb: string };
export type CirclesByDay = Record<Day, Record<string, Circle>>;

export function loadCircles(): CirclesByDay {
  const out: CirclesByDay = { 1: {}, 2: {}, 3: {} };
  try {
    const f = JSON.parse(localStorage.getItem(PUB_KEYS.circles) ?? "null");
    if (f?.format !== "comiket3d-circles" || !Array.isArray(f.circles)) return out;
    for (const c of f.circles as Circle[]) {
      if (!DAYS.includes(c.day) || !Array.isArray(c.codes) || typeof c.name !== "string") continue;
      const circle: Circle = {
        day: c.day,
        codes: c.codes.filter((x) => typeof x === "string"),
        name: c.name,
        works: Array.isArray(c.works) ? c.works : [],
        chars: c.chars && typeof c.chars === "object" && !Array.isArray(c.chars) ? c.chars : {},
        x: typeof c.x === "string" ? c.x : "",
        url: typeof c.url === "string" && c.url.startsWith("https://") ? c.url : "",
        image: typeof c.image === "string" && c.image.startsWith("/data/circles/") ? c.image : "",
        // 机の札に出す小さい画像（ないときは大きい画像を使う）
        thumb: typeof c.thumb === "string" && c.thumb.startsWith("/data/circles/") ? c.thumb : "",
      };
      for (const code of circle.codes) out[c.day][code] = circle;
    }
  } catch {}
  return out;
}

// 公開のデータを取り直す。changed：端末に取ってあるものと変わった。had：前から何か取ってあった。
// full：端末の保存がいっぱいで、入れられなかった
export async function refreshPublishedInfo(): Promise<{ changed: boolean; had: boolean; full: boolean }> {
  let changed = false, full = false;
  let had = false;
  try {
    had = (Object.values(PUB_KEYS) as string[]).some((k) => localStorage.getItem(k) !== null);
  } catch {}
  await Promise.all(
    (Object.keys(PUB_KEYS) as Part[]).map(async (p) => {
      let text: string | null;
      try {
        const res = await fetch(`/data/${p}.json`, { cache: "no-store" });
        if (res.status === 404) text = null; // 公開をやめた（または、まだない）
        else if (!res.ok) return;
        else {
          text = await res.text();
          JSON.parse(text); // 読めないもの（開発中のサーバーが返すページなど）は取らない
        }
      } catch {
        return; // 電波がないときは、取ってあるものを使う
      }
      try {
        if ((localStorage.getItem(PUB_KEYS[p]) ?? null) === text) return;
        if (text === null) localStorage.removeItem(PUB_KEYS[p]);
        else localStorage.setItem(PUB_KEYS[p], text);
        changed = true;
      } catch {
        full = true;
      }
    }),
  );
  return { changed, had, full };
}
export async function refreshPublished(): Promise<boolean> {
  return (await refreshPublishedInfo()).changed;
}

// 新しいデータを取ったら：初めて取ったとき（まだ何も見ていない）はすぐ読みなおす。前から取ってあったときは、
// 選んでいた机や歩いていた場所が消えないよう、読みなおすかどうかを利用者にまかせる（"ask" を返す）
export async function refreshPublishedAndReload(): Promise<"none" | "ask" | "full"> {
  const r = await refreshPublishedInfo();
  if (r.full) return "full";
  if (!r.changed) return "none";
  if (r.had) return "ask";
  reloadOnce();
  return "none";
}
export function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return;
  }
  location.reload();
}
