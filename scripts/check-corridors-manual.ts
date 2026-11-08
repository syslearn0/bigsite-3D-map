// 手で引いた線（corridors-manual.ts）が、その階の歩ける所（通路・広場。穴と部屋を除く）からはみ出していないか調べる
import { readFileSync } from "node:fs";
import { pointInPolygon, type XZ } from "../src/lib/geo";
import { MANUAL } from "./corridors-manual";
type A = { name: string; level: number; poly: XZ[]; holes?: XZ[][]; sur?: boolean };
const v = JSON.parse(readFileSync("src/data/venue.json", "utf8")) as { areas: A[]; halls: { level: number; poly: XZ[] }[]; blocks?: { level: number; poly: XZ[] }[] };
const ok = (p: XZ, L: number) =>
  (v.areas.some((a) => a.level === L && pointInPolygon(p, a.poly) && !(a.holes ?? []).some((h) => pointInPolygon(p, h))) ||
    v.halls.some((h) => h.level === L && pointInPolygon(p, h.poly))) &&
  !(v.blocks ?? []).some((b) => b.level === L && pointInPolygon(p, b.poly));
let bad = 0;
MANUAL.lines.forEach((ln, li) => {
  for (let k = 1; k < ln.pts.length; k++) {
    const a = ln.pts[k - 1], b = ln.pts[k];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1);
    const outs: XZ[] = [];
    for (let i = 0; i <= n; i++) {
      const p: XZ = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
      if (!ok(p, ln.level)) outs.push(p.map((x) => Math.round(x)) as XZ);
    }
    if (outs.length) {
      bad++;
      console.log(`line ${li} seg ${k} ${JSON.stringify(a)}→${JSON.stringify(b)}: ${outs.length} 点が外 ${JSON.stringify(outs.slice(0, 4))}`);
    }
  }
});
console.log(bad ? `はみ出し ${bad}` : "はみ出しなし");
