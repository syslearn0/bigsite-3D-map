// 歩いて見るときの「線路」：机の前の通路のまん中を通る線。歩くモードでは、この線の上だけを進む（ユーザーの指示：
// 自由に動きすぎず、机の周りを歩ける一本の線の上を線路のように歩く）。
// 作り方：机 1 つごとに、通路側（島の机は島の外、壁ぞいの机はサークルの反対側）へ R だけ出た点を置き、列の向きに順につなぐ。
// 向かい合う 2 つの島の線が近いときは、2 本をまん中に寄せて 1 本にする。線の端は少しのばし、近くの線の端と（机をよけて）つなぐ
import { pointInPolygon, type XZ } from "./geo";
import { edgeShared, inWallHole, nearestWallHole, type HallWalls } from "./walls";
import {
  DESK_L,
  type Booth,
  type HallLike,
  type LayoutFeatures,
  type Line,
} from "./layout";

// hall：ホールの中の線はそのホール、通路・階段の線は ""。level：階（1・2・4）
export type Rails = {
  nodes: { p: XZ; hall: string; level: number }[];
  adj: number[][];
};
export type RailPos = { a: number; b: number; t: number }; // 辺 a→b の上の、a からの割合 t
const R = 2.4; // 机の中心から線までの距離（机 0.45m＋いす 0.9m＋通路の半分ほど）
const MERGE = 6; // 向かい合う線（通路をはさんで向かい合う机の線）がこれより近ければ、まん中で 1 本に
const EXT = 2.2; // 線の端を、端の机からのばす長さ
const LINK = 10; // 線の端どうしをつなぐ距離
const WALL_JOIN = 30; // 壁ぞいの列の切れ目（搬入口など）を、壁の前の線でつなぐ長さ
const CLEAR = 1.0; // 線と机（スペースの中心）のあいだにあける距離

