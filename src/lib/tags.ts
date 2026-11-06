// スペースにつける情報（作品・キャラ）。協力者が島のエディタで入れる。
// 同じ配置番号でも日が違えば別のサークルなので、日ごと（1〜3日目）に分けて持つ。
// 1つのサークルが複数の作品を扱うこともあるので、作品はいくつでも。キャラは作品ごとに分けて持つ。
// のちに入れるもの（準備会の確認と、サークル本人の登録が要る）：サークル名・お品書き・サークルの画像。
// それは共有の保存先とログインが要るので、ここでは置き場所（circle）だけ決めておく。

export type Day = 1 | 2 | 3;
export const DAYS: Day[] = [1, 2, 3];

export type SpaceTag = {
  genre?: string; // ジャンル（「男性向」「女性向」「ゲーム」など、大まかな分類）
  works?: string[]; // 作品（「ブルーアーカイブ」「原神」など）。入れた順
  chars?: Record<string, string[]>; // 作品 → キャラ
  circle?: { name?: string; menuUrl?: string; imageUrl?: string }; // あとで（サークル本人が入れる）
};
// 日 → 配置番号（「東A-01a」）→ 情報
export type Tags = Record<string, Record<string, SpaceTag>>;

export const TAGS_FORMAT = "comiket3d-tags";
export type TagsFile = { format: typeof TAGS_FORMAT; version: 2; updated: string; days: Tags };

export const TAGS_KEY = "comiket3d:tags"; // メインの地図で使う
export const TAGS_DRAFT_KEY = "comiket3d:tags-draft"; // エディタの書きかけ

export function toTagsFile(tags: Tags): TagsFile {
  return { format: TAGS_FORMAT, version: 2, updated: new Date().toISOString(), days: tags };
}

const clean = (list: unknown): string[] =>
  Array.isArray(list) ? [...new Set(list.filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => c.trim()))] : [];

// 読み込み。前の形（作品が1つ：work、キャラがその作品の分：chars が配列）も読める
export function parseTagsFile(json: unknown): Tags | null {
  const f = json as { format?: string; days?: unknown } | null;
  if (!f || f.format !== TAGS_FORMAT || !f.days || typeof f.days !== "object") return null;
  const out: Tags = {};
  for (const [day, spaces] of Object.entries(f.days as Record<string, unknown>)) {
    if (!DAYS.includes(Number(day) as Day) || !spaces || typeof spaces !== "object") return null;
    out[day] = {};
    for (const [code, raw] of Object.entries(spaces as Record<string, Record<string, unknown>>)) {
      if (!raw || typeof raw !== "object") return null;
      const works = clean(raw.works ?? (typeof raw.work === "string" ? [raw.work] : []));
      const chars: Record<string, string[]> = {};
      if (Array.isArray(raw.chars)) {
        // 前の形：キャラは、その作品（1つ）の分
        if (works[0] && clean(raw.chars).length) chars[works[0]] = clean(raw.chars);
      } else if (raw.chars && typeof raw.chars === "object") {
        for (const [w, list] of Object.entries(raw.chars as Record<string, unknown>)) if (works.includes(w) && clean(list).length) chars[w] = clean(list);
      }
      const tag: SpaceTag = {};
      if (typeof raw.genre === "string" && raw.genre.trim()) tag.genre = raw.genre.trim();
      if (works.length) tag.works = works;
      if (Object.keys(chars).length) tag.chars = chars;
      if (tag.works) out[day][code] = tag;
    }
  }
  return out;
}

export function loadTags(key: string): Tags | null {
  try {
    return parseTagsFile(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return null;
  }
}

export function saveTags(key: string, tags: Tags): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(toTagsFile(tags)));
    return true;
  } catch {
    return false;
  }
}

