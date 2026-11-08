// 通路・広場・階段の「移動の線」を作る（歩くモードの線路のうち、ホールの外の分）。
// 階ごとに、ホールの外の歩ける所を 1m の升目にし、出入口・外への出口・階段の上と下の端・救護室を「行き先」として、
// それぞれ近い行き先（4 つまで）へ、通路のまん中を通る道を探す（壁ぎわほど通りにくくする）。
// 道どうしが同じ升目を通る所は 1 本にまとめ、分かれ目と分かれ目のあいだを、見通せる所はまっすぐな線にする。
// 階段は、上の端と下の端を 1 本の線で結ぶ（歩くモードで、その線を進むと階が変わる）。
// 書き出し：src/data/corridors.json（npm run build:corridors）
import { readFileSync, writeFileSync } from "node:fs";
import { buildGrid, centerWeights, simplify, type Grid, type NavVenue } from "../src/lib/nav";
import { pointInPolygon, type XZ } from "../src/lib/geo";
import { MANUAL } from "./corridors-manual";

type V = NavVenue & {
  stairs?: { name: string; from: XZ; fromLevel: number; to: XZ; toLevel: number; kind?: string; sur?: boolean }[];
  firstAid: { at: XZ; level: number }[];
};
const venue = JSON.parse(readFileSync("src/data/venue.json", "utf8")) as V;
const LEVELS = [1, 2, 4];
const SPUR = 14; // 骨格の小さなとげ（行き先のない、これより短い行き止まり）は取る
const FAR = 260; // これより遠い行き先とは結ばない

const cellOf = (g: Grid, p: XZ) => {
  const c = Math.floor(p[0] - g.x0), r = Math.floor(p[1] - g.z0);
  return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
};
const centerOf = (g: Grid, i: number): XZ => [g.x0 + (i % g.w) + 0.5, g.z0 + Math.floor(i / g.w) + 0.5];
function nearestFree(g: Grid, p: XZ, rad: number) {
  const i0 = cellOf(g, p);
  if (i0 >= 0 && g.region[i0] >= 0) return i0;
  let best = -1, bd = Infinity;
  const c0 = Math.floor(p[0] - g.x0), r0 = Math.floor(p[1] - g.z0);
  for (let dr = -rad; dr <= rad; dr++)
    for (let dc = -rad; dc <= rad; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= g.h || c >= g.w) continue;
      const i = r * g.w + c;
      if (g.region[i] < 0) continue;
      const d = Math.hypot(dr, dc);
      if (d < bd) [best, bd] = [i, d];
    }
  return best;
}

// 1 つの升目から、ほかの行き先の升目のうち、近い（道のりで）k 個までの道を探す
function paths(g: Grid, w: Float32Array, from: number, goals: Map<number, number>, k: number): { cells: number[]; cost: number }[] {
  const n = g.w * g.h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap: number[] = [];
  const push = (d: number, i: number) => {
    heap.push(d, i);
    let x = heap.length / 2 - 1;
    while (x > 0) {
      const p = (x - 1) >> 1;
      if (heap[2 * p] <= heap[2 * x]) break;
      for (const o of [0, 1]) [heap[2 * p + o], heap[2 * x + o]] = [heap[2 * x + o], heap[2 * p + o]];
      x = p;
    }
  };
  const pop = (): [number, number] => {
    const d = heap[0], i = heap[1];
    const li = heap.pop()!, ld = heap.pop()!;
    if (heap.length) {
      heap[0] = ld;
      heap[1] = li;
      let x = 0;
      const m = heap.length / 2;
      for (;;) {
        const l = 2 * x + 1, r = l + 1;
        let s = x;
        if (l < m && heap[2 * l] < heap[2 * s]) s = l;
        if (r < m && heap[2 * r] < heap[2 * s]) s = r;
        if (s === x) break;
        for (const o of [0, 1]) [heap[2 * s + o], heap[2 * x + o]] = [heap[2 * x + o], heap[2 * s + o]];
        x = s;
      }
    }
    return [d, i];
  };
  dist[from] = 0;
  push(0, from);
  const found: number[] = [];
  const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;
  while (heap.length && found.length < k) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    if (i !== from && goals.has(i)) found.push(i);
    if (d > FAR * 3) break;
    const c = i % g.w, r = (i - c) / g.w;
    for (const [dc, dr, cost] of N8) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= g.w || rr >= g.h) continue;
      const j = rr * g.w + cc;
      if (g.region[j] < 0) continue;
      if (dc && dr && (g.region[r * g.w + cc] < 0 || g.region[rr * g.w + c] < 0)) continue;
      if (g.region[j] !== g.region[i] && !(g.portal[i] || g.portal[j])) continue;
      const nd = d + cost * (w[i] + w[j]) / 2;
      if (nd < dist[j]) {
        dist[j] = nd;
        prev[j] = i;
        push(nd, j);
      }
    }
  }
  return found.map((t) => {
    const cells: number[] = [];
    for (let i = t; i >= 0; i = prev[i]) cells.push(i);
    return { cells: cells.reverse(), cost: dist[t] };
  });
}

