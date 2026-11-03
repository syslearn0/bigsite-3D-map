"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import layoutJson from "@/data/layout-sample.json";
import venueJson from "@/data/venue.json";
import { centroid, type XZ } from "@/lib/geo";
import { DESK_D, DESK_L, expandBooths, parseCode, SAMPLE_GENRES, type Booth, type Line } from "@/lib/layout";

// 会場の 3D。見方は3つ：上から（2D の地図のように）・3D（ぐるっと回せる）・歩く（一人称）。
// ホールの位置関係は OSM の緯度経度のまま。机の配置は見本（C109 の本当の配置ではない）。
// 机は数が多いので InstancedMesh で描き、タップした机は instanceId から配置番号に戻す。

type Hall = { id: string; name: string; building: "東" | "西" | "南"; level: number; poly: XZ[]; closed?: string; rough?: boolean };
type Venue = {
  floorY: Record<string, number>;
  attribution: string;
  halls: Hall[];
  areas: { name: string; level: number; poly: XZ[] }[];
  context: { name: string; height: number; poly: XZ[] }[];
  toilets: { at: XZ; level: number | null }[];
};
const venue = venueJson as unknown as Venue;
const lines = (layoutJson as unknown as { lines: Line[] }).lines;
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
const WISH_COLOR = 0xff2d87;
const SELECT_COLOR = 0xffb000;
const WISH_KEY = "comiket3d:wish";

const floorY = (level: number) => venue.floorY[String(level)] ?? 0;
const floorOf = (level: number): Floor => (level >= 4 ? 4 : 1);
const hexCss = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

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

function shapeOf(poly: XZ[]) {
  // ShapeGeometry は XY 平面。-90° 倒すと (x, y) → (x, 0, -y) なので、y に -z を入れる
  return new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
}

function flatPoly(poly: XZ[], color: number, y: number, opacity = 1) {
  const m = new THREE.Mesh(
    new THREE.ShapeGeometry(shapeOf(poly)),
    new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
}

function walls(poly: XZ[], y: number, height: number, mat: THREE.Material) {
  const g = new THREE.Group();
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) continue;
    const w = new THREE.Mesh(new THREE.BoxGeometry(len, height, 0.4), mat);
    w.position.set((ax + bx) / 2, y + height / 2, (az + bz) / 2);
    w.rotation.y = -Math.atan2(bz - az, bx - ax);
    g.add(w);
  }
  return g;
}

type Api = {
  setView: (v: View) => void;
  setFloor: (f: Floor) => void;
  recolor: (colorByGenre: boolean, wish: Set<string>, selected: number | null) => void;
  focusBooth: (i: number) => void;
  focusHall: (id: string) => void;
  hold: (dir: -1 | 0 | 1) => void;
};

