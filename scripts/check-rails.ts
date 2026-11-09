// 歩く線が、壁（戸口・切れ目以外）・部屋の箱・机・柱・棟を通り抜けていないか調べる
// 使い方：npx tsx check-rails.ts [layout.json]（なければ見本の配置）
import { readFileSync } from "node:fs";
import { pointInPolygon, type XZ } from "../src/lib/geo";
import { addCorridors, buildRails, type Corridors } from "../src/lib/rails";
import { expandBooths, DESK_L, DESK_D, type Line, type LayoutFeatures } from "../src/lib/layout";

const ROOT = "";
const venue = JSON.parse(readFileSync(ROOT + "src/data/venue.json", "utf8"));
const corridors = JSON.parse(readFileSync(ROOT + "src/data/corridors.json", "utf8")) as Corridors;
const file = process.argv[2];
const lay = JSON.parse(readFileSync(file ?? ROOT + "src/data/layout-sample.json", "utf8"));
const lines: Line[] = lay.lines;
const features: LayoutFeatures | null = file ? lay.features : null;
const halls = venue.halls as { id: string; level: number; poly: XZ[]; closed?: string }[];
const booths = expandBooths(lines, halls as never);
const desksByHall = new Map<string, XZ[]>();
for (const b of booths) (desksByHall.get(b.hall) ?? desksByHall.set(b.hall, []).get(b.hall)!).push(b.at);
const rooms = (venue.blocks ?? []).filter((b: { base?: number }) => !b.base);
const rails = addCorridors(buildRails(lines, booths, halls as never, features, rooms), corridors, venue.doors, venue.exits ?? [], halls as never, desksByHall, venue.wallGaps ?? [], features, rooms);

