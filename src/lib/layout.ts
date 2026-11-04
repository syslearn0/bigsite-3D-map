// サークルの机（スペース）の配置。
// 島の列（ブロック1つ）を「始点・向き・区切りごとの机の数」で持ち、机1つ1つの位置と配置番号はそこから計算する。
// あとで手伝う人が島を並べるエディタも、この形をそのまま書き換える。
//
// 机の寸法はコミケの長机（1800×450mm）。机1つが番号1つで、左右の半分が a・b（1スペース＝机半分）。
// 島は机2列が背中合わせ。番号は片側（A側）を始点から進み、反対側（B側）を戻ってくる。

import { minAreaRect, pointInPolygon, type XZ } from "./geo";

export const DESK_L = 1.8;
export const DESK_D = 0.45;
const PITCH = 7; // 島どうしの間隔（机2列 0.9m＋椅子 0.9m×2＋通路 約4.3m）。実際のコミケの密度（東1ホールで千数百スペース）に合わせた目安
const MARGIN = 9; // 壁からの余白（壁ぞいの通路。壁サークルはあとで）
const MAX_DESKS = 16; // 区切り1つの机の数（約29m）ごとに横切る通路
const CROSS = 5; // 横切る通路の幅

export type Line = {
  hall: string;
  block: string; // 「ア」「A」「あ」など
  start: XZ; // 島の中心線の始点
  angle: number; // 島の向き（x 軸から z 軸へ、ラジアン）
  segments: number[]; // 区切りごとの机の数
  genre?: string;
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
  return line.segments.reduce((a, n) => a + n * DESK_L, 0) + CROSS * Math.max(0, line.segments.length - 1);
}

export function expandBooths(lines: Line[], halls: HallLike[]): Booth[] {
  const prefix = new Map(halls.map((h) => [h.id, h.building]));
  const out: Booth[] = [];
  lines.forEach((line, li) => {
    const c = Math.cos(line.angle), s = Math.sin(line.angle);
    const pos = (u: number, v: number): XZ => [line.start[0] + u * c - v * s, line.start[1] + u * s + v * c];
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
const BLOCKS: Record<string, string[]> = { 東: [...ALPHA, ...KANA_E], 西: [...KANA_W], 南: [...ALPHA.toLowerCase()] };
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
