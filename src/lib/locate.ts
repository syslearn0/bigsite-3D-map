// いまどのホールにいるか（D-2）。スマホの位置（GPS など）から、ホールを決める。
// 建物の中では位置が 10〜50m ずれることがあるので：ホールの中ならそのホール、外なら近いホール（「付近」）。
// 位置がゆれてホールの名前が行ったり来たりしないよう、ちがうホールが 2 回つづいたら切りかえる
import { pointInPolygon, type XZ } from "./geo";

export type HallLite = { id: string; name: string; level: number; poly: XZ[]; closed?: string };
export type Where = { hall: HallLite | null; inside: boolean; dist: number };

function distToPoly(p: XZ, poly: XZ[]) {
  let best = Infinity;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz));
  });
  return best;
}

// levels：見ている階のホールの階（1・2F を見ているときは [1, 2]）。near：これより遠ければ「会場の外」
export function hallAt(p: XZ, halls: HallLite[], levels: number[], near = 60): Where {
  const hs = halls.filter((h) => levels.includes(h.level) && !h.closed);
  for (const h of hs) if (pointInPolygon(p, h.poly)) return { hall: h, inside: true, dist: 0 };
  let best: Where = { hall: null, inside: false, dist: Infinity };
  for (const h of hs) {
    const d = distToPoly(p, h.poly);
    if (d < best.dist) best = { hall: h, inside: false, dist: d };
  }
  return best.dist <= near ? best : { hall: null, inside: false, dist: best.dist };
}

// ゆれを抑える：ちがうホールが need 回つづいたら切りかえる（ホールの中に入ったときは、すぐ）
export function makeSteady(need = 2) {
  let cur: Where | null = null;
  let cand: string | null = null, count = 0;
  return (w: Where): Where => {
    const id = w.hall?.id ?? "";
    if (!cur || (cur.hall?.id ?? "") === id) {
      cur = w;
      cand = null;
      count = 0;
      return cur;
    }
    if (cand === id) count++;
    else {
      cand = id;
      count = 1;
    }
    if (count >= need || (w.inside && !cur.inside)) {
      cur = w;
      cand = null;
      count = 0;
    }
    return cur;
  };
}
