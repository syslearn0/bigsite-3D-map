// 歩いて見るときの「線路」：机の前の通路のまん中を通る線。歩くモードでは、この線の上だけを進む（ユーザーの指示：
// 自由に動きすぎず、机の周りを歩ける一本の線の上を線路のように歩く）。
// 作り方：机 1 つごとに、通路側（島の机は島の外、壁ぞいの机はサークルの反対側）へ R だけ出た点を置き、列の向きに順につなぐ。
// 向かい合う 2 つの島の線が近いときは、2 本をまん中に寄せて 1 本にする。線の端は少しのばし、近くの線の端と（机をよけて）つなぐ
import { pointInPolygon, type XZ } from "./geo";
import { DESK_L, type Booth, type HallLike, type Line } from "./layout";

export type Rails = { nodes: { p: XZ; hall: string }[]; adj: number[][] };
export type RailPos = { a: number; b: number; t: number }; // 辺 a→b の上の、a からの割合 t
const R = 2.4; // 机の中心から線までの距離（机 0.45m＋いす 0.9m＋通路の半分ほど）
const MERGE = 6; // 向かい合う線（通路をはさんで向かい合う机の線）がこれより近ければ、まん中で 1 本に
const EXT = 2.2; // 線の端を、端の机からのばす長さ
const LINK = 10; // 線の端どうしをつなぐ距離
const CLEAR = 1.0; // 線と机（スペースの中心）のあいだにあける距離

const dist = (a: XZ, b: XZ) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// 多角形のふち（辺）までの距離
const edgeDist = (p: XZ, poly: XZ[]) => {
  let best = Infinity;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      L2 = dx * dx + dz * dz || 1;
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2),
    );
    best = Math.min(
      best,
      Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t),
    );
  });
  return best;
};

