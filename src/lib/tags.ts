// スペースにつける情報（作品・キャラ）。協力者が島のエディタで入れる。
// 同じ配置番号でも日が違えば別のサークルなので、日ごと（1〜3日目）に分けて持つ。
// のちに入れるもの（準備会の確認と、サークル本人の登録が要る）：サークル名・お品書き・サークルの画像。
// それは共有の保存先とログインが要るので、ここでは置き場所（circle）だけ決めておく。

export type Day = 1 | 2 | 3;
export const DAYS: Day[] = [1, 2, 3];

export type SpaceTag = {
  work?: string; // 作品（「ブルーアーカイブ」「原神」など）
  chars?: string[]; // キャラ
  circle?: { name?: string; menuUrl?: string; imageUrl?: string }; // あとで（サークル本人が入れる）
};
// 日 → 配置番号（「東A-01a」）→ 情報
export type Tags = Record<string, Record<string, SpaceTag>>;

export const TAGS_FORMAT = "comiket3d-tags";
export type TagsFile = { format: typeof TAGS_FORMAT; version: 1; updated: string; days: Tags };

export const TAGS_KEY = "comiket3d:tags"; // メインの地図で使う
export const TAGS_DRAFT_KEY = "comiket3d:tags-draft"; // エディタの書きかけ

export function toTagsFile(tags: Tags): TagsFile {
  return { format: TAGS_FORMAT, version: 1, updated: new Date().toISOString(), days: tags };
}

export function parseTagsFile(json: unknown): Tags | null {
  const f = json as Partial<TagsFile> | null;
  if (!f || f.format !== TAGS_FORMAT || !f.days || typeof f.days !== "object") return null;
  const out: Tags = {};
  for (const [day, spaces] of Object.entries(f.days)) {
    if (!DAYS.includes(Number(day) as Day) || !spaces || typeof spaces !== "object") return null;
    out[day] = {};
    for (const [code, t] of Object.entries(spaces as Record<string, SpaceTag>)) {
      if (!t || typeof t !== "object") return null;
      const tag: SpaceTag = {};
      if (typeof t.work === "string" && t.work.trim()) tag.work = t.work.trim();
      if (Array.isArray(t.chars)) {
        const chars = t.chars.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim());
        if (chars.length) tag.chars = chars;
      }
      if (tag.work || tag.chars) out[day][code] = tag;
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

// 選んだスペースに作品・キャラを入れる（新しい Tags を返す）。
// work：undefined は変えない、"" は外す。chars：mode が "set" なら置きかえ、"add" なら足す、"clear" なら消す
export function applyTag(tags: Tags, day: Day, codes: string[], change: { work?: string; chars?: string[]; mode?: "set" | "add" | "clear" }): Tags {
  const d = { ...(tags[day] ?? {}) };
  for (const code of codes) {
    const t: SpaceTag = { ...(d[code] ?? {}) };
    if (change.work !== undefined) {
      if (change.work.trim()) t.work = change.work.trim();
      else delete t.work;
    }
    if (change.mode === "clear") delete t.chars;
    else if (change.chars) {
      const add = change.chars.map((c) => c.trim()).filter(Boolean);
      const chars = change.mode === "add" ? [...new Set([...(t.chars ?? []), ...add])] : add;
      if (chars.length) t.chars = chars;
      else delete t.chars;
    }
    if (t.work || t.chars || t.circle) d[code] = t;
    else delete d[code];
  }
  return { ...tags, [day]: d };
}

// 作品の一覧（多い順）
export function worksOf(tags: Tags, day: Day): { work: string; count: number }[] {
  const n = new Map<string, number>();
  for (const t of Object.values(tags[day] ?? {})) if (t.work) n.set(t.work, (n.get(t.work) ?? 0) + 1);
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
  for (const t of Object.values(tags[day] ?? {})) if (t.work === work) for (const c of t.chars ?? []) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].map(([char, count]) => ({ char, count })).sort((a, b) => b.count - a.count || a.char.localeCompare(b.char, "ja"));
}

// 「アリス, ユウカ、ヒナ」→ ["アリス", "ユウカ", "ヒナ"]
export const splitChars = (s: string) => s.split(/[,、，\s]+/).map((c) => c.trim()).filter(Boolean);
