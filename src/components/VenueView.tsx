"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import layoutJson from "@/data/layout-sample.json";
import venueJson from "@/data/venue.json";
import { centroid, minAreaRect, pointInPolygon, project, type XZ } from "@/lib/geo";
import { clearLayout, LAYOUT_KEY, loadLayout, loadLayoutFeatures } from "@/lib/saved-layout";
import { charsText, DAYS, loadTags, TAGS_KEY, workColor, worksOf, type Day, type SpaceTag } from "@/lib/tags";
import { sampleTags } from "@/lib/sample-tags";
import { fillSampleCircles, imgUrl } from "@/lib/sample-circles";
import Tour, { type TourStep } from "./Tour";
import { ZoomImg } from "./ZoomImg";
import { AccountBox } from "./AccountBox";
import { flatten, unflatten, useAccountSync } from "@/lib/sync";
import { DOOR_H, DOOR_W, edgeGaps, edgeShared, type WallOpening } from "@/lib/walls";
import { decodeChecklist, readChecklist, type Checklist } from "@/lib/checklist";
import { EVENT, dateLabel, dayStarted, todayJst } from "@/lib/event";
import { addCorridors, buildRails, moveOnRails, nearestOnRails, railPoint, type Corridors, type RailPos, type Rails } from "@/lib/rails";
import corridorsJson from "@/data/corridors.json";
import { search, type Hit } from "@/lib/search";
import { hallAt, makeSteady, type Where } from "@/lib/locate";
import { buildGrid, findPath, type Grid, type NavVenue } from "@/lib/nav";
import { planTour, stopDist, type Stop } from "@/lib/tour";
import { loadCircles, PUB_KEYS, refreshPublishedAndReload, type Circle } from "@/lib/published";
import { DESK_D, DESK_L, expandBooths, islandEnds, lineLength, lineNums, normCode, SAMPLE_GENRES, wallLabelSpots, type Booth, type Line } from "@/lib/layout";

// 会場の 3D。見方は3つ：上から（2D の地図のように）・3D（ぐるっと回せる）・歩く（一人称）。
// ホールの位置関係は OSM の緯度経度のまま。机の配置は見本（C109 の本当の配置ではない）。
// 机は数が多いので InstancedMesh で描き、タップした机は instanceId から配置番号に戻す。

type Hall = { id: string; name: string; building: "東" | "西" | "南"; level: number; poly: XZ[]; closed?: string; rough?: boolean; inner?: XZ[] };
type Venue = {
  origin: { lat: number; lon: number };
  floorY: Record<string, number>;
  attribution: string;
  halls: Hall[];
  areas: { name: string; level: number; poly: XZ[]; see?: boolean; holes?: XZ[][]; under?: boolean; outdoor?: boolean; part?: boolean; sur?: boolean }[]; // sur：会場の外（やぐら橋など）。「周辺も表示」のときだけ
  context: { name: string; height: number; poly: XZ[] }[];
  parts3d: { poly: XZ[]; min: number; max: number; color: string | null; name: string }[];
  surroundings: {
    // br：運河をわたる地面の高さの橋（fill：車線と歩道のあいだを埋める板）
    // ys：点ごとの高さ（掘割へ下りる首都高）
    lines: { pts: XZ[]; y: number; w: number; kind: "road" | "walk" | "steps" | "rail" | "deck"; br?: boolean; fill?: boolean; ys?: number[] }[];
    cuts?: XZ[][]; // 地面の板にあける穴（首都高の掘割）
    areas: { poly: XZ[]; y: number; kind: "walk" | "platform" | "water"; name?: string; labels?: XZ[]; holes?: XZ[][] }[];
    stations: { name: string; line: string; at: XZ; y: number }[];
    // 周辺をくわしく：建物（PLATEAU の形と計測高さ。kind "canopy" は屋根のある歩道などの屋根）、緑地と駐車場、木、横断歩道、
    // 駅の出入口、バス停、タクシー乗り場、歩行者デッキへ上る階段
    // station：高架の下の部分（body の高さまで）とホームの上の屋根。bridgeHouse：駅の出口の歩道橋の通路と建物（base より上だけ）。
    // tube：歩道橋から地上へ下りる屋根つきのエスカレーター（slope の上の端 y から下の端の地面へ傾く）
    buildings?: {
      poly: XZ[]; h: number; name?: string; kind?: "canopy" | "station" | "bridgeHouse" | "tube"; est?: string; body?: number; base?: number;
      slope?: { from: XZ; to: XZ; y: number };
    }[];
    greens?: { poly: XZ[]; kind: "grass" | "wood" | "pitch" | "parking" }[];
    trees?: XZ[];
    crossings?: XZ[][];
    entrances?: { at: XZ; name: string; line: string }[];
    busStops?: { at: XZ; name: string }[];
    taxis?: XZ[];
    // デッキと地上をむすぶ階段（esc：エスカレーター。y：上の端の高さ、ないときは 2F。tower：階段室の箱の中なので段は描かない）
    // pts：折り返す階段の道すじ（上の端から下の端へ）
    deckStairs?: { from: XZ; to: XZ; w?: number; esc?: boolean; y?: number; tower?: boolean; pts?: XZ[] }[];
    decks?: { poly: XZ[]; holes?: XZ[][] }[]; // 歩行者デッキの広場（2F の高さの面）
    deckRails?: XZ[][]; // 広場のふちの手すり（ほかのデッキや会場の床につながる所は除いてある）
  };
  toilets: { at: XZ; level: number | null; kinds?: string[]; outside?: boolean }[];
  toiletRooms?: { hall: string; level: number; poly: XZ[] }[];
  firstAid: { at: XZ; level: number }[];
  doors: { at: XZ; level: number; kind: "出入口" | "搬入口"; hall: string; width?: number; height?: number }[]; // width・height：開口の幅と高さ（図面のシャッターの大きさ。ないときは DOOR_W と、出入口は DOOR_H・搬入口はその 2 倍）
  exits?: { at: XZ; level: number; name: string; width: number }[]; // 屋内と屋外の境目の仕切りにあける出口
  stairs?: { name: string; from: XZ; fromLevel: number; to: XZ; toLevel: number; width: number; kind?: "escalator" | "ramp"; outdoor?: boolean; sur?: boolean }[];
  blocks?: { name: string; level: number; poly: XZ[]; height: number; kind?: "room"; base?: number }[];
  wallGaps?: { hall: string; a: XZ; b: XZ; full?: boolean; sign?: false }[]; // 配置図を読みこまなくても開けておく壁の切れ目（東1〜3 のトラックヤード側のつなぎ目・ガレリア側の区画のあいだ）。full：壁の高さいっぱい（看板なし）
  yardWalls?: XZ[][]; // 1F の、トラックヤードと屋内の床の境目の壁（東3 の端）。点を結んだ線
  canopies?: { level: number; pts: XZ[]; ys: number[]; w: number }[]; // 屋外の白い屋根（やぐら橋など）：中心の線、点ごとの屋根の下の高さ、幅 // kind "room"：ホールの外の部屋の帯の、来場者の入れない部屋（その階だけ・黒）
};
const venue = venueJson as unknown as Venue;
// 机の配置：島のエディタで「3D で確かめる」を押した配置が端末にあればそれ、なければ見本
// （この画面はブラウザでだけ描くので、読み込むときに端末の保存を読める）
const savedLines = loadLayout(LAYOUT_KEY);
// 作者が公開した配置（端末に取ってあるもの）。エディタの配置があればそちらが先
const pubLines = savedLines ? null : loadLayout(PUB_KEYS.layout);
const lines = savedLines ?? pubLines ?? (layoutJson as unknown as { lines: Line[] }).lines;
// 配置図から写した配置なら、柱と壁の切れ目（出入口・開いているシャッター）もある
const features = savedLines ? loadLayoutFeatures(LAYOUT_KEY) : pubLines ? loadLayoutFeatures(PUB_KEYS.layout) : null;
// 作品・キャラ（島のエディタで入れたもの）。なければ見本の作品で色分けする
// サークル本人が登録して、作者が公開したもの（日 → 配置番号 → サークル）
const circles = loadCircles();
const savedTags = (() => {
  const t = loadTags(TAGS_KEY) ?? loadTags(PUB_KEYS.tags);
  // 作品・キャラが入っていない机は、サークル本人の登録の作品を使う
  let out = t;
  for (const d of DAYS)
    for (const [code, c] of Object.entries(circles[d])) {
      if (!c.works.length) continue;
      out ??= {};
      out[d] ??= {};
      if (!out[d][code]?.works?.length) out[d][code] = { ...out[d][code], works: c.works, ...(Object.keys(c.chars).length ? { chars: c.chars } : {}) };
    }
  return out;
})();
// 本当の配置・作品（公開されたもの）があるか。ないときは見本（架空の作品）
const realData = !!(pubLines || savedLines);
// 見本の配置のときは、見本のサークル情報（架空のサークル名とカット）も入れる（公開されたサークル情報があればそちら）
if (!realData && DAYS.every((d) => !Object.keys(circles[d]).length)) fillSampleCircles(circles, expandBooths(lines, venue.halls));
const hallById = new Map(venue.halls.map((h) => [h.id, h]));

type View = "top" | "orbit" | "walk";
type Mode = "register" | "plan";
type Floor = 1 | 4;
// 目の高さと歩く速さ。1.6m・広い画角・6m/秒では、自分が大きく感じた（ユーザーの指摘。目を下げて画角をせまく）
const EYE = 1.35;
// 歩くときの画角（縦）。せまくして前のものを大きく写す（ユーザーの指示：目の高さを下げて、画角をせまく）
const WALK_FOV = 50;
// スマホの縦長の画面では、横に見える幅がせまいので、もう少し引いて（画角を広く）見せる（ユーザーの指示）
const WALK_FOV_PORTRAIT = 68;
const walkFov = (aspect: number) => (aspect < 1 ? WALK_FOV_PORTRAIT : WALK_FOV);
// 歩くときの上下の向きは決めておく（ドラッグで上下にも動くと歩きにくい。ユーザーの指摘）。机が見やすいよう、少しだけ下向き
const WALK_PITCH = -0.1;
const WALK_SPEED = 3.5; // m/秒（見て回りやすいよう、ふつうに歩く速さより少し速め）
// 歩いて見るとき、近くの机の上に出すサークルの札（画像とサークル名）。この距離までで、画面の上で重なる札は出さない
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
// 2D（真上から）の画面の上の向き（会場の x・z）。机の列が画面の上下と平行になるように（ユーザーの指示）。
// 会場の机の列は、格子の u の向き（x 軸から 56.5°）か、それと直角（146.5°）のどちらか。ホールによって違い、配置によっても違う
// （見本の配置は東1・東3・東7 が直角の向き、C109 の配置は南だけが直角の向き）ので、読みこんだ配置で机の多いほうの向きを
// 画面の上下にする（もう一方の向きの列は画面の横）。上は、北がなるべく上になる側
const TOP_UP: XZ = (() => {
  const U: XZ = [0.5518669, 0.8339322], V: XZ = [-0.8339322, 0.5518669];
  let nu = 0, nv = 0;
  for (const l of lines) {
    const n = l.desks?.length ?? l.segments.reduce((a, b) => a + b, 0);
    const c = Math.abs(Math.cos(l.angle) * U[0] + Math.sin(l.angle) * U[1]); // 列の向きと u の向きのなす角の cos
    if (c >= Math.SQRT1_2) nu += n;
    else nv += n;
  }
  const d = nu >= nv ? U : V;
  return d[1] > 0 ? [-d[0], -d[1]] : d;
})();
const TOP_RIGHT: XZ = [-TOP_UP[1], TOP_UP[0]]; // 画面の右の向き
const NORTH_DEG = (Math.atan2(-TOP_RIGHT[1], -TOP_UP[1]) * 180) / Math.PI; // 2D の画面の上で、北が上から右回りに何度か
const SELECT_COLOR = 0xffb000;
const WALL_H = 12; // ホールの壁の高さ（見やすさの目安。7.5m の 1.6 倍）

// 机につける印。「行きたい」は必ず行く所、「候補」は迷っている所。1つの机にはどちらか1つ
type Mark = "want" | "maybe";
const MARKS: Mark[] = ["want", "maybe"];
const MARK: Record<Mark, { label: string; icon: string; color: number }> = {
  want: { label: "行きたい", icon: "★", color: 0xff2d87 },
  maybe: { label: "候補", icon: "◆", color: 0x0a84ff },
};
// 印とメモは日ごと（同じ配置番号でも日が違えば別のサークル）。日 → 配置番号 → 印・メモ
const MARKS_KEY = "comiket3d:marks-by-day";
const NOTES_KEY = "comiket3d:notes-by-day";
const OLD_MARKS_KEY = "comiket3d:marks"; // 日を分けていなかったころの保存（読んだら 1 日目へ移す）
const OLD_NOTES_KEY = "comiket3d:notes";
// 当日・計画のモードでつける「行った」（日 → 配置番号 → つけた時刻）。行った机とピンは灰色にする
const VISITED_KEY = "comiket3d:visited-by-day";
// 机ごとに使うつもりの金額（円。日 → 配置番号 → 金額）。一覧で日ごとの合計を出す
const BUDGET_KEY = "comiket3d:budget-by-day";
const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const VISITED_COLOR = 0x8e8e93;
const OLD_WISH_KEY = "comiket3d:wish"; // 「行きたい」だけだったころの保存
const PINS_KEY = "comiket3d:pins";
const TOUR_KEY = "comiket3d:tour"; // 使い方の案内を見終えたか

// 初めて開いた人向けの使い方の案内（Tour.tsx）。target は画面の部品（ないときは真ん中に吹き出しだけ）。
// menu：その段でサイドバーを開く。mode：その段のモード（途中で「作品を登録」に切りかえて説明し、「当日・計画」に戻す。
// 書いていない段は案内を始めたときのモード。案内を閉じたら、始めたときのモードに戻す）
const PICK = '[data-tour="picker"]';
// 短く 5 段だけ（長すぎる・文が長すぎる、というユーザーの指摘）
const TOUR_STEPS: TourStep[] = [
  { title: "ようこそ", text: "会場を立体で見られる地図です。ずらして移動、つまんで（ホイールで）拡大します。" },
  { target: PICK, title: "机を探す", text: "配置番号を選ぶか、左の虫めがねで名前から探せます。" },
  { title: "印とメモ", text: "机を押すと「★ 行きたい」「◆ 候補」の印とメモをつけられます。" },
  { target: '[aria-label="場所を指して歩く"]', title: "歩いて見る", text: "押してから地図の場所を選ぶと、通路の青い線の上を歩けます。" },
  { target: '[aria-label="メニュー"]', title: "メニュー", text: "日の切りかえ、ジャンル、印の一覧・印刷、ログインはここです。" },
];

// 端末の保存を読む。読めないとき（プライベートモードなど）は空から
type ByDay<T> = Record<Day, Record<string, T>>;
const emptyByDay = <T,>(): ByDay<T> => ({ 1: {}, 2: {}, 3: {} });
function readByDay<T>(key: string, oldDay1: () => Record<string, T>): ByDay<T> {
  const out = emptyByDay<T>();
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (saved && typeof saved === "object") {
      for (const d of DAYS) if (saved[d] && typeof saved[d] === "object") out[d] = saved[d];
      return out;
    }
    // 日を分けていなかったころの印・メモは、何日目のつもりか分からないので 1 日目へ（ユーザーの確認）
    out[1] = oldDay1();
  } catch {}
  return out;
}
function loadMarks(): ByDay<Mark> {
  return readByDay<Mark>(MARKS_KEY, () => {
    const saved = JSON.parse(localStorage.getItem(OLD_MARKS_KEY) ?? "null");
    if (saved && typeof saved === "object") return saved;
    const old = JSON.parse(localStorage.getItem(OLD_WISH_KEY) ?? "[]");
    return Object.fromEntries((Array.isArray(old) ? old : []).map((c: string) => [c, "want" as Mark]));
  });
}
function loadBudgets(): ByDay<number> {
  return readByDay<number>(BUDGET_KEY, () => ({}));
}
function loadVisited(): ByDay<number> {
  return readByDay<number>(VISITED_KEY, () => ({}));
}
function loadNotes(): ByDay<string> {
  return readByDay<string>(NOTES_KEY, () => {
    const saved = JSON.parse(localStorage.getItem(OLD_NOTES_KEY) ?? "null");
    return saved && typeof saved === "object" ? saved : {};
  });
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

// 床の厚み：平らな床のすぐ下に、床の色を少し暗くした板（ユーザーの指示「すべての床を少し厚みつけて」）。
// 2F・4F の床は 0.6m、1F の床は地面（-0.2m）まで届く 0.25m。上の面は床より少し下にして、床の色とちらつかないように
function slabUnder(poly: XZ[], color: number, y: number, level: number, holes: XZ[][] = []) {
  const t = level > 1 ? 0.6 : 0.25;
  const m = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shapeOf(poly, holes), { depth: t, bevelEnabled: false }),
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.8) }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = y - t - 0.005;
  return m;
}

// 道・線路の帯（線の両側に幅 w/2 ずつ）。種類ごとに1つの形にまとめて描く。skirt があれば、帯のふちから下へ厚みもつける（高架）
// ys があれば点ごとの高さ（坂）
function ribbons(list: { pts: XZ[]; y: number; w: number; ys?: number[] }[], skirt = 0) {
  const pos: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (const { pts, y, w, ys } of list) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const ya = ys?.[i] ?? y, yb = ys?.[i + 1] ?? y;
      const nx = (-(bz - az) / len) * (w / 2), nz = ((bx - ax) / len) * (w / 2);
      const l0 = [ax + nx, ya, az + nz], r0 = [ax - nx, ya, az - nz], l1 = [bx + nx, yb, bz + nz], r1 = [bx - nx, yb, bz - nz];
      quad(l0, l1, r1, r0);
      if (skirt > 0) {
        quad([l0[0], ya - skirt, l0[2]], [l1[0], yb - skirt, l1[2]], l1, l0);
        quad(r0, r1, [r1[0], yb - skirt, r1[2]], [r0[0], ya - skirt, r0[2]]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ホールの壁。doors（出入口の位置と幅）に近い辺は、そこに幅 DOOR_W（幅があればその幅）・高さ DOOR_H の戸口を開け、上は梁（はり）で残す。
// 扉より広い開口（ホールとリンクスペースのあいだのシャッターなど）は、シャッターと同じ高さ
// others：同じ階のほかのホールの形。となりのホールと重なる辺（東1〜3 の境など）は、つながっているので壁を描かない
type Opening = WallOpening;
function walls(poly: XZ[], y: number, height0: number, mat: THREE.Material, doors: Opening[] = [], spans: [XZ, XZ, number?][] = [], others: XZ[][] = [], edgeHeight?: (i: number) => number, shutters: Opening[] = []) {
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
    // 出入口・搬入口・配置図の切れ目の穴（[始め, 終わり, 戸口の高さ]）と、となりのホールと重なる所（上まで開ける）。歩く線と同じ計算（lib/walls.ts）
    const merged = edgeGaps(poly[i], poly[(i + 1) % poly.length], doors, spans, shutters);
    open = edgeShared(poly[i], poly[(i + 1) % poly.length], others);
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
  redrawCards: () => void;
  showRailsPick: (on: boolean) => void; // 歩き始める場所を選ぶあいだ、線路を出す
  showMe: (p: XZ | null, acc: number, fly: boolean) => void; // いまいる所の青い点（null で消す）
  showRoute: (pts: XZ[] | null, level: number) => void; // トイレ・救護室までの道（null で消す）
  showTour: (parts: { pts: XZ[]; level: number }[] | null) => void; // 回る順の道（null で消す）
  walkPos: () => XZ | null; // 歩いているときの、いまの位置
  recolor: (colorByGenre: boolean, marks: Record<string, Mark>, visited: Record<string, number>, selected: number | null, dayTags: Record<string, SpaceTag> | null, genre: string | null, work: string | null, char: string | null) => void;
  setPins: (list: { booth: number; mark: Mark | null; done: boolean; order?: number }[]) => void;
  focusBooth: (i: number) => void;
  focusLine: (line: number) => void;
  standAt: (x: number, z: number) => void; // 歩く：その場所に立つ（いま見ている向きのまま）
  focusHall: (id: string) => void;
  hold: (dir: -1 | 0 | 1) => void;
  setSurround: (on: boolean) => void;
  snapshot: (hallIds: string[], marked: { booth: number; mark: Mark }[]) => string;
};

// 選んだ机の、サークル本人が登録した情報（作者が公開したもの）
// ホールぜんぶを囲む四角（会場にいるかどうかを見る）
const VENUE_BOX = (() => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const h of venue.halls)
    for (const [x, z] of h.poly) {
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], z);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], z);
    }
  return b;
})();

// 机を選んだときの下の欄の、サークルの情報。onOpen：画像を全画面で見る（「画像を見る」・小さい画像を押したとき）
function CircleCard({ c, onOpen }: { c: Circle; onOpen: () => void }) {
  const count = c.images.length || (c.image ? 1 : 0);
  return (
    <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center" }}>
      {c.image && (
        <button onClick={onOpen} aria-label="画像を全画面で見る" style={{ padding: 0, border: 0, background: "none", flex: "none", cursor: "zoom-in", lineHeight: 0 }}>
          {/* 64px で出すので、小さい画像（160px）を使う（なければ大きい画像）。大きい画像は、全画面で見るときだけ読む */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imgUrl(c.thumb || c.image)} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, background: "#eee" }} />
        </button>
      )}
      <div style={{ minWidth: 0, fontSize: ".9rem" }}>
        <div style={{ fontWeight: 700 }}>{c.name}</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {c.x && (
            <a href={`https://x.com/${c.x}`} target="_blank" rel="noopener noreferrer">
              @{c.x}
            </a>
          )}
          {c.url && (
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              お品書き・サイト
            </a>
          )}
        </div>
      </div>
      {count > 0 && (
        <button className="chip" style={{ marginLeft: "auto", flex: "none", minHeight: 40 }} onClick={onOpen}>
          画像を見る{count > 1 ? `（${count} 枚）` : ""}
        </button>
      )}
    </div>
  );
}

