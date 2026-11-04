// サークルの机（スペース）の配置。
// 島の列（ブロック1つ）を「始点・向き・区切りごとの机の数」で持ち、机1つ1つの位置と配置番号はそこから計算する。
// あとで手伝う人が島を並べるエディタも、この形をそのまま書き換える。
//
// 机の寸法はコミケの長机（1800×450mm）。机1つが番号1つで、左右の半分が a・b（1スペース＝机半分）。
// 島は机2列が背中合わせ。番号は片側（A側）を始点から進み、反対側（B側）を戻ってくる。

import { minAreaRect, pointInPolygon, type XZ } from "./geo";

export const DESK_L = 1.8;
export const DESK_D = 0.45;
export const PITCH = 7; // 島どうしの間隔（机2列 0.9m＋椅子 0.9m×2＋通路 約4.3m）。実際のコミケの密度（東1ホールで千数百スペース）に合わせた目安
const MARGIN = 9; // 壁からの余白（壁ぞいの通路。壁サークルはあとで）
const MAX_DESKS = 16; // 区切り1つの机の数（約29m）ごとに横切る通路
const CROSS = 5; // 横切る通路の幅

export type Line = {
  hall: string;
  block: string; // 「ア」「A」「あ」など
  start: XZ; // 島の中心線の始点
  angle: number; // 島の向き（x 軸から z 軸へ、ラジアン）
  segments: number[]; // 区切りごとの机の数（desks があるときは使わない）
  genre?: string;
  // 机1つずつの位置（配置図から写した列）。あれば segments より優先する。
  // 島が等間隔でない列、角を曲がる壁ぞいの列、斜めの壁ぞいの机などを、そのまま持てる
  desks?: Desk[];
  wall?: boolean; // 壁ぞいの列（列の名前の札と、島の端の番号を出さない）
};

// 列の中の机1つ。u・v は列の始点からの位置（u：列の向き、v：その左手。expandBooths の pos と同じ）
export type Desk = {
  n: number; // 番号
  u: number;
  v: number;
  turn?: number; // 机の長い辺の向き（列の向きからの角、ラジアン）。なければ列の向き
  side: 1 | -1; // サークルが座る側（机の長い辺の向きから見て左手が 1。列の向きの机なら v と同じ側が 1）
};

export type Booth = {
  code: string; // 「東ア-12a」
  hall: string;
  block: string;
  num: number;
  half: "a" | "b";
  at: XZ; // スペース（机半分）の中心
  angle: number; // 机の長い辺の向き
  side: 1 | -1; // サークルが座る側（島の中心線から見て）
  line: number; // layout の何番目の列か
};

export type HallLike = { id: string; building: string; level: number; poly: XZ[]; closed?: string };

const pad = (n: number) => String(n).padStart(2, "0");

// 区切りの始まりの位置（始点からの距離）
function segmentStarts(line: Line) {
  const s: number[] = [];
  let u = 0;
  for (const n of line.segments) {
    s.push(u);
    u += n * DESK_L + CROSS;
  }
  return s;
}

export function lineLength(line: Line) {
  if (line.desks?.length) return Math.max(...line.desks.map((d) => d.u)) + DESK_L / 2;
  return line.segments.reduce((a, n) => a + n * DESK_L, 0) + CROSS * Math.max(0, line.segments.length - 1);
}

