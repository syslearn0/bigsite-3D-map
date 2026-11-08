// 回る順の計画（D-1）：印をつけた机を、歩く道のりが短くなる順に並べる。
// 距離はまっすぐの長さに、ちがう建物（東・西・南）へ移るときと、ちがう階へ移るときの手間を足したもの。
// いちばん近い所から順に回る並べ方を作り、2-opt（2 つの区間を入れかえて短くなれば入れかえる）で直す
import type { XZ } from "./geo";

export type Stop = { id: string; p: XZ; level: number; building: string };
const BUILDING_COST = 250; // 建物をまたぐ（外の通路を歩く）
const LEVEL_COST = 120; // 階をまたぐ（階段・エスカレーター）

export const stopDist = (a: { p: XZ; level: number; building: string }, b: { p: XZ; level: number; building: string }) =>
  Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) + (a.building !== b.building ? BUILDING_COST : 0) + (a.level !== b.level ? LEVEL_COST : 0);

function length(order: Stop[], start?: Stop) {
  let L = start && order.length ? stopDist(start, order[0]) : 0;
  for (let k = 1; k < order.length; k++) L += stopDist(order[k - 1], order[k]);
  return L;
}

function nearestFirst(stops: Stop[], from: Stop | undefined, first?: number): Stop[] {
  const left = stops.slice();
  const out: Stop[] = [];
  let cur = from;
  if (first !== undefined) {
    cur = left.splice(first, 1)[0];
    out.push(cur);
  }
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((s, i) => {
      const d = cur ? stopDist(cur, s) : 0;
      if (d < bd) [bi, bd] = [i, d];
    });
    cur = left.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}

function twoOpt(order: Stop[], start?: Stop): Stop[] {
  const o = order.slice();
  const n = o.length;
  const pos = (i: number) => (i < 0 ? start : o[i]);
  let better = true;
  for (let guard = 0; better && guard < 200; guard++) {
    better = false;
    for (let i = start ? 0 : 1; i < n - 1; i++)
      for (let j = i + 1; j < n; j++) {
        const a = pos(i - 1), b = o[i], c = o[j], d = o[j + 1];
        if (!a) continue;
        // a-b … c-d を a-c … b-d に（終わりの d がないときは、c で終わる）
        const before = stopDist(a, b) + (d ? stopDist(c, d) : 0);
        const after = stopDist(a, c) + (d ? stopDist(b, d) : 0);
        if (after + 1e-6 < before) {
          o.splice(i, j - i + 1, ...o.slice(i, j + 1).reverse());
          better = true;
        }
      }
  }
  return o;
}

// start があれば、そこから。なければ、どこから始めるといちばん短いかも選ぶ
export function planTour(stops: Stop[], start?: { p: XZ; level: number; building: string }): { order: Stop[]; length: number } {
  if (stops.length <= 1) return { order: stops.slice(), length: 0 };
  const s = start ? ({ id: "", ...start } as Stop) : undefined;
  let best: Stop[] = [];
  let bl = Infinity;
  const tries = s ? [undefined] : stops.map((_, i) => i);
  for (const first of tries) {
    const o = twoOpt(nearestFirst(stops, s, first), s);
    const L = length(o, s);
    if (L < bl) [best, bl] = [o, L];
    if (tries.length > 25 && first !== undefined && first >= 25) break; // 多いときは 25 とおりまで
  }
  return { order: best, length: bl };
}