// 壁の開いている所（VenueView の walls() と同じ考え）：辺ごとに [u0,u1]
const DOOR_W = 4.5;
const dataGaps = venue.wallGaps ?? [];
const allGaps = [
  ...dataGaps,
  ...(features?.openings ?? []).filter((o) => !dataGaps.some((g: { a: XZ; b: XZ }) => Math.hypot((o.a[0] + o.b[0] - g.a[0] - g.b[0]) / 2, (o.a[1] + o.b[1] - g.a[1] - g.b[1]) / 2) < 8)),
];
type Wall = { hall: string; level: number; a: XZ; b: XZ; c: number; s: number; len: number; open: [number, number][] };
const wallsList: Wall[] = [];
for (const h of halls) {
  const others = halls.filter((o) => o.id !== h.id && o.level === h.level).map((o) => o.poly);
  const doors = venue.doors.filter((d: { hall: string }) => d.hall === h.id);
  const spans = allGaps.filter((o: { hall: string }) => o.hall === h.id);
  h.poly.forEach((a, i) => {
    const b = h.poly[(i + 1) % h.poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) return;
    const c = (b[0] - a[0]) / len, s = (b[1] - a[1]) / len;
    const open: [number, number][] = [];
    for (const d of doors) {
      const u = (d.at[0] - a[0]) * c + (d.at[1] - a[1]) * s, v = -(d.at[0] - a[0]) * s + (d.at[1] - a[1]) * c;
      if (Math.abs(v) > (d.width ? 1 : 15) || u < 0 || u > len) continue;
      const w = d.width ?? DOOR_W;
      open.push([Math.max(0.3, u - w / 2), Math.min(len - 0.3, u + w / 2)]);
    }
    for (const o of spans) {
      const up = (o.a[0] - a[0]) * c + (o.a[1] - a[1]) * s, vp = -(o.a[0] - a[0]) * s + (o.a[1] - a[1]) * c;
      const uq = (o.b[0] - a[0]) * c + (o.b[1] - a[1]) * s, vq = -(o.b[0] - a[0]) * s + (o.b[1] - a[1]) * c;
      if (Math.abs(vp) > 5 || Math.abs(vq) > 5) continue;
      open.push([Math.max(0.3, Math.min(up, uq)), Math.min(len - 0.3, Math.max(up, uq))]);
    }
    for (const o of others)
      o.forEach((p, j) => {
        const q = o[(j + 1) % o.length];
        const vp = -(p[0] - a[0]) * s + (p[1] - a[1]) * c, vq = -(q[0] - a[0]) * s + (q[1] - a[1]) * c;
        if (Math.abs(vp) > 3 || Math.abs(vq) > 3) return;
        const up = (p[0] - a[0]) * c + (p[1] - a[1]) * s, uq = (q[0] - a[0]) * c + (q[1] - a[1]) * s;
        open.push([Math.max(0, Math.min(up, uq)) - 0.5, Math.min(len, Math.max(up, uq)) + 0.5]);
      });
    wallsList.push({ hall: h.id, level: h.level, a, b, c, s, len, open });
  });
}
// 線分 PQ と壁の交点の u（なければ null）
const cross = (P: XZ, Q: XZ, w: Wall): number | null => {
  const vp = -(P[0] - w.a[0]) * w.s + (P[1] - w.a[1]) * w.c, vq = -(Q[0] - w.a[0]) * w.s + (Q[1] - w.a[1]) * w.c;
  if ((vp > 0.2 && vq > 0.2) || (vp < -0.2 && vq < -0.2)) return null;
  if (Math.abs(vp - vq) < 1e-6) return null; // 壁に沿う
  const t = Math.max(0, Math.min(1, vp / (vp - vq)));
  const X: XZ = [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t];
  const u = (X[0] - w.a[0]) * w.c + (X[1] - w.a[1]) * w.s;
  if (u < -0.2 || u > w.len + 0.2) return null;
  // 壁の上に端があり、壁の内側へ向かうだけ（出入口の点が壁の上）のときも、通り抜けとして数える
  return u;
};
const MARGIN = 0.35; // 戸口の端（壁の柱）から離す
const blocks = ((venue.blocks ?? []) as { name: string; level: number; poly: XZ[]; base?: number }[]).filter((b) => !b.base);
// 机（スペースの長方形：1.8/2 × 0.45）
const deskHit = (p: XZ, hall: string) => {
  for (const b of booths) {
    if (b.hall !== hall) continue;
    const dx = p[0] - b.at[0], dz = p[1] - b.at[1];
    if (Math.abs(dx) > 2 || Math.abs(dz) > 2) continue;
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const u = dx * c + dz * s, v = -dx * s + dz * c;
    if (Math.abs(u) < DESK_L / 4 + 0.05 && Math.abs(v) < DESK_D / 2 + 0.05) return b.code;
  }
  return null;
};
const structs = features?.structures ?? [];
const pillars = features?.pillars ?? [];
const out: string[] = [];
const seen = new Set<string>();
const r1 = (p: XZ) => `[${p[0].toFixed(1)},${p[1].toFixed(1)}]`;
rails.adj.forEach((ns, a) =>
  ns.forEach((b) => {
    if (b < a) return;
    const A = rails.nodes[a], B = rails.nodes[b];
    if (A.level !== B.level) return; // 階段
    const L = A.level;
    const P = A.p, Q = B.p;
    const tag = `${A.hall || "通路"}→${B.hall || "通路"} L${L} ${r1(P)}→${r1(Q)} (${Math.hypot(Q[0] - P[0], Q[1] - P[1]).toFixed(1)}m)`;
    // 壁
    for (const w of wallsList) {
      if (w.level !== L) continue;
      const u = cross(P, Q, w);
      if (u === null) continue;
      // 端点が壁の上（0.2m 以内）で、もう一方の端も同じ側なら、通り抜けではない
      const vp = -(P[0] - w.a[0]) * w.s + (P[1] - w.a[1]) * w.c, vq = -(Q[0] - w.a[0]) * w.s + (Q[1] - w.a[1]) * w.c;
      if (Math.sign(vp) === Math.sign(vq) && Math.min(Math.abs(vp), Math.abs(vq)) <= 0.2) continue;
      const ok = w.open.some(([u0, u1]) => u >= u0 + MARGIN && u <= u1 - MARGIN);
      if (!ok) {
        const k = `wall ${tag}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push(`壁 ${w.hall} (u=${u.toFixed(1)}/${w.len.toFixed(1)} 開口 ${JSON.stringify(w.open.map((o) => o.map((x) => +x.toFixed(1))))}) ${tag}`);
        }
      }
    }
    // 部屋・棟・柱・机
    const n = Math.max(1, Math.ceil(Math.hypot(Q[0] - P[0], Q[1] - P[1]) / 0.25));
    const hits = new Set<string>();
    for (let i = 0; i <= n; i++) {
      const p: XZ = [P[0] + ((Q[0] - P[0]) * i) / n, P[1] + ((Q[1] - P[1]) * i) / n];
      for (const bl of blocks) if (bl.level === L && pointInPolygon(p, bl.poly)) hits.add(`部屋「${bl.name}」`);
      const hallHere = halls.find((h) => h.level === L && pointInPolygon(p, h.poly));
      if (hallHere) {
        const d = deskHit(p, hallHere.id);
        if (d) hits.add(`机 ${d}`);
        for (const st of structs) if (pointInPolygon(p, st.poly)) hits.add(`棟 ${r1(st.poly[0])}`);
        for (const pl of pillars) if (Math.hypot(pl.at[0] - p[0], pl.at[1] - p[1]) < (pl.wall ? 0.3 : 0.2)) hits.add(`柱 ${r1(pl.at)}`);
      }
    }
    for (const h of hits) out.push(`${h} ${tag}`);
  }),
);
console.log(`線 ${rails.nodes.length} 点`);
console.log(out.length ? out.join("\n") : "問題なし");
console.log(`計 ${out.length}`);

// つながり：いちばん大きいまとまりに入らない点（ホールごと）
{
  const comp = new Int32Array(rails.nodes.length).fill(-1);
  const sizes: number[] = [];
  for (let s0 = 0; s0 < rails.nodes.length; s0++) {
    if (comp[s0] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    const st = [s0];
    comp[s0] = id;
    while (st.length) {
      const i = st.pop()!;
      n++;
      for (const j of rails.adj[i])
        if (comp[j] < 0) {
          comp[j] = id;
          st.push(j);
        }
    }
    sizes.push(n);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  const lost = new Map<string, number>();
  rails.nodes.forEach((nd, i) => {
    if (comp[i] !== main && rails.adj[i].length) lost.set(`${nd.hall || "通路"} L${nd.level}`, (lost.get(`${nd.hall || "通路"} L${nd.level}`) ?? 0) + 1);
  });
  console.log(`まとまり ${sizes.length}（いちばん大きいもの ${sizes[main]} 点）`, lost.size ? "離れている点：" + JSON.stringify(Object.fromEntries(lost)) : "すべてつながっている");
}

// ホールの線の点が、そのホールの外にないか
{
  let n = 0;
  rails.nodes.forEach((nd, i) => {
    if (!nd.hall || !rails.adj[i].length) return;
    const h = halls.find((x) => x.id === nd.hall)!;
    if (!pointInPolygon(nd.p, h.poly)) {
      n++;
      if (n <= 10) console.log(`ホールの外の点 ${nd.hall} ${r1(nd.p)}`);
    }
  });
  console.log(`ホールの外の点 ${n}`);
}

// 通路の線の行き止まり（出入口・出口・階段の端など。どこにもつながらずに止まっている所を目で見るため）
{
  const ends: string[] = [];
  rails.nodes.forEach((nd, i) => {
    if (nd.hall || rails.adj[i].length !== 1) return;
    const j = rails.adj[i][0];
    if (rails.nodes[j].level !== nd.level) return; // 階段の端
    const door = venue.doors.find((d: { at: XZ; level: number }) => d.level === nd.level && Math.hypot(d.at[0] - nd.p[0], d.at[1] - nd.p[1]) < 2.5);
    ends.push(`${r1(nd.p)} L${nd.level}${door ? ` 出入口の文字 ${door.hall} ${door.kind}` : ""}`);
  });
  console.log(`通路の行き止まり ${ends.length}`);
  for (const e of ends) console.log("  " + e);
}