export function expandBooths(lines: Line[], halls: HallLike[]): Booth[] {
  const prefix = new Map(halls.map((h) => [h.id, h.building]));
  const out: Booth[] = [];
  lines.forEach((line, li) => {
    const c = Math.cos(line.angle), s = Math.sin(line.angle);
    const pos = (u: number, v: number): XZ => [line.start[0] + u * c - v * s, line.start[1] + u * s + v * c];
    if (line.desks) {
      const byNum = new Map(line.desks.map((d) => [d.n, d]));
      for (const d of line.desks) {
        const turn = d.turn ?? 0;
        const ac = Math.cos(turn), as = Math.sin(turn); // 机の長い辺の向き（列の中で）
        // a は前の番号の机の側（なければ、次の番号の机と反対の側）。どちらも近くになければ長い辺の向きの手前
        const near = (o: Desk | undefined) => (o && Math.hypot(o.u - d.u, o.v - d.v) < DESK_L * 1.6 ? o : undefined);
        const prev = near(byNum.get(d.n - 1)), next = near(byNum.get(d.n + 1));
        let dir = -1;
        if (prev) dir = (prev.u - d.u) * ac + (prev.v - d.v) * as >= 0 ? 1 : -1;
        else if (next) dir = (next.u - d.u) * ac + (next.v - d.v) * as >= 0 ? -1 : 1;
        for (const [half, k] of [["a", dir], ["b", -dir]] as const) {
          const off = (k * DESK_L) / 4;
          out.push({
            code: `${prefix.get(line.hall) ?? ""}${line.block}-${pad(d.n)}${half}`,
            hall: line.hall,
            block: line.block,
            num: d.n,
            half,
            at: pos(d.u + off * ac, d.v + off * as),
            angle: line.angle + turn,
            side: d.side,
            line: li,
          });
        }
      }
      return;
    }
    const starts = segmentStarts(line);
    // A側：始点から進む。机の中の a は進む向きの手前側
    const desksA: { u0: number; dir: 1 | -1 }[] = [];
    line.segments.forEach((n, i) => {
      for (let k = 0; k < n; k++) desksA.push({ u0: starts[i] + k * DESK_L, dir: 1 });
    });
    // B側：終点から戻る
    const desksB = [...desksA].reverse().map((d) => ({ u0: d.u0 + DESK_L, dir: -1 as const }));
    let num = 0;
    for (const [desks, side] of [[desksA, -1], [desksB, 1]] as const) {
      for (const d of desks) {
        num++;
        for (const [half, k] of [["a", 0], ["b", 1]] as const) {
          const u = d.u0 + d.dir * (k + 0.5) * (DESK_L / 2);
          out.push({
            code: `${prefix.get(line.hall) ?? ""}${line.block}-${pad(num)}${half}`,
            hall: line.hall,
            block: line.block,
            num,
            half,
            at: pos(u, (side * DESK_D) / 2),
            angle: line.angle,
            side,
            line: li,
          });
        }
      }
    }
  });
  return out;
}

// 島（横切る通路で区切られた区間）の両端の番号。端ごとに A側・B側の2つ。
// u：島の中心線の始点からの距離（端の机の端）、out：島の外へ向かう向き（始点側 -1・終点側 1）、side：A側 -1・B側 1（Booth.side と同じ）
export type IslandEnd = { line: number; u: number; out: 1 | -1; side: 1 | -1; num: number };

export function islandEnds(lines: Line[]): IslandEnd[] {
  const out: IslandEnd[] = [];
  lines.forEach((line, li) => {
    if (line.wall) return;
    if (line.desks) {
      // 机1つずつの列：列の向きにならんだ机を、あいだが空いた所で島に分ける。島ごと・側ごとに両端の番号
      const ds = [...line.desks].sort((a, b) => a.u - b.u);
      const islands: Desk[][] = [];
      for (const d of ds) {
        const last = islands[islands.length - 1];
        if (last && d.u - last[last.length - 1].u < DESK_L * 1.5) last.push(d);
        else islands.push([d]);
      }
      for (const isl of islands)
        for (const side of [-1, 1] as const) {
          const one = isl.filter((d) => (d.v >= 0 ? 1 : -1) === side);
          if (!one.length) continue;
          const a = one[0], b = one[one.length - 1];
          out.push({ line: li, u: a.u - DESK_L / 2, out: -1, side, num: a.n });
          out.push({ line: li, u: b.u + DESK_L / 2, out: 1, side, num: b.n });
        }
      return;
    }
    const starts = segmentStarts(line);
    const total = line.segments.reduce((a, n) => a + n, 0); // A側の机の数（B側も同じ）
    let before = 0; // この区間より前の A側の机の数
    line.segments.forEach((n, i) => {
      const u0 = starts[i], u1 = starts[i] + n * DESK_L;
      // A側は始点から 1, 2, …、B側は終点から続きの番号で戻る（A側の k 番目の机の向かいは 2*total+1-k）
      out.push({ line: li, u: u0, out: -1, side: -1, num: before + 1 });
      out.push({ line: li, u: u0, out: -1, side: 1, num: 2 * total - before });
      out.push({ line: li, u: u1, out: 1, side: -1, num: before + n });
      out.push({ line: li, u: u1, out: 1, side: 1, num: 2 * total + 1 - (before + n) });
      before += n;
    });
  });
  return out;
}