export function VenueView() {
  const box = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  // 歩いて見るときの札の中身（机の配置番号 → サークル名・画像、なければ作品名）。日を変えたら入れかえる
  const cardInfo = useRef<(code: string) => { name: string; image: string; sub: string } | null>(() => null);
  // 印をつけたサークルの画像（端末に持つ分。電波がなくても、歩くときの札に出せる）
  const markedImgs = useRef<Set<string>>(new Set());
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
  // 2 つのモード：作品を登録する（最初は 2D）と、当日に使う・計画する（最初は 3D）。配置番号の欄はどちらでも地図の上に出す。
  // 開いたときはいつも「当日・計画」（ユーザーの確認）
  const [mode, setMode] = useState<Mode>("plan");
  const [menu, setMenu] = useState(false); // サイドバー
  const [splash, setSplash] = useState(true); // 開いたときの「非公式」の案内
  const [day, setDay] = useState<Day>(1); // 何日目（作品・キャラは日ごと）
  // 机の情報（ジャンル・作品・キャラ）：エディタで入れたもの。なければ公開版の見本（架空の作品）
  const tags = useMemo(() => savedTags ?? sampleTags(booths), [booths]);
  const dayTags: Record<string, SpaceTag> | null = useMemo(() => tags[day] ?? {}, [tags, day]);
  const dayWorks = useMemo(() => worksOf(tags, day), [tags, day]);
  const [surround, setSurround] = useState(true); // 周辺の建物も立体で出す（開いた最初は出す）
  // 印刷するときの中身（ホールごとの絵と一覧）。作ったら印刷の画面を開き、閉じたら消す
  const [print, setPrint] = useState<{ made: string; day: Day; total: number; sections: { title: string; img: string; codes: { code: string; mark: Mark | null; hall: string; note: string; budget: number }[] }[] } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // サークルの画像を全画面で見る（ユーザーの指示：机を押しただけでは出さず、下の欄の「画像を見る」を押したとき。
  // 全体を暗くして、画像をぽんと出す）。画像が何枚かあれば（3 枚まで）、1 枚目から順に見られる
  const [popImg, setPopImg] = useState<{ images: string[]; i: number; name: string } | null>(null);
  const openImages = (c: Circle) => {
    const list = c.images.length ? c.images : c.image ? [c.image] : [];
    if (list.length) setPopImg({ images: list.map(imgUrl), i: 0, name: c.name });
  };
  // 全画面のあいだ：Esc で閉じる・← → で前・次
  useEffect(() => {
    if (!popImg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopImg(null);
      else if (e.key === "ArrowLeft") setPopImg((p) => (p && p.i > 0 ? { ...p, i: p.i - 1 } : p));
      else if (e.key === "ArrowRight") setPopImg((p) => (p && p.i < p.images.length - 1 ? { ...p, i: p.i + 1 } : p));
      else return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [popImg]);
  // 「歩く」は、立つ机を選んでから始める（選ぶまでは、いまの見方のまま案内を出す）
  const [walkPending, setWalkPending] = useState(false);
  // 歩き始める場所を選ぶあいだは、上から・3D の地図に線路（青い線）を出す（ユーザーの指示）
  useEffect(() => api.current?.showRailsPick(walkPending), [walkPending]);
  // 「歩く」を待っている間は、地図を押した所にピンを立てて、そこから歩き始める（机の上でなくてよい）
  const standPick = useRef<((x: number, z: number) => void) | null>(null);
  const startWalkAt = useCallback((i: number) => {
    standPick.current = null;
    setWalkPending(false);
    setView("walk");
    requestAnimationFrame(() => api.current?.focusBooth(i));
  }, []);
  // 開発中だけ：画面を確かめるために、配置番号の机の前に立つ
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __walkTo?: (code: string) => void }).__walkTo = (code) => {
      setSplash(false);
      setTour(false);
      const i = booths.findIndex((b) => b.code === code);
      if (i >= 0) startWalkAt(i);
    };
  });
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
  const [pickNum, setPickNum] = useState<number | null>(null);
  const [pickHalf, setPickHalf] = useState<"a" | "b">("a");
  // この画面はブラウザでだけ描く（page.tsx で ssr: false）ので、最初から端末の保存を読める
  // 印とメモは日ごとに持ち、地図・一覧・印刷にはいま選んでいる日のものだけを出す
  const [marksByDay, setMarksByDay] = useState<ByDay<Mark>>(loadMarks);
  const [pinsOn, setPinsOn] = useState<Record<Mark, boolean>>(loadPins);
  const [notesByDay, setNotesByDay] = useState<ByDay<string>>(loadNotes);
  const [visitedByDay, setVisitedByDay] = useState<ByDay<number>>(loadVisited);
  const [budgetsByDay, setBudgetsByDay] = useState<ByDay<number>>(loadBudgets);
  // ログインしているときは、ほかの端末と合わせる（サーバーの方が新しい所は、端末の保存を入れかえる）
  const syncFlat = useMemo(() => flatten(marksByDay, notesByDay, visitedByDay, budgetsByDay), [marksByDay, notesByDay, visitedByDay, budgetsByDay]);
  useAccountSync(syncFlat, (f) => {
    const u = unflatten(f);
    setMarksByDay(u.marks);
    setNotesByDay(u.notes);
    setVisitedByDay(u.visited);
    setBudgetsByDay(u.budgets);
  });
  const marks = marksByDay[day];
  // 印（どの日の分も）をつけたサークルの画像だけを、サービスワーカーに持ってもらう。ほかの画像は端末に残さない
  useEffect(() => {
    const urls = new Set<string>();
    for (const d of DAYS)
      for (const code of Object.keys(marksByDay[d] ?? {})) {
        const c = circles[d][code];
        for (const u of [c?.thumb, c?.image, ...(c?.images ?? [])]) if (u) urls.add(u);
      }
    markedImgs.current = urls; // 見本の画像（sample:）は端末で作るので、通信なしで出せる
    if (!("serviceWorker" in navigator)) return;
    const keep = [...urls].filter((u) => u.startsWith("/data/circles/"));
    navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: "keep-images", urls: keep })).catch(() => {});
  }, [marksByDay]);
  const notes = notesByDay[day];
  // 「行った」にできるのは、★ 行きたい・◆ 候補の印がある机だけ（ユーザーの指示）。印を外した机の「行った」は出さない
  // （保存はそのまま残すので、同じ日にまた印をつけると戻る）
  // 「✓ 行った」は、その日の当日になってから出す（ユーザーの指示）。開いたまま日をまたいでも出るように、1 分ごとに日付を見なおす
  const [today, setToday] = useState("");
  useEffect(() => {
    const tick = () => setToday(todayJst());
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);
  const canVisit = today !== "" && dayStarted(day, today);
  const visitedAll = visitedByDay[day];
  // 当日より前は「行った」を使わない（前に試した・ほかの端末から来た「行った」で、机が灰色のまま取り消せなくならないように。保存は残す）
  const visited = useMemo(() => (canVisit ? Object.fromEntries(Object.entries(visitedAll).filter(([c]) => marks[c])) : {}), [visitedAll, marks, canVisit]);
  const toggleVisited = (code: string) => {
    if (!marks[code] || !canVisit) return;
    setVisitedByDay((all) => {
      const n = { ...all[day] };
      if (n[code]) delete n[code];
      else n[code] = Date.now();
      return { ...all, [day]: n };
    });
  };
  const setMarks = (f: (m: Record<string, Mark>) => Record<string, Mark>) => setMarksByDay((all) => ({ ...all, [day]: f(all[day]) }));
  const setNotes = (f: (n: Record<string, string>) => Record<string, string>) => setNotesByDay((all) => ({ ...all, [day]: f(all[day]) }));
  // コミケ Web カタログのチェックリスト（CSV）を読みこむ：読んだ中身と、チェックの色ごとにつける印
  const [imp, setImp] = useState<{ file: string; list: Checklist; colorMark: Record<number, Mark | "">; memo: boolean; done?: string } | null>(null);
  const openChecklist = async (f: File) => {
    try {
      const list = readChecklist(decodeChecklist(await f.arrayBuffer()), EVENT.weekdays);
      if (!list.circles.length) throw new Error("サークルが入っていません");
      // いちばん小さい番号の色を ★ 行きたい、ほかを ◆ 候補に（あとで選びなおせる）
      const colors = [...new Set(list.circles.map((c) => c.color))].sort((a, b) => a - b);
      setImp({ file: f.name, list, colorMark: Object.fromEntries(colors.map((c, i) => [c, i === 0 ? "want" : "maybe"])), memo: true });
    } catch (e) {
      setImp({ file: f.name, list: { event: "", colors: {}, circles: [], skipped: 0 }, colorMark: {}, memo: false, done: `読めませんでした（${e instanceof Error ? e.message : "形がちがいます"}）。コミケ Web カタログの「チェックリストのエクスポート」で書き出した CSV を選んでください` });
    }
  };
  const applyChecklist = () => {
    if (!imp) return;
    let added = 0,
      kept = 0,
      memos = 0;
    const nextMarks = { 1: { ...marksByDay[1] }, 2: { ...marksByDay[2] }, 3: { ...marksByDay[3] } } as ByDay<Mark>;
    const nextNotes = { 1: { ...notesByDay[1] }, 2: { ...notesByDay[2] }, 3: { ...notesByDay[3] } } as ByDay<string>;
    for (const c of imp.list.circles) {
      const m = imp.colorMark[c.color];
      if (!c.day || !codeIndex.has(c.code)) continue;
      if (m) {
        // すでに印のある机は、そのまま（この地図でつけた印を消さない）
        if (nextMarks[c.day][c.code]) kept++;
        else {
          nextMarks[c.day][c.code] = m;
          added++;
        }
      }
      // メモは、入れる色の行だけ（「入れない」にした色のメモは入れない）
      if (m && imp.memo && c.memo && !nextNotes[c.day][c.code]) {
        nextNotes[c.day][c.code] = c.memo.replace(/\s+/g, " ").slice(0, 200);
        memos++;
      }
    }
    setMarksByDay(nextMarks);
    setNotesByDay(nextNotes);
    setImp({ ...imp, done: `${added} 件に印をつけました${kept ? `（${kept} 件は前から印があったので、そのまま）` : ""}${memos ? `。メモを ${memos} 件入れました` : ""}。` });
  };
  const budgets = budgetsByDay[day];
  const setBudget = (code: string, n: number) =>
    setBudgetsByDay((all) => {
      const m = { ...all[day] };
      if (n > 0) m[code] = n;
      else delete m[code];
      return { ...all, [day]: m };
    });
  const [tour, setTour] = useState(() => !tourDone()); // 使い方の案内（初めての人だけ。開いたときの案内を閉じてから）
  const tourFrom = useRef<Mode>("plan"); // 案内を始めたときのモード（閉じたら戻す）
  const endTour = () => {
    setTour(false);
    try {
      localStorage.setItem(TOUR_KEY, "done");
    } catch {}
  };
  const [listOpen, setListOpen] = useState(false);
  // いまどのホールにいるか（D-2）。押したときだけ位置を使う（端末の外へは送らない）
  const [locOn, setLocOn] = useState(false);
  const [loc, setLoc] = useState<{ where: Where; acc: number } | null>(null);
  const [locErr, setLocErr] = useState("");
  const floorRef = useRef<{ floor: Floor; both: boolean }>({ floor: 1, both: false });
  // トイレ・救護室までの道（D-3）。いまいる所（位置）・歩いている所・選んだ机のどれかから
  const [route, setRoute] = useState<{ to: "toilet" | "aid"; length: number; from: string } | { error: string } | null>(null);
  const [routeMenu, setRouteMenu] = useState(false);
  // 机も選んでいない・位置も使えないときに押した：次に押した机から、その道を出す（ユーザーの指示）
  const [routeWait, setRouteWait] = useState<"toilet" | "aid" | null>(null);
  const navGrids = useRef(new Map<number, Grid>());
  const lastMe = useRef<XZ | null>(null);
  // 会場にいる（「現在地」をオンにしていて、どこかのホールから 300m 以内）。会場では、歩くときの札の画像を読まない
  // （ユーザーの指示：目の前に本物の机があるので要らない。混んだ電波も使わない）。印のサークルの画像は端末にあるので出す
  const atVenue = useRef(false);
  // at：この机から（待っているあいだに押した机）
  const findRoute = (to: "toilet" | "aid", at?: number) => {
    setRouteMenu(false);
    let from: XZ | null = null, level = 1, fromName = "";
    const walkAt = api.current?.walkPos() ?? null;
    if (at !== undefined) {
      from = booths[at].at;
      level = hallById.get(booths[at].hall)!.level;
      fromName = booths[at].code;
    } else if (locOn && lastMe.current && loc?.where.hall) {
      from = lastMe.current;
      level = loc.where.hall.level; // いまいる（近い）ホールの階
      fromName = "いまいる所";
    } else if (walkAt) {
      from = walkAt;
      level = floor === 4 ? 4 : 1;
      fromName = "歩いている所";
    } else if (selected !== null) {
      const b = booths[selected];
      from = b.at;
      level = hallById.get(b.hall)!.level;
      fromName = b.code;
    }
    if (!from) {
      setRouteWait(to);
      setRoute({ error: `いまいる所の近くの机を押してください。そこから${to === "toilet" ? "いちばん近いトイレ" : "救護室"}までの道を出します` });
      return;
    }
    setRouteWait(null);
    if (!navGrids.current.has(level))
      navGrids.current.set(
        level,
        buildGrid(venue as unknown as NavVenue, level, booths.filter((b) => hallById.get(b.hall)!.level === level).map((b) => b.at)),
      );
    const goals = to === "toilet" ? venue.toilets.filter((t) => (t.level ?? 1) === level).map((t) => t.at) : venue.firstAid.filter((a) => a.level === level).map((a) => a.at);
    const r = goals.length ? findPath(navGrids.current.get(level)!, from, goals) : null;
    if (!r) {
      api.current?.showRoute(null, level);
      setRoute({ error: to === "toilet" ? "この階では、トイレまでの道が見つかりませんでした" : "この階では、救護室までの道が見つかりませんでした（救護室は南展示棟の 1F と 4F）" });
      return;
    }
    if (floor !== (level >= 4 ? 4 : 1) && !both) setFloor(level >= 4 ? 4 : 1);
    api.current?.showRoute(r.path, level);
    setRoute({ to, length: r.length, from: fromName });
  };
  const clearRoute = () => {
    api.current?.showRoute(null, 1);
    setRoute(null);
    setRouteWait(null);
  };
  // 待っているあいだに机を押した（検索で選んだときも）：その机から道を出す
  const onSelectBooth = useRef<(i: number) => void>(() => {});
  useEffect(() => {
    onSelectBooth.current = (i) => {
      if (routeWait) findRoute(routeWait, i);
    };
  });
  const navGrid = (level: number) => {
    if (!navGrids.current.has(level))
      navGrids.current.set(level, buildGrid(venue as unknown as NavVenue, level, booths.filter((b) => hallById.get(b.hall)!.level === level).map((b) => b.at)));
    return navGrids.current.get(level)!;
  };
  // 回る順（D-1）。★ 行きたい（と、えらべば ◆ 候補）の、まだ行っていない机を、道のりが短い順に
  const [trip, setTrip] = useState<{ day: Day; codes: string[]; length: number; withMaybe: boolean; from: string } | null>(null);
  const tripOrder = useMemo(() => new Map(trip && trip.day === day ? trip.codes.map((c, i) => [c, i + 1] as const) : []), [trip, day]);
  const stopOf = (code: string): Stop => {
    const b = booths[codeIndex.get(code)!];
    const h = hallById.get(b.hall)!;
    return { id: code, p: b.at, level: h.level, building: h.building };
  };
  const makeTrip = (withMaybe: boolean) => {
    const codes = Object.entries(marks)
      .filter(([c, m]) => (m === "want" || (withMaybe && m === "maybe")) && !visited[c] && codeIndex.has(c))
      .map(([c]) => c);
    if (!codes.length) {
      setTrip(null);
      api.current?.showTour(null);
      return;
    }
    // いまいる所が分かっていれば、そこから
    const meHall = locOn && lastMe.current ? loc?.where.hall : null;
    const start = meHall && lastMe.current ? { p: lastMe.current, level: meHall.level, building: hallById.get(meHall.id)!.building } : undefined;
    const r = planTour(codes.map(stopOf), start);
    // 同じ階どうしは、通路を通る道で結ぶ（遠すぎる所・道が見つからない所は、まっすぐ）
    const parts: { pts: XZ[]; level: number }[] = [];
    const seq = start ? [{ id: "", ...start } as Stop, ...r.order] : r.order;
    let walk = 0;
    for (let k = 1; k < seq.length; k++) {
      const a = seq[k - 1], b = seq[k];
      if (a.level !== b.level || a.building !== b.building) {
        // 建物・階をまたぐ所は、通路を探さずに、まっすぐの長さに移る手間（回る順を決めたときと同じ）を足す
        walk += stopDist(a, b);
        continue;
      }
      const path = findPath(navGrid(a.level), a.p, [b.p]);
      if (path) {
        parts.push({ pts: path.path, level: a.level });
        walk += path.length;
      } else {
        parts.push({ pts: [a.p, b.p], level: a.level });
        walk += Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
      }
    }
    api.current?.showTour(parts);
    setTrip({ day, codes: r.order.map((x) => x.id), length: walk, withMaybe, from: start ? "いまいる所" : "" });
  };
  const clearTrip = () => {
    setTrip(null);
    api.current?.showTour(null);
  };
  const [here, setHere] = useState(""); // 近づいたときの、いま見ているホール
  const onHere = useRef(setHere);
  const onFloor = useRef<(f: Floor) => void>(() => {}); // 歩いていて階段で階が変わったとき（下で setFloor を入れる）
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

  useEffect(() => {
    try {
      localStorage.setItem(MARKS_KEY, JSON.stringify(marksByDay));
      localStorage.removeItem(OLD_MARKS_KEY);
      localStorage.removeItem(OLD_WISH_KEY);
    } catch {}
  }, [marksByDay]);
  useEffect(() => {
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(notesByDay));
      localStorage.removeItem(OLD_NOTES_KEY);
    } catch {}
  }, [notesByDay]);
  useEffect(() => {
    try {
      localStorage.setItem(VISITED_KEY, JSON.stringify(visitedByDay));
    } catch {}
  }, [visitedByDay]);
  useEffect(() => {
    try {
      localStorage.setItem(BUDGET_KEY, JSON.stringify(budgetsByDay));
    } catch {}
  }, [budgetsByDay]);
  useEffect(() => {
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(pinsOn));
    } catch {}
  }, [pinsOn]);
  // 作者が公開したデータに新しいものがあれば取り直す（取ったら 1 回だけ読みなおす）
  // 作者が公開しなおした新しいデータがあるとき（"ask"）・端末の保存がいっぱいのとき（"full"）の札
  const [pubNote, setPubNote] = useState<"ask" | "full" | null>(null);
  useEffect(() => {
    refreshPublishedAndReload().then((r) => r !== "none" && setPubNote(r));
  }, []);
  useEffect(() => {
    floorRef.current = { floor, both };
  }, [floor, both]);
  useEffect(() => {
    if (!locOn) {
      atVenue.current = false;
      api.current?.showMe(null, 0, false);
      return;
    }
    const steady = makeSteady(2);
    let first = true;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const p = project(venue.origin, pos.coords.latitude, pos.coords.longitude);
        const { floor: f, both: b } = floorRef.current;
        const levels = b ? [1, 2, 4] : f === 4 ? [4] : [1, 2];
        const where = steady(hallAt(p, venue.halls, levels));
        setLoc({ where, acc: pos.coords.accuracy });
        setLocErr("");
        // 会場から遠い（1km より先）ときは、地図を動かさない
        const far = Math.hypot(p[0], p[1]) > 1000;
        atVenue.current = p[0] > VENUE_BOX[0] - 300 && p[0] < VENUE_BOX[2] + 300 && p[1] > VENUE_BOX[1] - 300 && p[1] < VENUE_BOX[3] + 300;
        api.current?.showMe(far ? null : p, pos.coords.accuracy, first && !far);
        lastMe.current = far ? null : p;
        first = false;
      },
      (e) => {
        setLocErr(e.code === e.PERMISSION_DENIED ? "位置を使うのが許可されていません（ブラウザの設定で許可できます）" : "位置が分かりませんでした");
        if (e.code === e.PERMISSION_DENIED) setLocOn(false);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [locOn]);

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

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshLambertMaterial({ color: 0xd3d5d0 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    scene.add(ground);
    // 周辺の建物の立体（OSM の高さ。会議棟の逆ピラミッドは段ごとの部品を積んだもの）。「周辺も表示」のときだけ出す
    const surroundings = new THREE.Group();
    surroundings.visible = false;
    // 「周辺も表示」のときの地面は、首都高の掘割の所に穴をあけた板（掘割が見えるように）。ふだんの地面と入れかえる
    const cutGround = (venue.surroundings.cuts ?? []).length
      ? flatPoly([[-4000, -4000], [4000, -4000], [4000, 4000], [-4000, 4000]], 0xd3d5d0, -0.2, 1, venue.surroundings.cuts)
      : null;
    if (cutGround) {
      (cutGround.material as THREE.MeshLambertMaterial).side = THREE.FrontSide;
      surroundings.add(cutGround);
    }
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
    const SUR_COLOR = { road: 0x6f7376, walk: 0xe3ddcf, steps: 0xc9c2b0, rail: 0xb4bac0 }; // 道はアスファルトの濃い灰色
    for (const kind of ["road", "walk", "steps"] as const) {
      const m = new THREE.Mesh(ribbons(sur.lines.filter((l) => l.kind === kind && !l.br)), new THREE.MeshLambertMaterial({ color: SUR_COLOR[kind], side: THREE.DoubleSide }));
      m.position.y = -0.08; // 地面（-0.2）より上、ホールの床より下
      surroundings.add(m);
    }
    // 首都高の掘割：下がっている所の両側に、道のふちから地面までのコンクリートの壁
    {
      const pos: number[] = [];
      for (const l of sur.lines.filter((x) => x.ys)) {
        const ys = l.ys!;
        for (let i = 0; i + 1 < l.pts.length; i++) {
          if (Math.max(ys[i], ys[i + 1]) > l.y - 0.1) continue;
          const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1], len = Math.hypot(bx - ax, bz - az) || 1;
          for (const k of [-1, 1]) {
            const nx = (-(bz - az) / len) * (l.w / 2 + 0.5) * k, nz = ((bx - ax) / len) * (l.w / 2 + 0.5) * k;
            const a0 = [ax + nx, ys[i] - 0.08, az + nz], b0 = [bx + nx, ys[i + 1] - 0.08, bz + nz], a1 = [ax + nx, -0.2, az + nz], b1 = [bx + nx, -0.2, bz + nz];
            pos.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
          }
        }
      }
      if (pos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        surroundings.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xa9aaa6, side: THREE.DoubleSide })));
      }
    }
    // 運河をわたる地面の高さの橋（あけみ橋など）：水面より少し上の道・歩道に、厚さ 1.2m の橋の板（側面）と、歩道の両側に高さ 1.1m の手すり
    {
      const brs = sur.lines.filter((l) => l.br);
      for (const kind of ["road", "walk"] as const) {
        const list = brs.filter((l) => l.kind === kind && !l.fill);
        if (list.length) surroundings.add(new THREE.Mesh(ribbons(list, 1.2), new THREE.MeshLambertMaterial({ color: SUR_COLOR[kind], side: THREE.DoubleSide })));
      }
      // 車線と歩道のあいだ（中央分離帯など）：コンクリートの色
      const fills = brs.filter((l) => l.fill);
      if (fills.length) surroundings.add(new THREE.Mesh(ribbons(fills, 1.2), new THREE.MeshLambertMaterial({ color: 0xb4b6b2, side: THREE.DoubleSide })));
      const rails = brs.filter((l) => l.kind === "walk").flatMap((l) => [-1, 1].map((k) => ({
        y: l.y + 1.1, w: 0.08,
        pts: l.pts.map(([x, z], i) => {
          const [bx, bz] = l.pts[Math.min(i + 1, l.pts.length - 1)], [ax, az] = l.pts[Math.max(i - 1, 0)];
          const len = Math.hypot(bx - ax, bz - az) || 1;
          return [x - ((bz - az) / len) * k * (l.w / 2 - 0.1), z + ((bx - ax) / len) * k * (l.w / 2 - 0.1)] as XZ;
        }),
      })));
      if (rails.length) surroundings.add(new THREE.Mesh(ribbons(rails, 1.1), new THREE.MeshLambertMaterial({ color: 0x9fb4c0, transparent: true, opacity: 0.55, side: THREE.DoubleSide })));
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
      sp.position.set(st.at[0], st.y + 9, st.at[1]);
      sp.userData.station = true;
      surroundings.add(sp);
      stationLabels.push({ s: sp, base: sp.scale.clone() });
    }
    scene.add(surroundings);

    // 階ごとの入れ物。選んでいない階は床を薄くし、机・壁・文字を隠す
    type LevelParts = { floors: THREE.Mesh[]; solid: THREE.Object3D[] };
    // 文字の札。上から・3D では、ズームしても画面の上で同じ大きさ（px）にする。近づいて机が見えてきたら、
    // ホールの名前のような大きな札は机を隠すので消し、列の名前のような細かい札は近いときだけ出す。歩くときは実物の大きさ
    type LabelKind = "hall" | "area" | "wc" | "aid" | "door" | "shutter" | "block" | "sur" | "genre"; // sur：周辺の札（建物の名前・駅の出入口・バス停）。genre：色分けの名前
    const LABEL_PX: Record<LabelKind, number> = { hall: 22, area: 13, wc: 16, aid: 16, door: 15, shutter: 13, block: 15, sur: 14, genre: 15 };
    const labels: { s: THREE.Sprite; kind: LabelKind; base: THREE.Vector3 }[] = [];
    const addLabel = (s: THREE.Sprite, kind: LabelKind) => labels.push({ s, kind, base: s.scale.clone() });
    // ---- 周辺をくわしく（ユーザーの指示：駅までの道など、まわりをくわしく、リアルに）
    const DECK_Y = floorY(2);
    {
      // 緑地・駐車場（道・歩道より下に敷く）
      const GREEN = { parking: 0x8e9294, pitch: 0x8fc27c, grass: 0xa3c98d, wood: 0x86b274 } as const;
      for (const g of sur.greens ?? []) surroundings.add(flatPoly(g.poly, GREEN[g.kind], g.kind === "parking" || g.kind === "pitch" ? -0.13 : -0.15));
      // 建物：高さで色の系統を分け（高い建物はガラスの青灰色、中くらいはコンクリートの白っぽい色、低い建物は薄い茶色）、
      // 建物ごとに少し明るさを変える。壁には 1 階 4m ごとの窓の帯（模様）を貼る。屋上は少し暗く
      const winTex = (() => {
        const c = document.createElement("canvas");
        c.width = 8;
        c.height = 32;
        const g = c.getContext("2d")!;
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, 8, 32);
        g.fillStyle = "#8f9aa5";
        g.fillRect(0, 9, 8, 15); // 窓の帯（1 階の高さの半分ほど）
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(1, 1 / 4); // ExtrudeGeometry の側面の UV はメートル（縦は高さ）。4m で 1 回
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      })();
      const tone = (h: number, i: number) => {
        const k = 0.92 + ((Math.sin(i * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.12;
        const base = h >= 45 ? new THREE.Color(0xb3c1cc) : h >= 15 ? new THREE.Color(0xdcdad3) : new THREE.Color(0xd8cdbd);
        return base.multiplyScalar(k);
      };
      const mats = new Map<string, THREE.Material[]>();
      const matOf = (h: number, i: number) => {
        const c = tone(h, i);
        const key = c.getHexString().slice(0, 5) + (h >= 8 ? "w" : "");
        if (!mats.has(key)) {
          const roof = new THREE.MeshLambertMaterial({ color: c.clone().multiplyScalar(0.82) });
          const wall = new THREE.MeshLambertMaterial({ color: c, map: h >= 8 ? winTex : null });
          mats.set(key, [roof, wall]);
        }
        return mats.get(key)!;
      };
      const roofMat = new THREE.MeshLambertMaterial({ color: 0xeef0ee });
      const postMat = new THREE.MeshLambertMaterial({ color: 0xc9cdd0 });
      const posts: [number, number, number, number?][] = []; // x, z, 上の端の高さ（マイナスは太い柱）, 下の端の高さ
      (sur.buildings ?? []).forEach((b, i) => {
        if (b.kind === "station") {
          // ゆりかもめの駅：高架の下の部分（改札など）と、ホームの上の屋根（厚さ 0.5m）、そのあいだはふちに 8m ごとの柱
          const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: b.body ?? 6, bevelEnabled: false }), matOf(b.body ?? 6, i));
          body.rotation.x = -Math.PI / 2;
          const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: 0.5, bevelEnabled: false }), roofMat);
          roof.rotation.x = -Math.PI / 2;
          roof.position.y = b.h - 0.5;
          surroundings.add(body, roof);
          const cx = b.poly.reduce((a, q) => a + q[0], 0) / b.poly.length, cz = b.poly.reduce((a, q) => a + q[1], 0) / b.poly.length;
          let next = 0, run = 0;
          b.poly.forEach((q, k) => {
            const r = b.poly[(k + 1) % b.poly.length], L = Math.hypot(r[0] - q[0], r[1] - q[1]);
            for (; next <= run + L; next += 8) {
              const d = next - run, x = q[0] + ((r[0] - q[0]) * d) / (L || 1), z = q[1] + ((r[1] - q[1]) * d) / (L || 1), dl = Math.hypot(cx - x, cz - z) || 1;
              posts.push([x + ((cx - x) / dl) * 0.6, z + ((cz - z) / dl) * 0.6, b.h - 0.5, b.body ?? 6]);
            }
            run += L;
          });
          return;
        }
        if (b.kind === "bridgeHouse") {
          // 駅の出口の歩道橋の通路と建物：base（床の板の下）から屋根までの箱。下は 8m ごとの太い柱で、道や歩道が通れる
          const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: b.h - (b.base ?? 0), bevelEnabled: false }), matOf(b.h, i));
          m.rotation.x = -Math.PI / 2;
          m.position.y = b.base ?? 0;
          surroundings.add(m);
          const cx = b.poly.reduce((a, q) => a + q[0], 0) / b.poly.length, cz = b.poly.reduce((a, q) => a + q[1], 0) / b.poly.length;
          let next = 2, run = 0;
          b.poly.forEach((q, k) => {
            const r = b.poly[(k + 1) % b.poly.length], L = Math.hypot(r[0] - q[0], r[1] - q[1]);
            for (; next <= run + L; next += 8) {
              const d = next - run, x = q[0] + ((r[0] - q[0]) * d) / (L || 1), z = q[1] + ((r[1] - q[1]) * d) / (L || 1), dl = Math.hypot(cx - x, cz - z) || 1;
              const px = x + ((cx - x) / dl) * 0.8, pz = z + ((cz - z) / dl) * 0.8;
              if (pointInPolygon([px, pz], b.poly)) posts.push([px, pz, -(b.base ?? 0)]);
            }
            run += L;
          });
          return;
        }
        if (b.kind === "tube" && b.slope) {
          // 屋根つきのエスカレーター：床は上の端（歩道橋の床）から下の端（地面）へ、屋根はその 3m 上。
          // 横はガラス（少し透ける）なので、中のエスカレーターが見える
          const { from, to, y: top } = b.slope;
          const L = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1, ux = (to[0] - from[0]) / L, uz = (to[1] - from[1]) / L;
          const tAt = (q: XZ) => Math.max(0, Math.min(1, ((q[0] - from[0]) * ux + (q[1] - from[1]) * uz) / L));
          const floorAt = (q: XZ) => Math.max(0, top * (1 - tAt(q)) - 0.4);
          const roofAt = (q: XZ) => top * (1 - tAt(q)) + 3.2;
          const pts = b.poly;
          const roofPos: number[] = [];
          for (const [a0, a1, a2] of THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, z)), []))
            for (const k of [a0, a2, a1]) roofPos.push(pts[k][0], roofAt(pts[k]), pts[k][1]);
          const wallPos: number[] = [];
          pts.forEach((q, k) => {
            const r = pts[(k + 1) % pts.length];
            const q0 = [q[0], floorAt(q), q[1]], q1 = [q[0], roofAt(q), q[1]], r0 = [r[0], floorAt(r), r[1]], r1 = [r[0], roofAt(r), r[1]];
            wallPos.push(...q0, ...r0, ...r1, ...q0, ...r1, ...q1);
          });
          const geo = (pos: number[]) => {
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
            g.computeVertexNormals();
            return g;
          };
          surroundings.add(
            new THREE.Mesh(geo(roofPos), new THREE.MeshLambertMaterial({ color: 0xe4e6e3, side: THREE.DoubleSide })),
            new THREE.Mesh(geo(wallPos), new THREE.MeshLambertMaterial({ color: 0xa9c2cf, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })),
          );
          // 下が空いている所（地面から床まで）は、8m ごとの柱
          for (let d = 4; d < L - 4; d += 8) {
            const q: XZ = [from[0] + ux * d, from[1] + uz * d];
            if (floorAt(q) > 2.5) posts.push([q[0], q[1], -floorAt(q)]);
          }
          return;
        }
        if (b.kind === "canopy") {
          // 屋根の板（厚さ 0.3m）と、ふちに 8m ごとの柱
          const g = new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: 0.3, bevelEnabled: false });
          const m = new THREE.Mesh(g, roofMat);
          m.rotation.x = -Math.PI / 2;
          m.position.y = b.h - 0.3;
          surroundings.add(m);
          const cx = b.poly.reduce((a, q) => a + q[0], 0) / b.poly.length, cz = b.poly.reduce((a, q) => a + q[1], 0) / b.poly.length;
          // ふちを一周たどり、8m ごとに（中心の側へ 0.4m 寄せて）
          let next = 0, run = 0;
          b.poly.forEach((q, k) => {
            const r = b.poly[(k + 1) % b.poly.length], L = Math.hypot(r[0] - q[0], r[1] - q[1]);
            for (; next <= run + L; next += 8) {
              const d = next - run, x = q[0] + ((r[0] - q[0]) * d) / (L || 1), z = q[1] + ((r[1] - q[1]) * d) / (L || 1), dl = Math.hypot(cx - x, cz - z) || 1;
              posts.push([x + ((cx - x) / dl) * 0.4, z + ((cz - z) / dl) * 0.4, b.h - 0.3]);
            }
            run += L;
          });
          return;
        }
        const g = new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: b.h, bevelEnabled: false });
        const m = new THREE.Mesh(g, matOf(b.h, i));
        m.rotation.x = -Math.PI / 2;
        surroundings.add(m);
        // 名前（大きい建物。OSM の名前）：屋上の少し上
        if (b.name) {
          const t = textSprite(b.name, { fg: "#ffffff", bg: "rgba(70,76,84,.82)", height: 3.2, px: 30 });
          const [x, z] = insidePoint(b.poly, []);
          t.position.set(x, b.h + 4, z);
          surroundings.add(t);
          addLabel(t, "sur");
        }
      });
      // 歩行者デッキの広場：厚さ 0.8m の板。ふちに 14m ごとの太い柱と、手すり（つながっている所は開けてある）
      {
        const deckMat = new THREE.MeshLambertMaterial({ color: 0xd6d0c2 });
        for (const d of sur.decks ?? []) {
          const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shapeOf(d.poly, d.holes ?? []), { depth: 0.8, bevelEnabled: false }), deckMat);
          m.rotation.x = -Math.PI / 2;
          m.position.y = DECK_Y - 0.8;
          surroundings.add(m);
          const cx = d.poly.reduce((a, q) => a + q[0], 0) / d.poly.length, cz = d.poly.reduce((a, q) => a + q[1], 0) / d.poly.length;
          let next = 4, run = 0;
          d.poly.forEach((q, k) => {
            const r = d.poly[(k + 1) % d.poly.length], L = Math.hypot(r[0] - q[0], r[1] - q[1]);
            for (; next <= run + L; next += 14) {
              const dd = next - run, x = q[0] + ((r[0] - q[0]) * dd) / (L || 1), z = q[1] + ((r[1] - q[1]) * dd) / (L || 1), dl = Math.hypot(cx - x, cz - z) || 1;
              posts.push([x + ((cx - x) / dl) * 1.5, z + ((cz - z) / dl) * 1.5, -(DECK_Y - 0.8)]);
            }
            run += L;
          });
        }
        const rails = (sur.deckRails ?? []).map((pts) => ({ pts, y: DECK_Y + 1.1, w: 0.08 }));
        if (rails.length) surroundings.add(new THREE.Mesh(ribbons(rails, 1.1), new THREE.MeshLambertMaterial({ color: 0x9fb4c0, transparent: true, opacity: 0.55, side: THREE.DoubleSide })));
      }
      // 柱（屋根の柱・デッキの柱・高架の道路の柱）はまとめて 1 つの形で
      const deckLines = sur.lines.filter((l) => l.kind === "deck");
      const roadHigh = sur.lines.filter((l) => l.kind === "road" && l.y > 1);
      // ゆりかもめの高架も（25m ごと）
      const railHigh = sur.lines.filter((l) => l.kind === "rail" && l.y > 1);
      for (const l of [...deckLines, ...roadHigh, ...railHigh]) {
        const step = l.kind === "rail" ? 25 : 14;
        for (let i = 0; i + 1 < l.pts.length; i++) {
          const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1], L = Math.hypot(bx - ax, bz - az);
          for (let d = 6; d < L - 2; d += step) posts.push([ax + ((bx - ax) * d) / L, az + ((bz - az) * d) / L, -(l.y - (l.kind === "rail" ? 1.5 : 0.8))]); // マイナス：太い柱
        }
      }
      {
        const thin = posts.filter((q) => q[2] > 0), thick = posts.filter((q) => q[2] < 0);
        const mk = (list: [number, number, number, number?][], r: number, mat: THREE.Material) => {
          const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(r, r, 1, 8), mat, Math.max(1, list.length));
          const o = new THREE.Object3D();
          list.forEach(([x, z, h, base = 0], i) => {
            const hh = Math.abs(h) - base;
            o.position.set(x, base + hh / 2, z);
            o.scale.set(1, hh, 1);
            o.updateMatrix();
            im.setMatrixAt(i, o.matrix);
          });
          im.count = list.length;
          im.computeBoundingSphere();
          surroundings.add(im);
        };
        mk(thin, 0.13, postMat);
        mk(thick, 0.6, new THREE.MeshLambertMaterial({ color: 0xbfc2bf }));
      }
      // 歩行者デッキ（2F の高さ。厚さ 0.8m の板と、両側に高さ 1.1m の手すり）
      if (deckLines.length) {
        surroundings.add(new THREE.Mesh(ribbons(deckLines, 0.8), new THREE.MeshLambertMaterial({ color: 0xd6d0c2, side: THREE.DoubleSide })));
        const rails = deckLines.flatMap((l) => [-1, 1].map((k) => ({
          y: l.y + 1.1, w: 0.08,
          pts: l.pts.map(([x, z], i) => {
            const [bx, bz] = l.pts[Math.min(i + 1, l.pts.length - 1)], [ax, az] = l.pts[Math.max(i - 1, 0)];
            const len = Math.hypot(bx - ax, bz - az) || 1;
            return [x - ((bz - az) / len) * k * (l.w / 2 - 0.1), z + ((bx - ax) / len) * k * (l.w / 2 - 0.1)] as XZ;
          }),
        })));
        surroundings.add(new THREE.Mesh(ribbons(rails, 1.1), new THREE.MeshLambertMaterial({ color: 0x9fb4c0, transparent: true, opacity: 0.55, side: THREE.DoubleSide })));
      }
      // デッキへ上る階段（デッキにつく端が 2F の高さ）：段の板を並べる
      for (const st of sur.deckStairs ?? []) {
        // 道すじ（上の端から下の端へ。折り返す階段は OSM の線のとおり）に沿って、段の板を並べる。高さは道すじの長さで割りふる
        const path = st.pts ?? [st.from, st.to];
        const segs = path.slice(1).map((q, k) => ({ a: path[k], b: q, L: Math.hypot(q[0] - path[k][0], q[1] - path[k][1]) }));
        const run = segs.reduce((s2, g) => s2 + g.L, 0);
        const at = (d: number) => {
          for (const g of segs) {
            if (d <= g.L || g === segs.at(-1)) {
              const t = Math.min(1, d / (g.L || 1));
              return { x: g.a[0] + (g.b[0] - g.a[0]) * t, z: g.a[1] + (g.b[1] - g.a[1]) * t, dx: g.a[0] - g.b[0], dz: g.a[1] - g.b[1] };
            }
            d -= g.L;
          }
          return { x: st.to[0], z: st.to[1], dx: 0, dz: 1 };
        };
        const topY = st.y ?? DECK_Y;
        const n = st.tower ? 0 : Math.max(3, Math.round(topY / 0.2));
        const im = new THREE.InstancedMesh(new THREE.BoxGeometry(st.w ?? 3, 1, run / Math.max(n, 1) + 0.02), new THREE.MeshLambertMaterial({ color: st.esc ? 0x6f8fb3 : 0xc9c2b0 }), n);
        const o = new THREE.Object3D();
        for (let i = 0; i < n; i++) {
          const f = (i + 0.5) / n, top = (topY * (i + 1)) / n, th = Math.min(1.5, top);
          const p = at(run * (1 - f));
          o.position.set(p.x, top - th / 2, p.z);
          o.rotation.set(0, Math.atan2(p.dx, p.dz), 0);
          o.scale.set(1, th, 1);
          o.updateMatrix();
          im.setMatrixAt(i, o.matrix);
        }
        if (n) {
          im.computeBoundingSphere();
          surroundings.add(im);
        }
        // 札（寄ったときだけ）：デッキと地上のあいだを上り下りできる所
        const t = textSprite(st.esc ? "⇅ エスカレーター" : "⇅ 階段", { bg: st.esc ? "rgba(60,95,140,.92)" : "rgba(150,120,80,.92)", height: 2.4, px: 28 });
        const mid = at(run / 2);
        t.position.set(mid.x, st.tower ? topY + 4.5 : topY / 2 + 3, mid.z);
        surroundings.add(t);
        addLabel(t, "sur");
      }
      // 道路の白線：広い道（幅 9m 以上、地上）の真ん中に破線（長さ 5m・間 5m）
      {
        const dashes: { pts: XZ[]; y: number; w: number; ys?: number[] }[] = [];
        for (const l of sur.lines.filter((x) => x.kind === "road" && x.y < 1 && x.w >= 9)) {
          let on = 0;
          // 道の上の白線の高さ（掘割へ下りる所は道に沿って下がる）
          const yAt = (i: number, f: number) => (l.ys ? l.ys[i] + (l.ys[i + 1] - l.ys[i]) * f - 0.065 : -0.035);
          for (let i = 0; i + 1 < l.pts.length; i++) {
            const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1], L = Math.hypot(bx - ax, bz - az);
            for (let d = 0; d < L; d += 5, on++)
              if (on % 2 === 0) {
                const e = Math.min(L, d + 5);
                dashes.push({ pts: [[ax + ((bx - ax) * d) / L, az + ((bz - az) * d) / L], [ax + ((bx - ax) * e) / L, az + ((bz - az) * e) / L]], y: -0.035, ys: [yAt(i, d / L), yAt(i, e / L)], w: 0.18 });
              }
          }
        }
        // 横断歩道：歩く向きに 0.9m ごとに、幅 0.45m・長さ 4m の白い帯
        for (const c of sur.crossings ?? [])
          for (let i = 0; i + 1 < c.length; i++) {
            const [ax, az] = c[i], [bx, bz] = c[i + 1], L = Math.hypot(bx - ax, bz - az);
            if (L < 0.5) continue;
            const ux = (bx - ax) / L, uz = (bz - az) / L;
            for (let d = 0.45; d < L - 0.2; d += 0.9) {
              const x = ax + ux * d, z = az + uz * d;
              dashes.push({ pts: [[x - uz * 2, z + ux * 2], [x + uz * 2, z - ux * 2]], y: -0.035, w: 0.45 });
            }
          }
        surroundings.add(new THREE.Mesh(ribbons(dashes), new THREE.MeshBasicMaterial({ color: 0xf4f4f0, side: THREE.DoubleSide })));
      }
      // 木：幹（高さ 3m）と、丸い葉の塊（色を少しずつ変える）
      {
        const trees = sur.trees ?? [];
        const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 3, 6), new THREE.MeshLambertMaterial({ color: 0x7a6248 }), Math.max(1, trees.length));
        const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, trees.length));
        const o = new THREE.Object3D();
        const greens = [0x5f8f4a, 0x6b9a52, 0x55833f, 0x74a35a].map((c) => new THREE.Color(c));
        trees.forEach(([x, z], i) => {
          const k = 0.85 + (((Math.sin(i * 12.9898) * 43758.5453) % 1) + 1) % 1 * 0.35;
          o.position.set(x, 1.5 * k, z);
          o.scale.set(1, k, 1);
          o.updateMatrix();
          trunk.setMatrixAt(i, o.matrix);
          o.position.set(x, 3 * k + 1.6 * k, z);
          o.scale.set(k, k * 1.05, k);
          o.updateMatrix();
          crown.setMatrixAt(i, o.matrix);
          crown.setColorAt(i, greens[i % greens.length]);
        });
        trunk.count = crown.count = trees.length;
        trunk.computeBoundingSphere();
        crown.computeBoundingSphere();
        surroundings.add(trunk, crown);
      }
      // 駅の出入口・バス停・タクシー乗り場の札（寄ったときだけ）。駅の出入口は小さな屋根つきの入口の箱
      for (const e of sur.entrances ?? []) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3, 3.2), new THREE.MeshLambertMaterial({ color: e.line === "ゆりかもめ" ? 0x2f8f6e : 0x2f5f9f }));
        box.position.set(e.at[0], 1.5, e.at[1]);
        surroundings.add(box);
        const t = textSprite(`🚉 ${e.name}`, { bg: e.line === "ゆりかもめ" ? "rgba(0,120,90,.92)" : "rgba(20,80,160,.92)", height: 2.6, px: 30 });
        t.position.set(e.at[0], 6, e.at[1]);
        surroundings.add(t);
        addLabel(t, "sur");
      }
      for (const b of sur.busStops ?? []) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 6), new THREE.MeshLambertMaterial({ color: 0x3d5a80 }));
        pole.position.set(b.at[0], 1.3, b.at[1]);
        surroundings.add(pole);
        const t = textSprite(`🚌 ${b.name}`, { bg: "rgba(60,90,128,.9)", height: 2.4, px: 28 });
        t.position.set(b.at[0], 4.5, b.at[1]);
        surroundings.add(t);
        addLabel(t, "sur");
      }
      for (const at of sur.taxis ?? []) {
        const t = textSprite("🚕 タクシー乗り場", { bg: "rgba(150,120,20,.9)", height: 2.4, px: 28 });
        t.position.set(at[0], 4.5, at[1]);
        surroundings.add(t);
        addLabel(t, "sur");
      }
    }
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
      areaColor.set(a, color);
      // 床の厚み（下が透けて見える床と、ほかの床の下に敷いた床にはつけない）
      const slab = a.see || a.under ? null : slabUnder(a.poly, color, f.position.y, a.level, a.holes ?? []);
      // 会場の外（やぐら橋とその先の地上）は、「周辺も表示」のときだけ。階で薄くしない
      if (a.sur) {
        surroundings.add(f);
        if (slab) surroundings.add(slab);
        if (a.part) continue;
        const label = textSprite(a.name, { fg: "#55584f", height: 3.2, px: 32 });
        const [cx, cz] = insidePoint(a.poly, a.holes ?? []);
        label.position.set(cx, y + 3, cz);
        surroundings.add(label);
        addLabel(label, "area");
        continue;
      }
      scene.add(f);
      partsOf(a.level).floors.push(f);
      if (slab) {
        scene.add(slab);
        partsOf(a.level).floors.push(slab);
      }
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
      const edgeGroups = new Map<string, { color: number; level: number; sur: boolean; runs: { pts: XZ[]; y: number; w: number }[]; lines: number[] }>();
      for (const a of venue.areas) {
        const color = areaColor.get(a)!;
        const others = venue.areas.filter((o) => o !== a && o.level === a.level);
        const hallPolys = venue.halls.filter((h) => h.level === a.level).map((h) => h.poly);
        const ey = floorY(a.level) + (a.under ? 0.03 : 0.07);
        const key = `${a.level}-${color}${a.sur ? "-sur" : ""}`;
        const out = edgeGroups.get(key) ?? { color, level: a.level, sur: !!a.sur, runs: [], lines: [] };
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
        if (g.sur) surroundings.add(band, line);
        else {
          scene.add(band, line);
          partsOf(g.level).solid.push(band, line);
        }
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
    const openDoors = venue.doors.filter((d) => d.kind === "出入口" && freePart(d.hall, ...doorSpan(d.hall, d.at, d.width ?? DOOR_W)));
    // 配置図の切れ目は、通れる所だけに縮める（看板はその真ん中に）
    // 壁の切れ目：会場データに入れてあるもの（外壁の線の上に置いてある）と、配置図のもの（それと 8m より近いものは除く）
    const dataGaps = venue.wallGaps ?? [];
    const allGaps = [
      ...dataGaps,
      ...(features?.openings ?? []).filter((o) => !dataGaps.some((g) => Math.hypot((o.a[0] + o.b[0] - g.a[0] - g.b[0]) / 2, (o.a[1] + o.b[1] - g.a[1] - g.b[1]) / 2) < 8)),
    ];
    // 看板を出さない切れ目（壁の高さいっぱいの開口・西のトイレのあいだの扉）は除く
    const openGaps = allGaps.filter((o) => !("full" in o && o.full) && !("sign" in o && o.sign === false)).flatMap((o) => {
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
      const hs = slabUnder(h.poly, h.closed ? 0xc4c4bf : BUILDING_COLOR[h.building], y + 0.05, h.level);
      scene.add(hs);
      partsOf(h.level).floors.push(hs);
      const w = walls(
        h.poly,
        y,
        WALL_H,
        wallMat,
        // 図面の出入口（建物の扉）と、配置図から写した壁の切れ目（当日開いている所）の両方を開ける
        // 穴は、壁サークルがふさいでいる出入口も開ける（看板だけ出さない）
        venue.doors.filter((d) => d.hall === h.id && d.kind === "出入口"),
        // full の切れ目は、壁の高さいっぱい（上に梁を残さない）
        allGaps.filter((o) => o.hall === h.id).map((o) => [o.a, o.b, "full" in o && o.full ? 100 : undefined] as [XZ, XZ, number?]),
        venue.halls.filter((o) => o.id !== h.id && o.level === h.level).map((o) => o.poly),
        (i) => (lowEdge(h, i) ? floorY(2) - floorY(1) : WALL_H),
        // 搬入口（大きなシャッター）も穴にする。西・南に加えて東も（ユーザーの指示）。配置図を読みこんでいなくても開ける
        venue.doors.filter((d) => d.hall === h.id && d.kind === "搬入口"),
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
    // 東3 の端の、トラックヤードと屋内の床の境目の壁（ガレリアの北の端の建物の壁）。ホールの壁と同じ高さ
    {
      const g = new THREE.Group();
      for (const line of venue.yardWalls ?? [])
        for (let i = 0; i + 1 < line.length; i++) {
          const [a, b] = [line[i], line[i + 1]];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 0.05) continue;
          const m = new THREE.Mesh(new THREE.BoxGeometry(len + 0.4, WALL_H, 0.4), wallMat);
          m.position.set((a[0] + b[0]) / 2, floorY(1) + WALL_H / 2, (a[1] + b[1]) / 2);
          m.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
          g.add(m);
        }
      scene.add(g);
      occluders.push(g);
      partsOf(1).solid.push(g);
    }
    // 階段の段の上の高さ（歩く線を段の上に出すため）：階段ごとに、下の端・向き・段の数・踊り場の最初の段
    const stairProfiles: { to: XZ; dir: XZ; run: number; w: number; n: number; m0: number; y0: number; yTop: number }[] = [];
    // 階段（屋上展示場からエントランスプラザへ）。段は 0.2m ほどの高さで、どの階を見ていても出す
    for (const st of venue.stairs ?? []) {
      const y0 = floorY(st.toLevel), y1 = floorY(st.fromLevel);
      const dx = st.from[0] - st.to[0], dz = st.from[1] - st.to[1], run = Math.hypot(dx, dz);
      if (st.kind === "ramp") {
        // 車のスロープ：段のない 1 枚の傾いた板（厚さ 2m。エスカレーター・階段と同じ：ユーザーの確認）
        const RT = 2, len = Math.hypot(run, y1 - y0);
        const geo = new THREE.BoxGeometry(st.width, RT, len);
        const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: RAMP_COLOR }));
        m.rotation.order = "YXZ";
        m.rotation.set(-Math.atan2(y1 - y0, run), Math.atan2(dx, dz), 0);
        // 上の面が、上と下の床の高さをむすぶ線にのるように（板の厚さの半分だけ、面に直角に下げる）
        const tilt = Math.atan2(y1 - y0, run);
        m.position.set((st.from[0] + st.to[0]) / 2 + (dx / run) * Math.sin(tilt) * (RT / 2), (y0 + y1) / 2 - Math.cos(tilt) * (RT / 2), (st.from[1] + st.to[1]) / 2 + (dz / run) * Math.sin(tilt) * (RT / 2));
        // ふち：床と同じく、色を濃くした帯（幅 0.35m）と線（1px）を、上の面の長い 2 辺に。上と下の端は床・地面とひと続きなので描かない
        {
          const dark = new THREE.Color(RAMP_COLOR).multiplyScalar(0.5);
          const bandMat = new THREE.MeshBasicMaterial({ color: dark, side: THREE.DoubleSide });
          const pts: number[] = [];
          for (const sx of [-1, 1]) {
            const band = new THREE.Mesh(new THREE.PlaneGeometry(0.35, len), bandMat);
            band.rotation.x = -Math.PI / 2;
            band.position.set(sx * (st.width / 2 - 0.175), RT / 2 + 0.03, 0);
            m.add(band);
            pts.push(sx * st.width / 2, RT / 2 + 0.04, -len / 2, sx * st.width / 2, RT / 2 + 0.04, len / 2);
          }
          const lg = new THREE.BufferGeometry();
          lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
          m.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: dark })));
        }
        scene.add(m);
        const label = textSprite(`⇅ ${st.name}`, { bg: "rgba(190,120,20,.95)", height: 2.6, px: 30 });
        label.position.set((st.from[0] + st.to[0]) / 2, (y0 + y1) / 2 + 3, (st.from[1] + st.to[1]) / 2);
        scene.add(label);
        addLabel(label, "door");
        continue;
      }
      const n = Math.max(3, Math.round((y1 - y0) / 0.2));
      const geo = new THREE.BoxGeometry(st.width, 1, run / n + 0.02);
      // 上の階の床（その階の床とホール）。階段の上の端が、この床の中や床のふちの帯（幅 0.35m）にかかっている所は、
      // 床の上に敷いた薄い踊り場（床と帯より少し上）にし、そこまでの段で床の面の少し上まで上がりきる。
      // 床に隠れずに、つながっている所の上まで階段の色に見える（ユーザーの確認。床の下まで厚い段を上げると箱のように見えた）
      const upper = [
        ...venue.areas.filter((a) => a.level === st.fromLevel && !a.see).map((a) => ({ poly: a.poly, holes: a.holes ?? [] })),
        ...venue.halls.filter((h) => h.level === st.fromLevel).map((h) => ({ poly: h.poly, holes: [] as XZ[][] })),
      ];
      const underFloor = (p: XZ) => upper.some((u) => pointInPolygon(p, u.poly) && !u.holes.some((h) => pointInPolygon(p, h)));
      const esc = st.kind === "escalator";
      // 屋外の階段（屋上展示場からエントランスプラザへ）は、目立つマゼンタ
      const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: esc ? 0x6f8fb3 : st.outdoor ? OUTDOOR_STAIR_COLOR : LINK_COLOR }), n);
      const t = new THREE.Object3D();
      const center = (i: number): XZ => [st.to[0] + dx * ((i + 0.5) / n), st.to[1] + dz * ((i + 0.5) / n)];
      // 上の端から続けて床の中（か、0.4m 先が床の中）にある段は踊り場。m0：踊り場の最初の段
      let m0 = n;
      while (m0 > 1) {
        const [cx, cz] = center(m0 - 1);
        if (!(underFloor([cx, cz]) || underFloor([cx + (dx / run) * 0.4, cz + (dz / run) * 0.4]))) break;
        m0--;
      }
      const yTop = y1 + 0.08;
      stairProfiles.push({ to: st.to, dir: [dx / run, dz / run], run, w: st.width, n, m0, y0, yTop });
      for (let i = 0; i < n; i++) {
        // 段は 1 段ずつ、厚さ 2m の板（下まで埋めた塊にすると、下の階から壁のように見える。薄いと横から線にしか見えない：ユーザーの確認）
        const [cx, cz] = center(i);
        const landing = i >= m0;
        const top = landing ? yTop : y0 + ((yTop - y0) * (i + 1)) / m0, th = landing ? 0.15 : Math.min(2, top - y0);
        t.position.set(cx, top - th / 2, cz);
        t.rotation.set(0, Math.atan2(dx, dz), 0);
        t.scale.set(1, th, 1);
        t.updateMatrix();
        m.setMatrixAt(i, t.matrix);
      }
      m.computeBoundingSphere();
      const label = textSprite(`⇅ ${st.name}`, { bg: esc ? "rgba(60,95,140,.92)" : st.outdoor ? "rgba(200,30,120,.95)" : "rgba(205,110,50,.92)", height: 2.6, px: 30 });
      label.position.set((st.from[0] + st.to[0]) / 2, (y0 + y1) / 2 + 3, (st.from[1] + st.to[1]) / 2);
      // やぐら橋の大階段（会場の外）は「周辺も表示」のときだけ
      (st.sur ? surroundings : scene).add(m, label);
      addLabel(label, st.fromLevel === 2 && st.toLevel === 1 ? "block" : "door"); // ガレリアの階段・エスカレーターの札は、寄ったときだけ
    }
    // 人の入れない建物（西と南のつなぎ目の角の 45° の建物など）。その階の床の高さに立つ灰色の箱。
    // 部屋の帯の、来場者の入れない部屋（東1〜3 の主催者事務室など）は、その階の黒い低い箱
    {
      const mat = new THREE.MeshLambertMaterial({ color: 0x8a908c });
      const roomMat = new THREE.MeshLambertMaterial({ color: 0x2a2d2c });
      for (const b of venue.blocks ?? []) {
        const geo = new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: b.height, bevelEnabled: false });
        const m = new THREE.Mesh(geo, b.kind === "room" ? roomMat : mat);
        m.rotation.x = -Math.PI / 2;
        m.position.y = floorY(b.level) + (b.base ?? 0);
        if (b.kind === "room") {
          scene.add(m);
          partsOf(b.level).solid.push(m);
          continue;
        }
        // 床より上から始まる箱（南の角の建物の 3F より上）は、下の階の床が見えるよう、4F を見ているときだけ出す
        if (b.base) {
          scene.add(m);
          partsOf(4).solid.push(m);
          continue;
        }
        // 地面から 4F の上まで続く建物なので、どの階を見ているときも出す（階ごとの出し分けに入れない）
        scene.add(m);
        occluders.push(m);
      }
    }
    // 屋外の白い屋根（やぐら橋と、その先の屋根のある歩道）：中心の線にそって、厚さ 0.3m の板と、両側に 6m ごとの細い柱（高さ 3.3m）
    {
      const roofMat = new THREE.MeshLambertMaterial({ color: 0xf1f2ee });
      const postMat = new THREE.MeshLambertMaterial({ color: 0xdfe2e0 });
      const POST = 3.3;
      for (const c of venue.canopies ?? []) {
        const g = new THREE.Group();
        for (let i = 0; i + 1 < c.pts.length; i++) {
          const [ax, az] = c.pts[i], [bx, bz] = c.pts[i + 1], ya = c.ys[i], yb = c.ys[i + 1];
          const L = Math.hypot(bx - ax, bz - az);
          if (L < 0.1) continue;
          const ux = (bx - ax) / L, uz = (bz - az) / L;
          const slab = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(L, yb - ya) + 0.2, 0.3, c.w), roofMat);
          slab.position.set((ax + bx) / 2, (ya + yb) / 2 + 0.15, (az + bz) / 2);
          slab.rotation.order = "YZX";
          slab.rotation.y = -Math.atan2(uz, ux);
          slab.rotation.z = Math.atan2(yb - ya, L);
          g.add(slab);
          const n = Math.max(1, Math.round(L / 6));
          for (let k = 0; k <= n; k++) {
            if (k === n && i + 2 < c.pts.length) continue; // つなぎ目の柱は次の区間で
            const t = k / n, y = ya + (yb - ya) * t;
            for (const sgn of [-1, 1]) {
              const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, POST, 0.25), postMat);
              post.position.set(ax + ux * L * t - uz * sgn * (c.w / 2 - 0.3), y - POST / 2, az + uz * L * t + ux * sgn * (c.w / 2 - 0.3));
              g.add(post);
            }
          }
        }
        surroundings.add(g); // やぐら橋と、その先の屋根のある歩道は会場の外なので「周辺も表示」のときだけ
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
            const gap: XZ[] = [at(o0, 0), at(o1, 0), at(o1, vAt(o1)), at(o0, vAt(o0))];
            const f = flatPoly(gap, h.closed ? 0xc4c4bf : BUILDING_COLOR[h.building], floorY(h.level) + 0.05);
            scene.add(f);
            partsOf(h.level).floors.push(f);
            const gs = slabUnder(gap, h.closed ? 0xc4c4bf : BUILDING_COLOR[h.building], floorY(h.level) + 0.05, h.level);
            scene.add(gs);
            partsOf(h.level).floors.push(gs);
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
    const fromPlan: Entrance[] = openDoors.map((d) => ({ hall: d.hall, level: d.level, at: d.at, width: d.width ?? DOOR_W }));
    // 配置図の切れ目のうち、図面の出入口と重ならないもの（8m より離れている）を足す
    const fromLayout: Entrance[] = openGaps
      .map((o) => ({ hall: o.hall, level: hallById.get(o.hall)?.level ?? 1, at: [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2] as XZ, width: Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) }))
      .filter((e) => !fromPlan.some((d) => Math.hypot(d.at[0] - e.at[0], d.at[1] - e.at[1]) < 8))
      // 2 つのホールのつなぎ目の切れ目は両方のホールに入れてあるので、看板は 1 つだけ
      .filter((e, i, all) => !all.slice(0, i).some((o) => Math.hypot(o.at[0] - e.at[0], o.at[1] - e.at[1]) < 8));
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
    const VIEW_DESK_D = 1.4; // 3D
    const WALK_DESK_D = VIEW_DESK_D; // 歩くときも同じ（机はこのままで、画角を広げて大きく見えすぎないようにする。ユーザーの指示）
    const placeDesks = (v: View) => {
      const d = v === "top" ? TOP_DESK_D : v === "walk" ? WALK_DESK_D : VIEW_DESK_D;
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
    placeDesks("top");
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
        const out = (b.side * (WALK_DESK_D - DESK_D)) / 2;
        const nx = -Math.sin(b.angle), nz = Math.cos(b.angle);
        const cx = b.at[0] + nx * out, cz = b.at[1] + nz * out;
        for (const [j, sgn] of [[0, 1], [1, -1]] as const) {
          const off = WALK_DESK_D / 2 + 0.02;
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
      const topGeo = new THREE.PlaneGeometry(DESK_L / 2 - 0.12, Math.min(0.62, WALK_DESK_D - 0.06));
      const topRects = new Float32Array(index.length * 4);
      const top = new THREE.InstancedMesh(topGeo, numMat, index.length);
      const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
      const yawQ = new THREE.Quaternion();
      index.forEach((bi, k) => {
        const b = booths[bi];
        const cell = numCell.get(`${String(b.num).padStart(2, "0")}${b.half}`)!;
        const out = (b.side * (WALK_DESK_D - DESK_D)) / 2;
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
    // いまいる所（D-2）：青い点と、位置のあいまいさの円。見ている階の床の上に
    const meDot = new THREE.Group();
    {
      const ring = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0x1a73e8, transparent: true, opacity: 0.16, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.name = "acc";
      const dot = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: 0x1a73e8 }));
      dot.rotation.x = -Math.PI / 2;
      dot.position.y = 0.05;
      dot.name = "dot";
      const rim = new THREE.Mesh(new THREE.CircleGeometry(1.35, 32), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = 0.04;
      rim.name = "rim";
      meDot.add(ring, rim, dot);
      meDot.visible = false;
      meDot.renderOrder = 2;
      scene.add(meDot);
    }
    let meAcc = 0;
    // トイレ・救護室までの道（D-3）：床の上のオレンジの帯と、着く所の丸
    let routeMesh: THREE.Mesh | null = null;
    let tourMesh: THREE.Mesh | null = null;
    const showTour = (parts: { pts: XZ[]; level: number }[] | null) => {
      if (tourMesh) {
        scene.remove(tourMesh);
        tourMesh.geometry.dispose();
        (tourMesh.material as THREE.Material).dispose();
        tourMesh = null;
      }
      if (!parts?.length) return;
      const W = 0.4, arr: number[] = [];
      for (const { pts, level } of parts) {
        const y = floorY(level) + 0.12;
        for (let k = 1; k < pts.length; k++) {
          const A = pts[k - 1], B = pts[k], L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
          const nx = (-(B[1] - A[1]) / L) * W, nz = ((B[0] - A[0]) / L) * W;
          arr.push(A[0] + nx, y, A[1] + nz, B[0] + nx, y, B[1] + nz, B[0] - nx, y, B[1] - nz, A[0] + nx, y, A[1] + nz, B[0] - nx, y, B[1] - nz, A[0] - nx, y, A[1] - nz);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      tourMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x8a4fc7, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }));
      tourMesh.renderOrder = 3;
      scene.add(tourMesh);
    };
    const showRoute = (pts: XZ[] | null, level: number) => {
      if (routeMesh) {
        scene.remove(routeMesh);
        routeMesh.geometry.dispose();
        (routeMesh.material as THREE.Material).dispose();
        routeMesh = null;
      }
      if (!pts || pts.length < 2) return;
      const W = 0.7, y = floorY(level) + 0.14, arr: number[] = [];
      for (let k = 1; k < pts.length; k++) {
        const A = pts[k - 1], B = pts[k], L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        const nx = (-(B[1] - A[1]) / L) * W, nz = ((B[0] - A[0]) / L) * W;
        arr.push(A[0] + nx, y, A[1] + nz, B[0] + nx, y, B[1] + nz, B[0] - nx, y, B[1] - nz, A[0] + nx, y, A[1] + nz, B[0] - nx, y, B[1] - nz, A[0] - nx, y, A[1] - nz);
      }
      // 着く所の丸
      const [ex, ez] = pts[pts.length - 1];
      for (let k = 0; k < 24; k++) {
        const a0 = (k / 24) * Math.PI * 2, a1 = ((k + 1) / 24) * Math.PI * 2;
        arr.push(ex, y, ez, ex + Math.cos(a1) * 1.6, y, ez + Math.sin(a1) * 1.6, ex + Math.cos(a0) * 1.6, y, ez + Math.sin(a0) * 1.6);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      routeMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff7a00, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
      routeMesh.renderOrder = 3;
      scene.add(routeMesh);
      // 道が全部見える所へ（歩いているときは動かさない）
      if (current !== "walk") {
        const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
        focusPoint(new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, floorY(level), (Math.min(...zs) + Math.max(...zs)) / 2), false);
      }
    };
    // 遠くから見ても見えるように、点の大きさは画面の上で 14px ほどに
    const sizeMe = () => {
      if (!meDot.visible) return;
      const ppm = (() => {
        const h = el.clientHeight;
        if (current === "top") return (h * ortho.zoom) / (2 * 160);
        return h / (2 * Math.max(0.1, camera.position.distanceTo(meDot.position)) * Math.tan((persp.fov * Math.PI) / 360));
      })();
      const r = Math.max(0.6, 7 / ppm);
      meDot.getObjectByName("dot")!.scale.setScalar(r);
      meDot.getObjectByName("rim")!.scale.setScalar(r);
      meDot.getObjectByName("acc")!.scale.setScalar(Math.max(meAcc, r * 1.5));
    };
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
    // 2D の画面の向き（右 = TOP_RIGHT、上 = TOP_UP）で測った広がり
    const rs = all.map((p) => p[0] * TOP_RIGHT[0] + p[1] * TOP_RIGHT[1]), us = all.map((p) => p[0] * TOP_UP[0] + p[1] * TOP_UP[1]);
    const bounds = { minR: Math.min(...rs), maxR: Math.max(...rs), minU: Math.min(...us), maxU: Math.max(...us) };
    const midR = (bounds.minR + bounds.maxR) / 2, midU = (bounds.minU + bounds.maxU) / 2;
    const focus = new THREE.Vector3(midR * TOP_RIGHT[0] + midU * TOP_UP[0], 0, midR * TOP_RIGHT[1] + midU * TOP_UP[1]);
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
    let yaw = 0, pitch = WALK_PITCH;
    let hold: -1 | 0 | 1 = 0;
    let lastRailDir: XZ | null = null; // 線の上で最後に進んだ向き（横を向いて進むとき、向きを決めるため）
    const keys = new Set<string>();
    let fly: { t: number; from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3 } | null = null;
    // 歩くときは、机の前の通路の線（線路）の上だけを進む。線から遠い所（机のない広場など）に立ったときは、自由に歩く
    // ホールの中の線（机の前の通路）に、通路・広場・階段の線（scripts/build-corridors.ts）を足して、出入口でつなぐ
    // 組み立てには 0.3〜0.7 秒ほどかかるので、開いたときには作らない。最初に要ったとき（歩く・場所を選ぶ）か、
    // 画面が出たあとの手のあいている時に作る（walkR()）
    const buildWalkRails = () => {
      const desksByHall = new Map<string, XZ[]>();
      for (const b of booths) (desksByHall.get(b.hall) ?? desksByHall.set(b.hall, []).get(b.hall)!).push(b.at);
      // 床から立つ部屋の箱（階段室・ロッカー・部屋の帯など）は、線が通らないように
      const rooms = (venue.blocks ?? []).filter((b) => !b.base);
      return addCorridors(buildRails(lines, booths, venue.halls, features, rooms), corridorsJson as unknown as Corridors, venue.doors, venue.exits ?? [], venue.halls, desksByHall, venue.wallGaps ?? [], features, rooms);
    };
    // 線の上の位置の高さ（階段の線では、上と下の端のあいだ）
    // 階段の線の上の点の高さ：段の上の面（段は斜めの線より上に出ているので、線をまっすぐ結ぶと段の中に隠れる。ユーザーの指示）
    const stepTopAt = (p: XZ, la: number, lb: number, t: number) => {
      const lin = floorY(la) + (floorY(lb) - floorY(la)) * t;
      let best = lin, bd = Infinity;
      for (const s of stairProfiles) {
        const rx = p[0] - s.to[0], rz = p[1] - s.to[1];
        const along = rx * s.dir[0] + rz * s.dir[1], side = Math.abs(-rx * s.dir[1] + rz * s.dir[0]);
        if (along < -1 || along > s.run + 1 || side > s.w / 2 + 1.5 || side >= bd) continue;
        // 段の前のふち（角）を結んだ線。下から見上げても、段のうしろに隠れない
        const k = (Math.max(0, along) / s.run) * s.n + 1;
        const top = s.y0 + (s.yTop - s.y0) * Math.min(1, k / s.m0);
        [best, bd] = [Math.max(lin, Math.min(top, Math.max(floorY(la), floorY(lb)) + 0.1)), side];
      }
      return best;
    };
    const railY = (q: RailPos) => {
      const la = walkR().nodes[q.a].level, lb = walkR().nodes[q.b].level;
      if (la === lb) return floorY(la);
      const A = walkR().nodes[q.a].p, B = walkR().nodes[q.b].p;
      return stepTopAt([A[0] + (B[0] - A[0]) * q.t, A[1] + (B[1] - A[1]) * q.t], la, lb, q.t);
    };
    // 高さからいちばん近い階（1・2・4）
    const levelAtY = (y: number) => [1, 2, 4].reduce((b, l) => (Math.abs(floorY(l) - y) < Math.abs(floorY(b) - y) ? l : b), 1);
    // 見ている階で線に乗れる階（1・2F を見ているときは 1F と 2F）
    const railLevels = (f: Floor) => (f === 4 ? [4] : [1, 2]);
    let railPos: RailPos | null = null;
    const RAIL_SNAP = 14; // 立った所からこの距離に線があれば、線に乗る
    const snapToRails = () => {
      const p: XZ = [persp.position.x, persp.position.z];
      const hall = venue.halls.find((h) => floorOf(h.level) === currentFloor && !h.closed && pointInPolygon(p, h.poly));
      // ホールの中ならそのホールの線、外なら見ている階の通路の線（1F と 2F が重なる所は、近いほう）
      let q = hall ? nearestOnRails(walkR(), p, hall.id) : nearestOnRails(walkR(), p, undefined, railLevels(currentFloor));
      if (!hall && currentFloor === 1) {
        // 1F と 2F の線が重なる所（2F のコンコースの下など）では、近さが 4m の差までなら 1F を選ぶ
        const q1 = nearestOnRails(walkR(), p, undefined, [1]);
        if (q1 && q && q1.d <= q.d + 4) q = q1;
      }
      // 近くに線がなければ、見ている階のいちばん近い線へ（線の外には立たない。ユーザーの指示）
      if (!q || q.d >= RAIL_SNAP) q = nearestOnRails(walkR(), p, undefined, railLevels(currentFloor)) ?? nearestOnRails(walkR(), p);
      if (q) {
        railPos = { a: q.a, b: q.b, t: q.t };
        persp.position.x = q.at[0];
        persp.position.z = q.at[1];
      } else railPos = null;
    };
    if (process.env.NODE_ENV !== "production")
      (window as unknown as { __walkDbg?: () => unknown }).__walkDbg = () => ({
        pos: [persp.position.x, persp.position.z],
        yaw,
        railPos,
        at: railPos ? railPoint(walkR(), railPos) : null,
        nodes: walkR().nodes.length,
        near: walkR().nodes.map((n, i) => [i, n.p, walkR().adj[i]] as const).filter(([, q]) => Math.hypot(q[0] - persp.position.x, q[1] - persp.position.z) < 6),
      });
    // 線路の絵（床の上の細い帯）。歩くときだけ、見ている階のものを出す
    const railMeshes: { mesh: THREE.Mesh; levels: number[] }[] = [];
    const railLines: { line: LineSegments2; levels: number[] }[] = [];
    const railLineMats: LineMaterial[] = []; // 太い線の材質（画面の大きさを教える）
    let railsPick = false; // 歩き始める場所を選んでいるあいだ
    let lastWalkLevel = 1;
    let walkRails: Rails | null = null;
    // 線を組み立てて、線路の絵も作る（1 回だけ）
    const walkR = (): Rails => {
      if (walkRails) return walkRails;
      walkRails = buildWalkRails();
      const wr = walkRails;
      // 階ごと（1F・2F・4F）にまとめる。階段の線は、上と下の階の組ごと（"1-2" など）。
      // 歩いているときは、いま立っている階の線と、その階につながる階段の線だけを出す（ほかの階の線が重なって見えないように）
      const keyOf = (la: number, lb: number) => (la === lb ? String(la) : `${Math.min(la, lb)}-${Math.max(la, lb)}`);
      const byKey = new Map<string, { tri: number[]; seg: number[] }>();
      const W = 0.3; // 帯の幅の半分（幅 0.6m。ユーザーの指示で太く）
      wr.adj.forEach((ns, a) => {
        const A = wr.nodes[a];
        for (const b of ns) {
          if (b < a) continue;
          const B = wr.nodes[b];
          const k = keyOf(A.level, B.level);
          if (!byKey.has(k)) byKey.set(k, { tri: [], seg: [] });
          const L = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]) || 1;
          const nx = (-(B.p[1] - A.p[1]) / L) * W, nz = ((B.p[0] - A.p[0]) / L) * W;
          // 階段の線は細かく分けて、段の上の面にのせる
          const parts = A.level === B.level ? 1 : Math.max(2, Math.ceil(L / 0.25));
          for (let j = 0; j < parts; j++) {
            const t0 = j / parts, t1 = (j + 1) / parts;
            const P: XZ = [A.p[0] + (B.p[0] - A.p[0]) * t0, A.p[1] + (B.p[1] - A.p[1]) * t0];
            const Q: XZ = [A.p[0] + (B.p[0] - A.p[0]) * t1, A.p[1] + (B.p[1] - A.p[1]) * t1];
            const ya = (A.level === B.level ? floorY(A.level) : stepTopAt(P, A.level, B.level, t0)) + 0.09; // 床（+0.05）の上
            const yb = (A.level === B.level ? floorY(A.level) : stepTopAt(Q, A.level, B.level, t1)) + 0.09;
            byKey.get(k)!.tri.push(P[0] + nx, ya, P[1] + nz, Q[0] + nx, yb, Q[1] + nz, Q[0] - nx, yb, Q[1] - nz, P[0] + nx, ya, P[1] + nz, Q[0] - nx, yb, Q[1] - nz, P[0] - nx, ya, P[1] - nz);
            byKey.get(k)!.seg.push(P[0], ya + 0.11, P[1], Q[0], yb + 0.11, Q[1]);
          }
        }
      });
      const mat = new THREE.MeshBasicMaterial({ color: 0x2f6fd6, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
      // 上から・3D で歩き始める場所を選ぶあいだは、遠くからでも見える細い線（画面の上で 1px）。2F の線は紫で、1F の線と分ける
      // 床・壁・屋根の向こうの線は隠す（透けて見えると、どこの線かわからない。ユーザーの指示）
      // 線の太さは画面の上で 3.5px（遠くからでも見えるよう。ユーザーの指示で太く）
      const lineMat = new LineMaterial({ color: 0x2f6fd6, linewidth: 3.5, transparent: true, opacity: 0.9 });
      const lineMat2F = new LineMaterial({ color: 0x9b4fd0, linewidth: 3.5, transparent: true, opacity: 0.9 });
      railLineMats.push(lineMat, lineMat2F);
      for (const [k, { tri, seg }] of byKey) {
        const levels = k.split("-").map(Number);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
        const mesh = new THREE.Mesh(g, mat);
        mesh.visible = false;
        mesh.renderOrder = 1;
        scene.add(mesh);
        railMeshes.push({ mesh, levels });
        const g2 = new LineSegmentsGeometry();
        g2.setPositions(seg);
        const line = new LineSegments2(g2, levels.includes(2) ? lineMat2F : lineMat);
        line.visible = false;
        line.renderOrder = 4;
        scene.add(line);
        railLines.push({ line, levels });
      }
      for (const m of railLineMats) m.resolution.set(el.clientWidth, el.clientHeight);
      applyVisibility();
      return wr;
    };

    const size = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      for (const m of railLineMats) m.resolution.set(w, h);
      persp.aspect = w / h;
      if (current === "walk") persp.fov = walkFov(persp.aspect);
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
      const prev = current;
      current = v;
      // 2D（真上から）では、会議棟は下の 2F のプラザを隠すので出さない
      for (const m of towerMeshes) m.visible = v !== "top";
      fly = null;
      const labelSprites = new Set(labels.map((l) => l.s));
      // 歩くときは、札（WC・搬入口・エスカレーターなど）も床・壁の向こうのものは隠す（透けて見えると、どこのものかわからない。ユーザーの指示）
      for (const s of sprites) s.material.depthTest = v !== "top" && (v === "walk" || !labelSprites.has(s));
      persp.fov = v === "walk" ? walkFov(persp.aspect) : 50;
      persp.updateProjectionMatrix();
      if (v === "top") {
        camera = ortho;
        // 真上から少しだけ下の向きへずらして置くと、画面の上が TOP_UP の向きになる
        ortho.position.set(focus.x - TOP_UP[0] * 0.01, 600, focus.z - TOP_UP[1] * 0.01);
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
        // パソコン：左ドラッグは床に沿って水平に動かし、右ドラッグで向きを変える。拡大はホイール（ユーザーの指示）。
        // スマホのタッチは three.js の初めのまま（1 本指で回し、2 本指でつまんで拡大・ずらして移動）。ユーザーの指示「スマホだけ戻せないかな」
        c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
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
        pitch = WALK_PITCH;
        // 2D から歩くに入ったときは、2D の画面の上の向き（机の列の向き）を向いて立つ
        if (prev === "top") yaw = Math.atan2(-TOP_UP[0], -TOP_UP[1]);
        snapToRails();
      }
      placeDesks(v);
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
      // 歩いているとき：いま立っている階（線の上の高さから）の線と、その階につながる階段の線
      const walkLevel = railPos ? levelAtY(railY(railPos)) : currentFloor;
      for (const { mesh, levels } of railMeshes) mesh.visible = current === "walk" && levels.includes(walkLevel);
      for (const { line, levels } of railLines) line.visible = railsPick && current !== "walk" && levels.some((l) => shown(floorOf(l)));
      pin.visible = pinOn && current === "orbit"; // 上からは真上から見た丸がとなりの机を隠すので出さない（選んだ机はオレンジになる）
    };
    const setFloor = (f: Floor) => {
      currentFloor = f;
      applyVisibility();
      // 歩いていて、線の上ですでにその階にいる（階段をのぼって階が変わった）ときは、立つ所を変えない
      const onThisFloor = current === "walk" && railPos && (railY(railPos) > (floorY(2) + floorY(4)) / 2 ? 4 : 1) === f;
      if (current === "walk" && !onThisFloor) {
        persp.position.y = eyeY();
        snapToRails();
      }
      focus.y = floorY(f);
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
        startFly(p.clone(), new THREE.Vector3(p.x - TOP_UP[0] * 0.01, 600, p.z - TOP_UP[1] * 0.01));
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
        // 机の前の線に乗り、机を向く
        let q = nearestOnRails(walkR(), b.at, b.hall);
        if (!q || q.d >= RAIL_SNAP) q = nearestOnRails(walkR(), b.at, undefined, [lv]) ?? q;
        if (q) {
          railPos = { a: q.a, b: q.b, t: q.t };
          persp.position.x = q.at[0];
          persp.position.z = q.at[1];
        } else railPos = null;
        yaw = Math.atan2(persp.position.x - b.at[0], persp.position.z - b.at[1]);
        pitch = WALK_PITCH;
        focus.copy(p);
      } else focusPoint(p, true);
    };
    // 列の机が全部見える所へ（2D は倍率、3D はカメラの距離を、列の広がりから）。選んだ机の印は外す
    const focusLine = (line: number) => {
      const bs = booths.filter((b) => b.line === line);
      if (!bs.length) return;
      const lv = hallById.get(bs[0].hall)!.level;
      if (!shown(floorOf(lv))) setFloor(floorOf(lv));
      const xs = bs.map((b) => b.at[0]), zs = bs.map((b) => b.at[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const span = Math.max(12, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 8;
      const p = new THREE.Vector3(cx, floorY(lv), cz);
      pinOn = false;
      applyVisibility();
      focus.copy(p);
      if (current === "top") {
        startFly(p.clone(), new THREE.Vector3(p.x - TOP_UP[0] * 0.01, 600, p.z - TOP_UP[1] * 0.01));
        // 列の広がりが、画面の短い辺の 8 割に入る倍率
        const ppm = (0.8 * Math.min(el.clientWidth, el.clientHeight)) / span;
        ortho.zoom = (ppm * 2 * 160) / el.clientHeight;
        ortho.updateProjectionMatrix();
      } else if (current === "orbit") {
        const d = span / (2 * Math.tan((persp.fov * Math.PI) / 360)) / 0.8;
        startFly(p.clone(), p.clone().add(new THREE.Vector3(-12, 22, 28).normalize().multiplyScalar(d)));
      } else {
        persp.position.set(cx, floorY(lv) + EYE, cz);
        snapToRails();
      }
    };
    // 歩く：(x, z) に立つ。向きは、それまで見ていた向き（真上から見ていたときは、2D の画面の上の向き）
    const standAt = (x: number, z: number) => {
      persp.position.set(x, eyeY(), z);
      snapToRails();
      pitch = WALK_PITCH;
      focus.set(x, floorY(currentFloor), z);
    };
    const focusHall = (id: string) => {
      const h = hallById.get(id)!;
      if (!shown(floorOf(h.level))) setFloor(floorOf(h.level));
      const [x, z] = centroid(h.poly);
      const p = new THREE.Vector3(x, floorY(h.level), z);
      if (current === "walk") {
        persp.position.set(x, floorY(h.level) + EYE, z);
        snapToRails();
        focus.copy(p);
      } else {
        if (current === "top") {
          ortho.zoom = 2.2;
          ortho.updateProjectionMatrix();
        }
        focusPoint(p, false);
      }
    };

    const genreSprites: THREE.Sprite[] = [];
    const recolor = (colorByGenre: boolean, marks: Record<string, Mark>, visited: Record<string, number>, sel: number | null, dayTags: Record<string, SpaceTag> | null, genre: string | null, work: string | null, char: string | null) => {
      const col = new THREE.Color();
      // ジャンル・作品（とキャラ）を選んでいるとき、その机か
      const hit = (b: Booth) => {
        if (dayTags && genre && dayTags[b.code]?.genre !== genre) return false;
        if (!work && !char) return true;
        if (dayTags) {
          const t = dayTags[b.code];
          if (work && !t?.works?.includes(work)) return false;
          if (!char) return true;
          // キャラ・グループだけを選んだとき（作品を選ばずに）は、どの作品のキャラでもよい
          return work ? !!t?.chars?.[work]?.includes(char) : Object.values(t?.chars ?? {}).some((l) => l.includes(char));
        }
        return !work || lines[b.line].genre === work;
      };
      // 色分けの名前：絞りこんでいないときは、机の作品（なければジャンル）。ジャンル・作品・キャラで絞りこんだときは、
      // キャラ・グループごと（キャラが入っていなければ作品、それもなければジャンル）。色もこの名前で決める（ユーザーの指示）
      const narrowed = !!(genre || work || char);
      const keyOf = (b: Booth): string | null => {
        const t = dayTags?.[b.code];
        if (!t) return null;
        if (!narrowed) return t.works?.[0] ?? t.genre ?? null;
        if (char) return char;
        const ws = work ? [work] : (t.works ?? []);
        for (const w of ws) {
          const c = t.chars?.[w]?.find((x) => x);
          if (c) return c;
        }
        return ws.find((w) => w !== genre) ?? t.genre ?? null;
      };
      for (const { mesh, index } of deskMeshes.values()) {
        index.forEach((bi, k) => {
          const b = booths[bi];
          if (bi === sel) col.setHex(SELECT_COLOR);
          else if (visited[b.code]) col.setHex(VISITED_COLOR);
          else if (marks[b.code]) col.setHex(MARK[marks[b.code]].color);
          else if (colorByGenre && !hit(b)) col.setHex(0xe6e5de); // 選んだ作品でない机は薄く
          else if (colorByGenre && dayTags) {
            // 入れた作品の色（選んだ作品があればその色。なければ 1 つ目の作品の色。作品が入っていない机はジャンルの色、どちらもなければ白）
            const w = keyOf(b);
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
      // 色分けの名前の札：同じ名前で、となり合う机（9m 以内。となりの島まで）のまとまりごとに 1 枚、まとまりの真ん中に（4 スペース以上のまとまりだけ）
      for (const s of genreSprites) {
        scene.remove(s);
        s.material.map?.dispose();
        s.material.dispose();
      }
      genreSprites.length = 0;
      for (let i = labels.length - 1; i >= 0; i--) if (labels[i].kind === "genre") labels.splice(i, 1);
      if (!colorByGenre || !dayTags) return;
      const groups = new Map<string, { bi: number; x: number; z: number; lv: number }[]>();
      booths.forEach((b, bi) => {
        if (!hit(b)) return;
        const key = keyOf(b);
        if (!key) return;
        const lv = hallById.get(b.hall)?.level ?? 1;
        const g = `${lv}|${key}`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push({ bi, x: b.at[0], z: b.at[1], lv });
      });
      const R = 9; // となりの島（7m おき）までは同じまとまり
      for (const [g, list] of groups) {
        const key = g.slice(g.indexOf("|") + 1);
        const cell = new Map<string, number[]>();
        list.forEach((q, i) => {
          const c = `${Math.floor(q.x / R)},${Math.floor(q.z / R)}`;
          if (!cell.has(c)) cell.set(c, []);
          cell.get(c)!.push(i);
        });
        const seen = new Array(list.length).fill(false);
        for (let i0 = 0; i0 < list.length; i0++) {
          if (seen[i0]) continue;
          const stack = [i0], comp: number[] = [];
          seen[i0] = true;
          while (stack.length) {
            const i = stack.pop()!;
            comp.push(i);
            const cx = Math.floor(list[i].x / R), cz = Math.floor(list[i].z / R);
            for (let dx = -1; dx <= 1; dx++)
              for (let dz = -1; dz <= 1; dz++)
                for (const j of cell.get(`${cx + dx},${cz + dz}`) ?? []) {
                  if (seen[j] || Math.hypot(list[j].x - list[i].x, list[j].z - list[i].z) > R) continue;
                  seen[j] = true;
                  stack.push(j);
                }
          }
          if (comp.length < 4) continue;
          const mx = comp.reduce((a, i) => a + list[i].x, 0) / comp.length, mz = comp.reduce((a, i) => a + list[i].z, 0) / comp.length;
          // 地は机の色を暗くしたもの、文字は白（明るい地に黒い文字は見にくい：ユーザーの指摘）
          const s = textSprite(key, { bg: workColor(key).replace(/56%\)$/, "34%)"), fg: "#fff", height: 2.6, px: 32 });
          s.position.set(mx, floorY(list[comp[0]].lv) + 2.8, mz);
          s.userData.level = list[comp[0]].lv;
          s.renderOrder = 11;
          scene.add(s);
          genreSprites.push(s);
          addLabel(s, "genre");
        }
      }
      placeLabels();
    };

    // ---- タップで机を選ぶ（ドラッグとは分ける） ----
    const ray = new THREE.Raycaster();
    const pick = (i: number) => {
      setSelected(i);
      onSelectBooth.current(i);
      setPickLine(booths[i].line);
      setPickNum(booths[i].num);
      setPickHalf(booths[i].half);
    };
    // touch：指で動かした（スマホ）。歩くときの左右の向きを、景色をつかんで動かす向きにする
    let down: { x: number; y: number; yaw: number; pitch: number; touch: boolean } | null = null;
    // 歩くとき：ストリートビューのように、床をダブルタップするとそこへ歩いていく
    let lastTap: { t: number; x: number; y: number } | null = null;
    const floorAt = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      // 歩いているときは、いま立っている高さ（2F の通路など）の床で
      const y = current === "walk" && railPos ? railY(railPos) : floorY(currentFloor);
      return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
    };
    // 青い線（線路）をダブルタップしたら、その線の上へすぐ移る（ユーザーの指示）。向きは変えない
    const JUMP_NEAR = 12; // 押した所からこの距離までに線があれば、そこへ跳ぶ
    const walkTo = (p: THREE.Vector3) => {
      // ダブルタップした所に、いちばん近い線の上の点へ跳ぶ（いま立っている階の線。線の外へは行かない：ユーザーの指示）。
      // 線から遠すぎる所（空・建物の外など）を押したときは動かない
      const curLevel = railPos ? (railY(railPos) > floorY(4) - 1 ? 4 : railY(railPos) > floorY(2) - 1 ? 2 : 1) : currentFloor === 4 ? 4 : 1;
      const q = nearestOnRails(walkR(), [p.x, p.z], undefined, [curLevel]);
      if (!q || q.d > JUMP_NEAR) return;
      railPos = { a: q.a, b: q.b, t: q.t };
      persp.position.x = q.at[0];
      persp.position.z = q.at[1];
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, yaw, pitch, touch: e.pointerType === "touch" };
      if (current === "walk") renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!down || current !== "walk") return;
      // スマホ（指）は、景色をつかんで動かす向き（右へなぞると左を向く。ユーザーの指示）。
      // パソコン（マウス）は、これまでどおり、なぞった方を向く
      yaw = down.yaw + (e.clientX - down.x) * (down.touch ? 0.005 : -0.005);
      // 上下には動かさない（左右の向きだけ）
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
      // 歩いているときは、机の上に立てた札も押せる（札を押したら、その札の机。札の奥の机が選ばれないように）
      if (current === "walk") {
        const cards = [...(hallCards.get(walkHall)?.sheets ?? [])].filter((sh) => sh.mesh.visible);
        const ch = ray.intersectObjects(cards.map((sh) => sh.mesh), false)[0];
        if (ch && ch.faceIndex != null) {
          const sh = cards.find((x) => x.mesh === ch.object)!;
          const bi = sh.booths[Math.floor(ch.faceIndex / 2)];
          // 札より手前に机があれば、そちらを選ぶ
          const near = ray.intersectObjects([...deskMeshes.entries()].filter(([lv]) => shown(floorOf(lv))).map(([, d]) => d.mesh), false)[0];
          if (bi !== undefined && (!near || near.distance >= ch.distance)) {
            pick(bi);
            return;
          }
        }
      }
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
    const setPins = (list: { booth: number; mark: Mark | null; done: boolean; order?: number }[]) => {
      for (const p of pins) {
        scene.remove(p.s);
        p.s.material.map?.dispose();
        p.s.material.dispose();
      }
      pins.length = 0;
      for (const { booth, mark, done, order } of list) {
        const b = booths[booth];
        const lv = hallById.get(b.hall)!.level;
        // 行った机は灰色に ✓（ユーザーの指示：行った所はピンの色を変える）。回る順を出しているときは、印の代わりに順番の数
        const s = done || !mark ? pinSprite(VISITED_COLOR, "✓") : pinSprite(MARK[mark].color, order ? String(order) : MARK[mark].icon);
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
    // 1F と 4F の両方を見ているとき、上の階の床（不透明な床とホール）にさえぎられる点か。
    // 机の番号と札は深さで切らずに描いているので、床ごしに下の階の番号・札が見えてしまう（ユーザーの指摘）。
    // 点からカメラへの線（上から見る 2D は真上への線）が、点より上の床の高さを横切る所が、その床の中なら隠れている
    const roofs = [
      ...venue.halls.filter((h) => h.level > 1).map((h) => ({ y: floorY(h.level), poly: h.poly, holes: [] as XZ[][] })),
      ...venue.areas.filter((a) => a.level > 1 && !a.see && !a.sur).map((a) => ({ y: floorY(a.level), poly: a.poly, holes: a.holes ?? [] })),
      // 箱（南の角の建物の 3F より上など）の上の面も
      ...(venue.blocks ?? []).map((b) => ({ y: floorY(b.level) + (b.base ?? 0) + b.height, poly: b.poly, holes: [] as XZ[][] })),
    ].map((r) => {
      const xs = r.poly.map((p) => p[0]), zs = r.poly.map((p) => p[1]);
      return { ...r, box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] };
    });
    const covered = (x: number, y: number, z: number) => {
      if (!bothFloors || current === "walk") return false;
      const cp = camera.position;
      for (const r of roofs) {
        if (r.y <= y + 0.3) continue;
        let qx = x, qz = z;
        if (current !== "top") {
          if (cp.y <= r.y) continue;
          const t = (r.y - y) / (cp.y - y);
          qx = x + (cp.x - x) * t;
          qz = z + (cp.z - z) * t;
        }
        if (qx < r.box[0] || qx > r.box[2] || qz < r.box[1] || qz > r.box[3]) continue;
        if (pointInPolygon([qx, qz], r.poly) && !r.holes.some((h) => pointInPolygon([qx, qz], h))) return true;
      }
      return false;
    };
    let hereName = "";
    const placeLabels = () => {
      const walk = current === "walk";
      for (const { s, kind, base } of labels) {
        let show = (kind === "genre" ? shown(floorOf(s.userData.level as number)) : s.userData.levelOn !== false) && !(s.userData.topOnly && current !== "top");
        if (walk) {
          s.scale.copy(base);
          if (kind === "hall" || kind === "genre") show = false;
        } else {
          const ppm = pxPerM(s.position);
          s.scale.copy(base).multiplyScalar(LABEL_PX[kind] / (base.y * ppm));
          if (kind === "hall" && ppm >= 3.5) show = false;
          if (kind === "block" && ppm < 2.2) show = false;
          if (kind === "area" && ppm < 0.9) show = false;
          if (kind === "sur" && (ppm < 1.3 || !surroundings.visible)) show = false;
        }
        if (show && covered(s.position.x, s.position.y, s.position.z)) show = false;
        s.visible = show;
      }
      hideBehindWalls();
      for (const { s, base } of stationLabels) {
        s.scale.copy(base);
        if (!walk) s.scale.multiplyScalar(18 / (base.y * pxPerM(s.position)));
        // 駅の名前は建物や駅の屋根に隠さない（ほかの札と重なる所は下の重なりの処理で隠す）
        s.material.depthTest = current !== "top" && (walk || !s.userData.station);
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
        for (const k of ["aid", "genre", "door", "wc", "shutter", "sur"] as const)
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
    // 上からの見方は真上から TOP_UP の向きを上に見ているので、画面の位置は (x, z) を TOP_RIGHT・TOP_UP の向きに分けて拡大する
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
              if (covered(x, y, z)) continue;
              const at = scr(x, y, z);
              if (at) write(full ? `${sp.block}-${String(sp.num).padStart(2, "0")}${sp.half}` : `${String(sp.num).padStart(2, "0")}${sp.half}`, px, at, 1 / ppm);
            }
          } else if (ppm * DESK_L >= 14) {
            if (covered(mx, y, mz)) continue;
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
        if (covered(x0, y, z0)) continue;
        const at = scr(x0 + c * inward - sn * side, y, z0 + sn * inward + c * side);
        if (at) write(String(e.num).padStart(2, "0"), 10, at, 1 / ppm);
      }
      flushItems();
    };
    // 歩いて見るときの札：机の上に立てた板（ユーザーの指示：画面の上に出すと、向きを変えるたびに出たり消えたりしてややこしい。
    // すべて固定して、机と平行に並べる）。いるホールの机ぜんぶに、通路の側を向けて立てる。1 つのサークルが 2 スペース（a・b）なら 1 枚。
    // ホールごとに、札を並べた 1 枚の絵と、板をまとめた 1 つの形にする（机の数だけ絵を作ると重い）
    const hallBooths = new Map<string, number[]>();
    booths.forEach((b, i) => {
      if (!hallBooths.has(b.hall)) hallBooths.set(b.hall, []);
      hallBooths.get(b.hall)!.push(i);
    });
    let cardsVer = 0; // 日・作品・サークルの情報が変わったら作り直す
    let walkHall = "";
    // 札の絵は、64 枚ずつの小さな絵（シート）に分ける。大きな絵を 1 度に GPU へ送ると、ホールに入ったときに 1〜2 秒止まった。
    // シートは 1 コマに 1 枚ずつ送り、送るまでは出さない。画像が読めたら、そのシートだけ（0.4 秒に 1 回まで）送り直す
    // booths：板（三角 2 つずつ）の順に、その札の机（押したときに選ぶ）
    type Sheet = { mesh: THREE.Mesh; tex: THREE.CanvasTexture; sent: boolean; dirty: boolean; dirtyAt: number; booths: number[] };
    // pend：まだ画像を描いていない札（近くに来たら読む）
    type PendCard = { x: number; z: number; nx: number; nz: number; src: string; draw: (im: HTMLImageElement) => void };
    const hallCards = new Map<string, { sheets: Sheet[]; ver: number; used: number; pend: PendCard[]; wait: Map<string, PendCard[]>; scan: number; srcs: Set<string> }>();
    // 画像を読むのは、立っている所から IMG_NEAR m 以内の札だけ（電波があるとき。印のサークルは端末に持っているので、電波がなくても）
    const IMG_NEAR = 25;
    const CARD_W = 0.8, CARD_H = 1.0, CELL_W = 120, CELL_H = 150, SHEET_COLS = 8, SHEET_ROWS = 8, PER_SHEET = SHEET_COLS * SHEET_ROWS;
    // 読みこんだ画像（ホール・日をまたいで使い回す）
    const cardImgs = new Map<string, HTMLImageElement | "loading">();
    const cardFail = new Map<string, number>(); // 読めなかった画像（しばらくは読み直さない）
    // 読み終わるのを待つ札。読めなかったときは null で知らせる（その札は、あとで読み直す）
    const cardImgWait = new Map<string, ((im: HTMLImageElement | null) => void)[]>();
    const withImg = (src: string, f: (im: HTMLImageElement | null) => void) => {
      const got = cardImgs.get(src);
      if (got && got !== "loading") return f(got);
      (cardImgWait.get(src) ?? cardImgWait.set(src, []).get(src)!).push(f);
      if (got) return;
      cardImgs.set(src, "loading");
      cardLoadQueue.push(src);
      pumpCardLoads();
    };
    // 画像は 3 つずつ読む（一度に何百も読みはじめると、読みこみの処理でしばらく止まる）
    const cardLoadQueue: string[] = [];
    let cardLoading = 0;
    const pumpCardLoads = () => {
      while (cardLoading < 3 && cardLoadQueue.length) {
        const src = cardLoadQueue.shift()!;
        cardLoading++;
        const im = new Image();
        const done = (ok: boolean) => {
          cardLoading--;
          const cbs = cardImgWait.get(src) ?? [];
          cardImgWait.delete(src);
          if (ok) {
            cardImgs.set(src, im);
            cardFail.delete(src);
          }
          else {
            cardImgs.delete(src);
            cardFail.set(src, performance.now());
          }
          for (const cb of cbs) cb(ok ? im : null);
          setTimeout(pumpCardLoads, 0);
        };
        im.onload = () => done(true);
        im.onerror = () => done(false);
        im.src = imgUrl(src);
      }
    };
    let lastCardUpload = 0;
    // 読めた画像を札の絵に描く仕事。1 コマに数ミリ秒ぶんずつ（一度に何百枚も描くと、しばらく止まる）
    const cardDrawQueue: (() => void)[] = [];
    const dropHallCards = (hallId: string) => {
      const e = hallCards.get(hallId);
      if (!e) return;
      for (const sh of e.sheets) {
        scene.remove(sh.mesh);
        sh.mesh.geometry.dispose();
        sh.tex.dispose();
        (sh.mesh.material as THREE.MeshBasicMaterial).dispose();
      }
      hallCards.delete(hallId);
      // 残っているホールの札が使わない画像は捨てる（いろいろなホールを歩くと、読んだ画像がたまっていく）
      const used = new Set<string>();
      for (const o of hallCards.values()) for (const s of o.srcs) used.add(s);
      for (const [src, v] of cardImgs) if (v !== "loading" && !used.has(src)) cardImgs.delete(src);
    };
    const buildHallCards = (hallId: string) => {
      dropHallCards(hallId);
      const hall = hallById.get(hallId);
      if (!hall) return;
      const info = cardInfo.current;
      const items: { x: number; z: number; ax: number; az: number; bi: number; c: { name: string; image: string; sub: string } }[] = [];
      const seen = new Set<string>();
      for (const i of hallBooths.get(hallId) ?? []) {
        const b = booths[i];
        const c = info(b.code);
        if (!c) continue;
        const id = c.name ? `${c.name}|${b.line}|${b.num}` : b.code;
        if (seen.has(id)) continue;
        seen.add(id);
        const nb = booths[i + 1];
        const pair = !!c.name && nb?.line === b.line && nb?.num === b.num && info(nb.code)?.name === c.name;
        items.push({ x: pair ? (b.at[0] + nb.at[0]) / 2 : b.at[0], z: pair ? (b.at[1] + nb.at[1]) / 2 : b.at[1], ax: Math.cos(b.angle), az: Math.sin(b.angle), bi: i, c });
      }
      // このホールの歩く線を 4m の升目に入れておく（机ごとに会場の線を全部見ると、ホールに入るたびに 1 秒近くかかった）
      const eg = new Map<string, [number, number][]>();
      walkR().adj.forEach((ns, a2) => {
        if (walkR().nodes[a2].hall !== hallId) return;
        for (const b2 of ns) {
          if (b2 < a2 || walkR().nodes[b2].hall !== hallId) continue;
          const A = walkR().nodes[a2].p, B = walkR().nodes[b2].p;
          for (let gx = Math.floor(Math.min(A[0], B[0]) / 4); gx <= Math.floor(Math.max(A[0], B[0]) / 4); gx++)
            for (let gz = Math.floor(Math.min(A[1], B[1]) / 4); gz <= Math.floor(Math.max(A[1], B[1]) / 4); gz++) {
              const key2 = `${gx},${gz}`;
              (eg.get(key2) ?? eg.set(key2, []).get(key2)!).push([a2, b2]);
            }
        }
      });
      const nearLine = (x: number, z: number): XZ | null => {
        let best: XZ | null = null, bd = Infinity;
        for (let gx = Math.floor(x / 4) - 1; gx <= Math.floor(x / 4) + 1; gx++)
          for (let gz = Math.floor(z / 4) - 1; gz <= Math.floor(z / 4) + 1; gz++)
            for (const [a2, b2] of eg.get(`${gx},${gz}`) ?? []) {
              const A = walkR().nodes[a2].p, B = walkR().nodes[b2].p, dx = B[0] - A[0], dz = B[1] - A[1], L2 = dx * dx + dz * dz || 1;
              const t = Math.max(0, Math.min(1, ((x - A[0]) * dx + (z - A[1]) * dz) / L2));
              const qx = A[0] + dx * t, qz = A[1] + dz * t, d = Math.hypot(qx - x, qz - z);
              if (d < bd) [best, bd] = [[qx, qz], d];
            }
        return best;
      };
      // 近い机から（近くの札の絵・画像が先にそろう）
      const cp0 = persp.position;
      items.sort((p2, q2) => Math.hypot(p2.x - cp0.x, p2.z - cp0.z) - Math.hypot(q2.x - cp0.x, q2.z - cp0.z));
      const entry = { sheets: [] as Sheet[], ver: cardsVer, used: performance.now(), pend: [] as PendCard[], wait: new Map<string, PendCard[]>(), scan: 0, srcs: new Set(items.map((it) => it.c.image).filter(Boolean)) };
      hallCards.set(hallId, entry);
      const y0 = floorY(hall.level) + 0.72, y1 = y0 + CARD_H;
      for (let s0 = 0; s0 < items.length; s0 += PER_SHEET) {
        const part = items.slice(s0, s0 + PER_SHEET);
        const rows = Math.ceil(part.length / SHEET_COLS);
        const cv = document.createElement("canvas");
        cv.width = SHEET_COLS * CELL_W;
        cv.height = rows * CELL_H;
        const g = cv.getContext("2d")!;
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const drawCell = (k: number, im: HTMLImageElement | null) => {
          const it = part[k], x0 = (k % SHEET_COLS) * CELL_W, yy = Math.floor(k / SHEET_COLS) * CELL_H;
          g.clearRect(x0, yy, CELL_W, CELL_H);
          g.fillStyle = "rgba(255,255,255,.95)";
          g.beginPath();
          g.roundRect(x0 + 3, yy + 3, CELL_W - 6, CELL_H - 6, 9);
          g.fill();
          const S = 96, ix = x0 + (CELL_W - S) / 2, iy = yy + 8;
          if (it.c.image) {
            if (im) {
              const k2 = Math.max(S / im.width, S / im.height), iw = im.width * k2, ih = im.height * k2;
              g.save();
              g.beginPath();
              g.rect(ix, iy, S, S);
              g.clip();
              g.drawImage(im, ix + (S - iw) / 2, iy + (S - ih) / 2, iw, ih);
              g.restore();
            } else {
              g.fillStyle = "#e6e6e1";
              g.fillRect(ix, iy, S, S);
            }
          }
          g.textAlign = "center";
          g.textBaseline = "top";
          const name = it.c.name.length > 9 ? it.c.name.slice(0, 8) + "…" : it.c.name;
          const sub = it.c.sub.length > 10 ? it.c.sub.slice(0, 9) + "…" : it.c.sub;
          let ty = it.c.image ? iy + S + 5 : yy + 45;
          if (name) {
            g.font = "700 15px system-ui, sans-serif";
            g.fillStyle = "#1d1d1b";
            g.fillText(name, x0 + CELL_W / 2, ty);
            ty += 18;
          }
          if (sub) {
            g.font = "500 13px system-ui, sans-serif";
            g.fillStyle = "#55554f";
            g.fillText(sub, x0 + CELL_W / 2, ty);
          }
        };
        const pos: number[] = [], uv: number[] = [], idx: number[] = [];
        const sheet: Sheet = { mesh: null as unknown as THREE.Mesh, tex, sent: false, dirty: false, dirtyAt: 0, booths: [] };
        part.forEach((it, k) => {
          drawCell(k, null);
          // 向き：机からいちばん近い歩く線の側（通路の側）。机の列と直角の向きにそろえる
          const q = nearLine(it.x, it.z);
          let nx = q ? q[0] - it.x : 1, nz = q ? q[1] - it.z : 0;
          const along = nx * it.ax + nz * it.az;
          nx -= it.ax * along;
          nz -= it.az * along;
          const nl = Math.hypot(nx, nz);
          if (nl >= 1e-3) {
            nx /= nl;
            nz /= nl;
          }
          if (it.c.image)
            entry.pend.push({
              x: it.x,
              z: it.z,
              nx: nl >= 1e-3 ? nx : 0,
              nz: nl >= 1e-3 ? nz : 0,
              src: it.c.image,
              draw: (im) =>
                cardDrawQueue.push(() => {
                  if (!sheet.mesh.parent) return; // もう捨てたシート
                  drawCell(k, im);
                  if (!sheet.dirty) sheet.dirtyAt = performance.now();
                  sheet.dirty = true;
                }),
            });
          if (nl < 1e-3) return;
          // 机の通路の側のふちの上に立てる。右向き（見る人から見て）は (nz, -nx)
          const cx = it.x + nx * 0.5, cz = it.z + nz * 0.5;
          const rx = nz * (CARD_W / 2), rz = -nx * (CARD_W / 2);
          const base = pos.length / 3;
          sheet.booths.push(it.bi);
          pos.push(cx - rx, y0, cz - rz, cx + rx, y0, cz + rz, cx + rx, y1, cz + rz, cx - rx, y1, cz - rz);
          const u0 = ((k % SHEET_COLS) * CELL_W) / cv.width, u1 = u0 + CELL_W / cv.width;
          const v1 = 1 - (Math.floor(k / SHEET_COLS) * CELL_H) / cv.height, v0 = v1 - CELL_H / cv.height;
          uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
        geo.setIndex(idx);
        geo.computeBoundingSphere();
        sheet.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.05 }));
        sheet.mesh.renderOrder = 2;
        sheet.mesh.visible = false;
        sheet.dirty = false; // はじめて送るときに、それまでに読めた画像もいっしょに送る
        scene.add(sheet.mesh);
        entry.sheets.push(sheet);
      }
      // 作ったホールのうち、しばらく行っていない所は捨てる（いま・前のホールの 2 つだけ残す）
      for (const [id] of [...hallCards.entries()].sort((a, b) => b[1].used - a[1].used).slice(2)) dropHallCards(id);
    };
    const drawWalkCards = (w: number, h: number) => {
      if (codesShown) codeCtx.clearRect(0, 0, w, h);
      codesShown = false;
      const cp = persp.position;
      const here = venue.halls.find((hh) => floorOf(hh.level) === currentFloor && !hh.closed && pointInPolygon([cp.x, cp.z], hh.poly));
      walkHall = here?.id ?? "";
      if (here && hallCards.get(here.id)?.ver !== cardsVer) buildHallCards(here.id);
      for (const [id, e] of hallCards) for (const sh of e.sheets) sh.mesh.visible = id === walkHall && sh.sent;
      const t0 = performance.now();
      while (cardDrawQueue.length && performance.now() - t0 < 8) cardDrawQueue.shift()!();
      const e = here ? hallCards.get(here.id) : undefined;
      if (!e) return;
      const now = performance.now();
      e.used = now;
      // 近くの札の画像を読む（0.3 秒に 1 回見る。まだ読み始めていない分は 12 まで。離れたら、まだの分は読まない）
      if (now - e.scan > 300 && e.pend.length) {
        e.scan = now;
        const online = navigator.onLine && !atVenue.current; // 会場では、印のないサークルの画像は読まない
        // 見えている札から読む：こちらを向いている札（島の向こう側を向いた札は見えない）・前にある札を先に。
        // 距離だけで決めると、すぐ近くの向かいの列より、背中合わせの机の札や後ろの札が先になることがあった
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const near = e.pend
          .map((p) => {
            const d = Math.hypot(p.x - cp.x, p.z - cp.z);
            const vx = cp.x - p.x, vz = cp.z - p.z;
            const away = p.nx * vx + p.nz * vz < 0; // 札の表が、立っている所と反対を向いている
            const behind = d > 2 && (-vx * fx - vz * fz) / d < -0.2;
            return { p, d, k: d + (away ? 30 : 0) + (behind ? 12 : 0) };
          })
          .filter(({ p, d }) => d <= IMG_NEAR && (online || markedImgs.current.has(p.src)) && now - (cardFail.get(p.src) ?? -1e9) > 30_000)
          .sort((a, b) => a.k - b.k);
        for (const { p } of near) {
          if (cardImgs.get(p.src) === undefined && cardLoadQueue.length >= 12) break;
          e.pend.splice(e.pend.indexOf(p), 1);
          (e.wait.get(p.src) ?? e.wait.set(p.src, []).get(p.src)!).push(p);
          withImg(p.src, (im) => {
            e.wait.delete(p.src);
            if (im) p.draw(im);
            else e.pend.push(p); // 読めなかった：30 秒たったら、近くにいればまた読む
          });
        }
        // 離れた所の（会場に着いた・電波がなくなったときは、印のない）、まだ読み始めていない画像は取りやめる（その札は、また近くに来たら読む）
        // 前にいたホール・前の日の札の分も取りやめる
        for (let qi = cardLoadQueue.length - 1; qi >= 0; qi--) {
          const src = cardLoadQueue[qi], ws = e.wait.get(src);
          if (ws && (online || markedImgs.current.has(src)) && ws.some((p) => Math.hypot(p.x - cp.x, p.z - cp.z) <= IMG_NEAR + 5)) continue;
          cardLoadQueue.splice(qi, 1);
          cardImgs.delete(src);
          cardImgWait.delete(src);
          for (const o of hallCards.values()) {
            const ows = o.wait.get(src);
            if (!ows) continue;
            o.wait.delete(src);
            o.pend.push(...ows);
          }
        }
      }
      // 1 コマに 1 枚だけ送る：まだ送っていないシート（近い順でなくてよい。64 枚ずつなので数コマで全部そろう）、なければ画像が読めたシート
      const first = e.sheets.find((sh) => !sh.sent);
      if (first) {
        first.tex.needsUpdate = true;
        first.sent = true;
        first.dirty = false;
        first.mesh.visible = true;
      }
      // 画像が読めたシートは、いちばん長く待っているものから送る（前は番号の若いシートから送っていたので、
      // そのシートに画像が次々に届くあいだ、ほかのシート（向かいの列など）が後回しになっていた）
      if (now - lastCardUpload < 250) return;
      let d: Sheet | undefined;
      for (const sh of e.sheets) if (sh.dirty && sh.sent && sh !== first && (!d || sh.dirtyAt < d.dirtyAt)) d = sh;
      if (d) {
        d.tex.needsUpdate = true;
        d.dirty = false;
        lastCardUpload = now;
      }
    };
    const drawCodes = () => {
      const w = el.clientWidth, h = el.clientHeight;
      // 歩くとき以外（3D・上から）は札の板を出さない
      if (current !== "walk") for (const e of hallCards.values()) for (const sh of e.sheets) sh.mesh.visible = false;
      if (current === "orbit") return drawCodes3d(w, h);
      if (current === "walk") return drawWalkCards(w, h);
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
      // 画面の位置（画面の外 2m より先は null）と、会場の向きを画面の向きに
      const toScr = (x: number, z: number): [number, number] | null => {
        const dx = x - cx, dz = z - cz;
        const sx = (dx * TOP_RIGHT[0] + dz * TOP_RIGHT[1]) * ppm + w / 2, sy = h / 2 - (dx * TOP_UP[0] + dz * TOP_UP[1]) * ppm;
        return sx < -2 * ppm || sx > w + 2 * ppm || sy < -2 * ppm || sy > h + 2 * ppm ? null : [sx, sy];
      };
      const scrDir = (dx: number, dz: number): [number, number] => [dx * TOP_RIGHT[0] + dz * TOP_RIGHT[1], -(dx * TOP_UP[0] + dz * TOP_UP[1])];
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
            const at = toScr(x, z);
            if (!at) continue;
            if (covered(x, floorY(lv), z)) continue;
            const label = String(a.num).padStart(2, "0");
            const [sx, sy] = at;
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
          const at = toScr(x, z);
          if (!at) continue;
          if (covered(x, floorY(hallById.get(l.hall)!.level), z)) continue;
          const sideOff = e.side * Math.max(7, (TOP_DESK_D / 2) * ppm);
          const inward = -e.out * Math.max(7, (DESK_L / 2) * ppm);
          // 列の向き（c, sn）と、それに直角な向き（-sn, c）を画面の向きにして、px でずらす
          const [ax, ay] = scrDir(c, sn), [bx, by] = scrDir(-sn, c);
          const sx = at[0] + ax * inward + bx * sideOff;
          const sy = at[1] + ay * inward + by * sideOff;
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
          const at = toScr(x, z);
          if (!at) continue;
          if (covered(x, floorY(lv), z)) continue;
          const label = full ? `${b.block}-${String(b.num).padStart(2, "0")}${b.half}` : `${String(b.num).padStart(2, "0")}${b.half}`;
          const [sx, sy] = at;
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
        if (railPos && (fwd || side)) {
          // 行きたい向き：前後は見ている向き、左右は見ている向きの横（横を向いたまま、机を見ながら歩ける）
          let wx = fx * fwd - fz * side, wz = fz * fwd + fx * side;
          const wl = Math.hypot(wx, wz) || 1;
          wx /= wl;
          wz /= wl;
          // 線と直角に近い向き（机のほうを向いて「前へ」など）のときは、さっき進んでいた向きへ
          const A = walkR().nodes[railPos.a].p, B = walkR().nodes[railPos.b].p, L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
          const along = (wx * (B[0] - A[0]) + wz * (B[1] - A[1])) / L;
          if (Math.abs(along) < 0.35 && lastRailDir) [wx, wz] = lastRailDir;
          const m = moveOnRails(walkR(), railPos, [wx, wz], Math.min(1, Math.abs(fwd) + Math.abs(side)) * WALK_SPEED * dt);
          railPos = m.pos;
          lastRailDir = m.dir;
          const at = railPoint(walkR(), railPos);
          persp.position.x = at[0];
          persp.position.z = at[1];
          // 向きは変えない（進むときに勝手に向きを変えられると見にくい。ユーザーの指示）
        }
        if (!railPos) {
          persp.position.x += (fx * fwd - fz * side) * WALK_SPEED * dt;
          persp.position.z += (fz * fwd + fx * side) * WALK_SPEED * dt;
        }
        if (railPos) {
          // 線の上の高さ（2F の通路・階段の途中）。階段で階が変わったら、見せる階も変える
          const y = railY(railPos);
          persp.position.y = y + EYE;
          // 立っている階（1F・2F・4F）が変わったら、出す線を入れかえる
          if (levelAtY(y) !== lastWalkLevel) {
            lastWalkLevel = levelAtY(y);
            applyVisibility();
          }
          const f: Floor = y > (floorY(2) + floorY(4)) / 2 ? 4 : 1;
          if (f !== currentFloor) {
            currentFloor = f;
            focus.y = floorY(f);
            applyVisibility();
            onFloor.current(f);
          }
        } else persp.position.y = eyeY();
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
      sizeMe();
      drawCodes();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // 上からの見方の縦の半分は 160m（size()）。会場の縦横が入る倍率に
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    ortho.zoom = Math.min((160 * 2) / ((bounds.maxU - bounds.minU) * 1.08), (160 * 2 * aspect) / ((bounds.maxR - bounds.minR) * 1.08));
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
      placeDesks("top");
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
      placeDesks(current);
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

    api.current = { redrawCards: () => {
      cardsVer++;
    }, showRailsPick: (on) => {
      railsPick = on;
      if (on) walkR(); // 線をまだ作っていなければ、ここで作る（作ると見え方もそろえる）
      applyVisibility();
    }, showRoute, showTour, walkPos: () => (current === "walk" ? [persp.position.x, persp.position.z] : null), showMe: (p, acc, fly) => {
      if (!p) {
        meDot.visible = false;
        return;
      }
      meAcc = Math.min(acc, 150);
      meDot.position.set(p[0], floorY(currentFloor) + 0.15, p[1]);
      meDot.visible = true;
      if (fly) {
        if (current === "walk") standAt(p[0], p[1]);
        else focusPoint(new THREE.Vector3(p[0], floorY(currentFloor), p[1]), false);
      }
    }, setView, setFloor, setBoth: (on) => {
      bothFloors = on;
      applyVisibility();
    }, recolor, setPins, focusBooth, focusLine, standAt, focusHall, snapshot, hold: (d) => (hold = d), setSurround: (on) => {
        surroundings.visible = on;
        ground.visible = !(on && cutGround);
      },
    };

    // 歩く線は、画面が出てから手のあいている時に作っておく（開くときを重くしない。歩きはじめたときに待たないように）
    const idle = (cb: () => void) =>
      "requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 6000 }) : (setTimeout(cb, 2500) as unknown as number);
    let idleId = 0;
    let gone = false; // 片づけたあと（この画面は捨てた）
    const firstWait = setTimeout(() => (idleId = idle(() => !gone && walkR())), 1500);

    return () => {
      gone = true;
      clearTimeout(firstWait);
      if ("cancelIdleCallback" in window) cancelIdleCallback(idleId);
      else clearTimeout(idleId);
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKey);
      controls?.dispose();
      renderer.dispose();
      printRenderer?.dispose();
      for (const id of [...hallCards.keys()]) dropHallCards(id); // 札の絵（テクスチャ）も捨てる
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
    onFloor.current = (f) => setFloor(f);
  }, []);
  useEffect(() => api.current?.setBoth(both), [both]);
  useEffect(() => {
    api.current?.setSurround(surround);
  }, [surround]);
  useEffect(() => api.current?.recolor(byGenre, marks, visited, selected, dayTags, genre, work, char), [byGenre, marks, visited, selected, dayTags, genre, work, char]);
  useEffect(() => {
    cardInfo.current = (code) => {
      const c = circles[day][code];
      // 札には小さい画像（ないときは大きい画像）
      if (c) return { name: c.name, image: c.thumb || c.image, sub: c.works[0] ?? "" };
      const w = dayTags?.[code]?.works?.[0];
      return w ? { name: "", image: "", sub: w } : null;
    };
    api.current?.redrawCards();
  }, [day, dayTags]);
  useEffect(() => {
    // 印の机（ピンを立てる印だけ）。「行った」の机は灰色の ✓
    const list = Object.entries(marks)
      .filter(([code, m]) => (pinsOn[m] || tripOrder.has(code)) && codeIndex.has(code))
      .map(([code, mark]) => ({ booth: codeIndex.get(code)!, mark: mark as Mark | null, done: !!visited[code], order: tripOrder.get(code) }));
    api.current?.setPins(list);
  }, [marks, visited, pinsOn, codeIndex, tripOrder]);

  const select = useCallback(
    (i: number) => {
      setSelected(i);
      onSelectBooth.current(i);
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
  // 名前で探す（D-4）：サークル名・作品・キャラ・ジャンル・配置番号。作品などは、その机の一覧から選んで飛ぶ
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findGroup, setFindGroup] = useState<Hit | null>(null);
  const allCodes = useMemo(() => booths.map((b) => b.code), [booths]);
  const findHits = useMemo(() => (findOpen ? search(findQ, allCodes, dayTags ?? {}, circles[day]) : []), [findOpen, findQ, allCodes, dayTags, day]);
  const goCode = (code: string) => {
    const i = codeIndex.get(code);
    if (i === undefined) return;
    setFindOpen(false);
    select(i);
  };
  // リンクで開いたとき（?day=1&code=東A-01a）：その日にして、その机を選ぶ（サークルが X で知らせたリンクなど）
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const d = Number(q.get("day"));
    const i = codeIndex.get(normCode(q.get("code") ?? ""));
    requestAnimationFrame(() => {
      if ((DAYS as readonly number[]).includes(d)) setDay(d as Day);
      if (i !== undefined) select(i);
    });
    // 開いたときに 1 回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const filterBy = (h: Hit) => {
    setByGenre(true);
    setGenre(h.kind === "genre" ? h.label : null);
    setWork(h.kind === "work" ? h.label : null);
    setChar(h.kind === "char" ? h.label : null);
  };
  // 列を選んだとき：番号はまだ選ばず、その列の机が全部見える所へ
  const chooseLine = (line: number) => {
    setPickLine(line);
    setPickNum(null);
    setPickHalf("a");
    setSelected(null);
    setFloor(floorOf(hallById.get(lines[line].hall)!.level));
    api.current?.focusLine(line);
  };

  const sel = selected !== null ? booths[selected] : null;
  const selHall = sel ? hallById.get(sel.hall)! : null;
  const selMark = sel ? marks[sel.code] : undefined;
  // 同じ印をもう一度押すと外す。違う印を押すと付け替える。メモは印と別に書けるので、印を外しても残す
  const toggleMark = (code: string, mark: Mark) => {
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
  const marked = lists.want.length + lists.maybe.length;
  const markedDone = [...lists.want, ...lists.maybe].filter((c) => visited[c]).length;
  // 印はつけずにメモだけ書いた机（「行った」の机は上に出すので除く）
  const memoOnly = [...new Set([...Object.keys(notes), ...Object.keys(budgets)])]
    .filter((c) => !marks[c] && !visited[c] && codeIndex.has(c))
    .sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
  // 使う金額の合計（その日。地図の配置にある机だけ）：★・◆・印なし（メモだけ）に分けて、当日は行った分と残りも
  const sumOf = (codes: string[]) => codes.reduce((a, c) => a + (budgets[c] ?? 0), 0);
  const budgetCodes = Object.keys(budgets).filter((c) => codeIndex.has(c));
  const money = {
    total: sumOf(budgetCodes),
    want: sumOf(lists.want),
    maybe: sumOf(lists.maybe),
    done: sumOf(budgetCodes.filter((c) => visited[c])),
    allDays: DAYS.reduce((a, d) => a + Object.entries(budgetsByDay[d]).reduce((x, [c, v]) => x + (codeIndex.has(c) ? v : 0), 0), 0),
  };
  const openHalls = venue.halls.filter((h) => !h.closed);
  // 作品のドロップダウン：入れた作品（なければ見本の作品）。キャラのドロップダウン：選んだ作品に入っているキャラ
  // ジャンルの一覧と、選んだジャンルの作品の一覧
  const genreList = [...new Set(Object.values(dayTags ?? {}).map((t) => t.genre).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, "ja"));
  // ジャンルには「ブルーアーカイブ」のような作品そのものの名前もある。そのジャンルの中の作品の一覧からは、ジャンルと同じ名前の作品は除く
  // （2 つめの選び方は、そのジャンルの中の作品・キャラ・グループ。ユーザーの指示）
  const workList = dayTags
    ? dayWorks.map((w) => w.work).filter((w) => w !== genre && (!genre || Object.values(dayTags).some((t) => t.genre === genre && t.works?.includes(w))))
    : SAMPLE_GENRES;
  // キャラ・グループ：作品を選んだときはその作品の分、選んでいないときはそのジャンル（なければその日）の机に入っているもの全部
  const charList = (() => {
    if (!dayTags) return [];
    const set = new Set<string>();
    for (const t of Object.values(dayTags)) {
      if (genre && t.genre !== genre) continue;
      for (const [w, list] of Object.entries(t.chars ?? {})) if (!work || w === work) for (const c of list) if (c) set.add(c);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "ja"));
  })();
  // 日を変えるとき、前の日に選んだジャンル・作品・キャラがその日にないなら、選びなおし（すべて）にする。
  // そのままだと、選べないものを選んだままになり、机がどれも薄くなっていた（3 日目に選んでから 1 日目を見たとき：ユーザーの指摘）
  const switchDay = (d: Day) => {
    const t = Object.values(tags[d] ?? {});
    const g = genre && t.some((x) => x.genre === genre) ? genre : null;
    const inG = t.filter((x) => !g || x.genre === g);
    const w = work && g === genre && inG.some((x) => x.works?.includes(work)) ? work : null;
    const c = char && w === work && inG.some((x) => Object.entries(x.chars ?? {}).some(([k, l]) => (!w || k === w) && l.includes(char))) ? char : null;
    setGenre(g);
    setWork(w);
    setChar(c);
    setDay(d);
  };
  const chooseMode = (m: Mode) => {
    setMode(m);
    cancelWalk();
    setView(m === "plan" ? "orbit" : "top");
  };
  const toggle3d = () => {
    cancelWalk();
    setView(view === "top" ? "orbit" : "top");
  };
  // 配置番号を選ぶ欄（列 → 番号 → a・b）。どちらのモードでも地図の上に
  const codePicker = (
    <div style={{ display: "flex", gap: 6, alignItems: "center", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: 4, boxShadow: "0 1px 6px rgba(0,0,0,.12)" }}>
      <select
        aria-label="列"
        value={pickLine ?? ""}
        onChange={(e) => chooseLine(Number(e.target.value))}
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
      <select aria-label="番号" value={pickNum ?? ""} disabled={pickLine === null} onChange={(e) => jump(pickLine!, Number(e.target.value), pickHalf)} style={{ flex: 1, minWidth: 0 }}>
        <option value="" disabled>
          番号
        </option>
        {pickNums.map((n) => (
          <option key={n} value={n}>
            {String(n).padStart(2, "0")}
          </option>
        ))}
      </select>
      <div className="seg" role="group" aria-label="a・b">
        {(["a", "b"] as const).map((x) => (
          <button key={x} aria-pressed={pickNum !== null && pickHalf === x} disabled={pickNum === null} onClick={() => jump(pickLine!, pickNum!, x)}>
            {x}
          </button>
        ))}
      </div>
    </div>
  );
  const KIND_LABEL = { circle: "サークル", code: "配置番号", work: "作品", char: "キャラ", genre: "ジャンル" } as const;
  const findPanel = findOpen && (
    <div
      role="dialog"
      aria-label="名前で探す"
      style={{ marginTop: 6, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: 8, boxShadow: "0 2px 10px rgba(0,0,0,.18)", maxHeight: "min(60vh, 460px)", display: "flex", flexDirection: "column" }}
    >
      <input
        type="search"
        autoFocus
        value={findQ}
        onChange={(e) => {
          setFindQ(e.target.value);
          setFindGroup(null);
        }}
        onKeyDown={(e) => e.key === "Escape" && setFindOpen(false)}
        placeholder="サークル名・作品・キャラ・配置番号"
        aria-label="探す言葉"
        style={{ width: "100%", minHeight: 40, boxSizing: "border-box", font: "inherit" }}
      />
      <div style={{ overflowY: "auto", marginTop: 6 }}>
        {findGroup ? (
          <>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "2px 0 6px" }}>
              <button className="chip small" onClick={() => setFindGroup(null)}>
                ← 戻る
              </button>
              <strong style={{ fontSize: ".9rem" }}>
                {KIND_LABEL[findGroup.kind]}：{findGroup.label}（{findGroup.codes.length}）
              </strong>
              <button
                className="chip small"
                style={{ marginLeft: "auto" }}
                onClick={() => {
                  filterBy(findGroup);
                  setFindOpen(false);
                }}
              >
                地図をこれで色分け
              </button>
            </div>
            {findGroup.codes.slice(0, 200).map((c) => (
              <button key={c} className="find-row" onClick={() => goCode(c)}>
                <b>{c}</b>
                <span>{[circles[day][c]?.name, dayTags?.[c]?.works?.join("・")].filter(Boolean).join("　")}</span>
              </button>
            ))}
          </>
        ) : (
          <>
            {findQ.trim() && !findHits.length && <p style={{ color: "var(--muted)", fontSize: ".85rem", margin: "6px 2px" }}>{day}日目には見つかりませんでした</p>}
            {!findQ.trim() && <p style={{ color: "var(--muted)", fontSize: ".8rem", margin: "4px 2px" }}>{day}日目の机から探します（サークル名は、サークルの方が登録したものだけ）</p>}
            {findHits.map((h, k) => (
              <button
                key={k}
                className="find-row"
                onClick={() => (h.codes.length === 1 && (h.kind === "code" || h.kind === "circle") ? goCode(h.codes[0]) : h.kind === "circle" ? goCode(h.codes[0]) : setFindGroup(h))}
              >
                <small>{KIND_LABEL[h.kind]}</small>
                <b>{h.label}</b>
                <span>{h.sub}</span>
              </button>
            ))}
          </>
        )}
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
        // 図の札は印の机だけ。下の一覧には、メモだけの机も入れる
        const memos = memoOnly.map((c) => ({ booth: codeIndex.get(c)!, mark: null })).filter((m) => ids.includes(booths[m.booth].hall));
        return {
          title: `${hs[0].building}${nums}ホール（${hs[0].level}F）`,
          img: api.current?.snapshot(ids, mine) ?? "",
          codes: [...mine, ...memos]
            .map(({ booth, mark }) => ({ code: booths[booth].code, mark, hall: hallById.get(booths[booth].hall)!.name, note: notes[booths[booth].code] ?? "", budget: budgets[booths[booth].code] ?? 0 }))
            .sort((a, b) => a.code.localeCompare(b.code, "ja", { numeric: true })),
        };
      });
    setListOpen(false);
    setPrint({ made: new Date().toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" }), day, total: money.total, sections });
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
      {popImg && (
        // 全画面：まわりを暗くして、画像をぽんと出す。暗い所・✕・Esc で閉じる。2 本の指・ダブルタップで拡大
        <div
          role="dialog"
          aria-label={`${popImg.name} の画像`}
          className="lb-fade"
          onClick={() => setPopImg(null)}
          style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.9)", display: "flex", flexDirection: "column", color: "#fff" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", flex: "none" }}>
            <span style={{ fontSize: ".9rem", opacity: 0.85, minWidth: 44 }}>{popImg.images.length > 1 ? `${popImg.i + 1} / ${popImg.images.length}` : ""}</span>
            <strong style={{ flex: 1, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{popImg.name}</strong>
            <button className="lb-btn" aria-label="閉じる" onClick={() => setPopImg(null)}>
              ✕
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {/* 画像を変えたら、元の大きさで、また ぽんと出す */}
            <div key={popImg.images[popImg.i]} className="lb-pop">
              <ZoomImg src={popImg.images[popImg.i]} width="100vw" height="calc(100dvh - 104px)" onOutside={() => setPopImg(null)} />
            </div>
            {popImg.images.length > 1 && (
              <>
                <button
                  className="lb-btn"
                  aria-label="前の画像"
                  disabled={popImg.i === 0}
                  style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPopImg({ ...popImg, i: popImg.i - 1 });
                  }}
                >
                  ‹
                </button>
                <button
                  className="lb-btn"
                  aria-label="次の画像"
                  disabled={popImg.i === popImg.images.length - 1}
                  style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPopImg({ ...popImg, i: popImg.i + 1 });
                  }}
                >
                  ›
                </button>
              </>
            )}
          </div>
          <div style={{ flex: "none", textAlign: "center", fontSize: ".8rem", opacity: 0.7, padding: "6px 10px 12px" }}>2 本の指で広げる・ダブルタップで拡大。まわりの暗い所を押すと閉じます</div>
        </div>
      )}
      <div ref={box} style={{ position: "relative", flex: 1, minHeight: 0, touchAction: "none" }}>
        {/* いつも出すもの：サイドバーを開くボタン、配置番号の欄、2D・3D、歩く、周辺 */}
        <div style={{ position: "absolute", top: 8, left: 8, right: 8, display: "flex", gap: 8, alignItems: "flex-start", pointerEvents: "none" }}>
          {/* 左の列：メニューと、名前で探す（配置番号の欄がスマホでせまくならないよう、欄の外に） */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, pointerEvents: "auto" }}>
            <button className="icon-btn" aria-label="メニュー" onClick={() => setMenu(true)}>
              <Icon name="menu" />
            </button>
            <button className="icon-btn" aria-label="名前で探す" aria-pressed={findOpen} onClick={() => setFindOpen((o) => !o)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M15.5 15.5 21 21" />
              </svg>
            </button>
          </div>
          {/* 配置番号の欄はモードによらずいつも地図の上に（ユーザーの指示） */}
          <div data-tour="picker" style={{ flex: 1, minWidth: 0, maxWidth: 520, pointerEvents: "auto" }}>
            {codePicker}
            {findPanel}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", gap: 6, pointerEvents: "auto" }}>
            <button className="icon-btn" aria-label={view === "top" ? "3D にする" : "2D にする"} onClick={toggle3d}>
              {/* 絵より文字のほうが分かりやすい（ユーザーの確認）。押すとなる見え方を出す */}
              <span style={{ fontWeight: 800, fontSize: "1rem", letterSpacing: ".02em" }}>{view === "top" ? "3D" : "2D"}</span>
            </button>
            <button className="icon-btn" aria-label="場所を指して歩く" aria-pressed={view === "walk" || walkPending} onClick={() => chooseView(view === "walk" ? "orbit" : "walk")}>
              <Icon name="walk" />
            </button>
            <button className="icon-btn" aria-label="周辺も表示" aria-pressed={surround} onClick={() => setSurround((x) => !x)}>
              <Icon name="city" />
            </button>
            <button
              className="icon-btn"
              aria-label="いまいる所"
              aria-pressed={locOn}
              onClick={() => {
                setLoc(null);
                if (!locOn && !("geolocation" in navigator)) {
                  setLocErr("この端末では位置を使えません");
                  return;
                }
                setLocErr("");
                setLocOn((x) => !x);
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" fill="currentColor" />
                <circle cx="12" cy="12" r="8" />
                <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" />
              </svg>
            </button>
            <div style={{ position: "relative" }}>
              <button className="icon-btn" aria-label="トイレ・救護室までの道" aria-pressed={routeMenu || (!!route && !("error" in route))} onClick={() => setRouteMenu((x) => !x)}>
                <span style={{ fontWeight: 800, fontSize: ".8rem" }}>WC</span>
              </button>
              {routeMenu && (
                <div className="route-menu" role="menu">
                  <button role="menuitem" onClick={() => findRoute("toilet")}>
                    いちばん近いトイレへ
                  </button>
                  <button role="menuitem" onClick={() => findRoute("aid")}>
                    救護室へ
                  </button>
                  {route && (
                    <button role="menuitem" onClick={() => (clearRoute(), setRouteMenu(false))}>
                      道を消す
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="floor-switch" role="group" aria-label="階">
              {([4, 1] as Floor[]).map((f) => (
                <button
                  key={f}
                  // 「1F」の表示は 2F の通路（コンコース・ガレリアなど）もいっしょに出すので「1・2F」（ユーザーの指示）
                  aria-label={f === 1 ? "1F・2F" : "4F"}
                  style={f === 1 ? { fontSize: ".72rem" } : undefined}
                  aria-pressed={!both && floor === f}
                  onClick={() => {
                    setBoth(false);
                    setFloor(f);
                  }}
                >
                  {f === 1 ? "1・2F" : "4F"}
                </button>
              ))}
              <button aria-pressed={both} aria-label="1・2F と 4F の両方" onClick={() => setBoth(true)} style={{ fontSize: ".72rem" }}>
                両方
              </button>
            </div>
            {/* 2D は机の列を画面の上下にそろえて回しているので、北の向きを矢印で出す */}
            {view === "top" && (
              <div
                role="img"
                aria-label={`北は画面の上から右へ ${Math.round(NORTH_DEG)} 度`}
                style={{ alignSelf: "center", width: 44, height: 44, borderRadius: "50%", background: "var(--card)", border: "1px solid var(--line)", boxShadow: "0 1px 6px rgba(0,0,0,.12)", display: "grid", placeItems: "center", pointerEvents: "none" }}
              >
                {/* 赤い矢印の先が北。「北」の字は矢印の先の側に、まっすぐ立てて書く */}
                <svg width="36" height="36" viewBox="-18 -18 36 36" aria-hidden>
                  <g transform={`rotate(${NORTH_DEG})`}>
                    <path d="M0 -3 L4 8 L0 6 L-4 8 Z" fill="#d23c3c" />
                    <text x="0" y="-8" textAnchor="middle" dominantBaseline="middle" fontSize="10" fontWeight="800" fill="#1d1d1b" transform={`rotate(${-NORTH_DEG} 0 -8)`}>
                      北
                    </text>
                  </g>
                </svg>
              </div>
            )}
          </div>
        </div>
        {!online && (
          <div role="status" style={{ ...OVER, top: 60, left: "50%", transform: "translateX(-50%)", background: "#3a3a37", color: "#fff", fontSize: ".85rem" }}>
            電波がありません。この端末に保存した地図と印を表示しています
          </div>
        )}
        {here && <div style={{ ...OVER, bottom: 22, right: 8, fontWeight: 700, fontSize: ".85rem" }}>{here}</div>}
        {walkPending && (
          // 配置番号の欄（いつも上にある）と、電波がないときの札の下に出す
          <div role="status" style={{ position: "absolute", left: "50%", top: online ? 64 : 116, transform: "translateX(-50%)", background: "#1f3b6e", color: "#fff", borderRadius: 8, padding: "8px 12px", display: "flex", gap: 10, alignItems: "center", boxShadow: "0 2px 8px rgba(0,0,0,.25)", maxWidth: "92%" }}>
            <span>歩き始める場所を、地図の上で押してください。青い線（通路の線路）の近くを押すと、その線の上に立ちます</span>
            <button className="chip small" onClick={cancelWalk}>やめる</button>
          </div>
        )}
        {view === "walk" && (
          <div style={{ position: "absolute", right: 12, bottom: sel ? 150 : 62, display: "flex", flexDirection: "column", gap: 8 }}>
            {/* 前・後ろ（見ている向き）。押しているあいだ進む（左右のボタンは、線の上では前後と同じ動きになるので出さない。ユーザーの指示） */}
            {(
              [
                [1, "前へ"],
                [-1, "後ろへ"],
              ] as const
            ).map(([d, label]) => (
              <button
                key={d}
                className="walk-btn"
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
              <strong>
                印をつけたサークル<span style={{ whiteSpace: "nowrap" }}>（{day}日目）</span>
                {mode === "plan" && canVisit && marked > 0 && <span style={{ fontWeight: 400, fontSize: ".85rem", marginLeft: 6, whiteSpace: "nowrap" }}>✓ 行った {markedDone}/{marked}</span>}
              </strong>
              <span style={{ display: "flex", gap: 6 }}>
                <button className="chip small" onClick={startPrint}>
                  配置図を印刷
                </button>
                <button className="chip small" onClick={() => setListOpen(false)}>
                  閉じる
                </button>
              </span>
            </div>
            {marked + memoOnly.length === 0 && (
              <p style={{ color: "var(--muted)", margin: "8px 0 0" }}>{day}日目の印はまだありません。机を押して「★ 行きたい」か「◆ 候補」をつけられます。印とメモは日ごとに別で、この端末に保存します（ログインすると、ほかの端末とも合わせます）。</p>
            )}
            {money.total > 0 && (
              <div style={{ marginTop: 8, fontSize: ".9rem" }}>
                <strong>使う金額 {yen(money.total)}</strong>
                <span style={{ color: "var(--muted)" }}>
                  （★ {yen(money.want)}・◆ {yen(money.maybe)}
                  {money.total - money.want - money.maybe > 0 ? `・印なし ${yen(money.total - money.want - money.maybe)}` : ""}）
                </span>
                {mode === "plan" && canVisit && (
                  <span style={{ marginLeft: 6, whiteSpace: "nowrap" }}>
                    行った分 {yen(money.done)}・残り {yen(money.total - money.done)}
                  </span>
                )}
                {money.allDays !== money.total && <div style={{ color: "var(--muted)", fontSize: ".8rem" }}>3 日の合計 {yen(money.allDays)}</div>}
              </div>
            )}
            {marked > 0 && (
              <section style={{ marginTop: 8, padding: 8, borderRadius: 8 }} className="soft">
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>回る順</strong>
                  <button className="chip small" onClick={() => makeTrip(false)}>
                    ★ を回る順を考える
                  </button>
                  {lists.maybe.length > 0 && (
                    <button className="chip small" onClick={() => makeTrip(true)}>
                      ★ と ◆ で考える
                    </button>
                  )}
                  {trip && trip.day === day && (
                    <button className="chip small" onClick={clearTrip}>
                      消す
                    </button>
                  )}
                </div>
                {trip && trip.day === day && (
                  <>
                    <p style={{ fontSize: ".8rem", color: "var(--muted)", margin: "4px 0" }}>
                      {trip.from ? `${trip.from}から、` : ""}
                      {trip.codes.length} か所・歩く道のり 約 {Math.round(trip.length / 10) * 10}m（混んでいると歩くだけで約 {Math.max(1, Math.ceil(trip.length / 50))} 分。列に並ぶ時間は入っていません）。地図のピンの数が順番です。まだ「行った」にしていない机だけで考えます
                    </p>
                    <ol style={{ margin: 0, paddingLeft: "1.6em" }}>
                      {trip.codes.map((c) => (
                        <li key={c} style={{ padding: "2px 0" }}>
                          <button className="chip small" style={visited[c] ? { color: "var(--muted)", textDecoration: "line-through" } : undefined} onClick={() => select(codeIndex.get(c)!)}>
                            {c}
                            {circles[day][c] ? `　${circles[day][c].name}` : ""}　{hallById.get(booths[codeIndex.get(c)!].hall)!.name.replace("ホール", "")}
                          </button>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </section>
            )}
            {MARKS.filter((m) => lists[m].length > 0).map((m) => (
              <section key={m} style={{ marginTop: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong style={{ color: hexCss(MARK[m].color) }}>
                    {MARK[m].icon} {MARK[m].label} {lists[m].length}
                    {money[m] > 0 && <span style={{ fontWeight: 400, fontSize: ".85rem", marginLeft: 6 }}>{yen(money[m])}</span>}
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
                        <button
                          className="chip small"
                          style={{ flex: 1, textAlign: "left", ...(visited[c] ? { color: "var(--muted)", textDecoration: "line-through" } : {}) }}
                          onClick={() => select(codeIndex.get(c)!)}
                        >
                          {c}　{hallById.get(booths[codeIndex.get(c)!].hall)!.name}
                          {budgets[c] > 0 && <span style={{ float: "right", fontWeight: 700 }}>{yen(budgets[c])}</span>}
                          {notes[c] && <span style={{ display: "block", color: "var(--muted)", fontSize: ".8rem", whiteSpace: "normal" }}>📝 {notes[c]}</span>}
                        </button>
                        {mode === "plan" && canVisit ? (
                          <button className="chip small" style={{ minHeight: 40, minWidth: 92 }} aria-pressed={!!visited[c]} onClick={() => toggleVisited(c)}>
                            {visited[c] ? "✓ 行った" : "行った？"}
                          </button>
                        ) : (
                          <>
                            <button className="chip small" onClick={() => toggleMark(c, other)}>
                              {MARK[other].icon} {MARK[other].label}へ
                            </button>
                            <button className="chip small" onClick={() => toggleMark(c, m)} aria-label={`${c} の印を外す`}>
                              外す
                            </button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {memoOnly.length > 0 && (
              <section style={{ marginTop: 8 }}>
                <strong>📝 印なし（メモ・金額だけ） {memoOnly.length}</strong>
                <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0" }}>
                  {memoOnly.map((c) => (
                    <li key={c} style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                      <button className="chip small" style={{ flex: 1, textAlign: "left" }} onClick={() => select(codeIndex.get(c)!)}>
                        {c}　{hallById.get(booths[codeIndex.get(c)!].hall)!.name}
                        {budgets[c] > 0 && <span style={{ float: "right", fontWeight: 700 }}>{yen(budgets[c])}</span>}
                        {notes[c] && <span style={{ display: "block", color: "var(--muted)", fontSize: ".8rem", whiteSpace: "normal" }}>📝 {notes[c]}</span>}
                      </button>
                      <button
                        className="chip small"
                        onClick={() => {
                          setNote(c, "");
                          setBudget(c, 0);
                        }}
                        aria-label={`${c} のメモと金額を消す`}
                      >
                        消す
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {imp && (
          <div style={{ ...SHEET, top: 8, bottom: "auto", maxHeight: "70%", overflowY: "auto", zIndex: 5 }} role="dialog" aria-label="チェックリストの読みこみ">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <strong>Web カタログのチェックリストを読む</strong>
              <button className="chip small" onClick={() => setImp(null)}>
                閉じる
              </button>
            </div>
            <p style={{ fontSize: ".85rem", color: "var(--muted)", margin: "4px 0" }}>{imp.file}{imp.list.event ? `（${imp.list.event}）` : ""}</p>
            {imp.done ? (
              <p style={{ margin: "6px 0" }}>{imp.done}</p>
            ) : (
              (() => {
                const cs = imp.list.circles;
                const onMap = cs.filter((c) => c.day && codeIndex.has(c.code));
                const willAdd = onMap.filter((c) => imp.colorMark[c.color]);
                const noDay = [...new Set(cs.filter((c) => !c.day).map((c) => c.dayText || "（空）"))];
                const offMap = cs.filter((c) => c.day && !codeIndex.has(c.code)).length;
                const colors = Object.keys(imp.colorMark).map(Number);
                return (
                  <>
                    <p style={{ margin: "6px 0", fontSize: ".9rem" }}>
                      サークル {cs.length} 件（{([1, 2, 3] as Day[]).map((d) => `${d}日目 ${cs.filter((c) => c.day === d).length}`).join("・")}）
                      {offMap > 0 && <span style={{ display: "block", color: "var(--muted)" }}>いまの地図の配置にない番号が {offMap} 件あります（入れません{realData ? "" : "。地図の配置は見本です"}）</span>}
                      {noDay.length > 0 && (
                        <span style={{ display: "block", color: "var(--muted)" }}>
                          参加日が {EVENT.name} の日（{EVENT.weekdays.join("・")}）でない行は入れません：{noDay.join("・")}
                        </span>
                      )}
                      {imp.list.skipped > 0 && <span style={{ display: "block", color: "var(--muted)" }}>配置番号のない行 {imp.list.skipped} 件は入れません</span>}
                    </p>
                    <div style={{ fontSize: ".9rem" }}>チェックの色ごとに、つける印を選んでください</div>
                    {colors.map((col) => (
                      <label key={col} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                        <span style={{ flex: 1 }}>
                          色 {col}
                          {imp.list.colors[col] ? `「${imp.list.colors[col]}」` : ""}　{onMap.filter((c) => c.color === col).length} 件
                        </span>
                        <select value={imp.colorMark[col]} onChange={(e) => setImp({ ...imp, colorMark: { ...imp.colorMark, [col]: e.target.value as Mark | "" } })}>
                          <option value="want">★ 行きたい</option>
                          <option value="maybe">◆ 候補</option>
                          <option value="">入れない</option>
                        </select>
                      </label>
                    ))}
                    <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, fontSize: ".9rem" }}>
                      <input type="checkbox" checked={imp.memo} onChange={(e) => setImp({ ...imp, memo: e.target.checked })} />
                      カタログのメモも入れる（メモを書いていない机だけ）
                    </label>
                    <p style={{ fontSize: ".8rem", color: "var(--muted)", margin: "6px 0" }}>すでに印のある机は、そのままにします。</p>
                    <button className="primary" style={{ minHeight: 44, padding: "0 18px" }} disabled={!willAdd.length} onClick={applyChecklist}>
                      {willAdd.length} 件を読みこむ
                    </button>
                  </>
                );
              })()
            )}
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
                  作品{savedTags || realData ? "" : "（見本）"}：{dayTags[sel.code]?.works?.join("・") ?? <span style={{ color: "var(--muted)" }}>まだ入っていません</span>}
                  {charsText(dayTags[sel.code]) ? `　／　キャラ：${charsText(dayTags[sel.code])}` : ""}
                </>
              ) : (
                <>作品（見本）：{lines[sel.line].genre}</>
              )}
              {!circles[day][sel.code] && (
                <>
                  　／　サークル：<span style={{ color: "var(--muted)" }}>まだ登録されていません</span>
                </>
              )}
            </div>
            {circles[day][sel.code] && <CircleCard c={circles[day][sel.code]} onOpen={() => openImages(circles[day][sel.code])} />}
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {/* 当日・計画のモードでも ★ 行きたい・◆ 候補の印をつけられる（ユーザーの指示）。
                  「✓ 行った」にできるのは、印がある机だけ */}
              {mode === "plan" ? (
                <>
                  {/* 押しやすいように 1 行まるごと使う（スマホで折り返さない） */}
                  {selMark && canVisit && (
                    <button
                      style={{ flex: "1 1 100%", minHeight: 52, fontWeight: 700, fontSize: "1.1rem" }}
                      aria-pressed={!!visited[sel.code]}
                      onClick={() => toggleVisited(sel.code)}
                    >
                      {visited[sel.code] ? "✓ 行った（取り消す）" : "✓ 行った"}
                    </button>
                  )}
                  {MARKS.map((m) => (
                    <button key={m} style={{ flex: 1, minHeight: 44, fontWeight: 700 }} aria-pressed={selMark === m} onClick={() => toggleMark(sel.code, m)}>
                      {MARK[m].icon} {MARK[m].label}
                      {selMark === m ? "（外す）" : ""}
                    </button>
                  ))}
                </>
              ) : (
                MARKS.map((m) => (
                  <button key={m} style={{ flex: 1, minHeight: 44, fontWeight: 700 }} aria-pressed={selMark === m} onClick={() => toggleMark(sel.code, m)}>
                    {MARK[m].icon} {MARK[m].label}
                    {selMark === m ? "（外す）" : ""}
                  </button>
                ))
              )}
              {/* 当日・計画のモードでは、印のない机に「机の前に立つ」も出さない（ユーザーの指示） */}
              {view !== "walk" && !(mode === "plan" && !selMark) && (
                <button
                  style={{ minHeight: 44 }}
                  onClick={() => startWalkAt(selected!)}
                >
                  机の前に立つ
                </button>
              )}
              <button style={{ minHeight: 44, marginLeft: "auto" }} onClick={() => setSelected(null)} aria-label="閉じる">
                ✕
              </button>
            </div>
            {mode === "plan" && selMark && !canVisit && today !== "" && (
              <p style={{ fontSize: ".8rem", color: "var(--muted)", margin: "6px 0 0" }}>「✓ 行った」のボタンは、{day}日目の当日（{dateLabel(day)}）になると出ます。</p>
            )}
            {/* メモは印をつけなくても書ける（ユーザーの指示） */}
            {/* 使うつもりの金額（円）。一覧で日ごとの合計を出す */}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <input
                type="text"
                aria-label="メモ（任意）"
                placeholder="メモ（任意）　例：新刊 2 冊・午前中に"
                maxLength={200}
                value={notes[sel.code] ?? ""}
                onChange={(e) => setNote(sel.code, e.target.value)}
                style={{ flex: 1, minWidth: 0, minHeight: 40, boxSizing: "border-box" }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 2, flex: "0 0 auto" }}>
                ¥
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="使う金額（円・任意）"
                  placeholder="金額"
                  value={budgets[sel.code] ? String(budgets[sel.code]) : ""}
                  onChange={(e) => {
                    const n = Number(e.target.value.normalize("NFKC").replace(/[^0-9]/g, "").slice(0, 7));
                    setBudget(sel.code, n);
                  }}
                  style={{ width: 84, minHeight: 40, boxSizing: "border-box", textAlign: "right" }}
                />
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="status-stack" hidden={findOpen}>
      {pubNote && (
        <div className="route-card" role="status" style={{ borderColor: "var(--accent)" }}>
          <span>{pubNote === "ask" ? "配置・作品の新しいデータがあります" : "端末の保存がいっぱいで、新しい配置・作品を入れられませんでした"}</span>
          {pubNote === "ask" && (
            <button className="chip small" onClick={() => location.reload()}>
              読みなおす
            </button>
          )}
          <button className="chip small" onClick={() => setPubNote(null)} aria-label="閉じる">
            ✕
          </button>
        </div>
      )}
      {route && (
        <div className="route-card" role="status">
          {"error" in route ? (
            <span>{route.error}</span>
          ) : (
            <span>
              {route.from}から{route.to === "toilet" ? "いちばん近いトイレ" : "救護室"}まで 約 <b>{Math.round(route.length / 10) * 10 || 10}m</b>（混んでいると歩いて約 {Math.max(1, Math.ceil(route.length / 50))} 分）
            </span>
          )}
          <button className="chip small" onClick={clearRoute} aria-label="道を消す">
            ✕
          </button>
        </div>
      )}
      {(locOn || locErr) && (
        <div className="loc-badge" role="status" onClick={() => !locOn && setLocErr("")}>
          {locErr ? (
            locErr
          ) : !loc ? (
            "位置を調べています…"
          ) : !loc.where.hall ? (
            "会場の外にいます"
          ) : (
            <>
              いま：<b>{loc.where.hall.name}</b>
              {loc.where.inside ? "" : "の近く"}
              <span style={{ color: "var(--muted)", marginLeft: 6, fontSize: ".75rem" }}>
                （±{Math.round(loc.acc)}m{loc.acc > 40 ? "・建物の中ではずれることがあります" : ""}）
              </span>
            </>
          )}
        </div>
      )}
      </div>
      {/* サイドバー：モード・日・作品とキャラ・ホールへ移動・印の一覧と印刷・エディタ（階は右の切りかえで） */}
      {menu && <div className="side-scrim" onClick={() => setMenu(false)} />}
      <aside className={"side" + (menu ? " open" : "")} aria-hidden={!menu}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: "1.05rem" }}>即売会 3D マップ</strong>
          <span className="tag">{savedLines ? "編集した配置" : pubLines ? "配置" : "見本"}</span>
          <button className="icon-btn small" style={{ marginLeft: "auto" }} aria-label="閉じる" onClick={() => setMenu(false)}>
            ✕
          </button>
        </div>
        <p style={{ color: "var(--muted)", fontSize: ".78rem", margin: "4px 0 10px" }}>
          コミックマーケット準備会・株式会社東京ビッグサイトとは関係のない非公式の試作です。
          {realData ? "作品・サークルは協力者とサークルの方が入れたものです（まちがいがあるかもしれません）" : "島の配置・作品は仮です（C109 の本当の配置ではありません）"}
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
          {mode === "register" ? "行きたい作品のスペースに印をつけるモード（最初は 2D）" : `当日に使う・回る順を考えるモード（最初は 3D）。当日（${dateLabel(1)}〜${dateLabel(3)}）になると、★・◆ の机を押して「✓ 行った」で、行った所が灰色になります`}
        </p>
        <>
            <h3>日</h3>
            <div className="seg" role="group" aria-label="日" style={{ display: "flex" }}>
              {DAYS.map((d) => (
                <button key={d} style={{ flex: 1 }} aria-pressed={day === d} onClick={() => switchDay(d)}>
                  {d}日目
                </button>
              ))}
            </div>
        </>
        <h3>ジャンル・作品・キャラ</h3>
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
          aria-label="作品・キャラ・グループ"
          value={!byGenre ? "__off" : work ? `w:${work}` : char ? `c:${char}` : "__all"}
          onChange={(e) => {
            const v = e.target.value;
            setByGenre(v !== "__off");
            setWork(v.startsWith("w:") ? v.slice(2) : null);
            setChar(v.startsWith("c:") ? v.slice(2) : null);
          }}
          style={{ width: "100%" }}
        >
          <option value="__all">{genre ? `${genre}：すべて` : "すべて（作品ごとに色分け）"}</option>
          <option value="__off">色分けしない</option>
          {workList.length > 0 && (
            <optgroup label="作品">
              {workList.map((w) => (
                <option key={w} value={`w:${w}`}>
                  {w}
                </option>
              ))}
            </optgroup>
          )}
          {!work && charList.length > 0 && (
            <optgroup label="キャラ・グループ">
              {charList.map((c) => (
                <option key={c} value={`c:${c}`}>
                  {c}
                </option>
              ))}
            </optgroup>
          )}
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
        {byGenre && !work && !char && (
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
            {day}日目 ★ {lists.want.length}・◆ {lists.maybe.length}
            {money.total > 0 ? `・${yen(money.total)}` : ""} の一覧
          </button>
          <button className="chip" onClick={startPrint}>
            配置図を印刷
          </button>
          {/* コミケ Web カタログで書き出したチェックリスト（CSV）から、印をつける */}
          <label className="chip" style={{ cursor: "pointer" }}>
            Web カタログの CSV を読む
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setMenu(false);
                openChecklist(f);
              }}
            />
          </label>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
          <span style={{ fontSize: ".85rem", color: "var(--muted)" }}>地図にピン：</span>
          {MARKS.map((m) => (
            <button key={m} className="chip small" aria-pressed={pinsOn[m]} onClick={() => setPinsOn((p) => ({ ...p, [m]: !p[m] }))}>
              {MARK[m].icon} {MARK[m].label}
            </button>
          ))}
        </div>
        {/* 島のエディタへのリンクは出さない（ユーザーの指示。エディタは /editor を直接開いたときだけ）。
            エディタで作った配置を使っているときだけ、見本に戻すボタンを出す */}
        {savedLines && (
          <>
            <h3>配置</h3>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                className="chip"
                onClick={() => {
                  clearLayout(LAYOUT_KEY);
                  location.reload();
                }}
              >
                見本に戻す
              </button>
            </div>
          </>
        )}
        <h3>ログイン（任意）</h3>
        <AccountBox />
        <p style={{ fontSize: ".8rem", margin: "8px 0 0" }}>
          <a href="/circle/">サークルの方へ：作品の登録</a>
        </p>
        <button
          className="chip"
          style={{ marginTop: 12 }}
          onClick={() => {
            setMenu(false);
            tourFrom.current = mode;
            setTour(true);
          }}
        >
          使い方を見る
        </button>
        <p style={{ color: "var(--muted)", fontSize: ".7rem", marginTop: 14 }}>
          {venue.attribution}
          <br />
          <a href="/privacy/">プライバシーポリシー</a>
        </p>
      </aside>

      {/* 初めての人向けの使い方の案内（開いたときの「非公式」の案内を閉じてから） */}
      {!splash && tour && (
        <Tour
          steps={TOUR_STEPS}
          onStep={(st) => {
            setMenu(!!st.menu);
            const m = st.mode ?? tourFrom.current;
            if (m !== mode) chooseMode(m);
          }}
          onDone={() => {
            setMenu(false);
            if (mode !== tourFrom.current) chooseMode(tourFrom.current);
            endTour();
          }}
        />
      )}

      {/* 開いたときの案内：非公式であることを大きく。どこかを押すと消える */}
      {splash && (
        <div className="splash" role="dialog" aria-label="非公式の試作です" onPointerDown={() => setSplash(false)}>
          <div className="splash-card">
            <div style={{ fontSize: "1.6rem", fontWeight: 800 }}>非公式の試作です</div>
            {/* 短く（文言が長すぎる、というユーザーの指摘）。言うべきこと（非公式・図の出どころ・見本・当日は運営に従う）は残す */}
            <p>
              コミックマーケット準備会・東京ビッグサイトとは<strong>関係のない</strong>個人の地図です。会場の図は、東京ビッグサイトの了承を得て独自に描きました（公認ではありません）。
            </p>
            <p>
              {realData ? "作品・サークルはまちがいがあるかもしれません。" : "島の配置・作品は見本です。"}
              当日は運営の案内に従ってください。
            </p>
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
                配置図（{print.day}日目の印）　{print.made} 作成。コミックマーケット準備会・株式会社東京ビッグサイトとは関係のない非公式の試作です。島の配置は見本で、C109 の本当の配置ではありません。○の文字が列の名前、島の端の数字がその列の端の机の番号。緑が出入口、灰が搬入口（シャッター）、青がトイレ、赤が救護室（図面を参考にした目安の位置で、数m ずれることがあります。当日の出入口は運営の案内に従ってください）。地図：
                {venue.attribution}
                {print.total > 0 && <strong style={{ display: "block", marginTop: 4 }}>{print.day}日目に使う金額の合計 {yen(print.total)}</strong>}
              </p>
            )}
            <h2>{sec.title}</h2>
            {/* eslint-disable-next-line @next/next/no-img-element -- その場で描いた絵（data URL）なので next/image は使わない */}
            <img src={sec.img} alt={`${sec.title}の配置図`} />
            {sec.codes.length > 0 && (
              <p className="print-marks">
                {sec.codes.map((c) => (
                  <span key={c.code} style={c.mark ? { color: hexCss(MARK[c.mark].color) } : undefined}>
                    {c.mark ? MARK[c.mark].icon : "📝"} {c.code}（{c.hall}）{c.budget > 0 ? `　${yen(c.budget)}` : ""}
                    {c.note ? `　${c.note}` : ""}
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
function Icon({ name }: { name: "menu" | "walk" | "city" }) {
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "menu":
      return (
        <svg {...common}>
          <path d="M4 6h16M4 12h16M4 18h16" />
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