export function buildRails(
  lines: Line[],
  booths: Booth[],
  halls: HallLike[],
): Rails {
  const hallPoly = new Map(halls.map((h) => [h.id, h.poly]));
  // 机（番号）ごとの中心と通路の向き
  type Pt = {
    p: XZ;
    n: XZ;
    hall: string;
    line: number;
    group: string;
    u: number;
  };
  const byDesk = new Map<string, Booth[]>();
  for (const b of booths) {
    const k = `${b.line}|${b.num}`;
    if (!byDesk.has(k)) byDesk.set(k, []);
    byDesk.get(k)!.push(b);
  }
  const pts: Pt[] = [];
  for (const bs of byDesk.values()) {
    const b = bs[0];
    const line = lines[b.line];
    const cx = bs.reduce((a, q) => a + q.at[0], 0) / bs.length,
      cz = bs.reduce((a, q) => a + q.at[1], 0) / bs.length;
    const left: XZ = [-Math.sin(b.angle), Math.cos(b.angle)];
    let k = line.wall ? -b.side : b.side;
    // 線を置く所がホールの外・壁ぎわ（1.2m 以内）になるときは、反対側が通路（壁ぞいの列に「壁ぞい」の印がないときなど）
    const poly = hallPoly.get(b.hall);
    const bad = (kk: number) => {
      const q: XZ = [cx + left[0] * kk * R, cz + left[1] * kk * R];
      return !!poly && (!pointInPolygon(q, poly) || edgeDist(q, poly) < 1.2);
    };
    if (bad(k) && !bad(-k)) k = -k;
    const n: XZ = [left[0] * k, left[1] * k];
    const lc = Math.cos(line.angle),
      ls = Math.sin(line.angle);
    const u = (cx - line.start[0]) * lc + (cz - line.start[1]) * ls;
    pts.push({
      p: [cx + n[0] * R, cz + n[1] * R],
      n,
      hall: b.hall,
      line: b.line,
      group: `${b.line}|${line.wall ? 0 : k}`,
      u,
    });
  }
  // 向かい合う線（別の列で、通路の向きが逆）が近ければ、まん中へ寄せる
  const cell = 4;
  const grid = new Map<string, number[]>();
  const key = (x: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  pts.forEach((q, i) => {
    const k = key(q.p[0], q.p[1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  const near = (p: XZ, r: number) => {
    const out: number[] = [];
    for (
      let gx = Math.floor((p[0] - r) / cell);
      gx <= Math.floor((p[0] + r) / cell);
      gx++
    )
      for (
        let gz = Math.floor((p[1] - r) / cell);
        gz <= Math.floor((p[1] + r) / cell);
        gz++
      )
        out.push(...(grid.get(`${gx},${gz}`) ?? []));
    return out;
  };
  const moved: XZ[] = pts.map((q, i) => {
    let best = -1,
      bd = MERGE;
    for (const j of near(q.p, MERGE)) {
      const o = pts[j];
      if (
        o.line === q.line ||
        o.hall !== q.hall ||
        q.n[0] * o.n[0] + q.n[1] * o.n[1] > -0.7
      )
        continue;
      const d = dist(q.p, o.p);
      if (d < bd) [best, bd] = [j, d];
    }
    if (best < 0) return pts[i].p;
    // 相手の線の上へ下ろした足との、まん中（線の向きにはずらさない）
    const o = pts[best];
    const along = (o.p[0] - q.p[0]) * q.n[0] + (o.p[1] - q.p[1]) * q.n[1];
    return [q.p[0] + (q.n[0] * along) / 2, q.p[1] + (q.n[1] * along) / 2] as XZ;
  });

  // 寄せたあとの線が机ごとにがたがたしないよう、同じ列・同じ側の点の「通路側へのずれ」を、前後 2 つずつとの中央値にそろえる
  {
    const byGroup = new Map<string, number[]>();
    pts.forEach((q, i) => {
      if (!byGroup.has(q.group)) byGroup.set(q.group, []);
      byGroup.get(q.group)!.push(i);
    });
    const off = pts.map((q, i) => (moved[i][0] - q.p[0]) * q.n[0] + (moved[i][1] - q.p[1]) * q.n[1]);
    for (const idx of byGroup.values()) {
      idx.sort((a2, b2) => pts[a2].u - pts[b2].u);
      const sm = idx.map((i, k) => {
        const win: number[] = [];
        for (let d = -2; d <= 2; d++) {
          const j = idx[k + d];
          // 列の切れ目（離れた机）をまたいでは、そろえない
          if (j === undefined || Math.abs(pts[j].u - pts[i].u) > Math.abs(d) * DESK_L * 1.2 + 0.1) continue;
          win.push(off[j]);
        }
        win.sort((x, y) => x - y);
        return win[(win.length - 1) >> 1];
      });
      idx.forEach((i, k) => {
        const q = pts[i];
        moved[i] = [q.p[0] + q.n[0] * sm[k], q.p[1] + q.n[1] * sm[k]];
      });
    }
  }
  // 机の場所（よけるため）
  // （ホールごと。上の階のホール（西3・4 など）の机は、平面で重なっていても よけない）
  const deskGrid = new Map<string, XZ[]>();
  for (const b of booths) {
    const k = `${b.hall}|${key(b.at[0], b.at[1])}`;
    if (!deskGrid.has(k)) deskGrid.set(k, []);
    deskGrid.get(k)!.push(b.at);
  }
  const clearAt = (p: XZ, hall: string) => {
    for (
      let gx = Math.floor((p[0] - CLEAR) / cell);
      gx <= Math.floor((p[0] + CLEAR) / cell);
      gx++
    )
      for (
        let gz = Math.floor((p[1] - CLEAR) / cell);
        gz <= Math.floor((p[1] + CLEAR) / cell);
        gz++
      )
        for (const d of deskGrid.get(`${hall}|${gx},${gz}`) ?? [])
          if (dist(d, p) < CLEAR) return false;
    return true;
  };
  const clearSeg = (a: XZ, b: XZ, hall: string) => {
    const L = dist(a, b),
      n = Math.max(1, Math.ceil(L / 0.4));
    const poly = hallPoly.get(hall);
    for (let i = 0; i <= n; i++) {
      const p: XZ = [
        a[0] + ((b[0] - a[0]) * i) / n,
        a[1] + ((b[1] - a[1]) * i) / n,
      ];
      if (!clearAt(p, hall) || (poly && !pointInPolygon(p, poly))) return false;
    }
    return true;
  };

  const nodes: Rails["nodes"] = [];
  const edges = new Set<string>();
  // 線（2 点のあいだ）も升目に入れておく（近くの線をすぐ探せるように）
  const edgeGrid = new Map<string, Set<string>>();
  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    const e = a < b ? `${a},${b}` : `${b},${a}`;
    if (edges.has(e)) return;
    edges.add(e);
    const A = nodes[a].p,
      B = nodes[b].p;
    for (
      let gx = Math.floor(Math.min(A[0], B[0]) / cell);
      gx <= Math.floor(Math.max(A[0], B[0]) / cell);
      gx++
    )
      for (
        let gz = Math.floor(Math.min(A[1], B[1]) / cell);
        gz <= Math.floor(Math.max(A[1], B[1]) / cell);
        gz++
      ) {
        const k = `${gx},${gz}`;
        if (!edgeGrid.has(k)) edgeGrid.set(k, new Set());
        edgeGrid.get(k)!.add(e);
      }
  };
  const ends: { i: number; dir: XZ }[] = [];
  // 列・側ごとに、列の向きの順につなぐ（間があけば、そこで線を分ける）
  const groups = new Map<string, number[]>();
  pts.forEach((q, i) => {
    if (!groups.has(q.group)) groups.set(q.group, []);
    groups.get(q.group)!.push(i);
  });
  // 同じ所の点は 1 つにまとめる（向かい合う 2 つの島の線は、まん中に寄せると重なる。島の端の線の端も重なる）
  const nodeKey = new Map<string, number>();
  const nodeGrid = new Map<string, number[]>();
  const SNAP = 0.6; // これより近い点は 1 つにまとめる（向かい合う 2 本の線を寄せたとき、少しずれて並ばないように）
  const nodeAt = (p: XZ, hall: string) => {
    const k = `${hall}|${Math.round(p[0] * 3)}|${Math.round(p[1] * 3)}`;
    const got = nodeKey.get(k);
    if (got !== undefined) return got;
    for (let gx = Math.floor((p[0] - SNAP) / cell); gx <= Math.floor((p[0] + SNAP) / cell); gx++)
      for (let gz = Math.floor((p[1] - SNAP) / cell); gz <= Math.floor((p[1] + SNAP) / cell); gz++)
        for (const j of nodeGrid.get(`${gx},${gz}`) ?? []) if (nodes[j].hall === hall && dist(nodes[j].p, p) < SNAP) return j;
    nodes.push({ p, hall });
    const i = nodes.length - 1;
    nodeKey.set(k, i);
    const g = key(p[0], p[1]);
    if (!nodeGrid.has(g)) nodeGrid.set(g, []);
    nodeGrid.get(g)!.push(i);
    return i;
  };
  // 島の列ごとに、線の端をそろえる所（u）：島の両端の少し先と、列の切れ目（横切る通路）のまん中
  const cutsOf = new Map<number, number[]>();
  lines.forEach((line, li) => {
    if (line.wall) return;
    const us = [
      ...new Set(
        pts.filter((q) => q.line === li).map((q) => Math.round(q.u * 10) / 10),
      ),
    ].sort((a, b) => a - b);
    if (!us.length) return;
    const cuts = [us[0] - EXT, us[us.length - 1] + EXT];
    for (let k = 1; k < us.length; k++)
      if (us[k] - us[k - 1] > DESK_L * 1.9) cuts.push((us[k] + us[k - 1]) / 2);
    cutsOf.set(
      li,
      cuts.sort((a, b) => a - b),
    );
  });
  for (const idx of groups.values()) {
    idx.sort((a, b) => pts[a].u - pts[b].u);
    let chain: number[] = [];
    const flush = () => {
      if (!chain.length) return;
      const li = pts[chain[0]].line,
        line = lines[li];
      const ids = chain.map((i) => nodeAt(moved[i], pts[i].hall));
      for (let k = 1; k < ids.length; k++) addEdge(ids[k - 1], ids[k]);
      // 両端をのばす：島の列は、列の向きにまっすぐ、端をそろえる所（cuts）まで。壁ぞいの列は、線の向きに EXT だけ
      for (const [end, prev, sgn, ue] of [
        [ids[0], ids[1], -1, pts[chain[0]].u],
        [
          ids[ids.length - 1],
          ids[ids.length - 2],
          1,
          pts[chain[chain.length - 1]].u,
        ],
      ] as const) {
        const e = nodes[end].p;
        let dir: XZ,
          len = EXT;
        const cuts = cutsOf.get(li);
        if (cuts) {
          dir = [Math.cos(line.angle) * sgn, Math.sin(line.angle) * sgn];
          const beyond = cuts
            .filter((c) => (c - ue) * sgn > 0.3)
            .sort((a, b) => (a - b) * sgn);
          len = beyond.length ? Math.abs(beyond[0] - ue) : EXT;
        } else if (prev !== undefined) {
          const pp = nodes[prev].p,
            L = dist(e, pp) || 1;
          dir = [(e[0] - pp[0]) / L, (e[1] - pp[1]) / L];
        } else dir = [Math.cos(line.angle) * sgn, Math.sin(line.angle) * sgn];
        const q: XZ = [e[0] + dir[0] * len, e[1] + dir[1] * len];
        const hall = nodes[end].hall;
        if (clearSeg(e, q, hall)) {
          const qi = nodeAt(q, hall);
          addEdge(end, qi);
          ends.push({ i: qi, dir });
        } else ends.push({ i: end, dir });
        if (ids.length === 1) break;
      }
      chain = [];
    };
    for (const i of idx) {
      if (
        chain.length &&
        dist(moved[chain[chain.length - 1]], moved[i]) > DESK_L * 1.9
      )
        flush();
      chain.push(i);
    }
    flush();
  }
  // 島を横切る線（ユーザーの指示：列の途切れている所にも線路を）：端をそろえる所で、島の中心線の上に点を置き、
  // 両側の通路の線の端（同じ u にある）と結ぶ。となりの島の分とつながって、横切る通路の 1 本の線になる
  const sideEnd = (li: number, u: number, sg: number, hall: string) => {
    const line = lines[li];
    const lc = Math.cos(line.angle),
      ls = Math.sin(line.angle);
    let best = -1,
      bv = 6;
    for (const i of ends.map((e) => e.i)) {
      const nd = nodes[i];
      if (nd.hall !== hall) continue;
      const dx = nd.p[0] - line.start[0],
        dz = nd.p[1] - line.start[1];
      const nu = dx * lc + dz * ls,
        nv = -dx * ls + dz * lc;
      if (Math.abs(nu - u) > 0.4 || nv * sg <= 0.5 || Math.abs(nv) >= bv)
        continue;
      [best, bv] = [i, Math.abs(nv)];
    }
    return best;
  };
  lines.forEach((line, li) => {
    const cuts = cutsOf.get(li);
    if (!cuts) return;
    const lc = Math.cos(line.angle),
      ls = Math.sin(line.angle);
    const hall = pts.find((q) => q.line === li)!.hall;
    for (const u of cuts) {
      const c: XZ = [line.start[0] + u * lc, line.start[1] + u * ls];
      if (!clearAt(c, hall) || !pointInPolygon(c, hallPoly.get(hall) ?? [c]))
        continue;
      const se = [-1, 1]
        .map((sg) => sideEnd(li, u, sg, hall))
        .filter((j) => j >= 0 && clearSeg(c, nodes[j].p, hall));
      if (se.length < 2) continue;
      const ci = nodeAt(c, hall);
      for (const j of se) addEdge(ci, j);
    }
  });
  // 線の上に、ほかの線の点が乗っていたら、そこで線を分けてつなぐ（となりの島の線が少しずれて重なっている所・T 字の所）
  const segDist = (p: XZ, A: XZ, B: XZ) => {
    const dx = B[0] - A[0],
      dz = B[1] - A[1],
      L2 = dx * dx + dz * dz || 1;
    const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dz) / L2;
    const tc = Math.max(0, Math.min(1, t));
    return { t, d: Math.hypot(p[0] - A[0] - dx * tc, p[1] - A[1] - dz * tc) };
  };
  const splitAt = (onto: Map<string, { t: number; n: number }[]>) => {
    for (const [e, list] of onto) {
      if (!edges.has(e)) continue;
      const [a, b] = e.split(",").map(Number);
      edges.delete(e);
      const seq = [a, ...list.sort((x, y) => x.t - y.t).map((x) => x.n), b];
      for (let k = 1; k < seq.length; k++) addEdge(seq[k - 1], seq[k]);
    }
  };
  const edgesNear = (p: XZ, r: number) => {
    const cand = new Set<string>();
    for (
      let gx = Math.floor((p[0] - r) / cell);
      gx <= Math.floor((p[0] + r) / cell);
      gx++
    )
      for (
        let gz = Math.floor((p[1] - r) / cell);
        gz <= Math.floor((p[1] + r) / cell);
        gz++
      )
        for (const e of edgeGrid.get(`${gx},${gz}`) ?? []) cand.add(e);
    return [...cand].filter((e) => edges.has(e));
  };
  {
    const onto = new Map<string, { t: number; n: number }[]>();
    nodes.forEach((nd, n) => {
      for (const e of edgesNear(nd.p, 0.4)) {
        const [a, b] = e.split(",").map(Number);
        if (a === n || b === n || nodes[a].hall !== nd.hall) continue;
        const { t, d } = segDist(nd.p, nodes[a].p, nodes[b].p);
        if (d < 0.4 && t > 0.02 && t < 0.98) {
          if (!onto.has(e)) onto.set(e, []);
          onto.get(e)!.push({ t, n });
        }
      }
    });
    splitAt(onto);
  }
  // まだ行き止まりの線の端は、いちばん近いほかの線へ、まっすぐ（その線と直角に）つなぐ（机をよけて）。
  // 壁ぞいのサークルの前の線を、島の通路の線につなぐため。自分の線（数歩先までつながっている点）へはつながない
  const deg = new Map<number, number>();
  const am = new Map<number, number[]>();
  for (const e of edges) {
    const [a, b] = e.split(",").map(Number);
    deg.set(a, (deg.get(a) ?? 0) + 1);
    deg.set(b, (deg.get(b) ?? 0) + 1);
    (am.get(a) ?? am.set(a, []).get(a)!).push(b);
    (am.get(b) ?? am.set(b, []).get(b)!).push(a);
  }
  const nearby = (i: number, steps: number) => {
    const seen = new Set([i]);
    let front = [i];
    for (let k = 0; k < steps; k++) {
      const nx: number[] = [];
      for (const v of front)
        for (const w of am.get(v) ?? [])
          if (!seen.has(w)) {
            seen.add(w);
            nx.push(w);
          }
      front = nx;
    }
    return seen;
  };
  const n0 = nodes.length;
  for (let i = 0; i < n0; i++) {
    const nd = nodes[i];
    if ((deg.get(i) ?? 0) > 1) continue;
    const mine = nearby(i, 6);
    let best: { e: string; t: number; at: XZ; d: number } | null = null;
    for (const e of edgesNear(nd.p, LINK)) {
      const [a, b] = e.split(",").map(Number);
      if ((mine.has(a) && mine.has(b)) || nodes[a].hall !== nd.hall) continue;
      const A = nodes[a].p,
        B = nodes[b].p;
      const { t } = segDist(nd.p, A, B);
      const tc = Math.max(0, Math.min(1, t));
      const at: XZ = [A[0] + (B[0] - A[0]) * tc, A[1] + (B[1] - A[1]) * tc];
      const d = dist(nd.p, at);
      if (d < 0.3 || d > LINK || (best && d >= best.d)) continue;
      if (!clearSeg(nd.p, at, nd.hall)) continue;
      best = { e, t: tc, at, d };
    }
    if (!best) continue;
    const [a, b] = best.e.split(",").map(Number);
    let target: number;
    if (best.t < 0.05) target = a;
    else if (best.t > 0.95) target = b;
    else {
      target = nodeAt(best.at, nd.hall);
      splitAt(new Map([[best.e, [{ t: best.t, n: target }]]]));
    }
    addEdge(i, target);
    deg.set(i, (deg.get(i) ?? 0) + 1);
  }
  // 同じホールの中で、つながっていない線のかたまり（島のかたまりが 2 つあるホールなど）を、いちばん近い所どうし
  // （机をよけて、まっすぐ 40m まで）で結ぶ。小さいかたまりから順に
  const LINK_FAR = 40;
  for (let round = 0; round < 50; round++) {
    const comp = new Map<number, number>();
    const amNow = new Map<number, number[]>();
    for (const e of edges) {
      const [a2, b2] = e.split(",").map(Number);
      (amNow.get(a2) ?? amNow.set(a2, []).get(a2)!).push(b2);
      (amNow.get(b2) ?? amNow.set(b2, []).get(b2)!).push(a2);
    }
    let c = 0;
    const members: number[][] = [];
    for (const start of amNow.keys()) {
      if (comp.has(start)) continue;
      const list = [start];
      comp.set(start, c);
      for (let k = 0; k < list.length; k++)
        for (const w of amNow.get(list[k]) ?? [])
          if (!comp.has(w)) {
            comp.set(w, c);
            list.push(w);
          }
      members.push(list);
      c++;
    }
    // ホールごとに、かたまりが 2 つ以上あるか
    const byHall = new Map<string, number[]>();
    members.forEach((m, ci) => {
      const h = nodes[m[0]].hall;
      if (!byHall.has(h)) byHall.set(h, []);
      byHall.get(h)!.push(ci);
    });
    let linked = false;
    for (const cis of byHall.values()) {
      if (cis.length < 2) continue;
      // 小さいかたまりから、ほかのかたまりへ結べるものを 1 つ（結べなければ次のかたまり）
      for (const small of cis.sort(
        (x, y) => members[x].length - members[y].length,
      )) {
        let best: [number, number, number] | null = null;
        for (const i of members[small]) {
          const p = nodes[i].p;
          for (
            let gx = Math.floor((p[0] - LINK_FAR) / cell);
            gx <= Math.floor((p[0] + LINK_FAR) / cell);
            gx++
          )
            for (
              let gz = Math.floor((p[1] - LINK_FAR) / cell);
              gz <= Math.floor((p[1] + LINK_FAR) / cell);
              gz++
            )
              for (const j of nodeGrid.get(`${gx},${gz}`) ?? []) {
                const cj = comp.get(j);
                if (
                  cj === undefined ||
                  cj === small ||
                  nodes[j].hall !== nodes[i].hall
                )
                  continue;
                const d = dist(p, nodes[j].p);
                if (d > LINK_FAR || (best && d >= best[2])) continue;
                if (!clearSeg(p, nodes[j].p, nodes[i].hall)) continue;
                best = [i, j, d];
              }
        }
        if (best) {
          addEdge(best[0], best[1]);
          linked = true;
          break;
        }
      }
    }
    if (!linked) break;
  }
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    const [a, b] = e.split(",").map(Number);
    adj[a].push(b);
    adj[b].push(a);
  }
  return { nodes, adj };
}

// いちばん近い線の上の点（hall を渡したときは、そのホールの線だけ）
export function nearestOnRails(
  r: Rails,
  p: XZ,
  hall?: string,
): (RailPos & { at: XZ; d: number }) | null {
  let best: (RailPos & { at: XZ; d: number }) | null = null;
  r.adj.forEach((ns, a) => {
    if (hall && r.nodes[a].hall !== hall) return;
    for (const b of ns) {
      if (b < a) continue;
      const A = r.nodes[a].p,
        B = r.nodes[b].p;
      const dx = B[0] - A[0],
        dz = B[1] - A[1],
        L2 = dx * dx + dz * dz || 1;
      const t = Math.max(
        0,
        Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dz) / L2),
      );
      const at: XZ = [A[0] + dx * t, A[1] + dz * t];
      const d = dist(at, p);
      if (!best || d < best.d) best = { a, b, t, at, d };
    }
  });
  return best;
}

