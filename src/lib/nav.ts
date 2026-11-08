// トイレ・救護室までの道（D-3）。1 つの階の、歩ける所を 1m の升目にして、いちばん近いトイレ（救護室）までの道を探す。
// 歩ける所：ホールの中と、その階の通路・広場（駐車場と、会場の外は除く）。ホールの壁は、出入口・シャッター・壁の切れ目の所だけ通れる。
// 机と、来場者の入れない部屋（ブロック）は通れない。ちがう階へは行かない（その階にないときは、ないと答える）
import { pointInPolygon, type XZ } from "./geo";

export type NavVenue = {
  halls: { id: string; level: number; poly: XZ[]; closed?: string }[];
  areas: { name: string; level: number; poly: XZ[]; holes?: XZ[][]; sur?: boolean }[];
  blocks?: { level: number; poly: XZ[] }[];
  doors: { at: XZ; level: number; hall: string; width?: number }[];
  exits?: { at: XZ; level: number; width: number }[];
  wallGaps?: { hall: string; a: XZ; b: XZ }[];
};
export type Grid = {
  level: number;
  x0: number;
  z0: number;
  w: number;
  h: number;
  region: Int16Array; // -1：歩けない、0：通路・広場、1〜：ホール（halls の番号 + 1）
  portal: Uint8Array; // 1：ホールの壁を通れる所（出入口のまわり）
};
const CELL = 1;

// 多角形を、升目の行ごとに塗る（中心が中にある升目）
function fill(g: Grid, poly: XZ[], f: (i: number) => void) {
  const zs = poly.map((p) => p[1]);
  const r0 = Math.max(0, Math.floor((Math.min(...zs) - g.z0) / CELL)), r1 = Math.min(g.h - 1, Math.ceil((Math.max(...zs) - g.z0) / CELL));
  for (let r = r0; r <= r1; r++) {
    const z = g.z0 + (r + 0.5) * CELL;
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (a[1] <= z !== b[1] <= z) xs.push(a[0] + ((z - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - g.x0) / CELL - 0.5)), c1 = Math.min(g.w - 1, Math.floor((xs[k + 1] - g.x0) / CELL - 0.5));
      for (let c = c0; c <= c1; c++) f(r * g.w + c);
    }
  }
}

// outside：ホールの中を歩けないことにする（ホールの外の通路だけの升目。出入口のまわりは残す）
export function buildGrid(v: NavVenue, level: number, desks: XZ[], outside = false): Grid {
  const halls = v.halls.map((h, i) => ({ ...h, i })).filter((h) => h.level === level && !h.closed);
  const areas = v.areas.filter((a) => a.level === level && !a.sur && !/駐車場/.test(a.name));
  const pts = [...halls.flatMap((h) => h.poly), ...areas.flatMap((a) => a.poly)];
  if (!pts.length) return { level, x0: 0, z0: 0, w: 0, h: 0, region: new Int16Array(0), portal: new Uint8Array(0) };
  const x0 = Math.min(...pts.map((p) => p[0])) - 2, z0 = Math.min(...pts.map((p) => p[1])) - 2;
  const w = Math.ceil((Math.max(...pts.map((p) => p[0])) + 2 - x0) / CELL), h = Math.ceil((Math.max(...pts.map((p) => p[1])) + 2 - z0) / CELL);
  const g: Grid = { level, x0, z0, w, h, region: new Int16Array(w * h).fill(-1), portal: new Uint8Array(w * h) };
  for (const a of areas) {
    fill(g, a.poly, (i) => (g.region[i] = 0));
    for (const hole of a.holes ?? []) fill(g, hole, (i) => (g.region[i] = -1));
  }
  for (const hl of halls) fill(g, hl.poly, (i) => (g.region[i] = hl.i + 1));
  for (const b of v.blocks ?? []) if (b.level === level) fill(g, b.poly, (i) => (g.region[i] = -1));
  // 机（スペースの中心から 0.8m）
  for (const d of desks) {
    const c = Math.floor((d[0] - x0) / CELL), r = Math.floor((d[1] - z0) / CELL);
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const cx = x0 + (cc + 0.5) * CELL, cz = z0 + (rr + 0.5) * CELL;
        if (Math.hypot(cx - d[0], cz - d[1]) < 0.8) g.region[rr * w + cc] = -1;
      }
  }
  // 壁を通れる所：出入口・出口のまわり（幅の半分＋1m）と、壁の切れ目
  const mark = (p: XZ, rad: number) => {
    const c = Math.floor((p[0] - x0) / CELL), r = Math.floor((p[1] - z0) / CELL), k = Math.ceil(rad / CELL);
    for (let dr = -k; dr <= k; dr++)
      for (let dc = -k; dc <= k; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        if (Math.hypot(x0 + (cc + 0.5) * CELL - p[0], z0 + (rr + 0.5) * CELL - p[1]) <= rad) g.portal[rr * w + cc] = 1;
      }
  };
  for (const d of v.doors) if (d.level === level) mark(d.at, (d.width ?? 4) / 2 + 1.5);
  for (const e of v.exits ?? []) if (e.level === level) mark(e.at, e.width / 2 + 1.5);
  const hallIds = new Set(halls.map((x) => x.id));
  for (const gp of v.wallGaps ?? []) {
    if (!hallIds.has(gp.hall)) continue;
    const L = Math.hypot(gp.b[0] - gp.a[0], gp.b[1] - gp.a[1]), n = Math.max(1, Math.ceil(L));
    for (let k = 0; k <= n; k++) mark([gp.a[0] + ((gp.b[0] - gp.a[0]) * k) / n, gp.a[1] + ((gp.b[1] - gp.a[1]) * k) / n], 1.5);
  }
  if (outside) for (let i = 0; i < g.region.length; i++) if (g.region[i] > 0 && !g.portal[i]) g.region[i] = -1;
  return g;
}

