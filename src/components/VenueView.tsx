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
import { DESK_D, DESK_L, expandBooths, islandEnds, lineLength, lineNums, SAMPLE_GENRES, wallLabelSpots, type Booth, type Line } from "@/lib/layout";

// 会場の 3D。見方は3つ：上から（2D の地図のように）・3D（ぐるっと回せる）・歩く（一人称）。
// ホールの位置関係は OSM の緯度経度のまま。机の配置は見本（C109 の本当の配置ではない）。
// 机は数が多いので InstancedMesh で描き、タップした机は instanceId から配置番号に戻す。

type Hall = { id: string; name: string; building: "東" | "西" | "南"; level: number; poly: XZ[]; closed?: string; rough?: boolean };
type Venue = {
  floorY: Record<string, number>;
  attribution: string;
  halls: Hall[];
  areas: { name: string; level: number; poly: XZ[]; see?: boolean; holes?: XZ[][]; under?: boolean }[];
  context: { name: string; height: number; poly: XZ[] }[];
  parts3d: { poly: XZ[]; min: number; max: number; color: string | null; name: string }[];
  surroundings: {
    lines: { pts: XZ[]; y: number; w: number; kind: "road" | "walk" | "steps" | "rail" }[];
    areas: { poly: XZ[]; y: number; kind: "walk" | "platform" }[];
    stations: { name: string; line: string; at: XZ; y: number }[];
  };
  toilets: { at: XZ; level: number | null; kinds?: string[] }[];
  firstAid: { at: XZ; level: number }[];
  doors: { at: XZ; level: number; kind: "出入口" | "搬入口"; hall: string }[];
  stairs?: { name: string; from: XZ; fromLevel: number; to: XZ; toLevel: number; width: number; kind?: "escalator" }[];
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
type Floor = 1 | 4;
const VIEWS: { id: View; label: string }[] = [
  { id: "top", label: "上から" },
  { id: "orbit", label: "3D" },
  { id: "walk", label: "歩く" },
];
const EYE = 1.6;
const WALK_SPEED = 6; // m/秒（見て回りやすいよう、歩く速さより速め）
const BUILDING_COLOR = { 東: 0xd6e4f7, 西: 0xd9efdd, 南: 0xf6e3cc };
const GENRE_COLOR = [0x2f6fd6, 0xd64545, 0x2f9e5b, 0xc2851b, 0x8a4fc7, 0x1b9aa8, 0xd4559a, 0x6b7a2a];
const DESK_COLOR = 0xf2f1ea;
// ホールの外の歩く所（通路・広場）の色。東展示棟からの連絡路（連絡ブリッジ・北コンコース）は、ほかの通路と分ける
const AREA_COLOR = 0xece3b6;
const LINK_COLOR = 0xf0b48a;
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
function loadPins(): Record<Mark, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null");
    if (saved && typeof saved === "object") return { want: !!saved.want, maybe: !!saved.maybe };
  } catch {}
  return { want: true, maybe: false };
}