export const railPoint = (r: Rails, q: RailPos): XZ => {
  const A = r.nodes[q.a].p,
    B = r.nodes[q.b].p;
  return [A[0] + (B[0] - A[0]) * q.t, A[1] + (B[1] - A[1]) * q.t];
};

// 線の上を、行きたい向き want（長さ 1）に近いほうへ len だけ進む。分かれ道では want にいちばん近い道へ。
// 進む道がなければ（行き止まり）そこで止まる。返すのは新しい位置と、進んでいる向き
export function moveOnRails(
  r: Rails,
  q: RailPos,
  want: XZ,
  len: number,
): { pos: RailPos; dir: XZ } {
  let { a, b, t } = q;
  const dirOf = (from: number, to: number): XZ => {
    const A = r.nodes[from].p,
      B = r.nodes[to].p,
      L = dist(A, B) || 1;
    return [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
  };
  // いまの辺の、want に近い向きへ
  let d = dirOf(a, b);
  if (d[0] * want[0] + d[1] * want[1] < 0) {
    [a, b, t] = [b, a, 1 - t];
    d = dirOf(a, b);
  }
  let left = len;
  for (let guard = 0; guard < 50 && left > 1e-6; guard++) {
    const L = dist(r.nodes[a].p, r.nodes[b].p) || 1e-6;
    const room = (1 - t) * L;
    if (left < room) {
      t += left / L;
      left = 0;
      break;
    }
    left -= room;
    // 分かれ目 b に着いた：来た道（a）以外で、want と今の向きに近い道へ
    let best = -1,
      bs = -Infinity;
    for (const n of r.adj[b]) {
      if (n === a) continue;
      const nd = dirOf(b, n);
      // 見ている向きと、いままで進んできた向き（まっすぐ）の両方を見る。机を向いたまま進んでも、線なりに進む
      const sc =
        nd[0] * want[0] + nd[1] * want[1] + 0.6 * (nd[0] * d[0] + nd[1] * d[1]);
      if (sc > bs) [best, bs] = [n, sc];
    }
    if (best < 0 || bs < -0.5) {
      t = 1;
      break; // 行き止まり（または、行きたい向きと逆の道しかない）
    }
    [a, b, t] = [b, best, 0];
    d = dirOf(a, b);
  }
  return { pos: { a, b, t }, dir: d };
}

// 線の上の 2 つの位置を結ぶ、線に沿ったいちばん短い道（点の列）。つながっていなければ null
export function railPath(r: Rails, from: RailPos, to: RailPos): XZ[] | null {
  const start = railPoint(r, from),
    goal = railPoint(r, to);
  if (
    (from.a === to.a && from.b === to.b) ||
    (from.a === to.b && from.b === to.a)
  )
    return [start, goal];
  const n = r.nodes.length;
  const dd = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap: [number, number][] = [];
  const push = (d: number, i: number) => {
    heap.push([d, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1,
          rr = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  for (const [i, d] of [
    [from.a, dist(start, r.nodes[from.a].p)],
    [from.b, dist(start, r.nodes[from.b].p)],
  ] as const) {
    dd[i] = d;
    push(d, i);
  }
  while (heap.length) {
    const [d, i] = pop();
    if (d > dd[i]) continue;
    for (const j of r.adj[i]) {
      const nd = d + dist(r.nodes[i].p, r.nodes[j].p);
      if (nd < dd[j]) {
        dd[j] = nd;
        prev[j] = i;
        push(nd, j);
      }
    }
  }
  const ga = dd[to.a] + dist(r.nodes[to.a].p, goal),
    gb = dd[to.b] + dist(r.nodes[to.b].p, goal);
  if (!isFinite(Math.min(ga, gb))) return null;
  const out: XZ[] = [goal];
  for (let i = ga <= gb ? to.a : to.b; i >= 0; i = prev[i])
    out.push(r.nodes[i].p);
  out.push(start);
  return out.reverse();
}