// 升目ごとの「壁（歩けない所）からの距離」から、通りにくさを作る：壁ぎわほど通りにくい（道が通路のまん中を通る）
export function centerWeights(g: Grid): Float32Array {
  const n = g.w * g.h;
  const d = new Float32Array(n).fill(1e9);
  const q: number[] = [];
  for (let i = 0; i < n; i++)
    if (g.region[i] < 0) {
      d[i] = 0;
      q.push(i);
    }
  // 4 方向の距離で広げる（だいたいでよい）
  for (let k = 0; k < q.length; k++) {
    const i = q[k], c = i % g.w, r = (i - c) / g.w;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= g.w || rr >= g.h) continue;
      const j = rr * g.w + cc;
      if (d[j] > d[i] + 1) {
        d[j] = d[i] + 1;
        q.push(j);
      }
    }
  }
  const w = new Float32Array(n);
  // 壁から 1m で 1 + 12/2^1.3 ≒ 5.9、15m で 1 + 12/16^1.3 ≒ 1.3：広い通路でも、まん中の 1 本に道が集まる
  for (let i = 0; i < n; i++) w[i] = 1 + 12 / Math.pow(1 + Math.min(d[i], 40) * CELL, 1.3);
  return w;
}

const cellOf = (g: Grid, p: XZ) => {
  const c = Math.floor((p[0] - g.x0) / CELL), r = Math.floor((p[1] - g.z0) / CELL);
  return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
};
const centerOf = (g: Grid, i: number): XZ => [g.x0 + ((i % g.w) + 0.5) * CELL, g.z0 + (Math.floor(i / g.w) + 0.5) * CELL];

// p にいちばん近い歩ける升目（rad m まで）
function nearestFree(g: Grid, p: XZ, rad: number): number {
  const i0 = cellOf(g, p);
  if (i0 >= 0 && g.region[i0] >= 0) return i0;
  const c0 = Math.floor((p[0] - g.x0) / CELL), r0 = Math.floor((p[1] - g.z0) / CELL);
  let best = -1, bd = Infinity;
  const k = Math.ceil(rad / CELL);
  for (let dr = -k; dr <= k; dr++)
    for (let dc = -k; dc <= k; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= g.h || c >= g.w) continue;
      const i = r * g.w + c;
      if (g.region[i] < 0) continue;
      const d = Math.hypot(dr, dc);
      if (d < bd && d * CELL <= rad) [best, bd] = [i, d];
    }
  return best;
}