const out: { level: number; pts: XZ[] }[] = [];
const keysOut: { level: number; at: XZ; kind: string }[] = [];
for (const L of LEVELS) {
  // 手で引いた階（corridors-manual.ts の replace）は、自動の線を作らない
  if (MANUAL.replace.includes(L)) continue;
  const g = buildGrid(venue, L, [], true);
  if (!g.w) continue;
  const w = centerWeights(g);
  // 行き先：出入口・出口・階段の端（車のスロープと会場の外は除く）・救護室
  const keys: { at: XZ; kind: string }[] = [];
  // （搬入口＝トラック用のシャッターは、来場者は通らないので行き先にしない）
  for (const d of venue.doors) if (d.level === L && (d as { kind?: string }).kind !== "搬入口") keys.push({ at: d.at, kind: "door" });
  for (const e of venue.exits ?? []) if (e.level === L) keys.push({ at: e.at, kind: "exit" });
  for (const s of venue.stairs ?? []) {
    if (s.kind === "ramp" || s.sur) continue;
    if (s.fromLevel === L) keys.push({ at: s.from, kind: "stair" });
    if (s.toLevel === L) keys.push({ at: s.to, kind: "stair" });
  }
  for (const a of venue.firstAid) if (a.level === L) keys.push({ at: a.at, kind: "aid" });
  const cells = new Map<number, number>(); // 升目 → 行き先の番号
  keys.forEach((k, i) => {
    const c = nearestFree(g, k.at, 8);
    if (c >= 0 && !cells.has(c)) cells.set(c, i);
    if (c >= 0) keysOut.push({ level: L, at: centerOf(g, c), kind: k.kind });
  });
  // 道をみな集めて、升目のつながり（道の向き）で 1 つの網にする
  const link = new Map<number, Set<number>>();
  const addLink = (a: number, b: number) => {
    if (!link.has(a)) link.set(a, new Set());
    if (!link.has(b)) link.set(b, new Set());
    link.get(a)!.add(b);
    link.get(b)!.add(a);
  };
  // 歩ける所を細らせて、まん中の 1 本の線（骨格）を取り出す（Zhang-Suen の細線化）
  // （壁から 1.5m 以内は除いてから細らせる：ホールどうしのすきまのような、幅 3m より狭い所に線を引かない）
  const wallD = new Float32Array(g.w * g.h).fill(1e9);
  {
    const q: number[] = [];
    for (let i = 0; i < wallD.length; i++)
      if (g.region[i] < 0) {
        wallD[i] = 0;
        q.push(i);
      }
    for (let k = 0; k < q.length; k++) {
      const i = q[k], c = i % g.w, r = (i - c) / g.w;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= g.w || rr >= g.h) continue;
        const j = rr * g.w + cc;
        if (wallD[j] > wallD[i] + 1) {
          wallD[j] = wallD[i] + 1;
          q.push(j);
        }
      }
    }
  }
  const sk = new Uint8Array(g.w * g.h);
  for (let i = 0; i < sk.length; i++) sk[i] = g.region[i] >= 0 && wallD[i] >= 2 ? 1 : 0;
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= g.w || r >= g.h ? 0 : sk[r * g.w + c]);
  for (let changed = true, it = 0; changed && it < 200; it++) {
    changed = false;
    for (const step of [0, 1]) {
      const del: number[] = [];
      for (let r = 0; r < g.h; r++)
        for (let c = 0; c < g.w; c++) {
          if (!sk[r * g.w + c]) continue;
          const P = [at(c, r - 1), at(c + 1, r - 1), at(c + 1, r), at(c + 1, r + 1), at(c, r + 1), at(c - 1, r + 1), at(c - 1, r), at(c - 1, r - 1)];
          const B = P.reduce((x, y) => x + y, 0);
          if (B < 2 || B > 6) continue;
          let A = 0;
          for (let k = 0; k < 8; k++) if (!P[k] && P[(k + 1) % 8]) A++;
          if (A !== 1) continue;
          if (step === 0 ? P[0] * P[2] * P[4] || P[2] * P[4] * P[6] : P[0] * P[2] * P[6] || P[0] * P[4] * P[6]) continue;
          del.push(r * g.w + c);
        }
      for (const i of del) sk[i] = 0;
      if (del.length) changed = true;
    }
  }
  const skel = new Map<number, number>();
  for (let i = 0; i < sk.length; i++) if (sk[i]) skel.set(i, 1);
  // 骨格の升目どうしのつながり（8 方向）
  for (const i of skel.keys()) {
    const c = i % g.w, r = (i - c) / g.w;
    for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
      const j = (r + dr) * g.w + (c + dc);
      if (c + dc >= 0 && c + dc < g.w && r + dr < g.h && skel.has(j)) addLink(i, j);
    }
  }
  // 行き先から骨格へ、いちばん近い所まで道を引く（壁ぎわを通りにくくして）
  for (const c of cells.keys()) {
    if (skel.has(c)) continue;
    const p = paths(g, w, c, skel, 1)[0];
    if (p) for (let k = 1; k < p.cells.length; k++) addLink(p.cells[k - 1], p.cells[k]);
  }
  // 骨格のとげを取る：行き先でない行き止まりの升目を、SPUR 回まで少しずつ削る
  for (let k = 0; k < SPUR; k++) {
    const leaves = [...link.keys()].filter((i) => (link.get(i)?.size ?? 0) <= 1 && !cells.has(i));
    if (!leaves.length) break;
    for (const i of leaves) {
      for (const j of link.get(i) ?? []) link.get(j)?.delete(i);
      link.delete(i);
    }
  }
  // 斜めの升目と、その角の升目の両方がつながっていると小さな三角ができるので、斜めは除く
  for (const [a, ns] of link)
    for (const b of [...ns]) {
      const ac = a % g.w, ar = (a - ac) / g.w, bc = b % g.w, br = (b - bc) / g.w;
      if (ac !== bc && ar !== br) {
        const c1 = ar * g.w + bc, c2 = br * g.w + ac;
        if ((link.get(a)?.has(c1) && link.get(c1)?.has(b)) || (link.get(a)?.has(c2) && link.get(c2)?.has(b))) {
          ns.delete(b);
          link.get(b)!.delete(a);
        }
      }
    }
  // 分かれ目（つながりが 2 でない升目）と行き先の升目のあいだを 1 本ずつたどる
  const isNode = (i: number) => (link.get(i)?.size ?? 0) !== 2 || cells.has(i);
  const done = new Set<string>();
  for (const [a, ns] of link) {
    if (!isNode(a)) continue;
    for (const b0 of ns) {
      const ek = a < b0 ? `${a},${b0}` : `${b0},${a}`;
      if (done.has(ek)) continue;
      const chain = [a, b0];
      done.add(ek);
      let prev = a, cur = b0;
      while (!isNode(cur)) {
        const nx = [...link.get(cur)!].find((x) => x !== prev)!;
        const k2 = cur < nx ? `${cur},${nx}` : `${nx},${cur}`;
        if (done.has(k2)) break;
        done.add(k2);
        chain.push(nx);
        prev = cur;
        cur = nx;
      }
      const pts = simplify(g, chain.map((i) => centerOf(g, i)));
      out.push({ level: L, pts: pts.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ) });
    }
  }
  // 手で引き直す所（MANUAL.remove）の中の自動の線を消す（形の中か、ふちから 2m 以内の点だけでできた線）
  for (const r of MANUAL.remove.filter((x) => x.level === L)) {
    const inside = (p: XZ) => pointInPolygon(p, r.poly) || r.poly.some((a2, i) => {
      const b2 = r.poly[(i + 1) % r.poly.length];
      const dx = b2[0] - a2[0], dz = b2[1] - a2[1], L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a2[0]) * dx + (p[1] - a2[1]) * dz) / L2));
      return Math.hypot(p[0] - a2[0] - dx * t, p[1] - a2[1] - dz * t) < 2;
    });
    for (let i = out.length - 1; i >= 0; i--) if (out[i].level === L && out[i].pts.every(inside)) out.splice(i, 1);
  }
  // 線から離れたままの出入口・出口（骨格まで道が引けなかったもの）は、いちばん近い線の点へまっすぐつなぐ
  // （30m まで。あいだが歩ける所のときだけ。つなぐ点は、その線の頂点にする）
  const mine = out.filter((o) => o.level === L);
  for (const k of keys) {
    if (k.kind !== "door" && k.kind !== "exit") continue;
    let best: { ln: (typeof mine)[number]; k: number; q: XZ; d: number } | null = null;
    for (const ln of mine)
      for (let j = 1; j < ln.pts.length; j++) {
        const A = ln.pts[j - 1], B = ln.pts[j];
        const dx = B[0] - A[0], dz = B[1] - A[1], L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((k.at[0] - A[0]) * dx + (k.at[1] - A[1]) * dz) / L2));
        const q: XZ = [A[0] + dx * t, A[1] + dz * t];
        const d = Math.hypot(q[0] - k.at[0], q[1] - k.at[1]);
        if (!best || d < best.d) best = { ln, k: j, q, d };
      }
    if (!best || best.d <= 1.5 || best.d > 30) continue;
    const n = Math.ceil(best.d);
    let clear = true;
    for (let i = 1; i < n; i++) {
      const c = cellOf(g, [k.at[0] + ((best.q[0] - k.at[0]) * i) / n, k.at[1] + ((best.q[1] - k.at[1]) * i) / n]);
      if (c < 0 || g.region[c] < 0) clear = false;
    }
    if (!clear) continue;
    const q: XZ = [Math.round(best.q[0] * 10) / 10, Math.round(best.q[1] * 10) / 10];
    best.ln.pts.splice(best.k, 0, q);
    out.push({ level: L, pts: [k.at, q] });
  }
  console.log(`${L}F: 行き先 ${keys.length}、線 ${out.filter((o) => o.level === L).length}`);
}
// 階段：上と下の端を結ぶ（端は、その階の網の行き先の升目に合わせる）
const snap = (p: XZ, L: number) => {
  let best = p, bd = 9;
  for (const k of keysOut) if (k.level === L && k.kind === "stair") {
    const d = Math.hypot(k.at[0] - p[0], k.at[1] - p[1]);
    if (d < bd) [best, bd] = [k.at, d];
  }
  return best;
};
const stairs = (venue.stairs ?? [])
  .filter((s) => s.kind !== "ramp" && !s.sur)
  .map((s) => ({ a: snap(s.from, s.fromLevel), la: s.fromLevel, b: snap(s.to, s.toLevel), lb: s.toLevel, kind: s.kind ?? "stairs" }));
for (const m of MANUAL.lines) out.push(m);
writeFileSync("src/data/corridors.json", JSON.stringify({ lines: out, stairs, keys: keysOut }));
console.log(`線 ${out.length} 本・階段 ${stairs.length}`);
