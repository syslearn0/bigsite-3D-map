"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import layoutJson from "@/data/layout-sample.json";
import venueJson from "@/data/venue.json";
import { centroid, minAreaRect, pointInPolygon, type XZ } from "@/lib/geo";
import { clearLayout, LAYOUT_KEY, loadLayout, loadLayoutFeatures } from "@/lib/saved-layout";
import { charsText, DAYS, loadTags, TAGS_KEY, workColor, worksOf, type Day, type SpaceTag } from "@/lib/tags";
import { sampleTags } from "@/lib/sample-tags";
import Tour, { type TourStep } from "./Tour";
import { DESK_D, DESK_L, expandBooths, islandEnds, lineLength, lineNums, SAMPLE_GENRES, wallLabelSpots, type Booth, type Line } from "@/lib/layout";

// 会場の 3D。見方は3つ：上から（2D の地図のように）・3D（ぐるっと回せる）・歩く（一人称）。
// ホールの位置関係は OSM の緯度経度のまま。机の配置は見本（C109 の本当の配置ではない）。
// 机は数が多いので InstancedMesh で描き、タップした机は instanceId から配置番号に戻す。

type Hall = { id: string; name: string; building: "東" | "西" | "南"; level: number; poly: XZ[]; closed?: string; rough?: boolean; inner?: XZ[] };
type Venue = {
  floorY: Record<string, number>;
  attribution: string;
  halls: Hall[];
  areas: { name: string; level: number; poly: XZ[]; see?: boolean; holes?: XZ[][]; under?: boolean; outdoor?: boolean; part?: boolean }[];
  context: { name: string; height: number; poly: XZ[] }[];
  parts3d: { poly: XZ[]; min: number; max: number; color: string | null; name: string }[];
  surroundings: {
    lines: { pts: XZ[]; y: number; w: number; kind: "road" | "walk" | "steps" | "rail" }[];
    areas: { poly: XZ[]; y: number; kind: "walk" | "platform" | "water"; name?: string; labels?: XZ[]; holes?: XZ[][] }[];
    stations: { name: string; line: string; at: XZ; y: number }[];
  };
  toilets: { at: XZ; level: number | null; kinds?: string[]; outside?: boolean }[];
  toiletRooms?: { hall: string; level: number; poly: XZ[] }[];
  firstAid: { at: XZ; level: number }[];
  doors: { at: XZ; level: number; kind: "出入口" | "搬入口"; hall: string }[];
  exits?: { at: XZ; level: number; name: string; width: number }[]; // 屋内と屋外の境目の仕切りにあける出口
  stairs?: { name: string; from: XZ; fromLevel: number; to: XZ; toLevel: number; width: number; kind?: "escalator" | "ramp"; outdoor?: boolean }[];
  blocks?: { name: string; level: number; poly: XZ[]; height: number }[];
};
const venue = venueJson as unknown as Venue;
// 机の配置：島のエディタで「3D で確かめる」を押した配置が端末にあればそれ、なければ見本
// （この画面はブラウザでだけ描くので、読み込むときに端末の保存を読める）
const savedLines = loadLayout(LAYOUT_KEY);
const lines = savedLines ?? (layoutJson as unknown as { lines: Line[] }).lines;
// 配置図から写した配置なら、柱と壁の切れ目（出入口・開いているシャッター）もある
const features = savedLines ? loadLayoutFeatures(LAYOUT_KEY) : null;
// 作品・キャラ（島のエディタで入れたもの）。なければ見本の作品で色分けする
const savedTags = loadTags(TAGS_KEY);
const hallById = new Map(venue.halls.map((h) => [h.id, h]));

type View = "top" | "orbit" | "walk";
type Mode = "register" | "plan";
const MODE_KEY = "comiket3d:mode";
type Floor = 1 | 4;
const EYE = 1.6;
const WALK_SPEED = 6; // m/秒（見て回りやすいよう、歩く速さより速め）
const BUILDING_COLOR = { 東: 0xd6e4f7, 西: 0xd9efdd, 南: 0xf6e3cc };
const GENRE_COLOR = [0x2f6fd6, 0xd64545, 0x2f9e5b, 0xc2851b, 0x8a4fc7, 0x1b9aa8, 0xd4559a, 0x6b7a2a];
const DESK_COLOR = 0xf2f1ea;
// ホールの外の歩く所（通路・広場）の色。東展示棟からの連絡路（連絡ブリッジ・北コンコース）は、ほかの通路と分ける
const AREA_COLOR = 0xece3b6;
const LINK_COLOR = 0xf0b48a;
const OUTDOOR_COLOR = 0x5ec8f0; // 屋外（屋上展示場・外の通路・トラックヤード）
const OUTDOOR_2F_COLOR = 0xb9a6e6; // 2F の屋外（エントランスプラザ・イベントプラザ・連絡ブリッジ・コンコースの屋外の所）。薄い紫
const PARKING_COLOR = 0x9ccc8a; // 東棟屋外臨時駐車場（緑）
const OUTDOOR_STAIR_COLOR = 0xe0358f; // 屋外の階段（目立つマゼンタ）
const RAMP_COLOR = 0xe8a33d; // 車のスロープ（目立つ山吹色）
const LINK_AREAS = new Set(["連絡ブリッジ", "北コンコース"]);
const SELECT_COLOR = 0xffb000;
const WALL_H = 12; // ホールの壁の高さ（見やすさの目安。7.5m の 1.6 倍）

// 机につける印。「行きたい」は必ず行く所、「候補」は迷っている所。1つの机にはどちらか1つ
type Mark = "want" | "maybe";
const MARKS: Mark[] = ["want", "maybe"];
const MARK: Record<Mark, { label: string; icon: string; color: number }> = {
  want: { label: "行きたい", icon: "★", color: 0xff2d87 },
  maybe: { label: "候補", icon: "◆", color: 0x0a84ff },
};
const MARKS_KEY = "comiket3d:marks";
const OLD_WISH_KEY = "comiket3d:wish"; // 「行きたい」だけだったころの保存
const PINS_KEY = "comiket3d:pins";
const NOTES_KEY = "comiket3d:notes"; // 印をつけた机のメモ（任意）。配置番号 → メモ
const TOUR_KEY = "comiket3d:tour"; // 使い方の案内を見終えたか

// 初めて開いた人向けの使い方の案内（Tour.tsx）。target は画面の部品（ないときは真ん中に吹き出しだけ）
const TOUR_STEPS: TourStep[] = [
  { title: "ようこそ", text: "即売会の会場を立体で見られる地図です。ドラッグで動かし、2 本指（パソコンはホイール）で拡大・回転できます。" },
  { target: '[aria-label="メニュー"]', title: "メニュー", text: "左上のこのボタンで、サイドバーを開きます。" },
  {
    target: "aside.side",
    menu: true,
    title: "サイドバー",
    text: "日の切りかえ、ジャンル・作品の絞り込み、ホールへの移動、行きたい机の一覧と印刷、モードの切りかえはここにあります。",
  },
  { target: '[data-tour="picker"]', title: "配置番号で探す", text: "列・番号・a/b を選ぶと、その机へ移動します。" },
  { title: "机に印とメモ", text: "机を押すと「★ 行きたい」「◆ 候補」の印をつけられます。印をつけた机には、メモも残せます（この端末の中だけに保存）。" },
  { target: '[aria-label="3D にする"], [aria-label="2D にする"]', title: "2D と 3D", text: "上から見た 2D と、立体の 3D を切りかえます。" },
  { target: '[aria-label="場所を指して歩く"]', title: "歩いて見る", text: "押してから地図の場所を指すと、そこに立って歩くように見られます。" },
  { target: '[aria-label="周辺も表示"]', title: "まわりも見る", text: "駅や道、海など、会場のまわりも出します。" },
  { target: ".floor-switch", title: "階を切りかえる", text: "1F と 4F を切りかえます。「両方」で重ねて見られます。" },
];

// 端末の保存を読む。読めないとき（プライベートモードなど）は空から
function loadMarks(): Record<string, Mark> {
  try {
    const saved = JSON.parse(localStorage.getItem(MARKS_KEY) ?? "null");
    if (saved && typeof saved === "object") return saved;
    const old = JSON.parse(localStorage.getItem(OLD_WISH_KEY) ?? "[]");
    return Object.fromEntries((Array.isArray(old) ? old : []).map((c: string) => [c, "want" as Mark]));
  } catch {
    return {};
  }
}
function loadNotes(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTES_KEY) ?? "null");
    if (saved && typeof saved === "object") return saved;
  } catch {}
  return {};
}
function tourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === "done";
  } catch {
    return true;
  }
}
function loadPins(): Record<Mark, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null");
    if (saved && typeof saved === "object") return { want: !!saved.want, maybe: !!saved.maybe };
  } catch {}
  return { want: true, maybe: false };
}

const floorY = (level: number) => venue.floorY[String(level)] ?? 0;
// 名前の札を置く所：形の重心が形の中なら重心。L 字などで外に出るときは、形の中で、ふちからいちばん遠い所（2m ごとに探す）
function insidePoint(poly: XZ[], holes: XZ[][]): XZ {
  const inPoly = (p: XZ) => pointInPolygon(p, poly) && !holes.some((h) => pointInPolygon(p, h));
  const c = centroid(poly);
  if (inPoly(c)) return c;
  const edgeDist = (p: XZ) => {
    let best = Infinity;
    for (const r of [poly, ...holes])
      r.forEach((a, i) => {
        const b = r[(i + 1) % r.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
        best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz));
      });
    return best;
  };
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  let best: [number, XZ] = [-1, c];
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 2)
    for (let z = Math.min(...zs); z <= Math.max(...zs); z += 2) {
      const p: XZ = [x, z];
      if (!inPoly(p)) continue;
      const d = edgeDist(p);
      if (d > best[0]) best = [d, p];
    }
  return best[1];
}
const floorOf = (level: number): Floor => (level >= 4 ? 4 : 1);
const hexCss = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

// 地図のピン（下の先が机を指す）
function pinSprite(color: number, icon: string) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 88;
  const g = c.getContext("2d")!;
  g.fillStyle = hexCss(color);
  g.strokeStyle = "#fff";
  g.lineWidth = 5;
  g.beginPath();
  g.arc(32, 30, 26, Math.PI * 0.82, Math.PI * 2.18);
  g.lineTo(32, 85);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = "#fff";
  g.font = "bold 28px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(icon, 32, 31);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  s.center.set(0.5, 0);
  s.scale.set((64 / 88) * 1.4, 1.4, 1);
  s.renderOrder = 11;
  return s;
}