// ---- 見本の配置（本当の配置が入るまでの仮のもの） ----

const KANA_E = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロ";
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const KANA_W = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ";
export const BLOCKS: Record<string, string[]> = { 東: [...ALPHA, ...KANA_E], 西: [...KANA_W], 南: [...ALPHA.toLowerCase()] };
export const SAMPLE_GENRES = ["作品A", "作品B", "作品C", "作品D", "作品E", "作品F", "作品G", "作品H"];

export function sampleLayout(halls: HallLike[]): Line[] {
  const lines: Line[] = [];
  const used: Record<string, number> = {};
  let genreRun = 0;
  for (const h of halls) {
    if (h.closed) continue;
    const rect = minAreaRect(h.poly);
    const c = Math.cos(rect.angle), s = Math.sin(rect.angle);
    const at = (u: number, v: number): XZ => [rect.center[0] + u * c - v * s, rect.center[1] + u * s + v * c];
    // 壁から MARGIN 以上離れているか（まわり8方向を確かめる）
    const ok = (u: number, v: number) => {
      for (let a = 0; a < 8; a++) {
        const t = (a * Math.PI) / 4;
        if (!pointInPolygon(at(u + MARGIN * Math.cos(t), v + MARGIN * Math.sin(t)), h.poly)) return false;
      }
      return pointInPolygon(at(u, v), h.poly);
    };
    const n = Math.floor((rect.width - 2 * MARGIN) / PITCH) + 1;
    const v0 = -((n - 1) * PITCH) / 2;
    for (let i = 0; i < n; i++) {
      const v = v0 + i * PITCH;
      // 島の両側（±1.4m）が入る、いちばん長い区間
      let best: [number, number] | null = null;
      let run: number | null = null;
      const half = rect.length / 2;
      for (let u = -half; u <= half + 0.01; u += 0.3) {
        const inside = ok(u, v - 1.4) && ok(u, v + 1.4);
        if (inside && run === null) run = u;
        if ((!inside || u + 0.3 > half + 0.01) && run !== null) {
          const end = inside ? u : u - 0.3;
          if (!best || end - run > best[1] - best[0]) best = [run, end];
          run = null;
        }
      }
      if (!best) continue;
      const len = best[1] - best[0];
      // 机 MAX_DESKS ごとに区切る。区切りの数を決めてから、机を均等に割る
      const k = Math.max(1, Math.ceil((len + CROSS) / (MAX_DESKS * DESK_L + CROSS)));
      const per = Math.floor((len - CROSS * (k - 1)) / DESK_L / k);
      if (per < 3) continue;
      const segments = Array(k).fill(per);
      const total = per * k * DESK_L + CROSS * (k - 1);
      const u0 = (best[0] + best[1]) / 2 - total / 2;
      const list = BLOCKS[h.building];
      const idx = used[h.building] ?? 0;
      used[h.building] = idx + 1;
      lines.push({
        hall: h.id,
        block: list[idx % list.length] + (idx >= list.length ? "'" : ""),
        start: at(u0, v).map((x) => Math.round(x * 100) / 100) as XZ,
        angle: Math.round(rect.angle * 1e4) / 1e4,
        segments,
        // 実際のコミケと同じく、同じ作品は隣り合う列にまとまる（見本なので名前は仮）
        genre: SAMPLE_GENRES[Math.floor(genreRun++ / 3) % SAMPLE_GENRES.length],
      });
    }
  }
  return lines;
}

// 配置番号の書き方の揺れ（「東ア12a」「東ア-12 a」「東ア-12」）を吸収して探す
export function parseCode(q: string): { prefix: string; block: string; num: number; half?: "a" | "b" } | null {
  const m = q.normalize("NFKC").replace(/\s/g, "").match(/^([東西南])(.+?)-?(\d{1,3})([abAB])?$/);
  if (!m) return null;
  return { prefix: m[1], block: m[2], num: Number(m[3]), half: m[4]?.toLowerCase() as "a" | "b" | undefined };
}

// ---- エディタ・保存した配置のための道具 ----