// from から、goals のうちいちばん近い所までの道。返すのは点の列と、何番目の goal か・道のりの長さ
// weight：升目ごとの通りにくさ（1 がふつう。通路のまん中を通るように、壁ぎわを通りにくくするときに使う）
export function findPath(g: Grid, from: XZ, goals: XZ[], weight?: Float32Array): { path: XZ[]; goal: number; length: number } | null {
  if (!g.w) return null;
  const s = nearestFree(g, from, 6);
  if (s < 0) return null;
  const goalAt = new Map<number, number>();
  goals.forEach((p, k) => {
    const i = nearestFree(g, p, 8);
    if (i >= 0 && !goalAt.has(i)) goalAt.set(i, k);
  });
  if (!goalAt.size) return null;
  const n = g.w * g.h;
  const dist = new Float64Array(n).fill(Infinity); // （Float32 だと、ヒープの値と丸めがずれて先へ進めない）
  const prev = new Int32Array(n).fill(-1);
  const heap: number[] = []; // [d, i] を交互に
  const push = (d: number, i: number) => {
    heap.push(d, i);
    let k = heap.length / 2 - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[2 * p] <= heap[2 * k]) break;
      for (const o of [0, 1]) [heap[2 * p + o], heap[2 * k + o]] = [heap[2 * k + o], heap[2 * p + o]];
      k = p;
    }
  };
  const pop = (): [number, number] => {
    const d = heap[0], i = heap[1];
    // 最後の組（[d, i] の順に入っている）を先頭へ
    const lastI = heap.pop()!, lastD = heap.pop()!;
    if (heap.length) {
      heap[0] = lastD;
      heap[1] = lastI;
      let k = 0;
      const m = heap.length / 2;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let s2 = k;
        if (l < m && heap[2 * l] < heap[2 * s2]) s2 = l;
        if (r < m && heap[2 * r] < heap[2 * s2]) s2 = r;
        if (s2 === k) break;
        for (const o of [0, 1]) [heap[2 * s2 + o], heap[2 * k + o]] = [heap[2 * k + o], heap[2 * s2 + o]];
        k = s2;
      }
    }
    return [d, i];
  };
  dist[s] = 0;
  push(0, s);
  const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;
  let found = -1;
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    if (goalAt.has(i)) {
      found = i;
      break;
    }
    const c = i % g.w, r = (i - c) / g.w;
    for (const [dc, dr, cost] of N8) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= g.w || rr >= g.h) continue;
      const j = rr * g.w + cc;
      const rj = g.region[j], ri = g.region[i];
      if (rj < 0) continue;
      // 斜めは、角の 2 つの升目も歩けるときだけ（壁の角をすり抜けない）
      if (dc && dr && (g.region[r * g.w + cc] < 0 || g.region[rr * g.w + c] < 0)) continue;
      // ホールの壁をこえるのは、出入口などの所だけ
      if (rj !== ri && !(g.portal[i] || g.portal[j])) continue;
      const nd = d + cost * CELL * (weight ? (weight[i] + weight[j]) / 2 : 1);
      if (nd < dist[j]) {
        dist[j] = nd;
        prev[j] = i;
        push(nd, j);
      }
    }
  }
  if (found < 0) return null;
  const cells: number[] = [];
  for (let i = found; i >= 0; i = prev[i]) cells.push(i);
  cells.reverse();
  // 升目の道を、まっすぐ見通せる所は 1 本の線にまとめる
  const raw = cells.map((i) => centerOf(g, i));
  const path = simplify(g, raw);
  path[0] = from;
  path.push(goals[goalAt.get(found)!]);
  let length = 0;
  for (let k = 1; k < path.length; k++) length += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
  return { path, goal: goalAt.get(found)!, length };
}

// 線の上の升目がみな歩けて、ホールをまたがない（または出入口を通る）なら、まっすぐ結ぶ
function clearLine(g: Grid, a: XZ, b: XZ) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / (CELL * 0.4)));
  let prev = cellOf(g, a);
  for (let k = 1; k <= n; k++) {
    const i = cellOf(g, [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    if (i < 0 || g.region[i] < 0) return false;
    if (prev >= 0 && g.region[i] !== g.region[prev] && !(g.portal[i] || g.portal[prev])) return false;
    prev = i;
  }
  return true;
}
export function simplify(g: Grid, pts: XZ[]): XZ[] {
  if (pts.length < 3) return pts.slice();
  const out: XZ[] = [pts[0]];
  let k = 0;
  while (k < pts.length - 1) {
    // 先 80 升目までで、まっすぐ見通せるいちばん先へ
    let j = Math.min(pts.length - 1, k + 80);
    while (j > k + 1 && !clearLine(g, pts[k], pts[j])) j--;
    out.push(pts[j]);
    k = j;
  }
  return out;
}

export const insideAny = (p: XZ, polys: XZ[][]) => polys.some((q) => pointInPolygon(p, q));
