// 名前で探す（D-4）：サークル名・作品・キャラ・ジャンル・配置番号から、机を探す。
// 全角半角・大文字小文字・ひらがなとカタカナの違いは気にしない
import type { Circle } from "./published";
import type { SpaceTag } from "./tags";

export const fold = (s: string | undefined | null) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・･\-ー_]/g, "");

export type Hit =
  | { kind: "circle"; label: string; sub: string; codes: string[] }
  | { kind: "code"; label: string; sub: string; codes: string[] }
  | { kind: "work" | "char" | "genre"; label: string; sub: string; codes: string[] };

// codes：その日にある机の配置番号（順に並べてあるもの）
export function search(q: string, codes: string[], tags: Record<string, SpaceTag>, circles: Record<string, Circle>, limit = 40): Hit[] {
  const f = fold(q);
  if (!f) return [];
  const out: Hit[] = [];
  // 配置番号（「東A01」「東a-1」など。先頭が合うもの）
  const codeQ = fold(q.replace(/^([東西南])(.+?)-?(\d{1,2})([abAB]?)$/u, (_, b, blk, n, h) => `${b}${blk}-${n.padStart(2, "0")}${h}`));
  if (/^[東西南]/.test(q.normalize("NFKC").trim())) {
    const hit = codes.filter((c) => fold(c).startsWith(codeQ)).slice(0, 12);
    for (const c of hit) out.push({ kind: "code", label: c, sub: [circles[c]?.name, tags[c]?.works?.join("・")].filter(Boolean).join("　"), codes: [c] });
  }
  // サークル名（1 つのサークルが 2 スペースでも 1 つ）
  const seen = new Set<Circle>();
  for (const [c, ci] of Object.entries(circles)) {
    if (seen.has(ci) || !fold(ci.name).includes(f)) continue;
    seen.add(ci);
    out.push({ kind: "circle", label: ci.name, sub: ci.codes.join("・") + (ci.works.length ? "　" + ci.works.join("・") : ""), codes: ci.codes.length ? ci.codes : [c] });
  }
  // 作品・キャラ・ジャンル：その名前の机をまとめて
  const groups = new Map<string, Hit>();
  const add = (kind: "work" | "char" | "genre", name: string, code: string) => {
    const k = kind + "|" + name;
    if (!groups.has(k)) groups.set(k, { kind, label: name, sub: "", codes: [] });
    const g = groups.get(k)!;
    if (!g.codes.includes(code)) g.codes.push(code);
  };
  for (const code of codes) {
    const t = tags[code];
    if (!t) continue;
    // 名前の入っていないもの（見本のデータなど）は飛ばす
    if (t.genre && fold(t.genre).includes(f)) add("genre", t.genre, code);
    for (const w of t.works ?? []) if (w && fold(w).includes(f)) add("work", w, code);
    for (const list of Object.values(t.chars ?? {})) for (const ch of list ?? []) if (ch && fold(ch).includes(f)) add("char", ch, code);
  }
  const rank = (h: Hit) => (fold(h.label) === f ? 0 : fold(h.label).startsWith(f) ? 1 : 2);
  const gs = [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.codes.length - a.codes.length);
  for (const g of gs) g.sub = `${g.codes.length} スペース`;
  out.sort((a, b) => (a.kind === "code" ? -1 : 0) - (b.kind === "code" ? -1 : 0) || rank(a) - rank(b));
  return [...out, ...gs].slice(0, limit);
}