const floorY = (level: number) => venue.floorY[String(level)] ?? 0;
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
function walls(poly: XZ[], y: number, height: number, mat: THREE.Material, doors: XZ[] = [], spans: [XZ, XZ][] = [], others: XZ[][] = []) {
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
    // この辺の近く（5m 以内）にある出入口を、辺の上の位置 u にして、戸口の範囲にする（重なれば1つに）
    const gaps: [number, number][] = [];
    for (const [dx, dz] of doors) {
      const u = (dx - ax) * c + (dz - az) * s, v = -(dx - ax) * s + (dz - az) * c;
      if (Math.abs(v) > 15 || u < 0 || u > len) continue; // 図面の「出入口」の文字は、壁から 5〜12m 離れて書かれていることが多い
      gaps.push([Math.max(0.3, u - DOOR_W / 2), Math.min(len - 0.3, u + DOOR_W / 2)]);
    }
    // 配置図の壁の切れ目：両端がこの辺の近く（5m 以内）にあれば、その間を開ける
    for (const [p, q] of spans) {
      const up = (p[0] - ax) * c + (p[1] - az) * s, vp = -(p[0] - ax) * s + (p[1] - az) * c;
      const uq = (q[0] - ax) * c + (q[1] - az) * s, vq = -(q[0] - ax) * s + (q[1] - az) * c;
      if (Math.abs(vp) > 5 || Math.abs(vq) > 5) continue;
      const g0 = Math.max(0.3, Math.min(up, uq)), g1 = Math.min(len - 0.3, Math.max(up, uq));
      if (g1 - g0 > 0.5) gaps.push([g0, g1]);
    }
    gaps.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const gp of gaps) {
      const last = merged[merged.length - 1];
      if (last && gp[0] <= last[1]) last[1] = Math.max(last[1], gp[1]);
      else merged.push([...gp]);
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
    for (const [g0, g1] of merged) {
      piece(ax, az, c, s, u, g0, 0, height);
      piece(ax, az, c, s, g0, g1, DOOR_H, height); // 戸口の上
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
  recolor: (colorByGenre: boolean, marks: Record<string, Mark>, selected: number | null, dayTags: Record<string, SpaceTag> | null) => void;
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
  const [view, setView] = useState<View>("top");
  const [floor, setFloor] = useState<Floor>(1);
  const [byGenre, setByGenre] = useState(true);
  const [day, setDay] = useState<Day>(1); // 何日目（作品・キャラは日ごと）
  const dayTags = useMemo(() => (savedTags ? (savedTags[day] ?? {}) : null), [day]);
  const dayWorks = useMemo(() => (savedTags ? worksOf(savedTags, day) : []), [day]);
  const [surround, setSurround] = useState(false); // 周辺の建物（会議棟の逆ピラミッドなど）も立体で出す
  // 印刷するときの中身（ホールごとの絵と一覧）。作ったら印刷の画面を開き、閉じたら消す
  const [print, setPrint] = useState<{ made: string; sections: { title: string; img: string; codes: { code: string; mark: Mark; hall: string }[] }[] } | null>(null);
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
      localStorage.setItem(PINS_KEY, JSON.stringify(pinsOn));
    } catch {}
  }, [pinsOn]);

  // ---- 3D の準備（1回だけ） ----
  useEffect(() => {
    const el = box.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
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

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshLambertMaterial({ color: 0xcfd6cf }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    scene.add(ground);
    for (const b of venue.context) scene.add(flatPoly(b.poly, 0xb9bfb8, -0.1));
    // 周辺の建物の立体（OSM の高さ。会議棟の逆ピラミッドは段ごとの部品を積んだもの）。「周辺も表示」のときだけ出す
    const surroundings = new THREE.Group();
    surroundings.visible = false;
    for (const b of venue.parts3d) {
      const g = new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: b.max - b.min, bevelEnabled: false });
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: b.color ? new THREE.Color(b.color) : new THREE.Color(0xd2d5cf) }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = b.min;
      surroundings.add(m);
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
    for (const a of sur.areas) surroundings.add(flatPoly(a.poly, a.kind === "platform" ? 0xd9cfb4 : SUR_COLOR.walk, a.y - (a.kind === "walk" ? 0.08 : 0)));
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

    for (const a of venue.areas) {
      const y = floorY(a.level);
      const link = LINK_AREAS.has(a.name) || a.see;
      const f = flatPoly(a.poly, link ? LINK_COLOR : AREA_COLOR, y + (a.under ? 0.01 : 0.02), a.see ? 0.8 : 1, a.holes ?? []);
      if (a.see) f.userData.see = 0.8; // 下（ガレリア）が少し透けて見える床
      scene.add(f);
      partsOf(a.level).floors.push(f);
      if (link) {
        // 連絡通路（東展示棟 2F・連絡ブリッジ・北コンコース）は、ふちを濃い線でなぞって、ひと続きの平面に見せる
        const edge = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(a.poly.map(([x, z]) => new THREE.Vector3(x, y + 0.08, z))),
          new THREE.LineBasicMaterial({ color: 0xb4501c }),
        );
        scene.add(edge);
        partsOf(a.level).solid.push(edge);
        // 吹き抜けのふちに手すり（高さ 1.1m の薄い板）
        for (const h of a.holes ?? []) {
          const rail = walls(h, y, 1.1, new THREE.MeshLambertMaterial({ color: 0xb4501c, transparent: true, opacity: 0.6 }));
          scene.add(rail);
          partsOf(a.level).solid.push(rail);
        }
      }
      if (a.under) continue;
      const label = textSprite(a.name, { fg: "#55584f", height: 3.2, px: 32 });
      const [cx, cz] = centroid(a.poly);
      label.position.set(cx, y + 3, cz);
      scene.add(label);
      partsOf(a.level).solid.push(label);
      addLabel(label, "area");
    }
    // 壁サークルが目の前に並んでいる出入口は、そのサークルが使っているので通れない（穴は開けるが、出入口の看板・札は出さない）。
    // 出入口の区間（a〜b）の前 3m 以内に、壁ぞいの列の机が区間にかかって並んでいれば「ふさがっている」
    const wallBooths = booths.filter((b) => lines[b.line].wall);
    const blocked = (hall: string, a: XZ, b: XZ) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
      return wallBooths.some((bt) => {
        if (bt.hall !== hall) return false;
        const u = (bt.at[0] - a[0]) * ux + (bt.at[1] - a[1]) * uz, v = -(bt.at[0] - a[0]) * uz + (bt.at[1] - a[1]) * ux;
        return Math.abs(v) < 3 && u > 0.3 && u < L - 0.3;
      });
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
    const openDoors = venue.doors.filter((d) => d.kind === "出入口" && !blocked(d.hall, ...doorSpan(d.hall, d.at, DOOR_W)));
    const openGaps = (features?.openings ?? []).filter((o) => !blocked(o.hall, o.a, o.b));
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
      );
      scene.add(w);
      occluders.push(w);
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
      const n = Math.max(3, Math.round((y1 - y0) / 0.2));
      const geo = new THREE.BoxGeometry(st.width, 1, run / n + 0.02);
      const esc = st.kind === "escalator";
      const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: esc ? 0x6f8fb3 : LINK_COLOR }), n);
      const t = new THREE.Object3D();
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n, top = y0 + ((y1 - y0) * (i + 1)) / n;
        t.position.set(st.to[0] + dx * f, (y0 + top) / 2, st.to[1] + dz * f);
        t.rotation.set(0, Math.atan2(dx, dz), 0);
        t.scale.set(1, top - y0, 1);
        t.updateMatrix();
        m.setMatrixAt(i, t.matrix);
      }
      m.computeBoundingSphere();
      scene.add(m);
      const label = textSprite(`⇅ ${st.name}`, { bg: esc ? "rgba(60,95,140,.92)" : "rgba(205,110,50,.92)", height: 2.6, px: 30 });
      label.position.set((st.from[0] + st.to[0]) / 2, (y0 + y1) / 2 + 3, (st.from[1] + st.to[1]) / 2);
      scene.add(label);
      addLabel(label, st.fromLevel === 2 && st.toLevel === 1 ? "block" : "door"); // ガレリアの階段・エスカレーターの札は、寄ったときだけ
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
    for (const t of venue.toilets) {
      const lv = t.level ?? 1;
      // 多機能トイレがあるときは「WC♿」
      const m = textSprite(t.kinds?.includes("多機能") ? "WC ♿" : "WC", { bg: "rgba(31,95,191,.9)", height: 3, px: 34 });
      m.position.set(t.at[0], floorY(lv) + 3, t.at[1]);
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
    const persp = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    let camera: THREE.Camera = ortho;
    let controls: OrbitControls | MapControls | null = null;
    let current: View = "top";
    let currentFloor: Floor = 1;
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
        const on = floorOf(lv) === currentFloor || (currentFloor === 1 && lv === 2 && !walk);
        for (const m of p.floors) {
          const mat = m.material as THREE.MeshLambertMaterial;
          const see = m.userData.see as number | undefined;
          mat.transparent = !on || see !== undefined;
          mat.opacity = on ? (see ?? 1) : 0.18;
          mat.depthWrite = on && see === undefined;
          m.visible = on || !walk;
        }
        // 札は、階で出すかどうかを覚えておき、毎フレームの大きさの計算と合わせて決める
        for (const o of p.solid) {
          if (o instanceof THREE.Sprite) o.userData.levelOn = on && !o.userData.hidden;
          else o.visible = on;
        }
      }
      for (const { mesh, level } of numMeshes) mesh.visible = current !== "top" && floorOf(level) === currentFloor;
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
      if (floorOf(lv) !== currentFloor) setFloor(floorOf(lv));
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
      if (floorOf(h.level) !== currentFloor) setFloor(floorOf(h.level));
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

    const recolor = (colorByGenre: boolean, marks: Record<string, Mark>, sel: number | null, dayTags: Record<string, SpaceTag> | null) => {
      const col = new THREE.Color();
      for (const { mesh, index } of deskMeshes.values()) {
        index.forEach((bi, k) => {
          const b = booths[bi];
          if (bi === sel) col.setHex(SELECT_COLOR);
          else if (marks[b.code]) col.setHex(MARK[marks[b.code]].color);
          else if (colorByGenre && dayTags) {
            // 入れた作品の色（作品が2つ以上なら1つ目の色。作品が入っていない机は白）
            const w = dayTags[b.code]?.works?.[0];
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
      const targets = [...deskMeshes.entries()].filter(([lv]) => floorOf(lv) === currentFloor).map(([, d]) => d.mesh);
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
        if (floorOf(lv) !== currentFloor) continue;
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
        s.visible = floorOf(level) === currentFloor;
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
      const h = near ? venue.halls.find((x) => floorOf(x.level) === currentFloor && pointInPolygon([focus.x, focus.z], x.poly)) : undefined;
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
    const drawCodes = () => {
      const w = el.clientWidth, h = el.clientHeight;
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
          if (floorOf(lv) !== currentFloor) continue;
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
          if (floorOf(hallById.get(l.hall)!.level) !== currentFloor) continue;
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
        if (floorOf(lv) !== currentFloor) continue;
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
      printRenderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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

    api.current = { setView, setFloor, recolor, setPins, focusBooth, standAt, focusHall, snapshot, hold: (d) => (hold = d), setSurround: (on) => {
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
  useEffect(() => {
    api.current?.setSurround(surround);
  }, [surround]);
  useEffect(() => api.current?.recolor(byGenre, marks, selected, dayTags), [byGenre, marks, selected, dayTags]);
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
  const toggleMark = (code: string, mark: Mark) =>
    setMarks((m) => {
      const n = { ...m };
      if (n[code] === mark) delete n[code];
      else n[code] = mark;
      return n;
    });
  const listOf = (mark: Mark) =>
    Object.keys(marks)
      .filter((c) => marks[c] === mark && codeIndex.has(c))
      .sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
  const lists = { want: listOf("want"), maybe: listOf("maybe") };
  const openHalls = venue.halls.filter((h) => !h.closed);

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
            .map(({ booth, mark }) => ({ code: booths[booth].code, mark, hall: hallById.get(booths[booth].hall)!.name }))
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
      <header style={{ padding: "8px 12px 6px", background: "var(--card)", borderBottom: "1px solid var(--line)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <strong style={{ fontSize: "1.05rem" }}>即売会 3D マップ</strong>
          <span className="tag">{savedLines ? "編集した配置" : "見本"}</span>
          {savedLines && (
            <button
              className="chip small"
              onClick={() => {
                clearLayout(LAYOUT_KEY);
                location.reload();
              }}
            >
              見本に戻す
            </button>
          )}
          <a className="chip small" href="/editor" style={{ border: "1px solid var(--line)", textDecoration: "none", color: "var(--fg)" }}>
            島のエディタ
          </a>
          <span style={{ color: "var(--muted)", fontSize: ".8rem" }}>
            コミックマーケット準備会・株式会社東京ビッグサイトとは関係のない非公式の試作です。島の配置・作品は仮です（C109 の本当の配置ではありません）
          </span>
        </div>
        {!online && (
          <div role="status" style={{ marginTop: 6, fontSize: ".85rem", background: "#3a3a37", color: "#fff", borderRadius: 6, padding: "3px 8px" }}>
            電波がありません。この端末に保存した地図と印を表示しています
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
          <div className="seg" role="group" aria-label="見方">
            {VIEWS.map((v) => (
              <button key={v.id} aria-pressed={view === v.id || (v.id === "walk" && walkPending)} onClick={() => chooseView(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
          {savedTags && (
            <div className="seg" role="group" aria-label="日">
              {DAYS.map((d) => (
                <button key={d} aria-pressed={day === d} onClick={() => setDay(d)}>
                  {d}日目
                </button>
              ))}
            </div>
          )}
          <div className="seg" role="group" aria-label="階">
            {([1, 4] as Floor[]).map((f) => (
              <button key={f} aria-pressed={floor === f} onClick={() => setFloor(f)}>
                {f}F
              </button>
            ))}
          </div>
          <button className="chip" aria-pressed={byGenre} onClick={() => setByGenre((x) => !x)}>
            作品で色分け
          </button>
          <button className="chip" aria-pressed={surround} onClick={() => setSurround((x) => !x)}>
            周辺も表示
          </button>
          <button className="chip" onClick={startPrint}>
            配置図を印刷
          </button>
          <button className="chip" onClick={() => setListOpen((x) => !x)}>
            ★ {lists.want.length}・◆ {lists.maybe.length} の一覧
          </button>
          <span style={{ fontSize: ".85rem", color: "var(--muted)" }}>ピン：</span>
          {MARKS.map((m) => (
            <button key={m} className="chip" aria-pressed={pinsOn[m]} onClick={() => setPinsOn((p) => ({ ...p, [m]: !p[m] }))}>
              {MARK[m].icon} {MARK[m].label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
          <select
            aria-label="列"
            value={pickLine ?? ""}
            onChange={(e) => jump(Number(e.target.value), lineNums(lines[Number(e.target.value)])[0] ?? 1, "a")}
            style={{ flex: 2, minWidth: 0 }}
          >
            <option value="" disabled>
              列を選ぶ
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
          <select
            aria-label="番号"
            value={pickNum}
            disabled={pickLine === null}
            onChange={(e) => jump(pickLine!, Number(e.target.value), pickHalf)}
            style={{ flex: 1, minWidth: 0 }}
          >
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
        <div style={{ display: "flex", gap: 4, marginTop: 6, overflowX: "auto", paddingBottom: 2 }}>
          {openHalls.map((h) => (
            <button key={h.id} className="chip small" onClick={() => api.current?.focusHall(h.id)}>
              {h.name.replace("ホール", "")}
            </button>
          ))}
        </div>
      </header>

      <div ref={box} style={{ position: "relative", flex: 1, minHeight: 0, touchAction: "none" }}>
        {byGenre && dayTags && (
          <div style={{ ...OVER, top: 8, left: 8, fontSize: ".75rem", display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 260 }}>
            {!dayWorks.length && <span>{day}日目の作品はまだ入っていません</span>}
            {dayWorks.slice(0, 12).map((w) => (
              <span key={w.work} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: workColor(w.work), display: "inline-block" }} />
                {w.work}
              </span>
            ))}
            {dayWorks.length > 12 && <span>ほか {dayWorks.length - 12}</span>}
          </div>
        )}
        {byGenre && !dayTags && (
          <div style={{ ...OVER, top: 8, left: 8, fontSize: ".75rem", display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 260 }}>
            {SAMPLE_GENRES.map((g, i) => (
              <span key={g} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: hexCss(GENRE_COLOR[i]), display: "inline-block" }} />
                {g}
              </span>
            ))}
          </div>
        )}
        {here && <div style={{ ...OVER, top: 8, right: 8, fontWeight: 700 }}>{here}</div>}
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
                  作品：{dayTags[sel.code]?.works?.join("・") ?? <span style={{ color: "var(--muted)" }}>まだ入っていません</span>}
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
          </div>
        )}
      </div>
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
                    {MARK[c.mark].icon} {c.code}（{c.hall}）
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