function textSprite(text: string, opts: { bg?: string; fg?: string; height?: number; px?: number } = {}) {
  const px = opts.px ?? 40;
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = `bold ${px}px system-ui, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + px;
  c.width = w;
  c.height = Math.ceil(px * 1.6);
  g.font = `bold ${px}px system-ui, sans-serif`;
  if (opts.bg) {
    g.fillStyle = opts.bg;
    g.beginPath();
    g.roundRect(0, 0, c.width, c.height, px * 0.4);
    g.fill();
  }
  g.fillStyle = opts.fg ?? "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, c.width / 2, c.height / 2 + px * 0.05);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const h = opts.height ?? 4;
  s.scale.set((h * c.width) / c.height, h, 1);
  s.renderOrder = 10;
  return s;
}

function shapeOf(poly: XZ[], holes: XZ[][] = []) {
  // ShapeGeometry は XY 平面。-90° 倒すと (x, y) → (x, 0, -y) なので、y に -z を入れる
  const sh = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes) sh.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  return sh;
}

function flatPoly(poly: XZ[], color: number, y: number, opacity = 1, holes: XZ[][] = []) {
  const m = new THREE.Mesh(
    new THREE.ShapeGeometry(shapeOf(poly, holes)),
    new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
}

// 道・線路の帯（線の両側に幅 w/2 ずつ）。種類ごとに1つの形にまとめて描く。skirt があれば、帯のふちから下へ厚みもつける（高架）
function ribbons(list: { pts: XZ[]; y: number; w: number }[], skirt = 0) {
  const pos: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (const { pts, y, w } of list) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const nx = (-(bz - az) / len) * (w / 2), nz = ((bx - ax) / len) * (w / 2);
      const l0 = [ax + nx, y, az + nz], r0 = [ax - nx, y, az - nz], l1 = [bx + nx, y, bz + nz], r1 = [bx - nx, y, bz - nz];
      quad(l0, l1, r1, r0);
      if (skirt > 0) {
        quad([l0[0], y - skirt, l0[2]], [l1[0], y - skirt, l1[2]], l1, l0);
        quad(r0, r1, [r1[0], y - skirt, r1[2]], [r0[0], y - skirt, r0[2]]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ホールの壁。doors（出入口の位置）に近い辺は、そこに幅 DOOR_W・高さ DOOR_H の戸口を開け、上は梁（はり）で残す
const DOOR_W = 4.5;
const DOOR_H = 3.6;
// others：同じ階のほかのホールの形。となりのホールと重なる辺（東1〜3 の境など）は、つながっているので壁を描かない
function walls(poly: XZ[], y: number, height0: number, mat: THREE.Material, doors: XZ[] = [], spans: [XZ, XZ][] = [], others: XZ[][] = [], edgeHeight?: (i: number) => number, shutters: XZ[] = []) {
  const g = new THREE.Group();
  let open: [number, number][] = [];
  const piece = (ax: number, az: number, c: number, s: number, u0: number, u1: number, y0: number, y1: number) => {
    // となりのホールとつながる所にかかる分は、切り分けて描かない
    for (const [o0, o1] of open) {
      if (o1 <= u0 || o0 >= u1) continue;
      piece(ax, az, c, s, u0, o0, y0, y1);
      piece(ax, az, c, s, o1, u1, y0, y1);
      return;
    }
    if (u1 - u0 < 0.05 || y1 - y0 < 0.05) return;
    const w = new THREE.Mesh(new THREE.BoxGeometry(u1 - u0, y1 - y0, 0.4), mat);
    const um = (u0 + u1) / 2;
    w.position.set(ax + c * um, y + (y0 + y1) / 2, az + s * um);
    w.rotation.y = -Math.atan2(s, c);
    g.add(w);
  };
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) continue;
    const c = (bx - ax) / len, s = (bz - az) / len;
    const height = edgeHeight ? edgeHeight(i) : height0;
    // この辺の近く（5m 以内）にある出入口を、辺の上の位置 u にして、戸口の範囲にする（重なれば1つに）
    // [始め, 終わり, 戸口の高さ]
    const gaps: [number, number, number][] = [];
    for (const [list, h] of [
      [doors, DOOR_H],
      [shutters, DOOR_H * 2], // 搬入口のシャッターは出入口の 2 倍の高さ
    ] as [XZ[], number][])
      for (const [dx, dz] of list) {
        const u = (dx - ax) * c + (dz - az) * s, v = -(dx - ax) * s + (dz - az) * c;
        if (Math.abs(v) > 15 || u < 0 || u > len) continue; // 図面の「出入口」の文字は、壁から 5〜12m 離れて書かれていることが多い
        gaps.push([Math.max(0.3, u - DOOR_W / 2), Math.min(len - 0.3, u + DOOR_W / 2), h]);
      }
    // 配置図の壁の切れ目：両端がこの辺の近く（5m 以内）にあれば、その間を開ける
    for (const [p, q] of spans) {
      const up = (p[0] - ax) * c + (p[1] - az) * s, vp = -(p[0] - ax) * s + (p[1] - az) * c;
      const uq = (q[0] - ax) * c + (q[1] - az) * s, vq = -(q[0] - ax) * s + (q[1] - az) * c;
      if (Math.abs(vp) > 5 || Math.abs(vq) > 5) continue;
      const g0 = Math.max(0.3, Math.min(up, uq)), g1 = Math.min(len - 0.3, Math.max(up, uq));
      if (g1 - g0 > 0.5) gaps.push([g0, g1, DOOR_H]);
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
    // となりのホールと重なる所（辺がほぼ同じ線の上にあり、3m 以内）は、上まで開ける
    open = [];
    for (const o of others)
      o.forEach((p, j) => {
        const q = o[(j + 1) % o.length];
        const vp = -(p[0] - ax) * s + (p[1] - az) * c, vq = -(q[0] - ax) * s + (q[1] - az) * c;
        if (Math.abs(vp) > 3 || Math.abs(vq) > 3) return;
        const up = (p[0] - ax) * c + (p[1] - az) * s, uq = (q[0] - ax) * c + (q[1] - az) * s;
        const o0 = Math.max(0, Math.min(up, uq)), o1 = Math.min(len, Math.max(up, uq));
        if (o1 - o0 > 1) open.push([o0, o1]);
      });
    // 辺の先に、となりのホールの角が 3m 以内でつづいていれば、そこまで壁をのばす（ホールの形のあいだのすき間をふさぐ）
    let uStart = 0, uEnd = len;
    for (const o of others)
      for (const q of o) {
        const uq = (q[0] - ax) * c + (q[1] - az) * s, vq = -(q[0] - ax) * s + (q[1] - az) * c;
        if (Math.abs(vq) > 1) continue;
        if (uq > len && uq < len + 3) uEnd = Math.max(uEnd, uq);
        if (uq < 0 && uq > -3) uStart = Math.min(uStart, uq);
      }
    let u = uStart;
    for (const [g0, g1, gh] of merged) {
      piece(ax, az, c, s, u, g0, 0, height);
      piece(ax, az, c, s, g0, g1, Math.min(gh, height - 0.5), height); // 戸口の上
      u = g1;
    }
    piece(ax, az, c, s, u, uEnd, 0, height);
  }
  return g;
}

// 電波があるか（ブラウザの知らせ）。ない間は、端末に持っている地図を出していると伝える
const subscribeOnline = (cb: () => void) => {
  addEventListener("online", cb);
  addEventListener("offline", cb);
  return () => {
    removeEventListener("online", cb);
    removeEventListener("offline", cb);
  };
};

type Api = {
  setView: (v: View) => void;
  setFloor: (f: Floor) => void;
  setBoth: (on: boolean) => void;
  recolor: (colorByGenre: boolean, marks: Record<string, Mark>, selected: number | null, dayTags: Record<string, SpaceTag> | null, genre: string | null, work: string | null, char: string | null) => void;
  setPins: (list: { booth: number; mark: Mark }[]) => void;
  focusBooth: (i: number) => void;
  standAt: (x: number, z: number) => void; // 歩く：その場所に立つ（いま見ている向きのまま）
  focusHall: (id: string) => void;
  hold: (dir: -1 | 0 | 1) => void;
  setSurround: (on: boolean) => void;
  snapshot: (hallIds: string[], marked: { booth: number; mark: Mark }[]) => string;
};

export function VenueView() {
  const box = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const booths = useMemo<Booth[]>(() => expandBooths(lines, venue.halls), []);
  const codeIndex = useMemo(() => new Map(booths.map((b, i) => [b.code, i])), [booths]);
  // サイトを開いた最初は、どのモードでも 3D（モードを切りかえたときは、そのモードの最初の見方）
  const [view, setView] = useState<View>("orbit");
  const [floor, setFloor] = useState<Floor>(1);
  const [both, setBoth] = useState(false); // 1F と 4F の両方を見る
  // 作品で色分け：「すべて」（作品ごとの色）・「色分けしない」・1 つの作品（とキャラ）だけ
  const [byGenre, setByGenre] = useState(true);
  const [genre, setGenre] = useState<string | null>(null);
  const [work, setWork] = useState<string | null>(null);
  const [char, setChar] = useState<string | null>(null);
  // 2 つのモード：作品を登録する（最初は 2D・配置番号の欄をいつも出す）と、当日に使う・計画する（最初は 3D）
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "plan" ? "plan" : "register";
    } catch {
      return "register";
    }
  });
  const [menu, setMenu] = useState(false); // サイドバー
  const [splash, setSplash] = useState(true); // 開いたときの「非公式」の案内
  const [day, setDay] = useState<Day>(1); // 何日目（作品・キャラは日ごと）
  // 机の情報（ジャンル・作品・キャラ）：エディタで入れたもの。なければ公開版の見本（架空の作品）
  const tags = useMemo(() => savedTags ?? sampleTags(booths), [booths]);
  const dayTags: Record<string, SpaceTag> | null = useMemo(() => tags[day] ?? {}, [tags, day]);
  const dayWorks = useMemo(() => worksOf(tags, day), [tags, day]);
  const [surround, setSurround] = useState(true); // 周辺の建物も立体で出す（開いた最初は出す）
  // 印刷するときの中身（ホールごとの絵と一覧）。作ったら印刷の画面を開き、閉じたら消す
  const [print, setPrint] = useState<{ made: string; sections: { title: string; img: string; codes: { code: string; mark: Mark; hall: string; note: string }[] }[] } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // 「歩く」は、立つ机を選んでから始める（選ぶまでは、いまの見方のまま案内を出す）
  const [walkPending, setWalkPending] = useState(false);
  // 「歩く」を待っている間は、地図を押した所にピンを立てて、そこから歩き始める（机の上でなくてよい）
  const standPick = useRef<((x: number, z: number) => void) | null>(null);
  const startWalkAt = useCallback((i: number) => {
    standPick.current = null;
    setWalkPending(false);
    setView("walk");
    requestAnimationFrame(() => api.current?.focusBooth(i));
  }, []);
  const cancelWalk = () => {
    standPick.current = null;
    setWalkPending(false);
  };
  const chooseView = (v: View) => {
    if (v === "walk" && view !== "walk") {
      standPick.current = (x, z) => {
        standPick.current = null;
        setWalkPending(false);
        setView("walk");
        requestAnimationFrame(() => api.current?.standAt(x, z));
      };
      setWalkPending(true);
      return;
    }
    cancelWalk();
    setView(v);
  };
  // 机を選ぶ欄：列（lines の何番目か）→ 番号 → a・b。地図で机を押したときも、その机に合わせる
  const [pickLine, setPickLine] = useState<number | null>(null);
  const [pickNum, setPickNum] = useState(1);
  const [pickHalf, setPickHalf] = useState<"a" | "b">("a");
  // この画面はブラウザでだけ描く（page.tsx で ssr: false）ので、最初から端末の保存を読める
  const [marks, setMarks] = useState<Record<string, Mark>>(loadMarks);
  const [pinsOn, setPinsOn] = useState<Record<Mark, boolean>>(loadPins);
  const [notes, setNotes] = useState<Record<string, string>>(loadNotes);
  const [tour, setTour] = useState(() => !tourDone()); // 使い方の案内（初めての人だけ。開いたときの案内を閉じてから）
  const endTour = () => {
    setTour(false);
    try {
      localStorage.setItem(TOUR_KEY, "done");
    } catch {}
  };
  const [listOpen, setListOpen] = useState(false);
  const [here, setHere] = useState(""); // 近づいたときの、いま見ているホール
  const onHere = useRef(setHere);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

  useEffect(() => {
    try {
      localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
      localStorage.removeItem(OLD_WISH_KEY);
    } catch {}
  }, [marks]);
  useEffect(() => {
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
    } catch {}
  }, [notes]);
  useEffect(() => {
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(pinsOn));
    } catch {}
  }, [pinsOn]);

  // ---- 3D の準備（1回だけ） ----
  useEffect(() => {
    const el = box.current!;
    // 奥行きは対数の目盛りにする。地面・海・1F の屋外・床は高さの差が数 cm〜数十 cm しかなく、ふつうの目盛りだと
    // 遠くから見たときに見分けられず、面どうしが入れかわってチカチカする（z-fighting）
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    // 机の配置番号を書く透明な板（上からの見方で、拡大したときだけ）。3D の上に重ね、押すのは下の 3D に通す
    const codeLayer = document.createElement("canvas");
    codeLayer.style.cssText = "position:absolute;inset:0;pointer-events:none";
    // 先頭に入れる：後ろにある凡例や下の帯（同じく position: absolute）が、この板より上に描かれるように
    el.insertBefore(codeLayer, el.firstChild);
    const codeCtx = codeLayer.getContext("2d")!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe9ece9);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(-200, 400, 150);
    scene.add(sun);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshLambertMaterial({ color: 0xcfd6cf }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    scene.add(ground);
    // 周辺の建物の立体（OSM の高さ。会議棟の逆ピラミッドは段ごとの部品を積んだもの）。「周辺も表示」のときだけ出す
    const surroundings = new THREE.Group();
    surroundings.visible = false;
    const towerMeshes: THREE.Mesh[] = [];
    // まわりの建物の足元の形も、「周辺も表示」のときだけ（ふだんは会場だけを見せる）
    for (const b of venue.context) surroundings.add(flatPoly(b.poly, 0xb9bfb8, -0.1));
    for (const b of venue.parts3d) {
      const g = new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: b.max - b.min, bevelEnabled: false });
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: b.color ? new THREE.Color(b.color) : new THREE.Color(0xd2d5cf) }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = b.min;
      // 会議棟（逆ピラミッドと柱）は会場の目印なので、「周辺も表示」でなくても 3D ではいつも出す
      if (/Conference Tower|会議棟/.test(b.name)) {
        scene.add(m);
        towerMeshes.push(m);
      } else surroundings.add(m);
    }
    // 道・歩道（2F の歩行者デッキを含む）・ゆりかもめの高架・駅のホーム
    const sur = venue.surroundings;
    const SUR_COLOR = { road: 0x8f938e, walk: 0xe6e2d6, steps: 0xc9c2b0, rail: 0xb4bac0 };
    for (const kind of ["road", "walk", "steps"] as const) {
      const m = new THREE.Mesh(ribbons(sur.lines.filter((l) => l.kind === kind)), new THREE.MeshLambertMaterial({ color: SUR_COLOR[kind], side: THREE.DoubleSide }));
      m.position.y = -0.08; // 地面（-0.2）より上、ホールの床より下
      surroundings.add(m);
    }
    const elevated = sur.lines.filter((l) => l.kind === "rail" && l.y > 1);
    surroundings.add(new THREE.Mesh(ribbons(elevated, 1.5), new THREE.MeshLambertMaterial({ color: SUR_COLOR.rail, side: THREE.DoubleSide })));
    // 高架の上の線路（2本の細い線）
    const rails = elevated.flatMap((l) => [-1, 1].map((k) => ({ ...l, w: 0.4, y: l.y + 0.05, pts: l.pts.map(([x, z], i) => {
      const [bx, bz] = l.pts[Math.min(i + 1, l.pts.length - 1)], [ax, az] = l.pts[Math.max(i - 1, 0)];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      return [x - ((bz - az) / len) * k * 1.6, z + ((bx - ax) / len) * k * 1.6] as XZ;
    }) })));
    surroundings.add(new THREE.Mesh(ribbons(rails), new THREE.MeshLambertMaterial({ color: 0x5b5148, side: THREE.DoubleSide })));
    surroundings.add(new THREE.Mesh(ribbons(sur.lines.filter((l) => l.kind === "rail" && l.y <= 1)), new THREE.MeshLambertMaterial({ color: 0x9c9488, side: THREE.DoubleSide })));
    for (const a of sur.areas) {
      const m = flatPoly(a.poly, a.kind === "water" ? 0x6fa8d6 : a.kind === "platform" ? 0xd9cfb4 : SUR_COLOR.walk, a.y - (a.kind === "walk" ? 0.08 : 0), 1, a.holes ?? []);
      // 海は地面のすぐ上の広い面。遠くで地面と奥行きの差がなくなってチカチカしないよう、少し手前に描く
      if (a.kind === "water") {
        const mat = m.material as THREE.MeshLambertMaterial;
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = -4;
        mat.polygonOffsetUnits = -4;
        // 「海」「川」の文字
        for (const l of a.name ? (a.labels ?? []) : []) {
          const t = textSprite(a.name!, { fg: "#ffffff", bg: "rgba(40,100,160,.85)", height: 60, px: 96 });
          t.position.set(l[0], 30, l[1]);
          surroundings.add(t);
        }
      }
      surroundings.add(m);
    }
    // 駅の名前（画面の上で同じ大きさ。毎フレーム placeLabels で大きさを決める）
    const stationLabels: { s: THREE.Sprite; base: THREE.Vector3 }[] = [];
    // 重なったときに残す順（来場者がよく使う駅から）
    const STATION_ORDER = ["東京ビッグサイト駅", "国際展示場駅"];
    const rank = (n: string) => (STATION_ORDER.includes(n) ? STATION_ORDER.indexOf(n) : STATION_ORDER.length);
    for (const st of [...sur.stations].sort((a, b) => rank(a.name) - rank(b.name))) {
      const sp = textSprite(`🚉 ${st.name}（${st.line}）`, { bg: st.line === "ゆりかもめ" ? "rgba(0,120,90,.92)" : "rgba(20,80,160,.92)", height: 6, px: 36 });
      sp.position.set(st.at[0], st.y + 8, st.at[1]);
      surroundings.add(sp);
      stationLabels.push({ s: sp, base: sp.scale.clone() });
    }
    scene.add(surroundings);

    // 階ごとの入れ物。選んでいない階は床を薄くし、机・壁・文字を隠す
    type LevelParts = { floors: THREE.Mesh[]; solid: THREE.Object3D[] };
    // 文字の札。上から・3D では、ズームしても画面の上で同じ大きさ（px）にする。近づいて机が見えてきたら、
    // ホールの名前のような大きな札は机を隠すので消し、列の名前のような細かい札は近いときだけ出す。歩くときは実物の大きさ
    type LabelKind = "hall" | "area" | "wc" | "aid" | "door" | "shutter" | "block";
    const LABEL_PX: Record<LabelKind, number> = { hall: 22, area: 13, wc: 16, aid: 16, door: 15, shutter: 13, block: 15 };
    const labels: { s: THREE.Sprite; kind: LabelKind; base: THREE.Vector3 }[] = [];
    const addLabel = (s: THREE.Sprite, kind: LabelKind) => labels.push({ s, kind, base: s.scale.clone() });
    const levels = new Map<number, LevelParts>();
    const partsOf = (lv: number) => {
      if (!levels.has(lv)) levels.set(lv, { floors: [], solid: [] });
      return levels.get(lv)!;
    };
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x8d9894, transparent: true, opacity: 0.55 });
    const occluders: THREE.Object3D[] = []; // 札を隠す壁（3D・歩くで、壁の向こうの札は出さない）

    const areaColor = new Map<(typeof venue.areas)[number], number>();
    for (const a of venue.areas) {
      const y = floorY(a.level);
      const link = LINK_AREAS.has(a.name) || a.see;
      const south = a.name === "南コンコース" || a.name === "コンコース";
      // 屋外（公式フロアマップで灰色の所）は、どの階も屋上展示場と同じ水色。屋内の 2F はオレンジ、ほかの屋内は黄色
      const color = a.name === "東棟屋外臨時駐車場" ? PARKING_COLOR : a.outdoor ? (a.level === 2 ? OUTDOOR_2F_COLOR : OUTDOOR_COLOR) : a.level === 2 || south || link ? LINK_COLOR : AREA_COLOR;
      const f = flatPoly(a.poly, color, y + (a.under ? 0.01 : south ? 0.05 : 0.02), a.see ? 0.8 : 1, a.holes ?? []);
      if (a.see) f.userData.see = 0.8; // 下（ガレリア）が少し透けて見える床
      scene.add(f);
      partsOf(a.level).floors.push(f);
      areaColor.set(a, color);
      if (link) {
        // 連絡通路（東展示棟 2F・連絡ブリッジ・北コンコース）：吹き抜けのふちに手すり（高さ 1.1m の薄い板）
        for (const h of a.holes ?? []) {
          const rail = walls(h, y, 1.1, new THREE.MeshLambertMaterial({ color: 0xb4501c, transparent: true, opacity: 0.6 }));
          scene.add(rail);
          partsOf(a.level).solid.push(rail);
        }
      }
      if (a.under || a.part) continue;
      // 東棟屋外臨時駐車場（一般参加者の待機列に使う広い所）は、ユーザーの確認でホールの名前と同じ札・同じ出方にする
      const big = a.name === "東棟屋外臨時駐車場";
      const label = big
        ? textSprite(a.name, { bg: "rgba(30,40,60,.82)", height: 7, px: 40 })
        : textSprite(a.name, { fg: "#55584f", height: 3.2, px: 32 });
      const [cx, cz] = insidePoint(a.poly, a.holes ?? []);
      label.position.set(cx, y + (big ? 14 : 3), cz);
      scene.add(label);
      partsOf(a.level).solid.push(label);
      addLabel(label, big ? "hall" : "area");
    }
    // 床のふち：どの床も、外まわりと穴のまわりを、その床の色を濃くした帯（幅 0.35m。寄ったとき太く見える）と線（1px。引いたときも消えない）で
    // なぞる。エスカレーター・階段がどの床のふちにつながっているか分かるように（ユーザーの確認）。ふちを 0.5m ごとに見て、すぐ外が同じ階の
    // ほかの床かホールなら、2 枚の床でひと続きになっている所なので描かない
    {
      const onFloor = (a: (typeof venue.areas)[number], q: XZ) => pointInPolygon(q, a.poly) && !(a.holes ?? []).some((h) => pointInPolygon(q, h));
      const bbox = (poly: XZ[]) => {
        const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
        return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
      };
      const boxes = new Map(venue.areas.map((a) => [a, bbox(a.poly)] as const));
      const inBox = (b: number[], q: XZ) => q[0] >= b[0] - 0.5 && q[0] <= b[2] + 0.5 && q[1] >= b[1] - 0.5 && q[1] <= b[3] + 0.5;
      const edgeGroups = new Map<string, { color: number; level: number; runs: { pts: XZ[]; y: number; w: number }[]; lines: number[] }>();
      for (const a of venue.areas) {
        const color = areaColor.get(a)!;
        const others = venue.areas.filter((o) => o !== a && o.level === a.level);
        const hallPolys = venue.halls.filter((h) => h.level === a.level).map((h) => h.poly);
        const ey = floorY(a.level) + (a.under ? 0.03 : 0.07);
        const key = `${a.level}-${color}`;
        const out = edgeGroups.get(key) ?? { color, level: a.level, runs: [], lines: [] };
        edgeGroups.set(key, out);
        for (const r of [a.poly, ...(a.holes ?? [])]) {
          r.forEach((p0, i) => {
            const p1 = r[(i + 1) % r.length];
            const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
            if (L < 0.05) return;
            const ux = (p1[0] - p0[0]) / L, uz = (p1[1] - p0[1]) / L;
            let nx = -uz, nz = ux;
            const mid: XZ = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
            if (onFloor(a, [mid[0] + nx * 0.05, mid[1] + nz * 0.05])) [nx, nz] = [-nx, -nz]; // 床でない側（外）へ
            const n = Math.max(1, Math.ceil(L / 0.5));
            let s0 = -1;
            const flush = (k: number) => {
              if (s0 < 0) return;
              const t0 = (s0 / n) * L, t1 = (k / n) * L;
              const a0: XZ = [p0[0] + ux * t0, p0[1] + uz * t0], a1: XZ = [p0[0] + ux * t1, p0[1] + uz * t1];
              out.runs.push({ pts: [a0, a1], y: ey, w: 0.35 });
              out.lines.push(a0[0], ey + 0.01, a0[1], a1[0], ey + 0.01, a1[1]);
              s0 = -1;
            };
            for (let k = 0; k < n; k++) {
              const t = ((k + 0.5) / n) * L;
              const q: XZ = [p0[0] + ux * t + nx * 0.4, p0[1] + uz * t + nz * 0.4];
              const joined = others.some((o) => inBox(boxes.get(o)!, q) && onFloor(o, q)) || hallPolys.some((h) => pointInPolygon(q, h));
              if (!joined && s0 < 0) s0 = k;
              if (joined) flush(k);
            }
            flush(n);
          });
        }
      }
      // 階ごと・色ごとに 1 つの形にまとめて描く
      for (const g of edgeGroups.values()) {
        const dark = new THREE.Color(g.color).multiplyScalar(0.5);
        const band = new THREE.Mesh(ribbons(g.runs), new THREE.MeshBasicMaterial({ color: dark, side: THREE.DoubleSide }));
        const lg = new THREE.BufferGeometry();
        lg.setAttribute("position", new THREE.Float32BufferAttribute(g.lines, 3));
        const line = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: dark }));
        scene.add(band, line);
        partsOf(g.level).solid.push(band, line);
      }
    }
    // 2F と 4F の、屋内と屋外の境目の仕切り。2F は高さ 3.6m の仕切り、4F は建物の外壁なのでホールの壁と同じ高さ。
    // 屋内の床のふちを 1m ごとに見て、すぐ外が屋外の床で、ほかの屋内の床でもホールでもない所に立てる。
    // ふちのすぐ内側がホールの中なら、そこはホールの壁（搬入口の穴もある）なので立てない
    {
      const partMat = new THREE.MeshLambertMaterial({ color: 0x7d8a92, transparent: true, opacity: 0.85 });
      for (const lv of [2, 4]) {
        const ph = lv === 4 ? WALL_H : 3.6; // 2F は高さ 3.6m（ユーザーの確認で 1.2m の 3 倍）
        const indoor = venue.areas.filter((a) => a.level === lv && !a.outdoor);
        const outdoor = venue.areas.filter((a) => a.level === lv && a.outdoor);
        const halls4 = venue.halls.filter((h) => h.level === lv).map((h) => h.poly);
        const inAny = (p: XZ, list: XZ[][]) => list.some((q) => pointInPolygon(p, q));
        const exits = (venue.exits ?? []).filter((e) => e.level === lv);
        const atExit = (p: XZ) => exits.some((e) => Math.hypot(p[0] - e.at[0], p[1] - e.at[1]) < e.width / 2 + 0.6);
        const g = new THREE.Group();
        for (const a of indoor) {
          a.poly.forEach((p0, i) => {
            const p1 = a.poly[(i + 1) % a.poly.length];
            const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
            if (L < 0.5) return;
            const ux = (p1[0] - p0[0]) / L, uz = (p1[1] - p0[1]) / L;
            let nx = -uz, nz = ux;
            const mid: XZ = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
            if (pointInPolygon([mid[0] + nx * 0.3, mid[1] + nz * 0.3], a.poly)) [nx, nz] = [-nx, -nz]; // 外向き
            const n = Math.max(1, Math.round(L));
            let start = -1;
            const flush = (k: number) => {
              if (start < 0) return;
              const t0 = (start / n) * L, t1 = (k / n) * L, len = t1 - t0;
              if (len > 0.4) {
                const m = new THREE.Mesh(new THREE.BoxGeometry(len, ph, 0.15), partMat);
                m.position.set(p0[0] + ux * (t0 + len / 2), floorY(lv) + ph / 2, p0[1] + uz * (t0 + len / 2));
                m.rotation.y = -Math.atan2(uz, ux);
                g.add(m);
              }
              start = -1;
            };
            for (let k = 0; k < n; k++) {
              const t = ((k + 0.5) / n) * L;
              const q: XZ = [p0[0] + ux * t + nx * 0.6, p0[1] + uz * t + nz * 0.6];
              const qIn: XZ = [p0[0] + ux * t - nx * 0.6, p0[1] + uz * t - nz * 0.6];
              const border = inAny(q, outdoor.map((o) => o.poly)) && !inAny(q, indoor.filter((o) => o !== a).map((o) => o.poly)) && !inAny(q, halls4) && !inAny(qIn, halls4) && !atExit(q);
              if (border && start < 0) start = k;
              if (!border) flush(k);
            }
            flush(n);
          });
        }
        scene.add(g);
        partsOf(lv).solid.push(g);
        // 出口の札（開口の上）
        for (const e of exits) {
          const m = textSprite(e.name, { bg: "rgba(20,120,60,.92)", height: 2.6, px: 32 });
          m.position.set(e.at[0], floorY(lv) + ph + 1.6, e.at[1]);
          scene.add(m);
          partsOf(lv).solid.push(m);
          addLabel(m, "door");
        }
      }
    }
    // 壁サークルが目の前に並んでいる出入口は、そのサークルが使っているので通れない（穴は開けるが、出入口の看板・札は出さない）。
    // 出入口の区間（a〜b）の前 3m 以内に、壁ぞいの列の机が区間にかかって並んでいれば「ふさがっている」
    const wallBooths = booths.filter((b) => lines[b.line].wall);
    // 出入口の区間 a〜b のうち、通れる所（壁サークルの机の前でも、建物の固い部分の前でもない所）のいちばん長い区間。2m より短ければ null
    const freePart = (hall: string, a: XZ, b: XZ): [XZ, XZ] | null => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
      const near = wallBooths.filter((bt) => bt.hall === hall).map((bt) => ({
        u: (bt.at[0] - a[0]) * ux + (bt.at[1] - a[1]) * uz, v: -(bt.at[0] - a[0]) * uz + (bt.at[1] - a[1]) * ux,
      })).filter((q) => Math.abs(q.v) < 3);
      const structs = (features?.structures ?? []).filter((st) => st.hall === hall).map((st) => st.poly);
      const step = 0.25, n = Math.ceil(L / step);
      let best: [number, number] = [0, 0], start = -1;
      for (let i = 0; i <= n; i++) {
        const u = Math.min(L, i * step);
        const p: XZ = [a[0] + ux * u, a[1] + uz * u];
        const byDesk = near.some((q) => Math.abs(q.u - u) < DESK_L / 4 + 0.4);
        const byStruct = structs.some((sp) => [-1.5, 1.5].some((v) => pointInPolygon([p[0] - uz * v, p[1] + ux * v], sp)));
        const free = !byDesk && !byStruct && i < n;
        if (free && start < 0) start = u;
        if (!free && start >= 0) {
          if (u - start > best[1] - best[0]) best = [start, u];
          start = -1;
        }
      }
      if (best[1] - best[0] < 2) return null;
      return [[a[0] + ux * best[0], a[1] + uz * best[0]], [a[0] + ux * best[1], a[1] + uz * best[1]]];
    };
    const doorSpan = (hall: string, at: XZ, w: number): [XZ, XZ] => {
      // 出入口の点に、いちばん近い壁の向きで幅 w の区間
      const h = hallById.get(hall)!;
      let best = { d: Infinity, ux: 1, uz: 0 };
      h.poly.forEach((p, i) => {
        const q = h.poly[(i + 1) % h.poly.length];
        const dx = q[0] - p[0], dz = q[1] - p[1], L2 = dx * dx + dz * dz || 1, L = Math.sqrt(L2);
        const t = Math.max(0, Math.min(1, ((at[0] - p[0]) * dx + (at[1] - p[1]) * dz) / L2));
        const d = Math.hypot(at[0] - p[0] - t * dx, at[1] - p[1] - t * dz);
        if (d < best.d) best = { d, ux: dx / L, uz: dz / L };
      });
      return [[at[0] - best.ux * w / 2, at[1] - best.uz * w / 2], [at[0] + best.ux * w / 2, at[1] + best.uz * w / 2]];
    };
    const openDoors = venue.doors.filter((d) => d.kind === "出入口" && freePart(d.hall, ...doorSpan(d.hall, d.at, DOOR_W)));
    // 配置図の切れ目は、通れる所だけに縮める（看板はその真ん中に）
    const openGaps = (features?.openings ?? []).flatMap((o) => {
      const f = freePart(o.hall, o.a, o.b);
      return f ? [{ ...o, a: f[0], b: f[1] }] : [];
    });
    // 形のふちの上で、点 p にいちばん近い点と、その距離
    const nearestOnRing = (p: XZ, r: XZ[]): [XZ, number] => {
      let best: [XZ, number] = [r[0], Infinity];
      r.forEach((a, i) => {
        const b = r[(i + 1) % r.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
        const q: XZ = [a[0] + t * dx, a[1] + t * dz], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < best[1]) best = [q, d];
      });
      return best;
    };
    // 辺 a〜b（one の形の辺）が、もう一方の形（other）のふちから離れていて（＝外へずらした所）、
    // そのあいだの帯の上に 2F の床がかかっているか
    const overBand = (a: XZ, b: XZ, other: XZ[]) => {
      const mid: XZ = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [q, d] = nearestOnRing(mid, other);
      if (d < 0.5) return false;
      const m: XZ = [(mid[0] + q[0]) / 2, (mid[1] + q[1]) / 2];
      return venue.areas.some((ar) => ar.level === 2 && pointInPolygon(m, ar.poly));
    };
    // ホールの外壁の辺 i が「外へずらした辺で、その上に 2F の床がかかっている」か
    const lowEdge = (h: Hall, i: number) => !!h.inner && h.level === 1 && overBand(h.poly[i], h.poly[(i + 1) % h.poly.length], h.inner);
    for (const h of venue.halls) {
      const y = floorY(h.level);
      const f = flatPoly(h.poly, h.closed ? 0xc4c4bf : BUILDING_COLOR[h.building], y + 0.05);
      scene.add(f);
      partsOf(h.level).floors.push(f);
      const w = walls(
        h.poly,
        y,
        WALL_H,
        wallMat,
        // 図面の出入口（建物の扉）と、配置図から写した壁の切れ目（当日開いている所）の両方を開ける
        // 穴は、壁サークルがふさいでいる出入口も開ける（看板だけ出さない）
        venue.doors.filter((d) => d.hall === h.id && d.kind === "出入口").map((d) => d.at),
        (features?.openings ?? []).filter((o) => o.hall === h.id).map((o) => [o.a, o.b] as [XZ, XZ]),
        venue.halls.filter((o) => o.id !== h.id && o.level === h.level).map((o) => o.poly),
        (i) => (lowEdge(h, i) ? floorY(2) - floorY(1) : WALL_H),
        // 西・南のホールは、搬入口（大きなシャッター）も穴にする（ユーザーの確認）
        h.building === "南" || h.building === "西" ? venue.doors.filter((d) => d.hall === h.id && d.kind === "搬入口").map((d) => d.at) : [],
      );
      scene.add(w);
      occluders.push(w);
      // 外へずらした辺の上に 2F の床がかかっている所（東1〜3 のガレリア側）は、部屋の帯の上が 2F の通路になっている。
      // 外の壁は 2F の床の高さまで、そこから上の高い壁は展示場の床のふち（元の辺）に立てる
      if (h.inner) {
        const upper = new THREE.Group();
        h.inner.forEach((a, i) => {
          const b = h.inner![(i + 1) % h.inner!.length];
          if (h.level !== 1 || !overBand(a, b, h.poly)) return;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]), hgt = WALL_H - (floorY(2) - floorY(1));
          const m = new THREE.Mesh(new THREE.BoxGeometry(len, hgt, 0.4), wallMat);
          m.position.set((a[0] + b[0]) / 2, y + floorY(2) - floorY(1) + hgt / 2, (a[1] + b[1]) / 2);
          m.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
          upper.add(m);
        });
        scene.add(upper);
        occluders.push(upper);
        partsOf(h.level).solid.push(upper);
      }
      partsOf(h.level).solid.push(w);
      const [cx, cz] = centroid(h.poly);
      const name = h.name + (h.level >= 4 ? "（4F）" : "") + (h.closed ? "：工事中" : "") + (h.rough ? "（形は概略）" : "");
      const label = textSprite(name, { bg: h.closed ? "rgba(90,90,86,.85)" : "rgba(30,40,60,.82)", height: 7, px: 40 });
      label.position.set(cx, y + 14, cz);
      scene.add(label);
      partsOf(h.level).solid.push(label);
      addLabel(label, "hall");
    }
    // 階段（屋上展示場からエントランスプラザへ）。段は 0.2m ほどの高さで、どの階を見ていても出す
    for (const st of venue.stairs ?? []) {
      const y0 = floorY(st.toLevel), y1 = floorY(st.fromLevel);
      const dx = st.from[0] - st.to[0], dz = st.from[1] - st.to[1], run = Math.hypot(dx, dz);
      if (st.kind === "ramp") {
        // 車のスロープ：段のない 1 枚の傾いた板（厚さ 0.6m）
        const geo = new THREE.BoxGeometry(st.width, 0.6, Math.hypot(run, y1 - y0));
        const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: RAMP_COLOR }));
        m.rotation.order = "YXZ";
        m.rotation.set(-Math.atan2(y1 - y0, run), Math.atan2(dx, dz), 0);
        m.position.set((st.from[0] + st.to[0]) / 2, (y0 + y1) / 2 - 0.3, (st.from[1] + st.to[1]) / 2);
        scene.add(m);
        const label = textSprite(`⇅ ${st.name}`, { bg: "rgba(190,120,20,.95)", height: 2.6, px: 30 });
        label.position.set((st.from[0] + st.to[0]) / 2, (y0 + y1) / 2 + 3, (st.from[1] + st.to[1]) / 2);
        scene.add(label);
        addLabel(label, "door");
        continue;
      }
      const n = Math.max(3, Math.round((y1 - y0) / 0.2));
      const geo = new THREE.BoxGeometry(st.width, 1, run / n + 0.02);
      const esc = st.kind === "escalator";
      // 屋外の階段（屋上展示場からエントランスプラザへ）は、目立つマゼンタ
      const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: esc ? 0x6f8fb3 : st.outdoor ? OUTDOOR_STAIR_COLOR : LINK_COLOR }), n);
      const t = new THREE.Object3D();
      for (let i = 0; i < n; i++) {
        // 段は 1 段ずつ、厚さ 0.6m の板（下まで埋めた塊にすると、下の階から壁のように見える）
        const f = (i + 0.5) / n, top = y0 + ((y1 - y0) * (i + 1)) / n, th = Math.min(0.6, top - y0);
        t.position.set(st.to[0] + dx * f, top - th / 2, st.to[1] + dz * f);
        t.rotation.set(0, Math.atan2(dx, dz), 0);
        t.scale.set(1, th, 1);
        t.updateMatrix();
        m.setMatrixAt(i, t.matrix);
      }
      m.computeBoundingSphere();
      scene.add(m);
      const label = textSprite(`⇅ ${st.name}`, { bg: esc ? "rgba(60,95,140,.92)" : st.outdoor ? "rgba(200,30,120,.95)" : "rgba(205,110,50,.92)", height: 2.6, px: 30 });
      label.position.set((st.from[0] + st.to[0]) / 2, (y0 + y1) / 2 + 3, (st.from[1] + st.to[1]) / 2);
      scene.add(label);
      addLabel(label, st.fromLevel === 2 && st.toLevel === 1 ? "block" : "door"); // ガレリアの階段・エスカレーターの札は、寄ったときだけ
    }
    // 人の入れない建物（西と南のつなぎ目の角の 45° の建物など）。その階の床の高さに立つ灰色の箱
    {
      const mat = new THREE.MeshLambertMaterial({ color: 0x8a908c });
      for (const b of venue.blocks ?? []) {
        const geo = new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: b.height, bevelEnabled: false });
        const m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.y = floorY(b.level);
        // 地面から 4F の上まで続く建物なので、どの階を見ているときも出す（階ごとの出し分けに入れない）
        scene.add(m);
        occluders.push(m);
      }
    }
    // 建物の固い部分と部屋の囲み（配置図から写したとき）。高さ 3m の低い箱
    if (features?.structures?.length) {
      const mat = new THREE.MeshLambertMaterial({ color: 0x7c827e });
      for (const st of features.structures) {
        const lv = hallById.get(st.hall)?.level ?? 1;
        const geo = new THREE.ExtrudeGeometry(shapeOf(st.poly), { depth: 3, bevelEnabled: false });
        const m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.y = floorY(lv);
        scene.add(m);
        partsOf(lv).solid.push(m);
      }
    }
    // 柱（配置図から写したとき）。壁ぎわの柱は 0.8m 角で壁の高さまで。
    // 島の中の柱は、机を見やすく太く描いているので、本当の大きさだと机を突き抜けて見える。細く低い印（0.3m 角・高さ 1.6m、机は 0.7m）にする
    if (features?.pillars.length) {
      const pillarMat = new THREE.MeshLambertMaterial({ color: 0x6f7773 });
      const markMat = new THREE.MeshLambertMaterial({ color: 0x4a4f4c });
      const groups = new Map<string, { lv: number; wall: boolean; list: XZ[] }>();
      for (const p of features.pillars) {
        const lv = venue.halls.find((x) => x.id === p.hall)?.level ?? 1;
        const key = `${lv}:${p.wall ? 1 : 0}`;
        if (!groups.has(key)) groups.set(key, { lv, wall: !!p.wall, list: [] });
        groups.get(key)!.list.push(p.at);
      }
      const t = new THREE.Object3D();
      for (const { lv, wall, list } of groups.values()) {
        const size = wall ? 0.8 : 0.3, h = wall ? WALL_H : 1.6;
        const m = new THREE.InstancedMesh(new THREE.BoxGeometry(size, h, size), wall ? pillarMat : markMat, list.length);
        list.forEach(([x, z], i) => {
          t.position.set(x, floorY(lv) + h / 2, z);
          t.updateMatrix();
          m.setMatrixAt(i, t.matrix);
        });
        m.computeBoundingSphere();
        scene.add(m);
        partsOf(lv).solid.push(m);
      }
    }
    // となり合うホール（東1〜3・南1/2 など）の床のあいだのすき間を、同じ床の色でうめる
    venue.halls.forEach((h, i) => {
      for (const o of venue.halls.slice(i + 1)) {
        if (o.level !== h.level) continue;
        h.poly.forEach((a, k) => {
          const b = h.poly[(k + 1) % h.poly.length];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 1) return;
          const c = (b[0] - a[0]) / len, sn = (b[1] - a[1]) / len;
          o.poly.forEach((p, j) => {
            const q = o.poly[(j + 1) % o.poly.length];
            const up = (p[0] - a[0]) * c + (p[1] - a[1]) * sn, vp = -(p[0] - a[0]) * sn + (p[1] - a[1]) * c;
            const uq = (q[0] - a[0]) * c + (q[1] - a[1]) * sn, vq = -(q[0] - a[0]) * sn + (q[1] - a[1]) * c;
            if (Math.abs(vp) > 3 || Math.abs(vq) > 3 || Math.abs(uq - up) < 1) return;
            const o0 = Math.max(0, Math.min(up, uq)), o1 = Math.min(len, Math.max(up, uq));
            if (o1 - o0 < 1) return;
            const vAt = (u: number) => vp + ((vq - vp) * (u - up)) / (uq - up);
            const at = (u: number, v: number): XZ => [a[0] + c * u - sn * v, a[1] + sn * u + c * v];
            const f = flatPoly([at(o0, 0), at(o1, 0), at(o1, vAt(o1)), at(o0, vAt(o0))], h.closed ? 0xc4c4bf : BUILDING_COLOR[h.building], floorY(h.level) + 0.05);
            scene.add(f);
            partsOf(h.level).floors.push(f);
          });
        });
      }
    });
    // トイレの部屋の囲み：床を薄い青にして、まわりに高さ 3m の壁
    {
      const roomWall = new THREE.MeshLambertMaterial({ color: 0x5f7fae, transparent: true, opacity: 0.75 });
      for (const r of venue.toiletRooms ?? []) {
        const f = flatPoly(r.poly, 0xc9d9f2, floorY(r.level) + 0.07);
        scene.add(f);
        partsOf(r.level).floors.push(f);
        const w = walls(r.poly, floorY(r.level), 3, roomWall);
        scene.add(w);
        partsOf(r.level).solid.push(w);
      }
    }
    for (const t of venue.toilets) {
      const lv = t.level ?? 1;
      // 多機能トイレがあるときは「WC♿」
      const m = textSprite(t.kinds?.includes("多機能") ? "WC ♿" : "WC", { bg: "rgba(31,95,191,.9)", height: 3, px: 34 });
      m.position.set(t.at[0], floorY(lv) + 3, t.at[1]);
      if (t.outside) {
        // 会場の外の OpenStreetMap のトイレは「周辺も表示」のときだけ
        surroundings.add(m);
        stationLabels.push({ s: m, base: m.scale.clone() });
        continue;
      }
      scene.add(m);
      partsOf(lv).solid.push(m);
      addLabel(m, "wc");
    }
    // 出入口（緑）・搬入口（シャッター、灰）。図面から読んだもの
    for (const d of venue.doors) {
      if (d.kind === "出入口" && !openDoors.includes(d)) continue; // 壁サークルがふさいでいる出入口は出さない
      const m = textSprite(d.kind === "出入口" ? "⇄ 出入口" : "搬入口", { bg: d.kind === "出入口" ? "rgba(20,120,60,.92)" : "rgba(95,100,95,.85)", height: 2.6, px: 32 });
      m.position.set(d.at[0], floorY(d.level) + 2.6, d.at[1]);
      scene.add(m);
      partsOf(d.level).solid.push(m);
      addLabel(m, d.kind === "出入口" ? "door" : "shutter");
      // 出入口の浮いた札は上から見るときだけ（3D・歩くでは、戸口の上の看板）
      if (d.kind === "出入口") m.userData.topOnly = true;
    }
    // 出入口の看板：戸口の真上、壁の高い所の両側（ホールの内と外）に、戸口の幅くらいの大きさで
    type Entrance = { hall: string; level: number; at: XZ; width: number };
    const fromPlan: Entrance[] = openDoors.map((d) => ({ hall: d.hall, level: d.level, at: d.at, width: DOOR_W }));
    // 配置図の切れ目のうち、図面の出入口と重ならないもの（8m より離れている）を足す
    const fromLayout: Entrance[] = openGaps
      .map((o) => ({ hall: o.hall, level: hallById.get(o.hall)?.level ?? 1, at: [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2] as XZ, width: Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) }))
      .filter((e) => !fromPlan.some((d) => Math.hypot(d.at[0] - e.at[0], d.at[1] - e.at[1]) < 8));
    const entrances: Entrance[] = [...fromPlan, ...fromLayout];
    const signPx = textSprite("⇄ 出入口", { bg: "rgba(20,120,60,.95)", height: 1, px: 128 });
    const signAspect = signPx.scale.x / signPx.scale.y;
    const signMat = new THREE.MeshBasicMaterial({ map: (signPx.material as THREE.SpriteMaterial).map, transparent: true });
    for (const e of entrances) {
      const h = hallById.get(e.hall);
      if (!h) continue;
      // いちばん近い、となりのホールと分け合っていない辺に貼る
      let best = { d: Infinity, q: e.at as XZ, ux: 1, uz: 0 };
      h.poly.forEach((a, i) => {
        const b = h.poly[(i + 1) % h.poly.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1, L = Math.sqrt(L2);
        const ux = dx / L, uz = dz / L;
        const mid: XZ = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const shared = venue.halls.some((o) => o.id !== h.id && o.level === h.level && o.poly.some((p, j) => {
          const q = o.poly[(j + 1) % o.poly.length];
          const ox = q[0] - p[0], oz = q[1] - p[1], OL = Math.hypot(ox, oz) || 1;
          if (Math.abs(ux * oz / OL - uz * ox / OL) > 0.1) return false; // 平行でない
          const v = Math.abs(-(mid[0] - p[0]) * oz / OL + (mid[1] - p[1]) * ox / OL);
          const t = ((mid[0] - p[0]) * ox + (mid[1] - p[1]) * oz) / (OL * OL);
          return v < 3 && t > 0 && t < 1;
        }));
        if (shared) return;
        const t = Math.max(0, Math.min(1, ((e.at[0] - a[0]) * dx + (e.at[1] - a[1]) * dz) / L2));
        const q: XZ = [a[0] + t * dx, a[1] + t * dz];
        const dist = Math.hypot(e.at[0] - q[0], e.at[1] - q[1]);
        if (dist < best.d) best = { d: dist, q, ux, uz };
      });
      if (best.d > 6) continue; // 壁から離れた出入口（ホールの外の建物など）は看板を貼らない
      const nx = -best.uz, nz = best.ux;
      const sw = Math.min(8, Math.max(DOOR_W, e.width) * 0.95), sh = Math.min(2.6, sw / signAspect);
      const y = floorY(e.level) + Math.min(WALL_H - 0.3 - sh / 2, (DOOR_H + WALL_H) / 2 + 0.3);
      for (const k of [1, -1]) {
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(sh * signAspect, sh), signMat);
        sign.position.set(best.q[0] + nx * k * 0.22, y, best.q[1] + nz * k * 0.22);
        sign.rotation.y = Math.atan2(nx * k, nz * k);
        scene.add(sign);
        partsOf(e.level).solid.push(sign);
      }
      // 上から見るときの札（配置図の切れ目のとき。図面の出入口には、上で作った札がある）
      if (fromLayout.includes(e)) {
        const m = textSprite("⇄ 出入口", { bg: "rgba(20,120,60,.92)", height: 2.6, px: 32 });
        m.position.set(best.q[0], floorY(e.level) + 2.6, best.q[1]);
        m.userData.topOnly = true;
        scene.add(m);
        partsOf(e.level).solid.push(m);
        addLabel(m, "door");
      }
    }
    for (const a of venue.firstAid) {
      const m = textSprite("＋ 救護室", { bg: "rgba(200,30,30,.92)", height: 3, px: 34 });
      m.position.set(a.at[0], floorY(a.level) + 3, a.at[1]);
      scene.add(m);
      partsOf(a.level).solid.push(m);
      addLabel(m, "aid");
    }

    // 机（スペース＝机半分）。階ごとに InstancedMesh
    const deskGeo = new THREE.BoxGeometry(DESK_L / 2 - 0.04, 0.7, DESK_D);
    const deskMeshes = new Map<number, { mesh: THREE.InstancedMesh; index: number[] }>();
    const byLevel = new Map<number, number[]>();
    booths.forEach((b, i) => {
      const lv = hallById.get(b.hall)!.level;
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv)!.push(i);
    });
    const tmp = new THREE.Object3D();
    // 机の置き方。見やすく押しやすいよう、机をサークルの座る側（いすの所）までのばして描く（奥行き 0.45m → TOP_DESK_D・VIEW_DESK_D）。
    // 並びの向きにのばすと隣の机と重なるので、のばすのは奥行きだけ
    const TOP_DESK_D = 1.4;
    const VIEW_DESK_D = 1.4; // 3D・歩く
    const placeDesks = (top: boolean) => {
      const d = top ? TOP_DESK_D : VIEW_DESK_D;
      for (const [lv, { mesh, index }] of deskMeshes) {
        index.forEach((bi, k) => {
          const b = booths[bi];
          // 島の中心線から外へ（サークルの座る側へ）ずらす
          const out = (b.side * (d - DESK_D)) / 2;
          tmp.position.set(b.at[0] - Math.sin(b.angle) * out, floorY(lv) + 0.35, b.at[1] + Math.cos(b.angle) * out);
          tmp.rotation.set(0, -b.angle, 0);
          tmp.scale.set(1, 1, d / DESK_D);
          tmp.updateMatrix();
          mesh.setMatrixAt(k, tmp.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    };
    for (const [lv, index] of byLevel) {
      const mesh = new THREE.InstancedMesh(deskGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), index.length);
      index.forEach((_, k) => mesh.setColorAt(k, new THREE.Color(DESK_COLOR)));
      scene.add(mesh);
      partsOf(lv).solid.push(mesh);
      deskMeshes.set(lv, { mesh, index });
    }
    placeDesks(true);
    // 机の側面の番号（3D・歩く）。「05a」のような文字を1枚の絵にならべ、スペースごとに机の長い面の両側へ貼る
    const numTexts = [...new Set(booths.map((b) => `${String(b.num).padStart(2, "0")}${b.half}`))];
    const N_COLS = 16, CW = 128, CH = 96;
    const nRows = Math.ceil(numTexts.length / N_COLS);
    const atlas = document.createElement("canvas");
    atlas.width = N_COLS * CW;
    atlas.height = nRows * CH;
    const actx = atlas.getContext("2d")!;
    actx.font = `800 ${Math.round(CH * 0.7)}px system-ui, sans-serif`;
    actx.textAlign = "center";
    actx.textBaseline = "middle";
    actx.lineJoin = "round";
    actx.lineWidth = 12;
    actx.strokeStyle = "rgba(255,255,255,.95)";
    actx.fillStyle = "#1d1d1b";
    const numCell = new Map<string, number>();
    numTexts.forEach((t, i) => {
      numCell.set(t, i);
      const x = ((i % N_COLS) + 0.5) * CW, y = (Math.floor(i / N_COLS) + 0.5) * CH;
      actx.strokeText(t, x, y);
      actx.fillText(t, x, y);
    });
    const atlasTex = new THREE.CanvasTexture(atlas);
    atlasTex.colorSpace = THREE.SRGBColorSpace;
    atlasTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const numMat = new THREE.MeshBasicMaterial({ map: atlasTex, alphaTest: 0.35 });
    // スペースごとに、絵のどこを使うか（uvRect）を渡す
    numMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec4 uvRect;")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\nvMapUv = uvRect.xy + uv * uvRect.zw;");
    };
    const numMeshes: { mesh: THREE.InstancedMesh; level: number }[] = [];
    for (const [lv, { index }] of deskMeshes) {
      const geo = new THREE.PlaneGeometry(DESK_L / 2 - 0.12, 0.5);
      const rects = new Float32Array(index.length * 2 * 4);
      const mesh = new THREE.InstancedMesh(geo, numMat, index.length * 2);
      index.forEach((bi, k) => {
        const b = booths[bi];
        const cell = numCell.get(`${String(b.num).padStart(2, "0")}${b.half}`)!;
        const out = (b.side * (VIEW_DESK_D - DESK_D)) / 2;
        const nx = -Math.sin(b.angle), nz = Math.cos(b.angle);
        const cx = b.at[0] + nx * out, cz = b.at[1] + nz * out;
        for (const [j, sgn] of [[0, 1], [1, -1]] as const) {
          const off = VIEW_DESK_D / 2 + 0.02;
          tmp.position.set(cx + nx * sgn * off, floorY(lv) + 0.37, cz + nz * sgn * off);
          tmp.rotation.set(0, sgn > 0 ? -b.angle : Math.PI - b.angle, 0);
          tmp.scale.set(1, 1, 1);
          tmp.updateMatrix();
          mesh.setMatrixAt(k * 2 + j, tmp.matrix);
          rects.set([(cell % N_COLS) / N_COLS, 1 - (Math.floor(cell / N_COLS) + 1) / nRows, 1 / N_COLS, 1 / nRows], (k * 2 + j) * 4);
        }
      });
      geo.setAttribute("uvRect", new THREE.InstancedBufferAttribute(rects, 4));
      mesh.computeBoundingSphere();
      scene.add(mesh);
      numMeshes.push({ mesh, level: lv });
      // 机の上の面にも、平らに。字の頭は島の内側へ向け、通路（サークルの座る側）から読める向きにする
      const topGeo = new THREE.PlaneGeometry(DESK_L / 2 - 0.12, 0.62);
      const topRects = new Float32Array(index.length * 4);
      const top = new THREE.InstancedMesh(topGeo, numMat, index.length);
      const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
      const yawQ = new THREE.Quaternion();
      index.forEach((bi, k) => {
        const b = booths[bi];
        const cell = numCell.get(`${String(b.num).padStart(2, "0")}${b.half}`)!;
        const out = (b.side * (VIEW_DESK_D - DESK_D)) / 2;
        tmp.position.set(b.at[0] - Math.sin(b.angle) * out, floorY(lv) + 0.71, b.at[1] + Math.cos(b.angle) * out);
        yawQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.side > 0 ? -b.angle : Math.PI - b.angle);
        tmp.quaternion.copy(yawQ).multiply(flat);
        tmp.scale.set(1, 1, 1);
        tmp.updateMatrix();
        top.setMatrixAt(k, tmp.matrix);
        topRects.set([(cell % N_COLS) / N_COLS, 1 - (Math.floor(cell / N_COLS) + 1) / nRows, 1 / N_COLS, 1 / nRows], k * 4);
      });
      topGeo.setAttribute("uvRect", new THREE.InstancedBufferAttribute(topRects, 4));
      top.computeBoundingSphere();
      scene.add(top);
      numMeshes.push({ mesh: top, level: lv });
    }
    // 列の名前（ブロック）。会場の札のように、列の両端の頭の上に
    for (const l of lines) {
      const h = hallById.get(l.hall)!;
      // 島の列は両端の外に。壁ぞいの列は、まとまった机ごとにホールの内側へ
      const spots: XZ[] = l.wall ? wallLabelSpots(l, 3) : [-3, lineLength(l) + 3].map((u) => [l.start[0] + Math.cos(l.angle) * u, l.start[1] + Math.sin(l.angle) * u] as XZ);
      for (const [x, z] of spots) {
        const s = textSprite(l.block, { bg: "rgba(255,255,255,.9)", fg: "#1d1d1b", height: 1.8, px: 36 });
        s.position.set(x, floorY(h.level) + 3.2, z);
        scene.add(s);
        partsOf(h.level).solid.push(s);
        addLabel(s, "block");
      }
    }
    // 選んだ机の印
    const pin = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.2, 3, 16), new THREE.MeshLambertMaterial({ color: SELECT_COLOR }));
    cone.rotation.x = Math.PI;
    cone.position.y = 3.5;
    pin.add(cone);
    pin.visible = false;
    scene.add(pin);

    // ---- カメラと操作 ----
    // 最初は会場全体（ホールの外側の枠）が入るように
    const all = venue.halls.flatMap((h) => h.poly);
    const bounds = {
      minX: Math.min(...all.map((p) => p[0])), maxX: Math.max(...all.map((p) => p[0])),
      minZ: Math.min(...all.map((p) => p[1])), maxZ: Math.max(...all.map((p) => p[1])),
    };
    const focus = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
    // 上からの見方では、文字は壁や床に隠れない方が読みやすい。3D・歩くでは、壁の向こうの文字は隠す
    const sprites: THREE.Sprite[] = [];
    scene.traverse((o) => {
      if (o instanceof THREE.Sprite) sprites.push(o);
    });
    const persp = new THREE.PerspectiveCamera(50, 1, 0.1, 9000);
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    let camera: THREE.Camera = ortho;
    let controls: OrbitControls | MapControls | null = null;
    let current: View = "top";
    let currentFloor: Floor = 1;
    let bothFloors = false; // 1F と 4F の両方を見る（どちらも薄くしない）
    const shown = (f: Floor) => bothFloors || f === currentFloor;
    let yaw = 0, pitch = 0;
    let hold: -1 | 0 | 1 = 0;
    const keys = new Set<string>();
    let fly: { t: number; from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3 } | null = null;
    let walkAnim: { t: number; from: THREE.Vector3; to: THREE.Vector3; secs: number } | null = null;

    const size = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
      const half = 160;
      ortho.left = (-half * w) / h;
      ortho.right = (half * w) / h;
      ortho.top = half;
      ortho.bottom = -half;
      ortho.updateProjectionMatrix();
      const dpr = Math.min(devicePixelRatio, 2);
      codeLayer.width = w * dpr;
      codeLayer.height = h * dpr;
      codeLayer.style.width = `${w}px`;
      codeLayer.style.height = `${h}px`;
      codeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    const eyeY = () => floorY(currentFloor) + EYE;
    const setView = (v: View) => {
      controls?.dispose();
      controls = null;
      current = v;
      // 2D（真上から）では、会議棟は下の 2F のプラザを隠すので出さない
      for (const m of towerMeshes) m.visible = v !== "top";
      fly = null;
      const labelSprites = new Set(labels.map((l) => l.s));
      for (const s of sprites) s.material.depthTest = v !== "top" && !labelSprites.has(s);
      persp.fov = v === "walk" ? 70 : 50;
      persp.updateProjectionMatrix();
      if (v === "top") {
        camera = ortho;
        ortho.position.set(focus.x, 600, focus.z + 0.01);
        ortho.updateProjectionMatrix();
        const c = new MapControls(ortho, renderer.domElement);
        c.enableRotate = false;
        c.screenSpacePanning = false;
        c.zoomToCursor = true;
        c.minZoom = 0.2;
        c.maxZoom = 40;
        c.target.copy(focus);
        c.update();
        controls = c;
      } else if (v === "orbit") {
        camera = persp;
        // 上からの見方で見ていた広さ（縦の半分 160m ÷ 倍率）が、だいたい同じに入る距離から斜めに見下ろす
        const d = Math.min(900, Math.max(40, (160 / ortho.zoom) * 1.8));
        persp.position.copy(focus).add(new THREE.Vector3(-0.35, 0.7, 0.62).normalize().multiplyScalar(d));
        const c = new OrbitControls(persp, renderer.domElement);
        c.maxPolarAngle = Math.PI * 0.47;
        // 動かすときは床に沿って（画面に沿って動かすと、回転の中心が空中や床下へ行き、そこへ向かって拡大してしまう）。
        // 拡大は指・カーソルの場所へ向かって
        c.screenSpacePanning = false;
        c.zoomToCursor = true;
        c.minDistance = 5;
        c.maxDistance = 1200;
        c.target.copy(focus);
        c.update();
        controls = c;
        // 開発中だけ：見た目の確認（スクショ）用に、カメラを座標で動かせるようにする
        if (process.env.NODE_ENV !== "production")
          (window as unknown as { __look?: (tx: number, ty: number, tz: number, px: number, py: number, pz: number) => void }).__look = (tx, ty, tz, px, py, pz) => {
            c.target.set(tx, ty, tz);
            persp.position.set(px, py, pz);
            c.update();
          };
      } else {
        camera = persp;
        persp.position.set(focus.x, eyeY(), focus.z);
        pitch = 0;
      }
      placeDesks(v === "top");
      applyVisibility();
    };

    // 階と見方に合わせて、何を見せるか決める。
    // 上から・3D：選んでいない階は床を薄く残す（位置関係が分かるように）。
    // 歩く：頭の上にくる床（2F の通路・4F のホール）は天井のようにふさぐので出さない。ホールの名前と選んだ机の印も、目の前で大きすぎるので出さない
    let pinOn = false;
    const applyVisibility = () => {
      const walk = current === "walk";
      for (const [lv, p] of levels) {
        const on = shown(floorOf(lv)) || ((currentFloor === 1 || bothFloors) && lv === 2 && !walk);
        for (const m of p.floors) {
          const mat = m.material as THREE.MeshLambertMaterial;
          const see = m.userData.see as number | undefined;
          mat.transparent = !on || see !== undefined;
          mat.opacity = on ? (see ?? 1) : 0.3;
          mat.depthWrite = on && see === undefined;
          // 1F を見ているときは、4F（屋上展示場も）は薄くもせず出さない
          m.visible = (on || !walk) && !(currentFloor === 1 && !bothFloors && lv === 4);
        }
        // 札は、階で出すかどうかを覚えておき、毎フレームの大きさの計算と合わせて決める
        for (const o of p.solid) {
          if (o instanceof THREE.Sprite) o.userData.levelOn = on && !o.userData.hidden;
          else o.visible = on;
        }
      }
      for (const { mesh, level } of numMeshes) mesh.visible = current === "walk" && shown(floorOf(level));
      pin.visible = pinOn && current === "orbit"; // 上からは真上から見た丸がとなりの机を隠すので出さない（選んだ机はオレンジになる）
    };
    const setFloor = (f: Floor) => {
      currentFloor = f;
      applyVisibility();
      focus.y = floorY(f);
      if (current === "walk") persp.position.y = eyeY();
      if (current === "orbit" && controls) {
        controls.target.y = focus.y;
        controls.update();
      }
    };

    const startFly = (to: THREE.Vector3, camTo: THREE.Vector3) => {
      fly = { t: 0, from: (controls?.target ?? focus).clone(), to, camFrom: camera.position.clone(), camTo };
    };
    const focusPoint = (p: THREE.Vector3, close: boolean) => {
      focus.copy(p);
      if (current === "top") {
        startFly(p.clone(), new THREE.Vector3(p.x, 600, p.z + 0.01));
        if (close) {
          // 机を探したときは、1スペース（0.9m）が指で押せる 20px ほどになるまで寄る
          ortho.zoom = Math.max(ortho.zoom, (20 / 0.9) * (2 * 160) / el.clientHeight);
          ortho.updateProjectionMatrix();
        }
      } else if (current === "orbit") {
        startFly(p.clone(), p.clone().add(close ? new THREE.Vector3(-12, 22, 28) : new THREE.Vector3(-50, 80, 100)));
      }
    };
    const focusBooth = (i: number) => {
      const b = booths[i];
      const lv = hallById.get(b.hall)!.level;
      if (!shown(floorOf(lv))) setFloor(floorOf(lv));
      const p = new THREE.Vector3(b.at[0], floorY(lv), b.at[1]);
      pin.position.copy(p);
      pinOn = true;
      applyVisibility();
      if (current === "walk") {
        // 机の前の通路（サークルの反対側）に立って、机を向く
        const nx = -Math.sin(b.angle) * -b.side, nz = Math.cos(b.angle) * -b.side;
        persp.position.set(b.at[0] + nx * 3, floorY(lv) + EYE, b.at[1] + nz * 3);
        yaw = Math.atan2(nx, nz);
        pitch = -0.25;
        focus.copy(p);
      } else focusPoint(p, true);
    };
    // 歩く：(x, z) に立つ。向きは、それまで見ていた向き（真上から見ていたときは北）
    const standAt = (x: number, z: number) => {
      persp.position.set(x, eyeY(), z);
      pitch = -0.1;
      focus.set(x, floorY(currentFloor), z);
    };
    const focusHall = (id: string) => {
      const h = hallById.get(id)!;
      if (!shown(floorOf(h.level))) setFloor(floorOf(h.level));
      const [x, z] = centroid(h.poly);
      const p = new THREE.Vector3(x, floorY(h.level), z);
      if (current === "walk") {
        persp.position.set(x, floorY(h.level) + EYE, z);
        focus.copy(p);
      } else {
        if (current === "top") {
          ortho.zoom = 2.2;
          ortho.updateProjectionMatrix();
        }
        focusPoint(p, false);
      }
    };

    const recolor = (colorByGenre: boolean, marks: Record<string, Mark>, sel: number | null, dayTags: Record<string, SpaceTag> | null, genre: string | null, work: string | null, char: string | null) => {
      const col = new THREE.Color();
      // ジャンル・作品（とキャラ）を選んでいるとき、その机か
      const hit = (b: Booth) => {
        if (dayTags && genre && dayTags[b.code]?.genre !== genre) return false;
        if (!work) return true;
        if (dayTags) {
          const t = dayTags[b.code];
          if (!t?.works?.includes(work)) return false;
          return !char || !!t.chars?.[work]?.includes(char);
        }
        return lines[b.line].genre === work;
      };
      for (const { mesh, index } of deskMeshes.values()) {
        index.forEach((bi, k) => {
          const b = booths[bi];
          if (bi === sel) col.setHex(SELECT_COLOR);
          else if (marks[b.code]) col.setHex(MARK[marks[b.code]].color);
          else if (colorByGenre && !hit(b)) col.setHex(0xe6e5de); // 選んだ作品でない机は薄く
          else if (colorByGenre && dayTags) {
            // 入れた作品の色（選んだ作品があればその色。なければ 1 つ目の作品の色。作品が入っていない机はジャンルの色、どちらもなければ白）
            const w = work ?? dayTags[b.code]?.works?.[0] ?? dayTags[b.code]?.genre;
            if (w) col.setStyle(workColor(w)).lerp(new THREE.Color(0xffffff), 0.2);
            else col.setHex(DESK_COLOR);
          } else if (colorByGenre) {
            const g = SAMPLE_GENRES.indexOf(lines[b.line].genre ?? "");
            col.setHex(g >= 0 ? GENRE_COLOR[g] : DESK_COLOR).lerp(new THREE.Color(0xffffff), 0.35);
          } else col.setHex(DESK_COLOR);
          mesh.setColorAt(k, col);
        });
        mesh.instanceColor!.needsUpdate = true;
      }
      if (sel === null) {
        pinOn = false;
        pin.visible = false;
      }
    };

    // ---- タップで机を選ぶ（ドラッグとは分ける） ----
    const ray = new THREE.Raycaster();
    const pick = (i: number) => {
      setSelected(i);
      setPickLine(booths[i].line);
      setPickNum(booths[i].num);
      setPickHalf(booths[i].half);
    };
    let down: { x: number; y: number; yaw: number; pitch: number } | null = null;
    // 歩くとき：ストリートビューのように、床をダブルタップするとそこへ歩いていく
    let lastTap: { t: number; x: number; y: number } | null = null;
    const floorAt = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY(currentFloor)), new THREE.Vector3());
    };
    const walkTo = (p: THREE.Vector3) => {
      const from = persp.position.clone();
      const dx = p.x - from.x, dz = p.z - from.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.5 || dist > 80) return; // 足元すぎる・遠すぎる（空のあたり）は動かない
      const go = Math.max(0, dist - 1.2); // 押した所の手前で止まる（机の上に立たない）
      const to = new THREE.Vector3(from.x + (dx / dist) * go, from.y, from.z + (dz / dist) * go);
      walkAnim = { t: 0, from, to, secs: Math.min(1.5, Math.max(0.35, go / 12)) };
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, yaw, pitch };
      if (current === "walk") renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!down || current !== "walk") return;
      yaw = down.yaw - (e.clientX - down.x) * 0.005;
      pitch = Math.max(-1.2, Math.min(1.2, down.pitch - (e.clientY - down.y) * 0.005));
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6) return;
      if (current === "walk") {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
          lastTap = null;
          const p = floorAt(e);
          if (p) walkTo(p);
          return;
        }
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      if (standPick.current) {
        const p = floorAt(e);
        if (p) {
          // 立つ場所のピンを見せてから歩き始める
          pin.position.set(p.x, floorY(currentFloor), p.z);
          standPick.current(p.x, p.z);
        }
        return;
      }
      const r = renderer.domElement.getBoundingClientRect();
      // ピンを押したら、その机。ピンは画面の上の形（先から頭まで）のまわり 10px までを押せる所にする
      const toScreen = (v: THREE.Vector3) => {
        const q = v.clone().project(camera);
        return { x: r.left + ((q.x + 1) / 2) * r.width, y: r.top + ((1 - q.y) / 2) * r.height, front: q.z < 1 };
      };
      // ピンはいつも画面に向く板なので、頭はカメラの「上」の向きにある（真上から見るときも）
      const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      let pinHit = -1, pinD = Infinity;
      for (const p of pins) {
        if (!p.s.visible) continue;
        const tip = toScreen(p.s.position);
        const top = toScreen(p.s.position.clone().addScaledVector(camUp, p.s.scale.y));
        if (!tip.front) continue;
        const len = Math.hypot(top.x - tip.x, top.y - tip.y);
        const t = len ? Math.max(0, Math.min(1, ((e.clientX - tip.x) * (top.x - tip.x) + (e.clientY - tip.y) * (top.y - tip.y)) / len ** 2)) : 0;
        const d = Math.hypot(e.clientX - (tip.x + (top.x - tip.x) * t), e.clientY - (tip.y + (top.y - tip.y) * t));
        if (d <= len * 0.37 + 10 && d < pinD) [pinHit, pinD] = [p.booth, d];
      }
      if (pinHit >= 0) {
        pick(pinHit);
        return;
      }
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const targets = [...deskMeshes.entries()].filter(([lv]) => shown(floorOf(lv))).map(([, d]) => d.mesh);
      const hit = ray.intersectObjects(targets, false)[0];
      if (hit && hit.instanceId !== undefined) {
        const d = [...deskMeshes.values()].find((x) => x.mesh === hit.object)!;
        pick(d.index[hit.instanceId]);
        return;
      }
      // 机は細いので、外れたら床の上の一番近い机（1.5m 以内）を選ぶ
      const p = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY(currentFloor)), new THREE.Vector3());
      if (!p) return;
      let best = -1, bestD = 1.5;
      for (const [lv, d] of deskMeshes) {
        if (!shown(floorOf(lv))) continue;
        for (const bi of d.index) {
          const dist = Math.hypot(booths[bi].at[0] - p.x, booths[bi].at[1] - p.z);
          if (dist < bestD) [best, bestD] = [bi, dist];
        }
      }
      if (best >= 0) pick(best);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.type === "keydown") keys.add(e.key.toLowerCase());
      else keys.delete(e.key.toLowerCase());
    };
    addEventListener("keydown", onKey);
    addEventListener("keyup", onKey);

    // 印をつけた机のピン。数は少ないので、変わるたびに作り直す
    const pins: { s: THREE.Sprite; level: number; base: THREE.Vector3; booth: number }[] = [];
    const setPins = (list: { booth: number; mark: Mark }[]) => {
      for (const p of pins) {
        scene.remove(p.s);
        p.s.material.map?.dispose();
        p.s.material.dispose();
      }
      pins.length = 0;
      for (const { booth, mark } of list) {
        const b = booths[booth];
        const lv = hallById.get(b.hall)!.level;
        const s = pinSprite(MARK[mark].color, MARK[mark].icon);
        s.position.set(b.at[0], floorY(lv) + 0.75, b.at[1]);
        scene.add(s);
        pins.push({ s, level: lv, base: s.scale.clone(), booth });
      }
    };

    // 1m が画面の何 px か（その場所で）
    const pxPerM = (at: THREE.Vector3) => {
      const h = el.clientHeight;
      if (current === "top") return (h * ortho.zoom) / (2 * 160);
      return h / (2 * Math.max(0.1, camera.position.distanceTo(at)) * Math.tan((persp.fov * Math.PI) / 360));
    };
    // 3D・歩く：カメラから札までの間に壁があれば、その札を隠す（札は壁にめりこんで欠けないよう、深さで切らずに描いている）。
    // 札のすぐ手前（2.5m）の壁は数えない（出入口・トイレの札は壁ぎわにある）。動いている間は 0.12 秒ごとに調べ直す
    const wallRay = new THREE.Raycaster();
    const behind = new Set<THREE.Sprite>();
    const lastCam = new THREE.Vector3(Infinity, 0, 0);
    let lastCheck = 0;
    const hideBehindWalls = () => {
      if (current === "top") return;
      const now = performance.now();
      if (now - lastCheck > 120 || lastCam.distanceToSquared(camera.position) > 0.25) {
        lastCheck = now;
        lastCam.copy(camera.position);
        behind.clear();
        const walls = occluders.filter((o) => o.visible);
        const dir = new THREE.Vector3();
        for (const { s } of labels) {
          if (!s.visible) continue;
          dir.subVectors(s.position, camera.position);
          const dist = dir.length();
          if (dist < 2.6) continue;
          wallRay.set(camera.position, dir.normalize());
          wallRay.far = dist - 2.5;
          if (wallRay.intersectObjects(walls, true).length) behind.add(s);
        }
      }
      for (const { s } of labels) if (behind.has(s)) s.visible = false;
    };
    let hereName = "";
    const placeLabels = () => {
      const walk = current === "walk";
      for (const { s, kind, base } of labels) {
        let show = s.userData.levelOn !== false && !(s.userData.topOnly && current !== "top");
        if (walk) {
          s.scale.copy(base);
          if (kind === "hall") show = false;
        } else {
          const ppm = pxPerM(s.position);
          s.scale.copy(base).multiplyScalar(LABEL_PX[kind] / (base.y * ppm));
          if (kind === "hall" && ppm >= 3.5) show = false;
          if (kind === "block" && ppm < 2.2) show = false;
          if (kind === "area" && ppm < 0.9) show = false;
        }
        s.visible = show;
      }
      hideBehindWalls();
      for (const { s, base } of stationLabels) {
        s.scale.copy(base);
        if (!walk) s.scale.multiplyScalar(18 / (base.y * pxPerM(s.position)));
        s.material.depthTest = current !== "top";
      }
      for (const { s, level, base } of pins) {
        s.visible = shown(floorOf(level));
        s.material.depthTest = !(current === "top");
        // 上から・3D では画面の上で 34px、歩くときは実物 1.4m
        s.scale.copy(base);
        if (!walk) s.scale.multiplyScalar(34 / (base.y * pxPerM(s.position)));
      }
      // 上から・3D では、画面の上で重なる WC・救護室の札を隠す（近づけば出てくる）。
      // ホールの名前とピンを先に置き、その上に重なるものも隠す。救護室は WC より先に置く
      if (!walk) {
        const W = el.clientWidth, H = el.clientHeight;
        const placed: [number, number, number, number][] = [];
        const box = (s: THREE.Sprite, hpx: number, bottom: boolean): [number, number, number, number] | null => {
          const q = s.position.clone().project(camera);
          if (q.z > 1) return null;
          const x = ((q.x + 1) / 2) * W, y = ((1 - q.y) / 2) * H;
          const wpx = (hpx * s.scale.x) / s.scale.y;
          return bottom ? [x - wpx / 2, y - hpx, x + wpx / 2, y] : [x - wpx / 2, y - hpx / 2, x + wpx / 2, y + hpx / 2];
        };
        const hits = (b: [number, number, number, number]) => placed.some((r) => b[0] < r[2] + 3 && b[2] > r[0] - 3 && b[1] < r[3] + 3 && b[3] > r[1] - 3);
        for (const { s, kind } of labels) if (kind === "hall" && s.visible) { const b = box(s, LABEL_PX.hall, false); if (b) placed.push(b); }
        for (const { s } of pins) if (s.visible) { const b = box(s, 34, true); if (b) placed.push(b); }
        // 駅の名前（「周辺も表示」のとき）。重なったら後の駅を隠す
        if (surroundings.visible)
          for (const { s } of stationLabels) {
            const b = box(s, 18, false);
            s.visible = !b || !hits(b);
            if (b && s.visible) placed.push(b);
          }
        for (const k of ["aid", "door", "wc", "shutter"] as const)
          for (const { s, kind } of labels) {
            if (kind !== k || !s.visible) continue;
            const b = box(s, LABEL_PX[k], false);
            if (!b) continue;
            if (hits(b)) s.visible = false;
            else placed.push(b);
          }
      }
      // 近づいてホールの名前を消したときは、画面の真ん中（歩くときは自分の足元）のホールの名前を隅に出す
      const near = walk || pxPerM(focus) >= 3.5;
      const h = near ? venue.halls.find((x) => shown(floorOf(x.level)) && pointInPolygon([focus.x, focus.z], x.poly)) : undefined;
      const name = h ? h.name + (h.level >= 4 ? "（4F）" : "") : "";
      if (name !== hereName) {
        hereName = name;
        onHere.current(name);
      }
    };

    // 拡大して1スペースが 16px 以上になったら、机の上に配置番号を書く（上からの見方だけ）。
    // 上からの見方は真上から北を上に見ているので、画面の位置は (x, z) をそのまま拡大して足せばよい
    let codesShown = false;
    const ends = islandEnds(lines);
    // 3D（見下ろす見方）：机ごとに画面の上での大きさ（遠近で変わる）を見て、2D と同じ決まりで書く。
    // 1 スペースが 16px 以上ならスペースごと（05a。34px 以上で C-05a）、机 1 つが 14px 以上なら机ごと（05）、
    // 1m が 3px 以上なら島の端の番号だけ。カメラが動いていなければ書き直さない
    const pv = new THREE.Vector3();
    let lastKey3d = "";
    const drawCodes3d = (w: number, h: number) => {
      const key = [camera.position.x, camera.position.y, camera.position.z, camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, w, h, currentFloor, bothFloors]
        .map((v) => (typeof v === "number" ? v.toFixed(3) : String(v)))
        .join(",");
      if (key === lastKey3d && codesShown) return;
      lastKey3d = key;
      codeCtx.clearRect(0, 0, w, h);
      codesShown = true;
      const tanH = Math.tan((persp.fov * Math.PI) / 360);
      const cp = camera.position;
      const ppmAt = (x: number, y: number, z: number) => h / (2 * Math.max(0.1, Math.hypot(x - cp.x, y - cp.y, z - cp.z)) * tanH);
      const scr = (x: number, y: number, z: number): [number, number] | null => {
        pv.set(x, y, z).project(camera);
        if (pv.z < -1 || pv.z > 1 || Math.abs(pv.x) > 1.05 || Math.abs(pv.y) > 1.05) return null;
        return [((pv.x + 1) / 2) * w, ((1 - pv.y) / 2) * h];
      };
      codeCtx.textAlign = "center";
      codeCtx.textBaseline = "middle";
      codeCtx.fillStyle = "#1d1d1b";
      codeCtx.strokeStyle = "rgba(255,255,255,.85)";
      codeCtx.lineWidth = 3;
      let font = "";
      // 画面の上で、先に書いた番号と重なる番号は書かない（遠くの島は遠近で縦につぶれ、番号が重なって読めなくなる）。
      // 近い机から書くので、近い番号が残る。重なりは 24px の升目で調べる
      const cell = 24;
      const taken = new Map<number, [number, number, number, number][]>();
      const free = (x0: number, y0: number, x1: number, y1: number) => {
        for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++)
          for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++)
            for (const r of taken.get(gx * 4096 + gy) ?? []) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return false;
        return true;
      };
      const items: { label: string; px: number; at: [number, number]; d: number }[] = [];
      const write = (label: string, px: number, at: [number, number], d = 0) => items.push({ label, px, at, d });
      const flushItems = () => {
        items.sort((p, q) => p.d - q.d);
        for (const it of items) {
          const hw = (it.label.length * it.px * 0.62) / 2 + 1, hh = it.px / 2 + 1;
          const r: [number, number, number, number] = [it.at[0] - hw, it.at[1] - hh, it.at[0] + hw, it.at[1] + hh];
          if (!free(...r)) continue;
          for (let gx = Math.floor(r[0] / cell); gx <= Math.floor(r[2] / cell); gx++)
            for (let gy = Math.floor(r[1] / cell); gy <= Math.floor(r[3] / cell); gy++) {
              const k = gx * 4096 + gy;
              if (!taken.has(k)) taken.set(k, []);
              taken.get(k)!.push(r);
            }
          const f = `600 ${Math.round(it.px)}px system-ui, sans-serif`;
          if (f !== font) codeCtx.font = font = f;
          codeCtx.strokeText(it.label, it.at[0], it.at[1]);
          codeCtx.fillText(it.label, it.at[0], it.at[1]);
        }
      };
      const out = (VIEW_DESK_D - DESK_D) / 2;
      for (const [lv, d] of deskMeshes) {
        if (!shown(floorOf(lv))) continue;
        const y = floorY(lv) + 0.75;
        for (const bi of d.index) {
          const a = booths[bi];
          const b = booths[bi + 1];
          const pair = a.half === "a" && b && b.line === a.line && b.num === a.num;
          if (a.half === "b" && bi > 0 && booths[bi - 1].line === a.line && booths[bi - 1].num === a.num) continue; // 組の b は a の所で書く
          const spot = (s: Booth): [number, number] => [s.at[0] - Math.sin(s.angle) * s.side * out, s.at[1] + Math.cos(s.angle) * s.side * out];
          const c0 = spot(a);
          const c1 = pair ? spot(b) : c0;
          const mx = (c0[0] + c1[0]) / 2, mz = (c0[1] + c1[1]) / 2;
          const ppm = ppmAt(mx, y, mz);
          if (ppm * 0.9 >= 16) {
            const full = ppm * 0.9 >= 34;
            const px = Math.max(9, Math.min(14, ppm * 0.9 * (full ? 0.3 : 0.42)));
            for (const sp of pair ? [a, b] : [a]) {
              const [x, z] = spot(sp);
              const at = scr(x, y, z);
              if (at) write(full ? `${sp.block}-${String(sp.num).padStart(2, "0")}${sp.half}` : `${String(sp.num).padStart(2, "0")}${sp.half}`, px, at, 1 / ppm);
            }
          } else if (ppm * DESK_L >= 14) {
            const at = scr(mx, y, mz);
            if (at) write(String(a.num).padStart(2, "0"), Math.max(9, Math.min(13, ppm * DESK_L * 0.45)), at, 1 / ppm);
          }
        }
      }
      // 島の端の番号：机ごとの番号を書くほど近くないとき
      for (const e of ends) {
        const l = lines[e.line];
        const lv = hallById.get(l.hall)!.level;
        if (!shown(floorOf(lv))) continue;
        const c = Math.cos(l.angle), sn = Math.sin(l.angle);
        const x0 = l.start[0] + e.u * c, z0 = l.start[1] + e.u * sn, y = floorY(lv) + 0.75;
        const ppm = ppmAt(x0, y, z0);
        if (ppm < 3 || ppm * DESK_L >= 14) continue;
        const side = e.side * Math.max(7 / ppm, VIEW_DESK_D / 2);
        const inward = -e.out * Math.max(7 / ppm, DESK_L / 2);
        const at = scr(x0 + c * inward - sn * side, y, z0 + sn * inward + c * side);
        if (at) write(String(e.num).padStart(2, "0"), 10, at, 1 / ppm);
      }
      flushItems();
    };
    const drawCodes = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (current === "orbit") return drawCodes3d(w, h);
      lastKey3d = "";
      const ppm = (h * ortho.zoom) / (2 * 160);
      // スペースごとの番号（05a）：1スペースが 16px 以上。机ごとの番号（05）：机1つが 14px 以上。島の端の番号だけ：島どうしの間（7m）が 20px 以上
      const every = ppm * 0.9 >= 16;
      const perDesk = !every && ppm * DESK_L >= 14;
      const show = current === "top" && (every || ppm >= 3);
      if (!show) {
        if (codesShown) codeCtx.clearRect(0, 0, w, h);
        codesShown = false;
        return;
      }
      codesShown = true;
      codeCtx.clearRect(0, 0, w, h);
      const cx = controls ? controls.target.x : focus.x, cz = controls ? controls.target.z : focus.z;
      const halfW = w / 2 / ppm + 2, halfH = h / 2 / ppm + 2;
      if (perDesk) {
        // 机の真ん中（a と b のあいだ）に、机の番号だけ
        codeCtx.font = `600 ${Math.round(Math.max(9, Math.min(13, ppm * DESK_L * 0.45)))}px system-ui, sans-serif`;
        codeCtx.textAlign = "center";
        codeCtx.textBaseline = "middle";
        codeCtx.fillStyle = "#1d1d1b";
        codeCtx.strokeStyle = "rgba(255,255,255,.85)";
        codeCtx.lineWidth = 3;
        const out = (TOP_DESK_D - DESK_D) / 2;
        for (const [lv, d] of deskMeshes) {
          if (!shown(floorOf(lv))) continue;
          for (const bi of d.index) {
            const a = booths[bi], b = booths[bi + 1];
            if (a.half !== "a" || !b || b.line !== a.line || b.num !== a.num) continue;
            const x = (a.at[0] + b.at[0]) / 2 - Math.sin(a.angle) * a.side * out;
            const z = (a.at[1] + b.at[1]) / 2 + Math.cos(a.angle) * a.side * out;
            if (Math.abs(x - cx) > halfW || Math.abs(z - cz) > halfH) continue;
            const label = String(a.num).padStart(2, "0");
            const sx = (x - cx) * ppm + w / 2, sy = (z - cz) * ppm + h / 2;
            codeCtx.strokeText(label, sx, sy);
            codeCtx.fillText(label, sx, sy);
          }
        }
        return;
      }
      if (!every) {
        // 島の端の机の上に、A側・B側の番号（横切る通路の向こうの番号や列の名前と重ならないよう、島の内側に。A・B の間は画面の上で少し離す）
        codeCtx.font = "600 10px system-ui, sans-serif";
        codeCtx.textAlign = "center";
        codeCtx.textBaseline = "middle";
        codeCtx.fillStyle = "#1d1d1b";
        codeCtx.strokeStyle = "rgba(255,255,255,.9)";
        codeCtx.lineWidth = 3;
        for (const e of ends) {
          const l = lines[e.line];
          if (!shown(floorOf(hallById.get(l.hall)!.level))) continue;
          const c = Math.cos(l.angle), sn = Math.sin(l.angle);
          const x = l.start[0] + e.u * c, z = l.start[1] + e.u * sn;
          if (Math.abs(x - cx) > halfW || Math.abs(z - cz) > halfH) continue;
          const sideOff = e.side * Math.max(7, (TOP_DESK_D / 2) * ppm);
          const inward = -e.out * Math.max(7, (DESK_L / 2) * ppm);
          const sx = (x - cx) * ppm + w / 2 + c * inward - sn * sideOff;
          const sy = (z - cz) * ppm + h / 2 + sn * inward + c * sideOff;
          const label = String(e.num).padStart(2, "0");
          codeCtx.strokeText(label, sx, sy);
          codeCtx.fillText(label, sx, sy);
        }
        return;
      }
      // 大きく拡大したら列の名前もつける（「C-05a」）。そうでなければ番号だけ（「05a」）
      const full = ppm * 0.9 >= 34;
      const font = Math.max(9, Math.min(14, ppm * 0.9 * (full ? 0.3 : 0.42)));
      codeCtx.font = `600 ${font}px system-ui, sans-serif`;
      codeCtx.textAlign = "center";
      codeCtx.textBaseline = "middle";
      codeCtx.fillStyle = "#1d1d1b";
      codeCtx.strokeStyle = "rgba(255,255,255,.85)";
      codeCtx.lineWidth = 3;
      const out = (TOP_DESK_D - DESK_D) / 2;
      for (const [lv, d] of deskMeshes) {
        if (!shown(floorOf(lv))) continue;
        for (const bi of d.index) {
          const b = booths[bi];
          // 上から描いている机の真ん中（サークルの座る側へのばした分だけずらす）
          const x = b.at[0] - Math.sin(b.angle) * b.side * out;
          const z = b.at[1] + Math.cos(b.angle) * b.side * out;
          if (Math.abs(x - cx) > halfW || Math.abs(z - cz) > halfH) continue;
          const label = full ? `${b.block}-${String(b.num).padStart(2, "0")}${b.half}` : `${String(b.num).padStart(2, "0")}${b.half}`;
          const sx = (x - cx) * ppm + w / 2, sy = (z - cz) * ppm + h / 2;
          codeCtx.strokeText(label, sx, sy);
          codeCtx.fillText(label, sx, sy);
        }
      }
    };

    // ---- 毎フレーム ----
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (fly && controls) {
        fly.t = Math.min(1, fly.t + dt / 0.6);
        const k = 1 - Math.pow(1 - fly.t, 3);
        controls.target.lerpVectors(fly.from, fly.to, k);
        camera.position.lerpVectors(fly.camFrom, fly.camTo, k);
        if (fly.t >= 1) fly = null;
      }
      if (current === "walk") {
        const fwd = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0) + hold;
        const side = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        if (fwd || side) walkAnim = null; // 自分で動かしたら、ダブルタップの移動はやめる
        if (walkAnim) {
          walkAnim.t = Math.min(1, walkAnim.t + dt / walkAnim.secs);
          const k = 1 - Math.pow(1 - walkAnim.t, 2);
          persp.position.x = walkAnim.from.x + (walkAnim.to.x - walkAnim.from.x) * k;
          persp.position.z = walkAnim.from.z + (walkAnim.to.z - walkAnim.from.z) * k;
          if (walkAnim.t >= 1) walkAnim = null;
        }
        persp.position.x += (fx * fwd - fz * side) * WALK_SPEED * dt;
        persp.position.z += (fz * fwd + fx * side) * WALK_SPEED * dt;
        persp.position.y = eyeY();
        persp.rotation.set(pitch, yaw, 0, "YXZ");
      } else if (controls) {
        // 回転の中心は、いつも選んでいる階の床の上に（カーソルへの拡大で少しずれても戻す）
        if (current === "orbit" && !fly && Math.abs(controls.target.y - focus.y) > 0.01) {
          const dy = focus.y - controls.target.y;
          controls.target.y += dy;
          camera.position.y += dy;
        }
        controls.update();
      }
      if (controls) focus.set(controls.target.x, focus.y, controls.target.z);
      else if (current === "walk") focus.set(persp.position.x, focus.y, persp.position.z);
      placeLabels();
      drawCodes();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // 上からの見方の縦の半分は 160m（size()）。会場の縦横が入る倍率に
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    ortho.zoom = Math.min((160 * 2) / ((bounds.maxZ - bounds.minZ) * 1.08), (160 * 2 * aspect) / ((bounds.maxX - bounds.minX) * 1.08));
    ortho.updateProjectionMatrix();
    setView("top");
    setFloor(1);
    // 印刷用の配置図：同じ建物・同じ階のホールをまとめて真上から描いた絵に、列の名前・島の端の番号・印の札・ホールの名前・北の矢印を書き足す。
    // 島の列が紙に対してまっすぐになるよう、ホールの長い向きを横にして回す（北は矢印で示す）。
    // 描き手（WebGLRenderer）は印刷用に1つだけ作って使い回す。描いたら階・机の置き方・札を元に戻す
    let printRenderer: THREE.WebGLRenderer | null = null;
    const snapshot = (hallIds: string[], marked: { booth: number; mark: Mark }[]) => {
      const hs = hallIds.map((id) => hallById.get(id)!);
      const level = hs[0].level;
      const prevFloor = currentFloor;
      setFloor(floorOf(level));
      placeDesks(true);
      const hiddenSprites: THREE.Sprite[] = [];
      scene.traverse((o) => {
        if (o instanceof THREE.Sprite && o.visible) {
          o.visible = false;
          hiddenSprites.push(o);
        }
      });
      const pinWas = pin.visible;
      pin.visible = false;
      // 回す角：島の列がまっすぐ（横か縦）になる2通りのうち、絵が横長になるほう。そのうえで北がなるべく上になる側を選ぶ
      const all = hs.flatMap((h) => h.poly);
      const lineAngle = lines.find((l) => hallIds.includes(l.hall))?.angle ?? minAreaRect(all).angle;
      const extent = (t: number) => {
        const us = all.map(([x, z]) => x * Math.cos(t) + z * Math.sin(t)), vs = all.map(([x, z]) => -x * Math.sin(t) + z * Math.cos(t));
        return (Math.max(...us) - Math.min(...us)) / (Math.max(...vs) - Math.min(...vs));
      };
      let th = extent(lineAngle) >= extent(lineAngle + Math.PI / 2) ? lineAngle : lineAngle + Math.PI / 2;
      if (Math.cos(th) < 0) th += Math.PI;
      const ct = Math.cos(th), st = Math.sin(th);
      const toUV = (x: number, z: number): [number, number] => [x * ct + z * st, -x * st + z * ct];
      // 図の範囲：ホールと、そのホールの出入口・搬入口まで（南のエントランスはホールの手前 36m ほど）
      const uv = [...all, ...venue.doors.filter((d) => hallIds.includes(d.hall)).map((d) => d.at)].map(([x, z]) => toUV(x, z));
      const PAD = 8;
      const u0 = Math.min(...uv.map((q) => q[0])) - PAD, u1 = Math.max(...uv.map((q) => q[0])) + PAD;
      const v0 = Math.min(...uv.map((q) => q[1])) - PAD, v1 = Math.max(...uv.map((q) => q[1])) + PAD;
      const W = u1 - u0, Hh = v1 - v0;
      const big = 3200;
      const pxW = Math.round((big * W) / Math.max(W, Hh)), pxH = Math.round((big * Hh) / Math.max(W, Hh));
      const cam = new THREE.OrthographicCamera(-W / 2, W / 2, Hh / 2, -Hh / 2, 0.1, 3000);
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      const cx = uc * ct - vc * st, cz = uc * st + vc * ct;
      const y = floorY(level);
      cam.up.set(st, 0, -ct); // 画面の上 = 会場のこの向き
      cam.position.set(cx, y + 600, cz);
      cam.lookAt(cx, y, cz);
      printRenderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
      printRenderer.setSize(pxW, pxH, false);
      printRenderer.render(scene, cam);
      const c = document.createElement("canvas");
      c.width = pxW;
      c.height = pxH;
      const g = c.getContext("2d")!;
      g.drawImage(printRenderer.domElement, 0, 0);
      // 元に戻す（札の大きさと見せ方は、次のフレームの placeLabels が決め直す）
      for (const o of hiddenSprites) o.visible = true;
      pin.visible = pinWas;
      placeDesks(current === "top");
      setFloor(prevFloor);
      const px = (x: number, z: number): [number, number] => {
        const [u, v] = toUV(x, z);
        return [((u - u0) / W) * pxW, ((v - v0) / Hh) * pxH];
      };
      const k = pxW / W; // 1m の px
      // A4 横（幅 277mm）に印刷したときの 1m の mm。机ごとの番号が 1.3mm 以上で読めるときだけ、机ごとに番号を書く
      const mmPerM = 277 / W;
      const everyDesk = 0.95 * mmPerM >= 1.3;
      const mm = (x: number) => (x / mmPerM) * k; // 紙の上の mm → 絵の px
      const out = (TOP_DESK_D - DESK_D) / 2;
      const ids = new Set(hallIds);
      g.textAlign = "center";
      g.textBaseline = "middle";
      // ホールの名前（ホールの真ん中に薄く大きく）
      g.font = `800 ${Math.round(mm(9))}px system-ui, sans-serif`;
      g.fillStyle = "rgba(30,40,60,.18)";
      for (const h of hs) {
        const [sx, sy] = px(...centroid(h.poly));
        g.fillText(h.name.replace("ホール", ""), sx, sy);
      }
      g.fillStyle = "#1d1d1b";
      if (everyDesk) {
        // 机ごとの番号（机1つに1つ。a・b は机の左右の半分）
        g.font = `600 ${Math.round(k * 0.95)}px system-ui, sans-serif`;
        for (let i = 0; i + 1 < booths.length; i++) {
          const a = booths[i], bb = booths[i + 1];
          if (!ids.has(a.hall) || a.half !== "a" || bb.num !== a.num || bb.line !== a.line) continue;
          const [sx, sy] = px((a.at[0] + bb.at[0]) / 2 - Math.sin(a.angle) * a.side * out, (a.at[1] + bb.at[1]) / 2 + Math.cos(a.angle) * a.side * out);
          g.fillText(String(a.num).padStart(2, "0"), sx, sy);
        }
      } else {
        // 島の端の番号（区間の両端に、A側・B側の端の机の番号）
        g.font = `600 ${Math.round(mm(1.6))}px system-ui, sans-serif`;
        for (const e of ends) {
          const l = lines[e.line];
          if (!ids.has(l.hall)) continue;
          // 端の机の上。A側・B側の番号は、紙の上で 1.8mm 以上離す（縦の島では横に並ぶので、くっつかないように）
          const u = e.u - e.out * (DESK_L / 2);
          const v = e.side * Math.max(TOP_DESK_D / 2, mm(1.8) / k);
          const x = l.start[0] + u * Math.cos(l.angle) - v * Math.sin(l.angle);
          const z = l.start[1] + u * Math.sin(l.angle) + v * Math.cos(l.angle);
          const [sx, sy] = px(x, z);
          g.strokeStyle = "rgba(255,255,255,.9)";
          g.lineWidth = mm(0.5);
          g.strokeText(String(e.num).padStart(2, "0"), sx, sy);
          g.fillText(String(e.num).padStart(2, "0"), sx, sy);
        }
      }
      // 列の名前（両端）
      const blockPx = Math.round(Math.max(mm(2.4), k * 1.8));
      g.font = `700 ${blockPx}px system-ui, sans-serif`;
      for (const l of lines) {
        if (!ids.has(l.hall)) continue;
        const spots: XZ[] = l.wall ? wallLabelSpots(l, 3) : [-2.8, lineLength(l) + 2.8].map((u) => [l.start[0] + Math.cos(l.angle) * u, l.start[1] + Math.sin(l.angle) * u] as XZ);
        for (const [x, z] of spots) {
          const [sx, sy] = px(x, z);
          g.fillStyle = "#fff";
          g.strokeStyle = "#1d1d1b";
          g.lineWidth = Math.max(1, mm(0.15));
          g.beginPath();
          g.arc(sx, sy, blockPx * 0.72, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          g.fillStyle = "#1d1d1b";
          g.fillText(l.block, sx, sy);
        }
      }
      // 出入口・搬入口・トイレ・救護室（このページの階のもの。紙の上で 2mm ほどの文字）
      const facPx = Math.round(mm(1.9));
      g.font = `700 ${facPx}px system-ui, sans-serif`;
      const tag = (x: number, z: number, text: string, bg: string) => {
        const [sx, sy] = px(x, z);
        if (sx < 0 || sy < 0 || sx > pxW || sy > pxH) return;
        const w = g.measureText(text).width + facPx * 0.5, hh = facPx * 1.35;
        g.fillStyle = bg;
        g.beginPath();
        g.roundRect(sx - w / 2, sy - hh / 2, w, hh, facPx * 0.2);
        g.fill();
        g.fillStyle = "#fff";
        g.fillText(text, sx, sy);
      };
      for (const d of venue.doors) if (floorOf(d.level) === floorOf(level)) tag(d.at[0], d.at[1], d.kind === "出入口" ? "出入口" : "搬入", d.kind === "出入口" ? "#14783c" : "#6b706b");
      for (const t of venue.toilets) if (floorOf(t.level ?? 1) === floorOf(level)) tag(t.at[0], t.at[1], t.kinds?.includes("多機能") ? "WC♿" : "WC", "#1f5fbf");
      for (const a of venue.firstAid) if (floorOf(a.level) === floorOf(level)) tag(a.at[0], a.at[1], "＋救護", "#c81e1e");
      g.fillStyle = "#1d1d1b";
      // 印の机：丸と配置番号の札（紙の上で 3mm ほどの文字）
      const codePx = Math.round(mm(3));
      g.font = `700 ${codePx}px system-ui, sans-serif`;
      for (const { booth, mark } of marked) {
        const b = booths[booth];
        if (!ids.has(b.hall)) continue;
        const [sx, sy] = px(b.at[0] - Math.sin(b.angle) * b.side * out, b.at[1] + Math.cos(b.angle) * b.side * out);
        const label = `${MARK[mark].icon} ${b.block}-${String(b.num).padStart(2, "0")}${b.half}`;
        const w = g.measureText(label).width + codePx * 0.6, hh = codePx * 1.4;
        g.fillStyle = hexCss(MARK[mark].color);
        g.strokeStyle = "#fff";
        g.lineWidth = Math.max(2, mm(0.3));
        g.beginPath();
        g.arc(sx, sy, Math.max(codePx * 0.3, k * 0.7), 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.beginPath();
        g.roundRect(sx - w / 2, sy - hh - codePx * 0.5, w, hh, codePx * 0.25);
        g.fill();
        g.fillStyle = "#fff";
        g.fillText(label, sx, sy - hh / 2 - codePx * 0.5);
      }
      // 北の矢印（右下。白い丸の上に）
      const ar = mm(6), ax = pxW - mm(11), ay = pxH - mm(11);
      g.fillStyle = "rgba(255,255,255,.9)";
      g.beginPath();
      g.arc(ax, ay, ar * 1.9, 0, Math.PI * 2);
      g.fill();
      const nx = -st, ny = -ct; // 会場の北（z の負の向き）が、絵の上でどちらか
      g.strokeStyle = "#1d1d1b";
      g.fillStyle = "#1d1d1b";
      g.lineWidth = mm(0.5);
      g.beginPath();
      g.moveTo(ax - nx * ar, ay - ny * ar);
      g.lineTo(ax + nx * ar, ay + ny * ar);
      g.stroke();
      g.beginPath();
      g.moveTo(ax + nx * ar, ay + ny * ar);
      g.lineTo(ax + nx * ar * 0.4 - ny * ar * 0.35, ay + ny * ar * 0.4 + nx * ar * 0.35);
      g.lineTo(ax + nx * ar * 0.4 + ny * ar * 0.35, ay + ny * ar * 0.4 - nx * ar * 0.35);
      g.fill();
      g.font = `700 ${Math.round(mm(3.5))}px system-ui, sans-serif`;
      g.fillText("N", ax + nx * ar * 1.6, ay + ny * ar * 1.6);
      return c.toDataURL("image/png");
    };

    api.current = { setView, setFloor, setBoth: (on) => {
      bothFloors = on;
      applyVisibility();
    }, recolor, setPins, focusBooth, standAt, focusHall, snapshot, hold: (d) => (hold = d), setSurround: (on) => {
        surroundings.visible = on;
      },
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKey);
      controls?.dispose();
      renderer.dispose();
      printRenderer?.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      el.removeChild(renderer.domElement);
      el.removeChild(codeLayer);
      api.current = null;
    };
  }, [booths]);

  useEffect(() => api.current?.setView(view), [view]);
  useEffect(() => api.current?.setFloor(floor), [floor]);
  useEffect(() => api.current?.setBoth(both), [both]);
  useEffect(() => {
    api.current?.setSurround(surround);
  }, [surround]);
  useEffect(() => api.current?.recolor(byGenre, marks, selected, dayTags, genre, work, char), [byGenre, marks, selected, dayTags, genre, work, char]);
  useEffect(() => {
    const list = Object.entries(marks)
      .filter(([code, m]) => pinsOn[m] && codeIndex.has(code))
      .map(([code, mark]) => ({ booth: codeIndex.get(code)!, mark }));
    api.current?.setPins(list);
  }, [marks, pinsOn, codeIndex]);

  const select = useCallback(
    (i: number) => {
      setSelected(i);
      const lv = hallById.get(booths[i].hall)!.level;
      setFloor(floorOf(lv));
      api.current?.focusBooth(i);
    },
    [booths],
  );

  // 選ぶ欄を変えたら、すぐその机へ
  const jump = (line: number, num: number, half: "a" | "b") => {
    setPickLine(line);
    setPickNum(num);
    setPickHalf(half);
    const l = lines[line];
    const i = codeIndex.get(`${hallById.get(l.hall)!.building}${l.block}-${String(num).padStart(2, "0")}${half}`);
    if (i !== undefined) select(i);
  };
  const pickNums = pickLine === null ? [] : lineNums(lines[pickLine]);

  const sel = selected !== null ? booths[selected] : null;
  const selHall = sel ? hallById.get(sel.hall)! : null;
  const selMark = sel ? marks[sel.code] : undefined;
  // 同じ印をもう一度押すと外す。違う印を押すと付け替える
  const toggleMark = (code: string, mark: Mark) => {
    if (marks[code] === mark)
      setNotes((o) => {
        const n = { ...o };
        delete n[code];
        return n;
      });
    setMarks((m) => {
      const n = { ...m };
      if (n[code] === mark) delete n[code];
      else n[code] = mark;
      return n;
    });
  };
  const setNote = (code: string, text: string) =>
    setNotes((o) => {
      const n = { ...o };
      if (text) n[code] = text;
      else delete n[code];
      return n;
    });
  const listOf = (mark: Mark) =>
    Object.keys(marks)
      .filter((c) => marks[c] === mark && codeIndex.has(c))
      .sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
  const lists = { want: listOf("want"), maybe: listOf("maybe") };
  const openHalls = venue.halls.filter((h) => !h.closed);
  // 作品のドロップダウン：入れた作品（なければ見本の作品）。キャラのドロップダウン：選んだ作品に入っているキャラ
  // ジャンルの一覧と、選んだジャンルの作品の一覧
  const genreList = [...new Set(Object.values(dayTags ?? {}).map((t) => t.genre).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, "ja"));
  const workList = dayTags
    ? dayWorks.map((w) => w.work).filter((w) => !genre || Object.values(dayTags).some((t) => t.genre === genre && t.works?.includes(w)))
    : SAMPLE_GENRES;
  const charList = (() => {
    if (!work || !dayTags) return [];
    const set = new Set<string>();
    for (const t of Object.values(dayTags)) for (const c of t.chars?.[work] ?? []) set.add(c);
    return [...set].sort((a, b) => a.localeCompare(b, "ja"));
  })();
  const chooseMode = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
    cancelWalk();
    setView(m === "plan" ? "orbit" : "top");
  };
  const toggle3d = () => {
    cancelWalk();
    setView(view === "top" ? "orbit" : "top");
  };
  // 配置番号を選ぶ欄（列 → 番号 → a・b）。作品を登録するモードでは地図の上に、当日・計画のモードではサイドバーに
  const codePicker = (
    <div style={{ display: "flex", gap: 6, alignItems: "center", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: 4, boxShadow: "0 1px 6px rgba(0,0,0,.12)" }}>
      <select
        aria-label="列"
        value={pickLine ?? ""}
        onChange={(e) => jump(Number(e.target.value), lineNums(lines[Number(e.target.value)])[0] ?? 1, "a")}
        style={{ flex: 2, minWidth: 0 }}
      >
        <option value="" disabled>
          配置番号
        </option>
        {openHalls.map((h) => (
          <optgroup key={h.id} label={h.name + (h.level >= 4 ? "（4F）" : "")}>
            {lines.map((l, i) =>
              l.hall === h.id ? (
                <option key={i} value={i}>
                  {h.building}
                  {l.block}
                </option>
              ) : null,
            )}
          </optgroup>
        ))}
      </select>
      <select aria-label="番号" value={pickNum} disabled={pickLine === null} onChange={(e) => jump(pickLine!, Number(e.target.value), pickHalf)} style={{ flex: 1, minWidth: 0 }}>
        {pickNums.map((n) => (
          <option key={n} value={n}>
            {String(n).padStart(2, "0")}
          </option>
        ))}
      </select>
      <div className="seg" role="group" aria-label="a・b">
        {(["a", "b"] as const).map((x) => (
          <button key={x} aria-pressed={pickLine !== null && pickHalf === x} disabled={pickLine === null} onClick={() => jump(pickLine!, pickNum, x)}>
            {x}
          </button>
        ))}
      </div>
    </div>
  );

  // 配置図を印刷する：同じ建物・同じ階のホールを1枚にまとめる（東1〜3・東7・8・西1・2・西3・4・南1・2・南3・4）。
  // 印をつけた机は図の上に札で、図の下に一覧で。印刷の画面で「PDF に保存」も選べる
  const PRINT_GROUPS = [["E1", "E2", "E3"], ["E7", "E8"], ["W1", "W2"], ["W3", "W4"], ["S1", "S2"], ["S3", "S4"]];
  const startPrint = () => {
    const marked = MARKS.flatMap((m) => lists[m].map((c) => ({ booth: codeIndex.get(c)!, mark: m })));
    const open = new Set(openHalls.map((h) => h.id));
    const sections = PRINT_GROUPS.map((ids) => ids.filter((id) => open.has(id)))
      .filter((ids) => ids.length > 0)
      .map((ids) => {
        const hs = ids.map((id) => hallById.get(id)!);
        const nums = hs.map((h) => h.name.replace(/[^0-9]/g, "")).join("・");
        const mine = marked.filter((m) => ids.includes(booths[m.booth].hall));
        return {
          title: `${hs[0].building}${nums}ホール（${hs[0].level}F）`,
          img: api.current?.snapshot(ids, mine) ?? "",
          codes: mine
            .map(({ booth, mark }) => ({ code: booths[booth].code, mark, hall: hallById.get(booths[booth].hall)!.name, note: notes[booths[booth].code] ?? "" }))
            .sort((a, b) => a.code.localeCompare(b.code, "ja", { numeric: true })),
        };
      });
    setListOpen(false);
    setPrint({ made: new Date().toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" }), sections });
  };
  useEffect(() => {
    if (!print) return;
    const done = () => setPrint(null);
    addEventListener("afterprint", done);
    // 絵が描き終わってから印刷の画面を開く
    const t = setTimeout(() => print.sections.length && window.print(), 300);
    return () => {
      clearTimeout(t);
      removeEventListener("afterprint", done);
    };
  }, [print]);

  return (
    <>
    {/* 長押しで文字が選ばれたり、メニューが出たりしないように（入力欄は除く。globals.css の .app） */}
    <div className="app" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }} onContextMenu={(e) => e.preventDefault()}>
      <div ref={box} style={{ position: "relative", flex: 1, minHeight: 0, touchAction: "none" }}>
        {/* いつも出すもの：サイドバーを開くボタン、2D・3D、歩く、周辺。作品を登録するモードでは、配置番号の欄も */}
        <div style={{ position: "absolute", top: 8, left: 8, right: 8, display: "flex", gap: 8, alignItems: "flex-start", pointerEvents: "none" }}>
          <button className="icon-btn" style={{ pointerEvents: "auto" }} aria-label="メニュー" onClick={() => setMenu(true)}>
            <Icon name="menu" />
          </button>
          {mode === "register" && (
            <div data-tour="picker" style={{ flex: 1, minWidth: 0, maxWidth: 520, pointerEvents: "auto" }}>
              {codePicker}
            </div>
          )}
          <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", gap: 6, pointerEvents: "auto" }}>
            <button className="icon-btn" aria-label={view === "top" ? "3D にする" : "2D にする"} onClick={toggle3d}>
              <Icon name={view === "top" ? "3d" : "2d"} />
            </button>
            <button className="icon-btn" aria-label="場所を指して歩く" aria-pressed={view === "walk" || walkPending} onClick={() => chooseView(view === "walk" ? "orbit" : "walk")}>
              <Icon name="walk" />
            </button>
            <button className="icon-btn" aria-label="周辺も表示" aria-pressed={surround} onClick={() => setSurround((x) => !x)}>
              <Icon name="city" />
            </button>
            <div className="floor-switch" role="group" aria-label="階">
              {([4, 1] as Floor[]).map((f) => (
                <button
                  key={f}
                  aria-pressed={!both && floor === f}
                  onClick={() => {
                    setBoth(false);
                    setFloor(f);
                  }}
                >
                  {f}F
                </button>
              ))}
              <button aria-pressed={both} aria-label="1F と 4F の両方" onClick={() => setBoth(true)} style={{ fontSize: ".72rem" }}>
                両方
              </button>
            </div>
          </div>
        </div>
        {!online && (
          <div role="status" style={{ ...OVER, top: 60, left: "50%", transform: "translateX(-50%)", background: "#3a3a37", color: "#fff", fontSize: ".85rem" }}>
            電波がありません。この端末に保存した地図と印を表示しています
          </div>
        )}
        {here && <div style={{ ...OVER, bottom: 22, right: 8, fontWeight: 700, fontSize: ".85rem" }}>{here}{floor === 4 ? "（4F）" : ""}</div>}
        {walkPending && (
          <div role="status" style={{ position: "absolute", left: "50%", top: 12, transform: "translateX(-50%)", background: "#1f3b6e", color: "#fff", borderRadius: 8, padding: "8px 12px", display: "flex", gap: 10, alignItems: "center", boxShadow: "0 2px 8px rgba(0,0,0,.25)", maxWidth: "92%" }}>
            <span>歩き始める場所を、地図の上で押してください。そこにピンを立てて、その場所から歩きます</span>
            <button className="chip small" onClick={cancelWalk}>やめる</button>
          </div>
        )}
        {view === "walk" && (
          <div style={{ position: "absolute", right: 12, bottom: sel ? 150 : 40, display: "flex", flexDirection: "column", gap: 8 }}>
            {(
              [
                [1, "前へ"],
                [-1, "後ろへ"],
              ] as const
            ).map(([d, label]) => (
              <button
                key={d}
                style={{ minWidth: 76, minHeight: 52, fontWeight: 700 }}
                onPointerDown={() => api.current?.hold(d)}
                onPointerUp={() => api.current?.hold(0)}
                onPointerLeave={() => api.current?.hold(0)}
                onPointerCancel={() => api.current?.hold(0)}
                onContextMenu={(e) => e.preventDefault()}
              >
                {label}
              </button>
            ))}
            <span style={{ ...OVER, position: "static", fontSize: ".72rem" }}>ドラッグで見回す</span>
          </div>
        )}
        <div style={{ position: "absolute", left: 8, bottom: 6, fontSize: ".7rem", color: "#55584f", pointerEvents: "none" }}>
          {venue.attribution}
        </div>

        {listOpen && (
          <div style={{ ...SHEET, top: 8, bottom: "auto", maxHeight: "60%", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>印をつけたサークル</strong>
              <span style={{ display: "flex", gap: 6 }}>
                <button className="chip small" onClick={startPrint}>
                  配置図を印刷
                </button>
                <button className="chip small" onClick={() => setListOpen(false)}>
                  閉じる
                </button>
              </span>
            </div>
            {lists.want.length + lists.maybe.length === 0 && (
              <p style={{ color: "var(--muted)", margin: "8px 0 0" }}>机を押して「★ 行きたい」か「◆ 候補」をつけられます。この端末の中だけに保存します。</p>
            )}
            {MARKS.filter((m) => lists[m].length > 0).map((m) => (
              <section key={m} style={{ marginTop: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong style={{ color: hexCss(MARK[m].color) }}>
                    {MARK[m].icon} {MARK[m].label} {lists[m].length}
                  </strong>
                  <label style={{ fontSize: ".85rem", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" checked={pinsOn[m]} onChange={() => setPinsOn((p) => ({ ...p, [m]: !p[m] }))} />
                    ピンを立てる
                  </label>
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0" }}>
                  {lists[m].map((c) => {
                    const other: Mark = m === "want" ? "maybe" : "want";
                    return (
                      <li key={c} style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                        <button className="chip small" style={{ flex: 1, textAlign: "left" }} onClick={() => select(codeIndex.get(c)!)}>
                          {c}　{hallById.get(booths[codeIndex.get(c)!].hall)!.name}
                          {notes[c] && <span style={{ display: "block", color: "var(--muted)", fontSize: ".8rem", whiteSpace: "normal" }}>📝 {notes[c]}</span>}
                        </button>
                        <button className="chip small" onClick={() => toggleMark(c, other)}>
                          {MARK[other].icon} {MARK[other].label}へ
                        </button>
                        <button className="chip small" onClick={() => toggleMark(c, m)} aria-label={`${c} の印を外す`}>
                          外す
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {sel && selHall && (
          <div style={SHEET}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <strong style={{ fontSize: "1.25rem" }}>{sel.code}</strong>
              <span style={{ color: "var(--muted)" }}>
                {selHall.name}・{selHall.level}F
              </span>
            </div>
            <div style={{ fontSize: ".9rem", marginTop: 2 }}>
              {dayTags ? (
                <>
                  {dayTags[sel.code]?.genre ? `ジャンル：${dayTags[sel.code].genre}　／　` : ""}
                  作品{savedTags ? "" : "（見本）"}：{dayTags[sel.code]?.works?.join("・") ?? <span style={{ color: "var(--muted)" }}>まだ入っていません</span>}
                  {charsText(dayTags[sel.code]) ? `　／　キャラ：${charsText(dayTags[sel.code])}` : ""}
                </>
              ) : (
                <>作品（見本）：{lines[sel.line].genre}</>
              )}
              　／　サークル：<span style={{ color: "var(--muted)" }}>まだ登録されていません</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {MARKS.map((m) => (
                <button key={m} style={{ flex: 1, minHeight: 44, fontWeight: 700 }} aria-pressed={selMark === m} onClick={() => toggleMark(sel.code, m)}>
                  {MARK[m].icon} {MARK[m].label}
                  {selMark === m ? "（外す）" : ""}
                </button>
              ))}
              {view !== "walk" && (
                <button
                  style={{ minHeight: 44 }}
                  onClick={() => startWalkAt(selected!)}
                >
                  机の前に立つ
                </button>
              )}
              <button style={{ minHeight: 44 }} onClick={() => setSelected(null)} aria-label="閉じる">
                ✕
              </button>
            </div>
            {selMark && (
              <input
                type="text"
                aria-label="メモ（任意）"
                placeholder="メモ（任意）　例：新刊 2 冊・午前中に"
                maxLength={200}
                value={notes[sel.code] ?? ""}
                onChange={(e) => setNote(sel.code, e.target.value)}
                style={{ width: "100%", marginTop: 8, minHeight: 40, boxSizing: "border-box" }}
              />
            )}
          </div>
        )}
      </div>

      {/* サイドバー：モード・日・作品とキャラ・ホールへ移動・印の一覧と印刷・エディタ（階は右の切りかえで） */}
      {menu && <div className="side-scrim" onClick={() => setMenu(false)} />}
      <aside className={"side" + (menu ? " open" : "")} aria-hidden={!menu}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: "1.05rem" }}>即売会 3D マップ</strong>
          <span className="tag">{savedLines ? "編集した配置" : "見本"}</span>
          <button className="icon-btn small" style={{ marginLeft: "auto" }} aria-label="閉じる" onClick={() => setMenu(false)}>
            ✕
          </button>
        </div>
        <p style={{ color: "var(--muted)", fontSize: ".78rem", margin: "4px 0 10px" }}>
          コミックマーケット準備会・株式会社東京ビッグサイトとは関係のない非公式の試作です。島の配置・作品は仮です（C109 の本当の配置ではありません）
        </p>
        <h3>モード</h3>
        <div className="seg" role="group" aria-label="モード" style={{ display: "flex" }}>
          <button style={{ flex: 1 }} aria-pressed={mode === "register"} onClick={() => chooseMode("register")}>
            作品を登録
          </button>
          <button style={{ flex: 1 }} aria-pressed={mode === "plan"} onClick={() => chooseMode("plan")}>
            当日・計画
          </button>
        </div>
        <p style={{ color: "var(--muted)", fontSize: ".75rem", margin: "4px 0 0" }}>
          {mode === "register" ? "行きたい作品のスペースに印をつけるモード（最初は 2D）" : "当日に使う・回る順を考えるモード（最初は 3D）"}
        </p>
        {mode === "plan" && (
          <>
            <h3>配置番号</h3>
            {codePicker}
          </>
        )}
        <>
            <h3>日</h3>
            <div className="seg" role="group" aria-label="日" style={{ display: "flex" }}>
              {DAYS.map((d) => (
                <button key={d} style={{ flex: 1 }} aria-pressed={day === d} onClick={() => setDay(d)}>
                  {d}日目
                </button>
              ))}
            </div>
        </>
        <h3>ジャンル・作品</h3>
        {genreList.length > 0 && (
          <select
            aria-label="ジャンル"
            value={genre ?? ""}
            onChange={(e) => {
              setGenre(e.target.value || null);
              setWork(null);
              setChar(null);
              setByGenre(true);
            }}
            style={{ width: "100%", marginBottom: 6 }}
          >
            <option value="">ジャンル：すべて</option>
            {genreList.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="作品"
          value={!byGenre ? "__off" : (work ?? "__all")}
          onChange={(e) => {
            const v = e.target.value;
            setByGenre(v !== "__off");
            setWork(v === "__all" || v === "__off" ? null : v);
            setChar(null);
          }}
          style={{ width: "100%" }}
        >
          <option value="__all">{genre ? `${genre}の作品すべて` : "すべての作品（作品ごとに色分け）"}</option>
          <option value="__off">色分けしない</option>
          {workList.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        {work && charList.length > 0 && (
          <select aria-label="キャラ・グループ" value={char ?? ""} onChange={(e) => setChar(e.target.value || null)} style={{ width: "100%", marginTop: 6 }}>
            <option value="">キャラ・グループ：すべて</option>
            {charList.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        {byGenre && !work && (
          <div style={{ fontSize: ".75rem", display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {dayTags && !dayWorks.length && <span>{day}日目の作品はまだ入っていません</span>}
            {dayTags
              ? dayWorks.slice(0, 16).map((w) => (
                  <span key={w.work} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <i style={{ width: 10, height: 10, borderRadius: 2, background: workColor(w.work), display: "inline-block" }} />
                    {w.work}
                  </span>
                ))
              : SAMPLE_GENRES.map((g, i) => (
                  <span key={g} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <i style={{ width: 10, height: 10, borderRadius: 2, background: hexCss(GENRE_COLOR[i]), display: "inline-block" }} />
                    {g}
                  </span>
                ))}
          </div>
        )}
        <h3>ホールへ移動</h3>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {openHalls.map((h) => (
            <button
              key={h.id}
              className="chip small"
              onClick={() => {
                api.current?.focusHall(h.id);
                setMenu(false);
              }}
            >
              {h.name.replace("ホール", "")}
            </button>
          ))}
        </div>
        <h3>印</h3>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            className="chip"
            onClick={() => {
              setListOpen(true);
              setMenu(false);
            }}
          >
            ★ {lists.want.length}・◆ {lists.maybe.length} の一覧
          </button>
          <button className="chip" onClick={startPrint}>
            配置図を印刷
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
          <span style={{ fontSize: ".85rem", color: "var(--muted)" }}>地図にピン：</span>
          {MARKS.map((m) => (
            <button key={m} className="chip small" aria-pressed={pinsOn[m]} onClick={() => setPinsOn((p) => ({ ...p, [m]: !p[m] }))}>
              {MARK[m].icon} {MARK[m].label}
            </button>
          ))}
        </div>
        <h3>配置</h3>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <a className="chip" href="/editor" style={{ border: "1px solid var(--line)", textDecoration: "none", color: "var(--fg)" }}>
            島のエディタ
          </a>
          {savedLines && (
            <button
              className="chip"
              onClick={() => {
                clearLayout(LAYOUT_KEY);
                location.reload();
              }}
            >
              見本に戻す
            </button>
          )}
        </div>
        <button
          className="chip"
          style={{ marginTop: 12 }}
          onClick={() => {
            setMenu(false);
            setTour(true);
          }}
        >
          使い方を見る
        </button>
        <p style={{ color: "var(--muted)", fontSize: ".7rem", marginTop: 14 }}>{venue.attribution}</p>
      </aside>

      {/* 初めての人向けの使い方の案内（開いたときの「非公式」の案内を閉じてから） */}
      {!splash && tour && (
        <Tour
          steps={TOUR_STEPS}
          onStep={(st) => setMenu(!!st.menu)}
          onDone={() => {
            setMenu(false);
            endTour();
          }}
        />
      )}

      {/* 開いたときの案内：非公式であることを大きく。どこかを押すと消える */}
      {splash && (
        <div className="splash" role="dialog" aria-label="非公式の試作です" onPointerDown={() => setSplash(false)}>
          <div className="splash-card">
            <div style={{ fontSize: "1.6rem", fontWeight: 800 }}>非公式の試作です</div>
            <p>
              この地図は、コミックマーケット準備会・株式会社東京ビッグサイトとは<strong>関係のない</strong>、個人の非公式の試作です。
            </p>
            <p>
              会場の図は、株式会社東京ビッグサイトから図面の利用について了承を得て、それを参考に独自に描いたものです（同社の公認・監修ではありません）。
            </p>
            <p>島の配置・作品は仮です（C109 の本当の配置ではありません）。当日の出入口・動線は、運営の案内に従ってください。</p>
            <p style={{ color: "var(--muted)", fontSize: ".85rem", marginBottom: 0 }}>画面のどこかを押すと閉じます</p>
          </div>
        </div>
      )}
    </div>
    {print && (
      <div className="print-sheet">
        {print.sections.map((sec, i) => (
          <section key={sec.title} className="print-hall">
            {i === 0 && (
              <p className="print-note">
                配置図　{print.made} 作成。コミックマーケット準備会・株式会社東京ビッグサイトとは関係のない非公式の試作です。島の配置は見本で、C109 の本当の配置ではありません。○の文字が列の名前、島の端の数字がその列の端の机の番号。緑が出入口、灰が搬入口（シャッター）、青がトイレ、赤が救護室（図面を参考にした目安の位置で、数m ずれることがあります。当日の出入口は運営の案内に従ってください）。地図：
                {venue.attribution}
              </p>
            )}
            <h2>{sec.title}</h2>
            {/* eslint-disable-next-line @next/next/no-img-element -- その場で描いた絵（data URL）なので next/image は使わない */}
            <img src={sec.img} alt={`${sec.title}の配置図`} />
            {sec.codes.length > 0 && (
              <p className="print-marks">
                {sec.codes.map((c) => (
                  <span key={c.code} style={{ color: hexCss(MARK[c.mark].color) }}>
                    {MARK[c.mark].icon} {c.code}（{c.hall}）{c.note ? `　${c.note}` : ""}
                  </span>
                ))}
              </p>
            )}
          </section>
        ))}
      </div>
    )}
    </>
  );
}

const OVER: CSSProperties = { position: "absolute", background: "rgba(255,255,255,.88)", color: "#1d1d1b", borderRadius: 8, padding: "4px 8px" };
const SHEET: CSSProperties = {
  position: "absolute",
  left: 8,
  right: 8,
  bottom: 22,
  background: "var(--card)",
  color: "var(--fg)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  padding: "10px 12px",
  boxShadow: "0 4px 18px rgba(0,0,0,.18)",
};

// このアプリの小さなアイコン（自作の簡単な絵）
function Icon({ name }: { name: "menu" | "2d" | "3d" | "walk" | "city" }) {
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "menu":
      return (
        <svg {...common}>
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      );
    case "2d":
      // 真上から見た地図（格子の平面）
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="1.5" />
          <path d="M4 12h16M12 4v16" />
        </svg>
      );
    case "3d":
      // 斜めから見た箱
      return (
        <svg {...common}>
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
          <path d="M12 12l8-4.5M12 12L4 7.5M12 12v9" />
        </svg>
      );
    case "walk":
      // 歩く人
      return (
        <svg {...common}>
          <circle cx="13" cy="4.5" r="1.8" />
          <path d="M13 7.5l-2 5 3 3v5M11 12.5l-3 2M13 9l3 2.5M10.5 15.5l-2 5" />
        </svg>
      );
    case "city":
      // まわりの建物
      return (
        <svg {...common}>
          <path d="M3 21h18M5 21V10l4-2v13M9 21V5l6-2v18M15 21v-9l4 2v7" />
        </svg>
      );
  }
}