const dist = (a: XZ, b: XZ) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// 配置図から写した、ホールの中の障害物（柱・自販機やロッカーの棟・部屋の囲み）。p がそのどれかに pad m より近いか
export type Obstacles = Pick<LayoutFeatures, "pillars" | "structures">;
// （となりのホールの棟が、ホールの境目の切れ目にかかっていることもあるので、同じ階のものはどのホールのものも見る）
// rooms：ホールの外の部屋の帯・ホールの中の階段室などの、入れない部屋（会場データの blocks。その階の床の上に立つもの）
export type Room = { level: number; poly: XZ[] };
function obstacleTest(
  feat: Obstacles | null | undefined,
  halls: { id: string; level: number }[],
  rooms: Room[] = [],
) {
  const lv = new Map(halls.map((h) => [h.id, h.level]));
  const byLevel = new Map<
    number,
    {
      pts: { at: XZ; r: number }[];
      polys: { poly: XZ[]; box: [number, number, number, number] }[];
    }
  >();
  const get = (h: string) => {
    const l = lv.get(h) ?? 1;
    return byLevel.get(l) ?? byLevel.set(l, { pts: [], polys: [] }).get(l)!;
  };
  for (const p of feat?.pillars ?? [])
    get(p.hall).pts.push({ at: p.at, r: p.wall ? 0.5 : 0.25 });
  for (const st of feat?.structures ?? []) {
    const xs = st.poly.map((q) => q[0]),
      zs = st.poly.map((q) => q[1]);
    get(st.hall).polys.push({
      poly: st.poly,
      box: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)],
    });
  }
  for (const rm of rooms) {
    const xs = rm.poly.map((q) => q[0]),
      zs = rm.poly.map((q) => q[1]);
    const o = byLevel.get(rm.level) ?? byLevel.set(rm.level, { pts: [], polys: [] }).get(rm.level)!;
    o.polys.push({
      poly: rm.poly,
      box: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)],
    });
  }
  // hall：ホールの id（その階）。通路の上では "@1" のように "@" と階
  return (p: XZ, hall: string, pad: number) => {
    const o = byLevel.get(hall.startsWith("@") ? Number(hall.slice(1)) : (lv.get(hall) ?? 1));
    if (!o) return false;
    for (const q of o.pts)
      if (
        Math.abs(q.at[0] - p[0]) < q.r + pad &&
        Math.abs(q.at[1] - p[1]) < q.r + pad &&
        dist(q.at, p) < q.r + pad
      )
        return true;
    for (const { poly, box } of o.polys) {
      if (
        p[0] < box[0] - pad ||
        p[0] > box[1] + pad ||
        p[1] < box[2] - pad ||
        p[1] > box[3] + pad
      )
        continue;
      if (pointInPolygon(p, poly) || edgeDist(p, poly) < pad) return true;
    }
    return false;
  };
}
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
  feat?: Obstacles | null,
  rooms: Room[] = [],
): Rails {
  const hitObstacle = obstacleTest(feat, halls, rooms);
  const hallPoly = new Map(halls.map((h) => [h.id, h.poly]));
  const hallLevel = new Map(halls.map((h) => [h.id, h.level]));
  // 机（番号）ごとの中心と通路の向き
  type Pt = {
    p: XZ;
    n: XZ;
    hall: string;
    line: number;
    group: string;
    u: number;
    num: number;
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
      num: b.num,
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
    const off = pts.map(
      (q, i) =>
        (moved[i][0] - q.p[0]) * q.n[0] + (moved[i][1] - q.p[1]) * q.n[1],
    );
    for (const idx of byGroup.values()) {
      // 壁ぞいの列は番号の順（角で曲がる）、島の列は列の向きの順
      const wallG = !!lines[pts[idx[0]].line].wall;
      idx.sort((a2, b2) =>
        wallG ? pts[a2].num - pts[b2].num : pts[a2].u - pts[b2].u,
      );
      // 切れ目のない机の続き（となりの机まで 2.3m 以内）ごとに、寄せる量を 1 つにそろえる（机ごとに少しずつちがうと、線がガタガタになる）。
      // 続きの 3 割以上の机が向かいの線と寄せ合っていれば、その寄せる量のまん中の値、そうでなければ寄せない
      const sm = new Array<number>(idx.length).fill(0);
      let r0 = 0;
      for (let k = 1; k <= idx.length; k++) {
        if (
          k < idx.length &&
          dist(pts[idx[k]].p, pts[idx[k - 1]].p) <= DESK_L * 1.2 + 0.1
        )
          continue;
        const run = idx.slice(r0, k).map((i) => off[i]);
        const merged = run
          .filter((o) => Math.abs(o) > 0.05)
          .sort((x, y) => x - y);
        const v =
          merged.length >= run.length * 0.3
            ? merged[(merged.length - 1) >> 1]
            : 0;
        for (let m = r0; m < k; m++) sm[m] = v;
        r0 = k;
      }
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
    return !hitObstacle(p, hall, 0.5);
  };
  // 柱や棟を突き抜けないか（机の前の線どうしを結ぶとき。机はよけなくてよい）
  const clearOfObstacles = (a: XZ, b: XZ, hall: string) => {
    const n = Math.max(1, Math.ceil(dist(a, b) / 0.3));
    for (let i = 0; i <= n; i++)
      if (
        hitObstacle(
          [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n],
          hall,
          0.4,
        )
      )
        return false;
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
    for (
      let gx = Math.floor((p[0] - SNAP) / cell);
      gx <= Math.floor((p[0] + SNAP) / cell);
      gx++
    )
      for (
        let gz = Math.floor((p[1] - SNAP) / cell);
        gz <= Math.floor((p[1] + SNAP) / cell);
        gz++
      )
        for (const j of nodeGrid.get(`${gx},${gz}`) ?? [])
          if (nodes[j].hall === hall && dist(nodes[j].p, p) < SNAP) return j;
    nodes.push({ p, hall, level: hallLevel.get(hall) ?? 1 });
    const i = nodes.length - 1;
    nodeKey.set(k, i);
    const g = key(p[0], p[1]);
    if (!nodeGrid.has(g)) nodeGrid.set(g, []);
    nodeGrid.get(g)!.push(i);
    return i;
  };
  // 島の列ごとに、線の端をそろえる所（u）：島の両端の少し先と、列の切れ目（横切る通路）のまん中
  const cutsOf = new Map<number, number[]>();
  const cutRange = new Map<number, [number, number][]>();
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
    // 動かしてよい範囲（端の机から 1.6m・切れ目の両側の机から 1.3m 以上、島の端からは 4m まで。机に近すぎると横切る線が引けない）
    cutRange.set(li, [
      [us[0] - 4, us[0] - 1.6],
      [us[us.length - 1] + 1.6, us[us.length - 1] + 4],
      ...us
        .slice(1)
        .flatMap((u2, k) =>
          u2 - us[k] > DESK_L * 1.9
            ? [[us[k] + 1.3, u2 - 1.3] as [number, number]]
            : [],
        ),
    ]);
  });
  // となり合う島の端・切れ目の横切る線が、少しずつずれて並ぶとジグザグになるので、同じ向きの島どうしで
  // 2.5m より近い所は 1 本の線にそろえる（ユーザーの指示：島の端のあたりが気持ち悪い）
  {
    type C = {
      li: number;
      k: number;
      g: number;
      lo: number;
      hi: number;
      sg: number;
      base: number;
    };
    const byDir = new Map<string, C[]>();
    for (const [li, cuts] of cutsOf) {
      const line = lines[li];
      const hall = pts.find((q) => q.line === li)?.hall ?? "";
      // 向き（π ちがいは同じ向き）
      let th = ((line.angle % Math.PI) + Math.PI) % Math.PI;
      if (th > Math.PI - 0.01) th -= Math.PI;
      const sg = Math.cos(line.angle - th) > 0 ? 1 : -1;
      const key2 = `${hall}|${Math.round(th * 50)}`;
      const d: XZ = [Math.cos(th), Math.sin(th)];
      const base = line.start[0] * d[0] + line.start[1] * d[1];
      const ranges = cutRange.get(li)!;
      cuts.forEach((u, k) => {
        const r0 = ranges.find(
          ([lo, hi]) => u >= lo - 0.01 && u <= hi + 0.01,
        ) ?? [u, u];
        const g1 = base + sg * r0[0],
          g2 = base + sg * r0[1];
        if (!byDir.has(key2)) byDir.set(key2, []);
        byDir
          .get(key2)!
          .push({
            li,
            k,
            g: base + sg * u,
            lo: Math.min(g1, g2),
            hi: Math.max(g1, g2),
            sg,
            base,
          });
      });
    }
    for (const list of byDir.values()) {
      list.sort((x, y) => x.g - y.g);
      let k0 = 0;
      for (let k = 1; k <= list.length; k++) {
        if (k < list.length && list[k].g - list[k - 1].g < 2.5) continue;
        const cl = list.slice(k0, k);
        k0 = k;
        if (cl.length < 2 || new Set(cl.map((c) => c.li)).size < cl.length)
          continue;
        const lo = Math.max(...cl.map((c) => c.lo)),
          hi = Math.min(...cl.map((c) => c.hi));
        if (lo > hi) continue;
        const mean = cl.reduce((a2, c) => a2 + c.g, 0) / cl.length;
        const v = Math.max(lo, Math.min(hi, mean));
        for (const c of cl) cutsOf.get(c.li)![c.k] = (v - c.base) * c.sg;
      }
    }
    for (const cuts of cutsOf.values()) cuts.sort((a2, b2) => a2 - b2);
  }
  for (const idx of groups.values()) {
    // 壁ぞいの列は、番号の順（壁にそって角も曲がる）。島の列は、列の向きの順
    const isWall = !!lines[pts[idx[0]].line].wall;
    idx.sort((a, b) =>
      isWall ? pts[a].num - pts[b].num : pts[a].u - pts[b].u,
    );
    let chain: number[] = [];
    // 壁ぞいの列が、搬入口・出入口・柱などで切れている所は、前のかたまりの端と次のかたまりの端を、まっすぐ結ぶ
    // （壁の前を 1 本の線で歩けるように。ユーザーの指示：短い線がばらばらに出ていた）
    let prevTail = -1;
    const flush = () => {
      if (!chain.length) return;
      const li = pts[chain[0]].line,
        line = lines[li];
      const ids = chain.map((i) => nodeAt(moved[i], pts[i].hall));
      for (let k = 1; k < ids.length; k++)
        if (
          clearOfObstacles(
            nodes[ids[k - 1]].p,
            nodes[ids[k]].p,
            nodes[ids[k]].hall,
          )
        )
          addEdge(ids[k - 1], ids[k]);
      const endIds: number[] = [];
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
          endIds.push(qi);
        } else {
          ends.push({ i: end, dir });
          endIds.push(end);
        }
        if (ids.length === 1) {
          endIds.push(endIds[0]);
          break;
        }
      }
      if (line.wall && prevTail >= 0) {
        const a = nodes[prevTail].p,
          b = nodes[endIds[0]].p;
        if (dist(a, b) <= WALL_JOIN && clearSeg(a, b, nodes[prevTail].hall))
          addEdge(prevTail, endIds[0]);
      }
      prevTail = endIds[1];
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
// levels を渡したときは、両端がその階の線だけ
export function nearestOnRails(
  r: Rails,
  p: XZ,
  hall?: string,
  levels?: number[],
): (RailPos & { at: XZ; d: number }) | null {
  let best: (RailPos & { at: XZ; d: number }) | null = null;
  r.adj.forEach((ns, a) => {
    if (hall && r.nodes[a].hall !== hall) return;
    if (levels && !levels.includes(r.nodes[a].level)) return;
    for (const b of ns) {
      if (b < a || (levels && !levels.includes(r.nodes[b].level))) continue;
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

// 通路・広場・階段の線（scripts/build-corridors.ts で作ったもの）を足し、ホールの出入口でホールの中の線とつなぐ。
// desks：ホールごとの机（出入口からホールの中の線へまっすぐ結ぶとき、机をよける）
export type Corridors = {
  lines: { level: number; pts: XZ[] }[];
  stairs: { a: XZ; la: number; b: XZ; lb: number; kind: string }[];
  keys?: { level: number; at: XZ; kind: string }[];
};
export function addCorridors(
  r: Rails,
  c: Corridors,
  doors: { at: XZ; level: number; hall: string; kind?: string }[],
  exits: { at: XZ; level: number }[],
  halls: { id: string; level: number; poly: XZ[]; closed?: string }[],
  desks: Map<string, XZ[]>,
  gaps: { hall: string; a: XZ; b: XZ }[] = [],
  feat?: (Obstacles & { openings?: LayoutFeatures["openings"] }) | null,
  rooms: Room[] = [],
): Rails {
  const hitObstacle = obstacleTest(feat, halls, rooms);
  const openings = feat?.openings ?? [];
  // 3D の壁と同じ穴（VenueView の walls() に渡すものと同じ：出入口・搬入口・会場データと配置図の切れ目・となりのホール）
  const allGaps = [
    ...gaps,
    ...openings.filter(
      (o) =>
        !gaps.some(
          (g) =>
            Math.hypot(
              (o.a[0] + o.b[0] - g.a[0] - g.b[0]) / 2,
              (o.a[1] + o.b[1] - g.a[1] - g.b[1]) / 2,
            ) < 8,
        ),
    ),
  ];
  const wallMemo = new Map<string, HallWalls>();
  const wallsOf = (h: { id: string; level: number; poly: XZ[] }) => {
    let w = wallMemo.get(h.id);
    if (!w) {
      w = {
        poly: h.poly,
        doors: doors.filter((d) => d.hall === h.id && d.kind !== "搬入口"),
        shutters: doors.filter((d) => d.hall === h.id && d.kind === "搬入口"),
        spans: allGaps
          .filter((o) => o.hall === h.id)
          .map((o) => [o.a, o.b] as [XZ, XZ]),
        others: halls
          .filter((o) => o.id !== h.id && o.level === h.level)
          .map((o) => o.poly),
      };
      wallMemo.set(h.id, w);
    }
    return w;
  };
  const nodes = r.nodes.slice();
  const edges = new Set<string>();
  r.adj.forEach((ns, a) => ns.forEach((b) => b > a && edges.add(`${a},${b}`)));
  const addEdge = (a: number, b: number) =>
    a !== b && edges.add(a < b ? `${a},${b}` : `${b},${a}`);
  const grid = new Map<string, number[]>();
  const gk = (p: XZ) => `${Math.floor(p[0] / 4)},${Math.floor(p[1] / 4)}`;
  nodes.forEach((n, i) =>
    (grid.get(gk(n.p)) ?? grid.set(gk(n.p), []).get(gk(n.p))!).push(i),
  );
  const near = (p: XZ, r2: number, ok: (i: number) => boolean) => {
    let best = -1,
      bd = r2;
    for (
      let gx = Math.floor((p[0] - r2) / 4);
      gx <= Math.floor((p[0] + r2) / 4);
      gx++
    )
      for (
        let gz = Math.floor((p[1] - r2) / 4);
        gz <= Math.floor((p[1] + r2) / 4);
        gz++
      )
        for (const j of grid.get(`${gx},${gz}`) ?? []) {
          const d = dist(nodes[j].p, p);
          if (d < bd && ok(j)) [best, bd] = [j, d];
        }
    return best;
  };
  // 通路の点（同じ階で 0.8m 以内の点は 1 つに）
  const corridorNode = (p: XZ, level: number) => {
    const j = near(
      p,
      0.8,
      (i) => nodes[i].hall === "" && nodes[i].level === level,
    );
    if (j >= 0) return j;
    nodes.push({ p, hall: "", level });
    (grid.get(gk(p)) ?? grid.set(gk(p), []).get(gk(p))!).push(nodes.length - 1);
    return nodes.length - 1;
  };
  for (const ln of c.lines) {
    let prev = -1;
    for (const p of ln.pts) {
      const i = corridorNode(p, ln.level);
      if (prev >= 0) addEdge(prev, i);
      prev = i;
    }
  }
  for (const s of c.stairs)
    addEdge(corridorNode(s.a, s.la), corridorNode(s.b, s.lb));
  // 通路の線の途中に、ほかの線の端（や点）が乗っている所（T 字）は、そこで線を分けてつなぐ
  {
    const cor = [...edges]
      .map((e) => e.split(",").map(Number) as [number, number])
      .filter(
        ([a2, b2]) =>
          nodes[a2].hall === "" &&
          nodes[b2].hall === "" &&
          nodes[a2].level === nodes[b2].level,
      );
    const onto = new Map<string, { t: number; n: number }[]>();
    nodes.forEach((nd, n) => {
      if (nd.hall !== "") return;
      for (const [a2, b2] of cor) {
        if (a2 === n || b2 === n || nodes[a2].level !== nd.level) continue;
        const A = nodes[a2].p,
          B = nodes[b2].p;
        if (
          nd.p[0] < Math.min(A[0], B[0]) - 0.6 ||
          nd.p[0] > Math.max(A[0], B[0]) + 0.6 ||
          nd.p[1] < Math.min(A[1], B[1]) - 0.6 ||
          nd.p[1] > Math.max(A[1], B[1]) + 0.6
        )
          continue;
        const dx = B[0] - A[0],
          dz = B[1] - A[1],
          L2 = dx * dx + dz * dz || 1;
        const t = ((nd.p[0] - A[0]) * dx + (nd.p[1] - A[1]) * dz) / L2;
        if (t <= 0.01 || t >= 0.99) continue;
        if (Math.hypot(nd.p[0] - A[0] - dx * t, nd.p[1] - A[1] - dz * t) > 0.6)
          continue;
        const k = `${a2},${b2}`;
        (onto.get(k) ?? onto.set(k, []).get(k)!).push({ t, n });
      }
    });
    for (const [k, list] of onto) {
      const [a2, b2] = k.split(",").map(Number);
      edges.delete(a2 < b2 ? `${a2},${b2}` : `${b2},${a2}`);
      const seq = [a2, ...list.sort((x, y) => x.t - y.t).map((x) => x.n), b2];
      for (let i = 1; i < seq.length; i++) addEdge(seq[i - 1], seq[i]);
    }
  }
  // at からいちばん近い線の上の点（線を分けて点を足す）。ok：その線を使うか。maxD より遠ければ -1
  const attach = (
    at: XZ,
    maxD: number,
    ok: (a: number, b: number) => boolean,
    hall: string,
    level: number,
    clear?: (q: XZ) => boolean,
  ) => {
    let best: { a: number; b: number; t: number; q: XZ; d: number } | null =
      null;
    for (const e of edges) {
      const [a2, b2] = e.split(",").map(Number);
      if (!ok(a2, b2)) continue;
      const A = nodes[a2].p,
        B = nodes[b2].p;
      if (
        at[0] < Math.min(A[0], B[0]) - maxD ||
        at[0] > Math.max(A[0], B[0]) + maxD ||
        at[1] < Math.min(A[1], B[1]) - maxD ||
        at[1] > Math.max(A[1], B[1]) + maxD
      )
        continue;
      const dx = B[0] - A[0],
        dz = B[1] - A[1],
        L2 = dx * dx + dz * dz || 1;
      const t = Math.max(
        0,
        Math.min(1, ((at[0] - A[0]) * dx + (at[1] - A[1]) * dz) / L2),
      );
      const q: XZ = [A[0] + dx * t, A[1] + dz * t];
      const d = dist(q, at);
      if (d > maxD || (best && d >= best.d)) continue;
      if (clear && !clear(q)) continue;
      best = { a: a2, b: b2, t, q, d };
    }
    if (!best) return -1;
    if (best.t < 0.05) return best.a;
    if (best.t > 0.95) return best.b;
    nodes.push({ p: best.q, hall, level });
    const n = nodes.length - 1;
    edges.delete(
      best.a < best.b ? `${best.a},${best.b}` : `${best.b},${best.a}`,
    );
    addEdge(best.a, n);
    addEdge(n, best.b);
    return n;
  };
  // 出入口からホールの中の線へ：壁に直角に入り、そのあとは壁と平行・直角にだけ曲がって（ユーザーの指示）、
  // 机・柱・棟をよけて、いちばん近い線まで。0.5m 角の升目で、曲がるたびに 3m 分の遠回りとして数える
  const hallById = new Map(halls.map((h) => [h.id, h]));
  const deskCell = new Map<string, XZ[]>();
  for (const [h, list] of desks)
    for (const d of list) {
      const k = `${h}|${Math.floor(d[0] / 2)},${Math.floor(d[1] / 2)}`;
      (deskCell.get(k) ?? deskCell.set(k, []).get(k)!).push(d);
    }
  const nearDesk = (q: XZ, h: string, r0: number) => {
    for (
      let gx = Math.floor((q[0] - r0) / 2);
      gx <= Math.floor((q[0] + r0) / 2);
      gx++
    )
      for (
        let gz = Math.floor((q[1] - r0) / 2);
        gz <= Math.floor((q[1] + r0) / 2);
        gz++
      )
        for (const d of deskCell.get(`${h}|${gx},${gz}`) ?? [])
          if (dist(d, q) < r0) return true;
    return false;
  };
  // a から b へまっすぐ、机・柱・棟・部屋に当たらず、ホールの中だけを通るか（a は壁の上でもよい）
  const clearPath = (a: XZ, b: XZ, h: string) => {
    const poly = hallById.get(h)?.poly;
    const m = Math.max(1, Math.ceil(dist(a, b) / 0.4));
    for (let k = 1; k <= m; k++) {
      const q: XZ = [
        a[0] + ((b[0] - a[0]) * k) / m,
        a[1] + ((b[1] - a[1]) * k) / m,
      ];
      if (poly && !pointInPolygon(q, poly)) return false;
      if (k >= 2 && (nearDesk(q, h, 0.9) || hitObstacle(q, h, 0.4)))
        return false;
    }
    return true;
  };
  // 外の通路で、a から b へまっすぐ、どのホールの中も部屋も通らないか（a は出入口の壁の上）
  const hallBox = new Map(
    halls.map((h) => {
      const xs = h.poly.map((q) => q[0]),
        zs = h.poly.map((q) => q[1]);
      return [h, [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]] as const;
    }),
  );
  const outsideClear = (a: XZ, b: XZ, level: number) => {
    // その線分の近くにある、同じ階のホールだけを調べる
    const near = halls.filter((h) => {
      const bx = hallBox.get(h)!;
      return (
        h.level === level &&
        Math.max(a[0], b[0]) >= bx[0] &&
        Math.min(a[0], b[0]) <= bx[1] &&
        Math.max(a[1], b[1]) >= bx[2] &&
        Math.min(a[1], b[1]) <= bx[3]
      );
    });
    const m = Math.max(1, Math.ceil(dist(a, b) / 0.25));
    for (let k = 1; k <= m; k++) {
      const q: XZ = [
        a[0] + ((b[0] - a[0]) * k) / m,
        a[1] + ((b[1] - a[1]) * k) / m,
      ];
      if (
        near.some(
          (h) =>
            pointInPolygon(q, h.poly) &&
            edgeDist(q, h.poly) > 0.15,
        ) ||
        hitObstacle(q, `@${level}`, 0)
      )
        return false;
    }
    return true;
  };
  // 点 p に、いちばん近い多角形のふちの上の点
  const onEdge = (p: XZ, poly: XZ[]): XZ => {
    let best: XZ = p,
      bd = Infinity;
    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length];
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        L2 = dx * dx + dz * dz || 1;
      const t = Math.max(
        0,
        Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2),
      );
      const q: XZ = [a[0] + dx * t, a[1] + dz * t];
      const d = dist(p, q);
      if (d < bd) [bd, best] = [d, q];
    });
    return best;
  };
  const routeIn = (
    at: XZ,
    h: string,
    level: number,
    startNode = -1,
  ): number => {
    const hall = hallById.get(h);
    if (!hall) return -1;
    const poly = hall.poly;
    // いちばん近い壁の向き（e）と、ホールの内向き（n）
    let e: XZ = [1, 0],
      bd = Infinity;
    poly.forEach((a, k) => {
      const b = poly[(k + 1) % poly.length];
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        L = Math.hypot(dx, dz) || 1;
      const t = Math.max(
        0,
        Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dz) / (L * L)),
      );
      const d = Math.hypot(at[0] - a[0] - dx * t, at[1] - a[1] - dz * t);
      if (d < bd) [bd, e] = [d, [dx / L, dz / L]];
    });
    let n: XZ = [-e[1], e[0]];
    if (!pointInPolygon([at[0] + n[0] * 1.5, at[1] + n[1] * 1.5], poly))
      n = [-n[0], -n[1]];
    const S = 0.5,
      NI = 161,
      NJ = 101,
      I0 = 80; // 壁ぞいに ±40m、奥へ 50m
    const world = (i: number, j: number): XZ => [
      at[0] + e[0] * (i - I0) * S + n[0] * j * S,
      at[1] + e[1] * (i - I0) * S + n[1] * j * S,
    ];
    const cellOf = (q: XZ): [number, number] => {
      const rx = q[0] - at[0],
        rz = q[1] - at[1];
      return [
        Math.round((rx * e[0] + rz * e[1]) / S) + I0,
        Math.round((rx * n[0] + rz * n[1]) / S),
      ];
    };
    // 線のある升目（このホールの線）
    const target = new Map<number, [number, number]>();
    for (const ek of edges) {
      const [a2, b2] = ek.split(",").map(Number);
      if (nodes[a2].hall !== h || nodes[b2].hall !== h) continue;
      const A = nodes[a2].p,
        B = nodes[b2].p;
      if (Math.min(dist(A, at), dist(B, at)) > 60 + dist(A, B)) continue;
      const m = Math.max(1, Math.ceil(dist(A, B) / 0.2));
      for (let k = 0; k <= m; k++) {
        const [ci, cj] = cellOf([
          A[0] + ((B[0] - A[0]) * k) / m,
          A[1] + ((B[1] - A[1]) * k) / m,
        ]);
        if (ci >= 0 && ci < NI && cj >= 1 && cj < NJ)
          target.set(ci * NJ + cj, [a2, b2]);
      }
    }
    if (!target.size) return -1;
    const freeMemo = new Int8Array(NI * NJ);
    const free = (i: number, j: number) => {
      const k = i * NJ + j;
      if (!freeMemo[k]) {
        const q = world(i, j);
        freeMemo[k] =
          pointInPolygon(q, poly) &&
          !nearDesk(q, h, 0.9) &&
          !hitObstacle(q, h, 0.45)
            ? 1
            : 2;
      }
      return freeMemo[k] === 1;
    };
    // 状態：升目 × 向き（0:+e 1:-e 2:+n 3:-n）
    const DI = [1, -1, 0, 0],
      DJ = [0, 0, 1, -1];
    const N = NI * NJ * 4,
      cost = new Float64Array(N).fill(Infinity),
      from = new Int32Array(N).fill(-1);
    const heap: [number, number][] = [];
    const push = (c: number, st: number) => {
      heap.push([c, st]);
      let k = heap.length - 1;
      while (k > 0) {
        const pk = (k - 1) >> 1;
        if (heap[pk][0] <= heap[k][0]) break;
        [heap[pk], heap[k]] = [heap[k], heap[pk]];
        k = pk;
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
            r2 = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r2 < heap.length && heap[r2][0] < heap[m][0]) m = r2;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    // 入ってすぐの空いている升目（壁から 5m まで。配置図の壁と会場の形が少しずれている所もある）から、奥へ向いて始める。
    // 出入口のすぐ前に棟などがあってまっすぐ入れないときは、入ってすぐ横へよけた所（8m まで）から
    // （ホールの外の升目は飛ばしてよいが、机・柱・棟・部屋に当たったらそこで止める。まっすぐ入る線がそれを抜けないように）
    let started = false;
    for (let j = 1; j <= 10 && !started; j++) {
      if (free(I0, j)) {
        const st = (I0 * NJ + j) * 4 + 2;
        cost[st] = j * S;
        push(j * S, st);
        started = true;
        break;
      }
      const q = world(I0, j);
      if (
        pointInPolygon(q, poly) ||
        nearDesk(q, h, 0.9) ||
        hitObstacle(q, h, 0.2)
      )
        break;
    }
    if (!started)
      for (let di = 1; di <= 16; di++)
        for (const i of [I0 - di, I0 + di])
          for (let j = 1; j <= 4; j++) {
            if (!free(i, j) || !clearPath(at, world(i, j), h)) continue;
            const st = (i * NJ + j) * 4 + 2,
              c0 = dist(at, world(i, j)) + 3;
            if (c0 < cost[st]) {
              cost[st] = c0;
              push(c0, st);
            }
          }
    let goal = -1;
    while (heap.length) {
      const [c, st] = pop();
      if (c > cost[st]) continue;
      if (c > 90) break;
      const cell = st >> 2,
        dir = st & 3,
        i = Math.floor(cell / NJ),
        j = cell % NJ;
      if (target.has(cell)) {
        goal = st;
        break;
      }
      for (let d2 = 0; d2 < 4; d2++) {
        if (dir >> 1 === d2 >> 1 && dir !== d2) continue; // 引き返さない
        const ni = i + DI[d2],
          nj = j + DJ[d2];
        if (ni < 0 || ni >= NI || nj < 1 || nj >= NJ || !free(ni, nj)) continue;
        const nc = c + S + (d2 === dir ? 0 : 3);
        const ns = (ni * NJ + nj) * 4 + d2;
        if (nc < cost[ns]) {
          cost[ns] = nc;
          from[ns] = st;
          push(nc, ns);
        }
      }
    }
    if (goal < 0) return -1;
    // 升目の道を、曲がる所だけの点にする
    const cells: [number, number, number][] = [];
    for (let st = goal; st >= 0; st = from[st])
      cells.push([Math.floor((st >> 2) / NJ), (st >> 2) % NJ, st & 3]);
    cells.reverse();
    const corners: XZ[] = [];
    if (cells[0][0] !== I0) corners.push(world(cells[0][0], cells[0][1]));
    for (let k = 1; k < cells.length; k++)
      if (cells[k][2] !== cells[k - 1][2])
        corners.push(world(cells[k - 1][0], cells[k - 1][1]));
    // 最後：線の上へ（升目のまん中から、いちばん近い所）
    const [ga, gb] = target.get(goal >> 2)!;
    const ek = ga < gb ? `${ga},${gb}` : `${gb},${ga}`;
    if (!edges.has(ek)) return -1;
    const last = world(cells[cells.length - 1][0], cells[cells.length - 1][1]);
    const A = nodes[ga].p,
      B = nodes[gb].p,
      dx = B[0] - A[0],
      dz = B[1] - A[1],
      L2 = dx * dx + dz * dz || 1;
    const t = Math.max(
      0,
      Math.min(1, ((last[0] - A[0]) * dx + (last[1] - A[1]) * dz) / L2),
    );
    let end: number;
    if (dist(A, last) < 0.4 || t < 0.02) end = ga;
    else if (dist(B, last) < 0.4 || t > 0.98) end = gb;
    else {
      nodes.push({ p: [A[0] + dx * t, A[1] + dz * t], hall: h, level });
      end = nodes.length - 1;
      edges.delete(ek);
      addEdge(ga, end);
      addEdge(end, gb);
    }
    // 出入口の点から、曲がり角を通って線まで（出入口に通路の線の端があれば、その点から）
    let first = startNode;
    if (first < 0) {
      nodes.push({ p: at, hall: "", level });
      first = nodes.length - 1;
    }
    let prev = first;
    for (const q of corners) {
      nodes.push({ p: q, hall: h, level });
      addEdge(prev, nodes.length - 1);
      prev = nodes.length - 1;
    }
    addEdge(prev, end);
    return first;
  };
  // 出入口：ホールの中の線へ（上の道）と、外の通路の線のいちばん近い所（outD m まで）を結ぶ。
  // needOut：外の線がなければ結ばない（開いているシャッターなど、外に道がない所）
  const link = (
    at0: XZ,
    level: number,
    hall: string | null,
    outD = 8,
    needOut = false,
  ) => {
    let linked = false;
    const hallsHere = hall
      ? [hall]
      : halls
          .filter(
            (h) => h.level === level && !h.closed && edgeDist(at0, h.poly) < 6,
          )
          .map((h) => h.id);
    for (const h of hallsHere) {
      // 出入口の点は、図面の「出入口」の文字の位置で、壁から離れていることがある（壁の穴は、壁の上のいちばん近い所に開く）。
      // 線は壁の上の点を通す（文字の位置から壁や部屋をななめに抜けないように）
      const hh = hallById.get(h);
      if (!hh) continue;
      // 壁のその所に穴がなければ（3D では壁のまま）、3m 以内の穴の中へ寄せる。それもなければ、つながない
      const onWall = onEdge(at0, hh.poly);
      const at = inWallHole(onWall, wallsOf(hh))
        ? onWall
        : nearestWallHole(onWall, wallsOf(hh));
      if (!at) continue;
      // 外の通路の線へは、壁の上の点からまっすぐ、ホールの中も部屋も通らずに行ける所。
      // 通路の線が出入口の文字の位置まで来ていれば、まずそこへ（壁からまっすぐ外へ出る線になる）
      const toLabel =
        dist(at, at0) > 0.5 && outsideClear(at, at0, level)
          ? near(
              at0,
              0.8,
              (i) => nodes[i].hall === "" && nodes[i].level === level,
            )
          : -1;
      const out = toLabel >= 0 ? toLabel : attach(
        at,
        outD,
        (a2, b2) =>
          nodes[a2].hall === "" &&
          nodes[b2].hall === "" &&
          nodes[a2].level === level &&
          nodes[b2].level === level,
        "",
        level,
        (q) => outsideClear(at, q, level),
      );
      if (needOut && out < 0) continue;
      const same = out >= 0 && dist(nodes[out].p, at) < 0.5;
      let di = routeIn(at, h, level, same ? out : -1);
      if (di < 0) {
        // 升目の道が見つからない（出入口のすぐ前がふさがっている）ときは、いちばん近い所へまっすぐ（机・柱をよけられるときだけ）
        const inn = attach(
          at,
          35,
          (a2, b2) => nodes[a2].hall === h && nodes[b2].hall === h,
          h,
          level,
          (q) => clearPath(at, q, h),
        );
        if (inn < 0) continue;
        if (same) di = out;
        else {
          nodes.push({ p: at, hall: "", level });
          di = nodes.length - 1;
        }
        addEdge(di, inn);
      }
      if (out >= 0 && !same) addEdge(di, out);
      linked = true;
    }
    return linked;
  };
  // 搬入口（トラック用のシャッター）は、来場者は通らないのでつながない
  // （壁に穴がなくてつながらなかった出入口の文字・出口は、下の行き止まりの枝を消すとき、行き先に数えない）
  const linkedDoors = doors.filter(
    (d) => d.kind !== "搬入口" && link(d.at, d.level, d.hall),
  );
  const linkedExits = exits.filter((e) => link(e.at, e.level, null));
  // 配置図で開いている壁の切れ目（開いているシャッターなど）：出入口と同じように結ぶ（出入口と同じ所は除く）
  for (const o of openings) {
    const m: XZ = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
    const hall = hallById.get(o.hall);
    if (!hall || hall.closed) continue;
    if (
      doors.some(
        (d) => d.kind !== "搬入口" && d.hall === o.hall && dist(d.at, m) < 8,
      )
    )
      continue;
    // となりのホールとの切れ目（下で結ぶ）と同じ所は除く
    if (
      gaps.some((g) => {
        const gm: XZ = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
        return (
          dist(gm, m) < 8 &&
          halls.filter((h) => !h.closed && edgeDist(gm, h.poly) < 3).length >= 2
        );
      })
    )
      continue;
    // 切れ目のまん中のすぐ内側に棟などがあるときは、切れ目の中で少しずつずらした所から
    const w = dist(o.a, o.b),
      ex: XZ = [(o.b[0] - o.a[0]) / (w || 1), (o.b[1] - o.a[1]) / (w || 1)];
    for (let k = 0; k <= Math.floor(w / 2 - 0.5); k++) {
      let done = false;
      for (const sg of k ? [-1, 1] : [1]) {
        if (
          link(
            [m[0] + ex[0] * k * sg, m[1] + ex[1] * k * sg],
            hall.level,
            o.hall,
            25,
            true,
          )
        ) {
          done = true;
          break;
        }
      }
      if (done) break;
    }
  }
  // となりのホールとの壁の切れ目（東1〜3 のつなぎ目など）：両側のホールの中の線を、切れ目のまん中を通って結ぶ
  // 壁のない、となりのホールと重なる辺（南1・南2 の境など。3D でも壁を描かない）も、40m ごとに結ぶ。
  // ただし、上の切れ目ですでに結んでいるホールどうし（東1〜3 など）は足さない（道を探すのに時間がかかるので）
  const joins: { m: XZ; level: number }[] = gaps.map((g) => ({
    m: [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2] as XZ,
    level: hallById.get(g.hall)?.level ?? 1,
  }));
  const joined = new Set<string>();
  for (const { m, level } of joins) {
    const ids = halls
      .filter((h) => !h.closed && h.level === level && edgeDist(m, h.poly) < 3)
      .map((h) => h.id)
      .sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) joined.add(`${ids[i]}|${ids[j]}`);
  }
  halls.forEach((h, hi) => {
    if (h.closed) return;
    const others = halls.filter(
      (o, oi) =>
        oi > hi &&
        !o.closed &&
        o.level === h.level &&
        !joined.has([h.id, o.id].sort().join("|")),
    );
    if (!others.length) return;
    h.poly.forEach((a, i) => {
      const b = h.poly[(i + 1) % h.poly.length];
      const len = dist(a, b);
      for (const [u0, u1] of edgeShared(a, b, others.map((o) => o.poly))) {
        const n = Math.max(1, Math.round((u1 - u0) / 40));
        for (let k = 0; k < n; k++) {
          const u = u0 + ((u1 - u0) * (k + 0.5)) / n;
          joins.push({
            m: [a[0] + ((b[0] - a[0]) * u) / len, a[1] + ((b[1] - a[1]) * u) / len],
            level: h.level,
          });
        }
      }
    });
  });
  for (const { m, level } of joins) {
    const both = halls.filter(
      (h) => !h.closed && h.level === level && edgeDist(m, h.poly) < 3,
    );
    if (both.length < 2) continue;
    const keepN = nodes.length,
      keepE = new Set(edges);
    const ends = both.map((h) => routeIn(m, h.id, h.level));
    if (ends.some((e) => e < 0)) {
      // 片方のホールへ入れないときは、つながない（もう片方へ引いた線も消す）
      nodes.length = keepN;
      edges.clear();
      for (const e of keepE) edges.add(e);
      continue;
    }
    addEdge(ends[0], ends[1]);
  }
  // 行き先のない枝（通路の線の行き止まりで、出入口・出口・階段の端・救護室のどれでもない所）は、つけ根まで消す（ユーザーの指示）
  {
    const goal = (p: XZ, level: number) =>
      (c.keys ?? []).some(
        (k) =>
          k.kind !== "door" &&
          k.kind !== "exit" &&
          k.level === level &&
          dist(k.at, p) < 2.5,
      ) ||
      linkedDoors.some((d) => d.level === level && dist(d.at, p) < 2.5) ||
      linkedExits.some((e) => e.level === level && dist(e.at, p) < 2.5) ||
      c.stairs.some(
        (st) =>
          (st.la === level && dist(st.a, p) < 1) ||
          (st.lb === level && dist(st.b, p) < 1),
      );
    const am = new Map<number, Set<number>>();
    for (const e of edges) {
      const [a2, b2] = e.split(",").map(Number);
      (am.get(a2) ?? am.set(a2, new Set()).get(a2)!).add(b2);
      (am.get(b2) ?? am.set(b2, new Set()).get(b2)!).add(a2);
    }
    const queue = [...am.keys()];
    while (queue.length) {
      const i = queue.pop()!;
      const ns = am.get(i);
      if (
        !ns ||
        ns.size !== 1 ||
        nodes[i].hall !== "" ||
        goal(nodes[i].p, nodes[i].level)
      )
        continue;
      const j = [...ns][0];
      if (nodes[j].level !== nodes[i].level) continue; // 階段の線は消さない
      edges.delete(i < j ? `${i},${j}` : `${j},${i}`);
      ns.delete(j);
      am.get(j)!.delete(i);
      queue.push(j);
    }
  }
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    const [a, b] = e.split(",").map(Number);
    adj[a].push(b);
    adj[b].push(a);
  }
  return { nodes, adj };
}