// 壁ぞいの列の名前の札を置く所。壁の一辺ごと（机の向きと、壁からの位置がそろった机のまとまり）に、
// その辺のいちばん端の机2つの、ホールの内側（サークルが座る側と反対）へ inward m。近すぎる札（10m 以内）は1つに
export function wallLabelSpots(line: Line, inward = 2.6): XZ[] {
  if (!line.desks?.length) return [];
  const c = Math.cos(line.angle), s = Math.sin(line.angle);
  const sides = new Map<string, { t: number; at: XZ; sit: XZ }[]>();
  for (const d of line.desks) {
    const at: XZ = [line.start[0] + d.u * c - d.v * s, line.start[1] + d.u * s + d.v * c];
    const a = line.angle + (d.turn ?? 0);
    const sit: XZ = [-Math.sin(a) * d.side, Math.cos(a) * d.side]; // サークルが座る向き（壁の側）
    // 同じ壁の辺：座る向きがそろい（15° きざみ）、その向きで測った壁までの位置がそろう（4m きざみ）
    const dirKey = Math.round(Math.atan2(sit[1], sit[0]) / (Math.PI / 12));
    const off = Math.round((at[0] * sit[0] + at[1] * sit[1]) / 4);
    const key = `${dirKey}:${off}`;
    if (!sides.has(key)) sides.set(key, []);
    sides.get(key)!.push({ t: -at[0] * sit[1] + at[1] * sit[0], at, sit });
  }
  const out: XZ[] = [];
  for (const list of sides.values()) {
    list.sort((p, q) => p.t - q.t);
    for (const p of list.length > 1 ? [list[0], list[list.length - 1]] : [list[0]]) {
      const spot: XZ = [p.at[0] - p.sit[0] * inward, p.at[1] - p.sit[1] * inward];
      if (!out.some((q) => Math.hypot(q[0] - spot[0], q[1] - spot[1]) < 10)) out.push(spot);
    }
  }
  return out;
}

// 列のいちばん大きい番号
export function maxNum(line: Line): number {
  if (line.desks?.length) return Math.max(...line.desks.map((d) => d.n));
  return 2 * line.segments.reduce((a, n) => a + n, 0);
}

// 列にある番号（小さい順）。机1つずつの列は、抜けている番号や、ホールをまたぐ壁ぞいの列の続きの番号がある
export function lineNums(line: Line): number[] {
  if (line.desks) return [...new Set(line.desks.map((d) => d.n))].sort((a, b) => a - b);
  return Array.from({ length: maxNum(line) }, (_, k) => k + 1);
}

// その建物でまだ使っていない、いちばん前の列の名前（東は A〜Z・ア〜、西は あ〜、南は a〜）
export function nextBlock(lines: Line[], building: string, halls: HallLike[]): string {
  const inBuilding = new Set(halls.filter((h) => h.building === building).map((h) => h.id));
  const used = new Set(lines.filter((l) => inBuilding.has(l.hall)).map((l) => l.block));
  // 使い切ったら、見本と同じく「'」をつけて続ける（a' b' …、a'' …）
  const list = BLOCKS[building] ?? ALPHA.split("");
  for (const mark of ["", "'", "''", "'''"]) {
    const b = list.find((x) => !used.has(x + mark));
    if (b) return b + mark;
  }
  return `${building}?`;
}

