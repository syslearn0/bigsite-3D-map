// 作者が管理の画面で「公開」したデータ（/data/layout.json・tags.json・circles.json）。
// 地図はこれを端末に取っておき（電波がなくても使える）、開いたときに新しいものがあれば取り直して、1 回だけ読みなおす。
// 使う順：島のエディタで「3D で確かめる」を押した配置（その端末だけ）＞ 公開のデータ ＞ 見本
import { DAYS, type Day } from "./tags";

export const PUB_KEYS = { layout: "comiket3d:pub-layout", tags: "comiket3d:pub-tags", circles: "comiket3d:pub-circles" } as const;
type Part = keyof typeof PUB_KEYS;
const RELOAD_KEY = "comiket3d:pub-reloaded";

export type Circle = { day: Day; codes: string[]; name: string; works: string[]; chars: Record<string, string[]>; x: string; url: string; image: string };
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
      };
      for (const code of circle.codes) out[c.day][code] = circle;
    }
  } catch {}
  return out;
}

// 公開のデータを取り直す。端末に取ってあるものと変わっていたら true（呼んだ側で読みなおす）
export async function refreshPublished(): Promise<boolean> {
  let changed = false;
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
      } catch {}
    }),
  );
  return changed;
}

// 新しいデータを取ったら、1 回だけ読みなおす（続けて何度も読みなおさないよう、30 秒は空ける）
export async function refreshPublishedAndReload() {
  if (!(await refreshPublished())) return;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return;
  }
  location.reload();
}