// 選んだスペースの作品を変える（新しい Tags を返す）。
// set：この作品だけにする／add：足す／remove：その作品を外す（その作品のキャラも消える）／clear：全部外す
export function applyWorks(tags: Tags, day: Day, codes: string[], how: "set" | "add" | "remove" | "clear", list: string[] = []): Tags {
  const names = clean(list);
  const d = { ...(tags[day] ?? {}) };
  for (const code of codes) {
    const t: SpaceTag = { ...(d[code] ?? {}) };
    const now = t.works ?? [];
    const works = how === "set" ? names : how === "add" ? [...new Set([...now, ...names])] : how === "remove" ? now.filter((w) => !names.includes(w)) : [];
    const chars = Object.fromEntries(Object.entries(t.chars ?? {}).filter(([w]) => works.includes(w)));
    if (works.length) d[code] = { ...t, works, ...(Object.keys(chars).length ? { chars } : { chars: undefined }) };
    else delete d[code];
    if (d[code] && !d[code].chars) delete d[code].chars;
  }
  return { ...tags, [day]: d };
}

// 選んだスペースの、ある作品のキャラを変える。その作品を扱っていないスペースは変えない。
// set：置きかえ／add：足す／clear：消す
export function applyChars(tags: Tags, day: Day, codes: string[], work: string, how: "set" | "add" | "clear", list: string[] = []): Tags {
  const names = clean(list);
  const d = { ...(tags[day] ?? {}) };
  for (const code of codes) {
    const t = d[code];
    if (!t?.works?.includes(work)) continue;
    const chars = { ...(t.chars ?? {}) };
    const next = how === "set" ? names : how === "add" ? [...new Set([...(chars[work] ?? []), ...names])] : [];
    if (next.length) chars[work] = next;
    else delete chars[work];
    d[code] = { ...t, chars };
    if (!Object.keys(chars).length) delete d[code].chars;
  }
  return { ...tags, [day]: d };
}

// 作品の一覧（その作品を扱うスペースの数、多い順）
export function worksOf(tags: Tags, day: Day): { work: string; count: number }[] {
  const n = new Map<string, number>();
  for (const t of Object.values(tags[day] ?? {})) for (const w of t.works ?? []) n.set(w, (n.get(w) ?? 0) + 1);
  return [...n].map(([work, count]) => ({ work, count })).sort((a, b) => b.count - a.count || a.work.localeCompare(b.work, "ja"));
}

// 作品ごとの色。名前から決めるので、だれの端末でも同じ作品は同じ色。pale は薄い色（まだキャラが入っていない所など）
export function workColor(work: string, pale = false): string {
  let h = 0;
  for (const ch of work) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return pale ? `hsl(${h % 360}, 45%, 84%)` : `hsl(${h % 360}, 62%, 56%)`; // カンマつき（three.js の色の読み込みでも使えるように）
}

// ある作品のキャラの一覧（多い順）
export function charsOf(tags: Tags, day: Day, work: string): { char: string; count: number }[] {
  const n = new Map<string, number>();
  for (const t of Object.values(tags[day] ?? {})) for (const c of t.chars?.[work] ?? []) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].map(([char, count]) => ({ char, count })).sort((a, b) => b.count - a.count || a.char.localeCompare(b.char, "ja"));
}

// 画面に出す文：「パイモン、蛍（原神）／アリス（ブルーアーカイブ）」。作品が1つなら作品名は付けない
export function charsText(t: SpaceTag | undefined): string {
  const entries = Object.entries(t?.chars ?? {}).filter(([, l]) => l.length);
  if (!entries.length) return "";
  if ((t?.works?.length ?? 0) <= 1) return entries.map(([, l]) => l.join("、")).join("、");
  return entries.map(([w, l]) => `${l.join("、")}（${w}）`).join("／");
}

// 「アリス, ユウカ、ヒナ」→ ["アリス", "ユウカ", "ヒナ"]
export const splitChars = (s: string) => s.split(/[,、，\s]+/).map((c) => c.trim()).filter(Boolean);