// 配置の困ったところ。エディタで警告として出す
export type LayoutProblem = { line: number; text: string };
export function layoutProblems(lines: Line[], halls: HallLike[]): LayoutProblem[] {
  const out: LayoutProblem[] = [];
  const hallOf = new Map(halls.map((h) => [h.id, h]));
  lines.forEach((l, i) => {
    const h = hallOf.get(l.hall);
    if (!h) return out.push({ line: i, text: `列 ${l.block}：ホール ${l.hall} がない` });
    if (!l.block.trim()) out.push({ line: i, text: `${i + 1}本目の列：列の名前がない` });
    if (l.desks ? !l.desks.length : !l.segments.length || l.segments.some((n) => !Number.isInteger(n) || n < 1)) out.push({ line: i, text: `列 ${l.block}：机の数が正しくない` });
  });
  // 同じ配置番号が2つない（同じ建物で列の名前が同じでも、番号が重ならなければよい。壁ぞいの列はホールをまたいで続く）
  const booths = expandBooths(lines, halls);
  const seen = new Map<string, number>();
  const dupWith = new Map<number, number>();
  for (const b of booths) {
    const j = seen.get(b.code);
    if (j === undefined) seen.set(b.code, b.line);
    else if (!dupWith.has(b.line)) dupWith.set(b.line, j);
  }
  for (const [i, j] of dupWith)
    out.push({ line: i, text: i === j ? `列 ${lines[i].block}：同じ番号の机が2つある` : `列 ${lines[i].block}：${j + 1}本目の列と番号が重なっている（同じ名前）` });
  // 机がホールの外にはみ出していないか
  const outside = new Set<number>();
  for (const b of booths) if (!outside.has(b.line) && hallOf.has(b.hall) && !pointInPolygon(b.at, hallOf.get(b.hall)!.poly)) outside.add(b.line);
  for (const i of outside) out.push({ line: i, text: `列 ${lines[i].block}：ホールの外にはみ出している` });
  // ほかの列と重なっていないか（同じ階で、違う列の机が 0.6m より近い）。1m のます目に分けて近くだけ調べる
  const grid = new Map<string, number[]>();
  const levelOf = (b: Booth) => hallOf.get(b.hall)?.level ?? 0;
  const cell = (lv: number, x: number, z: number) => `${lv}:${Math.floor(x)},${Math.floor(z)}`;
  booths.forEach((b, i) => {
    const k = cell(levelOf(b), b.at[0], b.at[1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  const overlap = new Map<number, number>();
  booths.forEach((b) => {
    if (overlap.has(b.line)) return;
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const j of grid.get(cell(levelOf(b), b.at[0] + dx, b.at[1] + dz)) ?? []) {
          const o = booths[j];
          if (o.line !== b.line && Math.hypot(o.at[0] - b.at[0], o.at[1] - b.at[1]) < 0.6) overlap.set(b.line, o.line);
        }
  });
  for (const [i, j] of overlap) out.push({ line: i, text: `列 ${lines[i].block}：列 ${lines[j].block} と重なっている` });
  return out;
}

// 配置のファイル（エディタで書き出し・読み込み、メインの地図が端末に保存したものを読む）
export const LAYOUT_FORMAT = "comiket3d-layout";
export type LayoutFile = { format: typeof LAYOUT_FORMAT; version: 1; updated: string; lines: Line[]; features?: LayoutFeatures };

// 配置図にある会場のつくり（配置といっしょに写したもの）：柱と、壁の切れ目（出入口・開いているシャッター）
export type LayoutFeatures = {
  pillars: { hall: string; at: XZ; wall?: boolean }[]; // wall：壁ぎわの柱（壁の線の上）
  openings: { hall: string; a: XZ; b: XZ }[]; // 壁の a から b までが開いている
};

export function toLayoutFile(lines: Line[], features?: LayoutFeatures | null): LayoutFile {
  return { format: LAYOUT_FORMAT, version: 1, updated: new Date().toISOString(), lines, ...(features ? { features } : {}) };
}

// 配置のファイルの会場のつくり（なければ・正しくなければ null）
export function parseLayoutFeatures(json: unknown): LayoutFeatures | null {
  const f = (json as Partial<LayoutFile> | null)?.features;
  if (!f || !Array.isArray(f.pillars) || !Array.isArray(f.openings)) return null;
  const xz = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v));
  const ok = f.pillars.every((p) => p && typeof p.hall === "string" && xz(p.at)) && f.openings.every((o) => o && typeof o.hall === "string" && xz(o.a) && xz(o.b));
  return ok ? { pillars: f.pillars, openings: f.openings } : null;
}

// 読み込んだものが配置のファイルとして正しければ lines を、だめなら null
export function parseLayoutFile(json: unknown): Line[] | null {
  const f = json as Partial<LayoutFile> | null;
  if (!f || f.format !== LAYOUT_FORMAT || !Array.isArray(f.lines)) return null;
  const ok = f.lines.every(
    (l) =>
      l &&
      typeof l.hall === "string" &&
      typeof l.block === "string" &&
      Array.isArray(l.start) &&
      l.start.length === 2 &&
      l.start.every((v) => typeof v === "number" && Number.isFinite(v)) &&
      typeof l.angle === "number" &&
      Array.isArray(l.segments) &&
      l.segments.every((n) => Number.isInteger(n) && n > 0) &&
      (l.desks === undefined ||
        (Array.isArray(l.desks) &&
          l.desks.every(
            (d) => d && Number.isInteger(d.n) && d.n > 0 && [d.u, d.v, d.turn ?? 0].every((x) => typeof x === "number" && Number.isFinite(x)) && (d.side === 1 || d.side === -1),
          ))),
  );
  return ok ? f.lines : null;
}

