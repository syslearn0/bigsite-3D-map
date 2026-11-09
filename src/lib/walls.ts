// ホールの壁の穴（出入口・搬入口・配置図の壁の切れ目・となりのホールとつながる所）。
// 3D の壁（VenueView の walls()）と歩く線（rails.ts）の両方がここを使い、線が穴のない壁を抜けないようにする
import type { XZ } from "./geo";

export const DOOR_W = 4.5; // 幅のない出入口の戸口の幅
export const DOOR_H = 3.6; // 出入口の戸口の高さ

export type WallOpening = { at: XZ; width?: number; height?: number };
export type WallSpan = [XZ, XZ, number?]; // 配置図の切れ目 a〜b（と高さ）

// 辺 a→b の上の穴：[始め, 終わり, 穴の高さ]（u は a からの距離。重なりは 1 つに）
export function edgeGaps(a: XZ, b: XZ, doors: WallOpening[], spans: WallSpan[], shutters: WallOpening[] = []): [number, number, number][] {
  const [ax, az] = a;
  const len = Math.hypot(b[0] - ax, b[1] - az);
  if (len < 0.5) return [];
  const c = (b[0] - ax) / len, s = (b[1] - az) / len;
  const gaps: [number, number, number][] = [];
  for (const [list, h] of [
    [doors, DOOR_H],
    [shutters, DOOR_H * 2], // 搬入口のシャッターは出入口の 2 倍の高さ
  ] as [WallOpening[], number][])
    for (const { at: [dx, dz], width, height: oh } of list) {
      const u = (dx - ax) * c + (dz - az) * s, v = -(dx - ax) * s + (dz - az) * c;
      // 図面の「出入口」の文字は、壁から 5〜12m 離れて書かれていることが多い。幅のある開口は壁の上に置いてあるので、その辺だけ
      if (Math.abs(v) > (width ? 1 : 15) || u < 0 || u > len) continue;
      const w = width ?? DOOR_W;
      gaps.push([Math.max(0.3, u - w / 2), Math.min(len - 0.3, u + w / 2), oh ?? (w > DOOR_W ? Math.max(h, DOOR_H * 2) : h)]);
    }
  // 配置図の壁の切れ目：両端がこの辺の近く（5m 以内）にあれば、その間を開ける
  for (const [p, q, sh] of spans) {
    const up = (p[0] - ax) * c + (p[1] - az) * s, vp = -(p[0] - ax) * s + (p[1] - az) * c;
    const uq = (q[0] - ax) * c + (q[1] - az) * s, vq = -(q[0] - ax) * s + (q[1] - az) * c;
    if (Math.abs(vp) > 5 || Math.abs(vq) > 5) continue;
    const g0 = Math.max(0.3, Math.min(up, uq)), g1 = Math.min(len - 0.3, Math.max(up, uq));
    if (g1 - g0 > 0.5) gaps.push([g0, g1, sh ?? DOOR_H]);
  }
  gaps.sort((p, q) => p[0] - q[0]);
  const merged: [number, number, number][] = [];
  for (const gp of gaps) {
    const last = merged[merged.length - 1];
    if (last && gp[0] <= last[1]) {
      last[1] = Math.max(last[1], gp[1]);
      last[2] = Math.max(last[2], gp[2]);
    } else merged.push([...gp]);
  }
  return merged;
}

// 辺 a→b のうち、となりのホール（others）と重なっていて壁を描かない所（[始め, 終わり]）
export function edgeShared(a: XZ, b: XZ, others: XZ[][]): [number, number][] {
  const [ax, az] = a;
  const len = Math.hypot(b[0] - ax, b[1] - az);
  if (len < 0.5) return [];
  const c = (b[0] - ax) / len, s = (b[1] - az) / len;
  const open: [number, number][] = [];
  for (const o of others)
    o.forEach((p, j) => {
      const q = o[(j + 1) % o.length];
      const vp = -(p[0] - ax) * s + (p[1] - az) * c, vq = -(q[0] - ax) * s + (q[1] - az) * c;
      if (Math.abs(vp) > 3 || Math.abs(vq) > 3) return;
      const up = (p[0] - ax) * c + (p[1] - az) * s, uq = (q[0] - ax) * c + (q[1] - az) * s;
      const o0 = Math.max(0, Math.min(up, uq)), o1 = Math.min(len, Math.max(up, uq));
      if (o1 - o0 > 1) open.push([o0, o1]);
    });
  return open;
}

// ホールの壁の上の点 p（壁から 1m 以内）が、人の通れる穴の中か（穴の端の柱から margin m 以上内側）
export type HallWalls = { poly: XZ[]; doors: WallOpening[]; spans: WallSpan[]; shutters?: WallOpening[]; others: XZ[][] };
export function inWallHole(p: XZ, w: HallWalls, margin = 0.5): boolean {
  const { poly } = w;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const c = (b[0] - a[0]) / len, s = (b[1] - a[1]) / len;
    const u = (p[0] - a[0]) * c + (p[1] - a[1]) * s, v = -(p[0] - a[0]) * s + (p[1] - a[1]) * c;
    if (Math.abs(v) > 1 || u < -0.5 || u > len + 0.5) continue;
    const holes: [number, number][] = [
      ...edgeGaps(a, b, w.doors, w.spans, w.shutters).map(([u0, u1]) => [u0, u1] as [number, number]),
      ...edgeShared(a, b, w.others),
    ];
    if (holes.some(([u0, u1]) => u >= u0 + margin && u <= u1 - margin)) return true;
  }
  return false;
}

// 壁の上の点 p にいちばん近い、穴の中の点（maxD m まで。なければ null）。角に置いた出入口などを、穴の中へ寄せる
export function nearestWallHole(p: XZ, w: HallWalls, maxD = 3, margin = 0.5): XZ | null {
  const { poly } = w;
  let best: XZ | null = null,
    bd = maxD;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const c = (b[0] - a[0]) / len, s = (b[1] - a[1]) / len;
    const u = (p[0] - a[0]) * c + (p[1] - a[1]) * s;
    const holes: [number, number][] = [
      ...edgeGaps(a, b, w.doors, w.spans, w.shutters).map(([u0, u1]) => [u0, u1] as [number, number]),
      ...edgeShared(a, b, w.others),
    ];
    for (const [u0, u1] of holes) {
      if (u1 - u0 < 2 * margin + 0.2) continue;
      const uu = Math.max(u0 + margin, Math.min(u1 - margin, u));
      const q: XZ = [a[0] + c * uu, a[1] + s * uu];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) [bd, best] = [d, q];
    }
  }
  return best;
}