export function VenueView() {
  const box = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const booths = useMemo<Booth[]>(() => expandBooths(lines, venue.halls), []);
  const codeIndex = useMemo(() => new Map(booths.map((b, i) => [b.code, i])), [booths]);
  const [view, setView] = useState<View>("top");
  const [floor, setFloor] = useState<Floor>(1);
  const [byGenre, setByGenre] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [miss, setMiss] = useState(false);
  // この画面はブラウザでだけ描く（page.tsx で ssr: false）ので、最初から端末の保存を読める
  const [wish, setWish] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(WISH_KEY) ?? "[]");
      return new Set(Array.isArray(saved) ? saved : []);
    } catch {
      return new Set();
    }
  });
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(WISH_KEY, JSON.stringify([...wish]));
    } catch {}
  }, [wish]);

  // ---- 3D の準備（1回だけ） ----
  useEffect(() => {
    const el = box.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
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

    // 階ごとの入れ物。選んでいない階は床を薄くし、机・壁・文字を隠す
    type LevelParts = { floors: THREE.Mesh[]; solid: THREE.Object3D[] };
    // ホールの名前：上から全体を見ているときにも読めるよう、引くほど大きくする（元の大きさを覚えておく）
    const hallLabels: { s: THREE.Sprite; base: THREE.Vector3 }[] = [];
    const levels = new Map<number, LevelParts>();
    const partsOf = (lv: number) => {
      if (!levels.has(lv)) levels.set(lv, { floors: [], solid: [] });
      return levels.get(lv)!;
    };
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x8d9894, transparent: true, opacity: 0.55 });

    for (const a of venue.areas) {
      const y = floorY(a.level);
      const f = flatPoly(a.poly, 0xf3f1ea, y + 0.02);
      scene.add(f);
      partsOf(a.level).floors.push(f);
      const label = textSprite(a.name, { fg: "#55584f", height: 3.2, px: 32 });
      const [cx, cz] = centroid(a.poly);
      label.position.set(cx, y + 3, cz);
      scene.add(label);
      partsOf(a.level).solid.push(label);
    }
    for (const h of venue.halls) {
      const y = floorY(h.level);
      const f = flatPoly(h.poly, h.closed ? 0xc4c4bf : BUILDING_COLOR[h.building], y + 0.05);
      scene.add(f);
      partsOf(h.level).floors.push(f);
      const w = walls(h.poly, y, 5, wallMat);
      scene.add(w);
      partsOf(h.level).solid.push(w);
      const [cx, cz] = centroid(h.poly);
      const name = h.name + (h.level >= 4 ? "（4F）" : "") + (h.closed ? "：工事中" : "") + (h.rough ? "（形は概略）" : "");
      const label = textSprite(name, { bg: h.closed ? "rgba(90,90,86,.85)" : "rgba(30,40,60,.82)", height: 7, px: 40 });
      label.position.set(cx, y + 14, cz);
      scene.add(label);
      partsOf(h.level).solid.push(label);
      hallLabels.push({ s: label, base: label.scale.clone() });
    }
    for (const t of venue.toilets) {
      const lv = t.level ?? 1;
      const m = textSprite("WC", { bg: "rgba(31,95,191,.9)", height: 3, px: 34 });
      m.position.set(t.at[0], floorY(lv) + 3, t.at[1]);
      scene.add(m);
      partsOf(lv).solid.push(m);
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
    for (const [lv, index] of byLevel) {
      const mesh = new THREE.InstancedMesh(deskGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), index.length);
      index.forEach((bi, k) => {
        const b = booths[bi];
        tmp.position.set(b.at[0], floorY(lv) + 0.35, b.at[1]);
        tmp.rotation.set(0, -b.angle, 0);
        tmp.updateMatrix();
        mesh.setMatrixAt(k, tmp.matrix);
        mesh.setColorAt(k, new THREE.Color(DESK_COLOR));
      });
      scene.add(mesh);
      partsOf(lv).solid.push(mesh);
      deskMeshes.set(lv, { mesh, index });
    }
    // 列の名前（ブロック）。会場の札のように、列の端の頭の上に
    for (const l of lines) {
      const h = hallById.get(l.hall)!;
      const s = textSprite(l.block, { bg: "rgba(255,255,255,.9)", fg: "#1d1d1b", height: 1.8, px: 36 });
      s.position.set(l.start[0] - Math.cos(l.angle) * 1.5, floorY(h.level) + 3.2, l.start[1] - Math.sin(l.angle) * 1.5);
      scene.add(s);
      partsOf(h.level).solid.push(s);
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
      for (const s of sprites) s.material.depthTest = v !== "top";
      persp.fov = v === "walk" ? 70 : 50;
      persp.updateProjectionMatrix();
      if (v === "top") {
        camera = ortho;
        ortho.position.set(focus.x, 600, focus.z + 0.01);
        ortho.updateProjectionMatrix();
        const c = new MapControls(ortho, renderer.domElement);
        c.enableRotate = false;
        c.screenSpacePanning = false;
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
          mat.transparent = !on;
          mat.opacity = on ? 1 : 0.18;
          mat.depthWrite = on;
          m.visible = on || !walk;
        }
        for (const o of p.solid) o.visible = on;
      }
      for (const { s } of hallLabels) if (walk) s.visible = false;
      pin.visible = pinOn && !walk;
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
          ortho.zoom = Math.max(ortho.zoom, 4);
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

    const recolor = (colorByGenre: boolean, wishSet: Set<string>, sel: number | null) => {
      const col = new THREE.Color();
      for (const { mesh, index } of deskMeshes.values()) {
        index.forEach((bi, k) => {
          const b = booths[bi];
          if (bi === sel) col.setHex(SELECT_COLOR);
          else if (wishSet.has(b.code)) col.setHex(WISH_COLOR);
          else if (colorByGenre) {
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
      setMiss(false);
    };
    let down: { x: number; y: number; yaw: number; pitch: number } | null = null;
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
      const r = renderer.domElement.getBoundingClientRect();
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
        persp.position.x += (fx * fwd - fz * side) * WALK_SPEED * dt;
        persp.position.z += (fz * fwd + fx * side) * WALK_SPEED * dt;
        persp.position.y = eyeY();
        persp.rotation.set(pitch, yaw, 0, "YXZ");
      } else controls?.update();
      if (controls) focus.set(controls.target.x, focus.y, controls.target.z);
      else if (current === "walk") focus.set(persp.position.x, focus.y, persp.position.z);
      const grow = current === "top" ? Math.min(4, Math.max(1, 1.6 / ortho.zoom)) : 1;
      for (const { s, base } of hallLabels) s.scale.copy(base).multiplyScalar(grow);
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
    api.current = { setView, setFloor, recolor, focusBooth, focusHall, hold: (d) => (hold = d) };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKey);
      controls?.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      el.removeChild(renderer.domElement);
      api.current = null;
    };
  }, [booths]);

  useEffect(() => api.current?.setView(view), [view]);
  useEffect(() => api.current?.setFloor(floor), [floor]);
  useEffect(() => api.current?.recolor(byGenre, wish, selected), [byGenre, wish, selected]);

  const select = useCallback(
    (i: number) => {
      setSelected(i);
      const lv = hallById.get(booths[i].hall)!.level;
      setFloor(floorOf(lv));
      api.current?.focusBooth(i);
    },
    [booths],
  );

  const search = () => {
    const p = parseCode(query);
    if (!p) return setMiss(true);
    // a・b を書かなかったときは a
    const i = codeIndex.get(`${p.prefix}${p.block}-${String(p.num).padStart(2, "0")}${p.half ?? "a"}`);
    if (i === undefined) return setMiss(true);
    setMiss(false);
    select(i);
  };

  const sel = selected !== null ? booths[selected] : null;
  const selHall = sel ? hallById.get(sel.hall)! : null;
  const wished = sel ? wish.has(sel.code) : false;
  const toggleWish = (code: string) =>
    setWish((w) => {
      const n = new Set(w);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  const wishList = [...wish].filter((c) => codeIndex.has(c)).sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
  const openHalls = venue.halls.filter((h) => !h.closed);

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "8px 12px 6px", background: "var(--card)", borderBottom: "1px solid var(--line)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <strong style={{ fontSize: "1.05rem" }}>コミケ 3D マップ</strong>
          <span className="tag">見本</span>
          <span style={{ color: "var(--muted)", fontSize: ".8rem" }}>島の配置・作品は仮です（C109 の本当の配置ではありません）</span>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
          <div className="seg" role="group" aria-label="見方">
            {VIEWS.map((v) => (
              <button key={v.id} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
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
          <button className="chip" onClick={() => setListOpen((x) => !x)}>
            ★ 行きたい {wishList.length}
          </button>
        </div>
        <form
          style={{ display: "flex", gap: 6, marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="配置番号（例：東A-01a、西あ-12b）"
            aria-label="配置番号"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button type="submit">探す</button>
        </form>
        {miss && <div style={{ color: "var(--danger)", fontSize: ".85rem", marginTop: 4 }}>その配置番号は見本の配置にありません</div>}
        <div style={{ display: "flex", gap: 4, marginTop: 6, overflowX: "auto", paddingBottom: 2 }}>
          {openHalls.map((h) => (
            <button key={h.id} className="chip small" onClick={() => api.current?.focusHall(h.id)}>
              {h.name.replace("ホール", "")}
            </button>
          ))}
        </div>
      </header>

      <div ref={box} style={{ position: "relative", flex: 1, minHeight: 0, touchAction: "none" }}>
        {byGenre && (
          <div style={{ ...OVER, top: 8, left: 8, fontSize: ".75rem", display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 260 }}>
            {SAMPLE_GENRES.map((g, i) => (
              <span key={g} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: hexCss(GENRE_COLOR[i]), display: "inline-block" }} />
                {g}
              </span>
            ))}
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
              <strong>行きたいサークル</strong>
              <button className="chip small" onClick={() => setListOpen(false)}>
                閉じる
              </button>
            </div>
            {wishList.length === 0 && <p style={{ color: "var(--muted)", margin: "8px 0 0" }}>机を押して「★ 行きたい」で追加できます。この端末の中だけに保存します。</p>}
            <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
              {wishList.map((c) => (
                <li key={c} style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                  <button className="chip small" style={{ flex: 1, textAlign: "left" }} onClick={() => select(codeIndex.get(c)!)}>
                    {c}　{hallById.get(booths[codeIndex.get(c)!].hall)!.name}
                  </button>
                  <button className="chip small" onClick={() => toggleWish(c)} aria-label={`${c} を外す`}>
                    外す
                  </button>
                </li>
              ))}
            </ul>
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
              作品（見本）：{lines[sel.line].genre}　／　サークル：<span style={{ color: "var(--muted)" }}>まだ登録されていません</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button style={{ flex: 1, minHeight: 44, fontWeight: 700 }} aria-pressed={wished} onClick={() => toggleWish(sel.code)}>
                {wished ? "★ 行きたい（外す）" : "☆ 行きたい"}
              </button>
              {view !== "walk" && (
                <button
                  style={{ minHeight: 44 }}
                  onClick={() => {
                    setView("walk");
                    requestAnimationFrame(() => api.current?.focusBooth(selected!));
                  }}
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
