"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import layoutJson from "@/data/layout-sample.json";
import venueJson from "@/data/venue.json";
import { minAreaRect, type XZ } from "@/lib/geo";
import { DESK_D, DESK_L, expandBooths, layoutProblems, lineLength, nextBlock, parseLayoutFile, PITCH, toLayoutFile, type HallLike, type Line } from "@/lib/layout";
import { DRAFT_KEY, LAYOUT_KEY, loadLayout, saveLayout } from "@/lib/saved-layout";

// 島のエディタ。カタログの配置図を下絵に重ねて、島の列（ブロック）を並べる。
// 見方は上から（2D）。ホールを、島がまっすぐ（横か縦）になる向きに回して見せる。
// 島の列 = 始点・向き・区切りごとの机の数（layout.ts の Line）。番号は始点から A側を進み、B側を戻る。
// 下絵の画像は端末の中だけで使い、保存も送信もしない（カタログの配置図をそのまま配らないため）。

type Hall = HallLike & { name: string; closed?: string };
const halls = (venueJson as unknown as { halls: Hall[] }).halls;
const openHalls = halls.filter((h) => !h.closed);
const hallById = new Map(halls.map((h) => [h.id, h]));
const sampleLines = (layoutJson as unknown as { lines: Line[] }).lines;

type Tool = "select" | "add" | "image";
type Bg = { img: HTMLImageElement; x: number; z: number; mPerPx: number; rot: number; opacity: number };
const floorOf = (lv: number) => (lv >= 4 ? 4 : 1);
const THICK = 6; // 机の奥行きを何倍に描くか（島 1 本が約 5.4m。島どうしの間 7m なら、間が 1.6m ほど残る）
const clone = (l: Line[]) => l.map((x) => ({ ...x, start: [...x.start] as XZ, segments: [...x.segments] }));

// ホールを島がまっすぐになる向きに回す角（ホールの長い辺を横に。北がなるべく上）
function viewAngle(h: Hall) {
  let t = minAreaRect(h.poly).angle;
  if (Math.cos(t) < 0) t += Math.PI;
  return t;
}

export function IslandEditor() {
  const [lines, setLines] = useState<Line[]>(() => loadLayout(DRAFT_KEY) ?? loadLayout(LAYOUT_KEY) ?? clone(sampleLines));
  const [hallId, setHallId] = useState("E1");
  const [sel, setSel] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [turn, setTurn] = useState(0); // 見る向きを 90° ずつ回す
  const [copyN, setCopyN] = useState(5);
  const [copyGap, setCopyGap] = useState(PITCH);
  const [bgs, setBgs] = useState<Record<string, Bg>>({});
  const [msg, setMsg] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const history = useRef<Line[][]>([]);
  const view = useRef({ k: 4, u: 0, v: 0 }); // 1m の px・画面の真ん中に見る位置（回した座標）
  const pointer = useRef<XZ | null>(null);
  const addStart = useRef<XZ | null>(null);
  const drag = useRef<{ kind: "pan" | "line" | "image"; sx: number; sy: number; u: number; v: number; start?: XZ; bg?: { x: number; z: number } } | null>(null);
  const [, redraw] = useState(0);
  const repaint = useCallback(() => redraw((n) => n + 1), []);

  const hall = hallById.get(hallId)!;
  const theta = viewAngle(hall) + (turn * Math.PI) / 2;
  const center = useMemo(() => {
    const xs = hall.poly.map((p) => p[0]), zs = hall.poly.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2] as XZ;
  }, [hall]);
  const levelHalls = useMemo(() => halls.filter((h) => floorOf(h.level) === floorOf(hall.level)), [hall]);
  const booths = useMemo(() => expandBooths(lines, halls), [lines]);
  const problems = useMemo(() => layoutProblems(lines, halls), [lines]);
  const badLines = useMemo(() => new Set(problems.map((p) => p.line)), [problems]);

  // 端末に書きかけを保存（自動）
  useEffect(() => {
    saveLayout(DRAFT_KEY, lines);
  }, [lines]);

  // ホールを変えたら、ホール全体が入る大きさに
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const c = Math.cos(theta), s = Math.sin(theta);
    const uv = hall.poly.map(([x, z]) => [(x - center[0]) * c + (z - center[1]) * s, -(x - center[0]) * s + (z - center[1]) * c]);
    const w = Math.max(...uv.map((p) => p[0])) - Math.min(...uv.map((p) => p[0]));
    const h = Math.max(...uv.map((p) => p[1])) - Math.min(...uv.map((p) => p[1]));
    view.current = { k: Math.min(el.clientWidth / (w + 16), el.clientHeight / (h + 16)), u: 0, v: 0 };
    repaint();
  }, [hallId, turn, center, hall, theta, repaint]);

  // 会場の座標 ⇔ 画面の座標
  const tf = useCallback(() => {
    const el = cv.current!;
    const W = el.clientWidth, H = el.clientHeight;
    const c = Math.cos(theta), s = Math.sin(theta);
    const { k, u: pu, v: pv } = view.current;
    const toS = ([x, z]: XZ): [number, number] => {
      const u = (x - center[0]) * c + (z - center[1]) * s, v = -(x - center[0]) * s + (z - center[1]) * c;
      return [W / 2 + (u - pu) * k, H / 2 + (v - pv) * k];
    };
    const toW = (sx: number, sy: number): XZ => {
      const u = (sx - W / 2) / k + pu, v = (sy - H / 2) / k + pv;
      return [center[0] + u * c - v * s, center[1] + u * s + v * c];
    };
    return { toS, toW, k, W, H };
  }, [theta, center]);

  // 島の向きを、ホールの壁の向き（90° ごと）に吸いつかせる
  const snapAngle = useCallback(
    (a: number) => {
      const base = viewAngle(hall);
      const k = Math.round((a - base) / (Math.PI / 2));
      return base + (k * Math.PI) / 2;
    },
    [hall],
  );

  const change = useCallback((next: Line[]) => {
    history.current.push(clone(lines));
    if (history.current.length > 80) history.current.shift();
    setLines(next);
  }, [lines]);
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) setLines(prev);
  }, []);
  const updateSel = useCallback((patch: Partial<Line>) => {
    if (sel === null) return;
    change(lines.map((l, i) => (i === sel ? { ...l, ...patch } : l)));
  }, [sel, lines, change]);

  // ---- 描く ----
  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const dpr = Math.min(devicePixelRatio, 2);
    el.width = el.clientWidth * dpr;
    el.height = el.clientHeight * dpr;
    const g = el.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { toS, k, W, H } = tf();
    g.fillStyle = "#e9ece9";
    g.fillRect(0, 0, W, H);
    // 下絵
    const bg = bgs[hallId];
    if (bg) {
      const [sx, sy] = toS([bg.x, bg.z]);
      g.save();
      g.translate(sx, sy);
      g.rotate((bg.rot * Math.PI) / 180);
      g.scale(bg.mPerPx * k, bg.mPerPx * k);
      g.globalAlpha = bg.opacity;
      g.drawImage(bg.img, -bg.img.width / 2, -bg.img.height / 2);
      g.restore();
    }
    // ホール（同じ階）
    const poly = (pts: XZ[]) => {
      g.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = toS(p);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
    };
    for (const h of levelHalls) {
      poly(h.poly);
      g.fillStyle = h.id === hallId ? "rgba(214,228,247,.55)" : h.closed ? "rgba(190,190,185,.4)" : "rgba(214,228,247,.25)";
      g.fill();
      g.strokeStyle = h.id === hallId ? "#41566e" : "#9aa5a0";
      g.lineWidth = h.id === hallId ? 2 : 1;
      g.stroke();
    }
    // 机（スペース＝机半分）
    const onLevel = new Set(levelHalls.map((h) => h.id));
    for (const b of booths) {
      if (!onLevel.has(b.hall)) continue;
      const c = Math.cos(b.angle), s = Math.sin(b.angle);
      // 机の奥行きは実物の THICK 倍に描く（細いと見にくく押しにくい）。島の外側へのばす
      const hl = DESK_L / 4 - 0.02, hd = (DESK_D / 2) * THICK, off = (b.side * DESK_D * (THICK - 1)) / 2;
      const corner = (du: number, dv: number): XZ => [b.at[0] + du * c - (dv + off) * s, b.at[1] + du * s + (dv + off) * c];
      poly([corner(-hl, -hd), corner(hl, -hd), corner(hl, hd), corner(-hl, hd)]);
      g.fillStyle = b.line === sel ? "#ffb000" : badLines.has(b.line) ? "#e05a5a" : b.hall === hallId ? "#7d93b6" : "#b7c2cf";
      g.fill();
    }
    // 列の名前（始点）と、番号の進む向き（始点から A側へ）
    g.textAlign = "center";
    g.textBaseline = "middle";
    lines.forEach((l, i) => {
      if (!onLevel.has(l.hall)) return;
      const c = Math.cos(l.angle), s = Math.sin(l.angle);
      const [sx, sy] = toS([l.start[0] - c * 2.2, l.start[1] - s * 2.2]);
      const r = Math.max(8, k * 1.1);
      g.fillStyle = i === sel ? "#ffb000" : "#fff";
      g.strokeStyle = "#1d1d1b";
      g.lineWidth = 1;
      g.beginPath();
      g.arc(sx, sy, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = "#1d1d1b";
      g.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`;
      g.fillText(l.block, sx, sy);
      if (i === sel) {
        // 矢印：始点から番号が進む向き
        const len = lineLength(l);
        const [ax, ay] = toS(l.start);
        const [bx, by] = toS([l.start[0] + c * Math.min(len, 6), l.start[1] + s * Math.min(len, 6)]);
        g.strokeStyle = "#d4559a";
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
        const ang = Math.atan2(by - ay, bx - ax);
        g.beginPath();
        g.moveTo(bx, by);
        g.lineTo(bx - 10 * Math.cos(ang - 0.4), by - 10 * Math.sin(ang - 0.4));
        g.lineTo(bx - 10 * Math.cos(ang + 0.4), by - 10 * Math.sin(ang + 0.4));
        g.closePath();
        g.fillStyle = "#d4559a";
        g.fill();
      }
    });
    // 拡大したら机ごとの番号
    if (k * DESK_L >= 22) {
      g.font = `600 ${Math.round(Math.min(13, k * 0.7))}px system-ui, sans-serif`;
      g.fillStyle = "#fff";
      for (let i = 0; i + 1 < booths.length; i++) {
        const a = booths[i], b = booths[i + 1];
        if (!onLevel.has(a.hall) || a.half !== "a" || b.num !== a.num || b.line !== a.line) continue;
        const [sx, sy] = toS([(a.at[0] + b.at[0]) / 2, (a.at[1] + b.at[1]) / 2]);
        if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
        g.fillText(String(a.num).padStart(2, "0"), sx, sy);
      }
    }
    // 置いている途中の島
    if (tool === "add" && addStart.current && pointer.current) {
      const a = addStart.current, p = pointer.current;
      const ang = snapAngle(Math.atan2(p[1] - a[1], p[0] - a[0]));
      const len = (p[0] - a[0]) * Math.cos(ang) + (p[1] - a[1]) * Math.sin(ang);
      const n = Math.max(1, Math.round(Math.abs(len) / DESK_L));
      const e: XZ = [a[0] + Math.cos(ang) * n * DESK_L * Math.sign(len || 1), a[1] + Math.sin(ang) * n * DESK_L * Math.sign(len || 1)];
      const [x1, y1] = toS(a), [x2, y2] = toS(e);
      g.strokeStyle = "#d4559a";
      g.lineWidth = Math.max(3, k * 0.9);
      g.globalAlpha = 0.7;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = "#1d1d1b";
      g.font = "700 13px system-ui, sans-serif";
      g.fillText(`机 ${n}`, x2 + 24, y2 - 12);
    }
  });

  // ---- 操作 ----
  const hitLine = useCallback(
    (p: XZ) => {
      let best = -1, bestD = 0.3 + DESK_D * THICK; // 太く描いた島の幅のぶん
      lines.forEach((l, i) => {
        if (l.hall !== hallId) return;
        const c = Math.cos(l.angle), s = Math.sin(l.angle);
        const u = (p[0] - l.start[0]) * c + (p[1] - l.start[1]) * s;
        const v = -(p[0] - l.start[0]) * s + (p[1] - l.start[1]) * c;
        const len = lineLength(l);
        const d = Math.hypot(Math.max(0, -u, u - len), v);
        if (d < bestD) [best, bestD] = [i, d];
      });
      return best;
    },
    [lines, hallId],
  );

  // 指 2 本で拡大・移動（スマホ・タブレット）
  const fingers = useRef(new Map<number, [number, number]>());
  const pinch = useRef<{ d0: number; k0: number; u: number; v: number } | null>(null);
  const zoomAt = useCallback(
    (sx: number, sy: number, k: number) => {
      const { W, H } = tf();
      const v = view.current;
      const before = { u: (sx - W / 2) / v.k + v.u, v: (sy - H / 2) / v.k + v.v };
      v.k = Math.min(80, Math.max(0.5, k));
      // 指・カーソルの下の場所がそのままになるように
      v.u = before.u - (sx - W / 2) / v.k;
      v.v = before.v - (sy - H / 2) / v.k;
      repaint();
    },
    [tf, repaint],
  );

  const onDown = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const { toW } = tf();
    const p = toW(sx, sy);
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    fingers.current.set(e.pointerId, [sx, sy]);
    if (fingers.current.size === 2) {
      // 2 本目の指：拡大・移動に切り替える（1 本目で始めた操作はやめる）
      const [a, b] = [...fingers.current.values()];
      const { W, H } = tf();
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const v = view.current;
      pinch.current = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]), k0: v.k, u: (mx - W / 2) / v.k + v.u, v: (my - H / 2) / v.k + v.v };
      drag.current = null;
      addStart.current = null;
      return;
    }
    const panStart = { sx, sy, u: view.current.u, v: view.current.v };
    if (tool === "add") {
      if (!addStart.current) {
        addStart.current = p;
        repaint();
        return;
      }
      const a = addStart.current;
      const ang0 = Math.atan2(p[1] - a[1], p[0] - a[0]);
      const ang = e.shiftKey ? ang0 : snapAngle(ang0);
      const len = (p[0] - a[0]) * Math.cos(ang) + (p[1] - a[1]) * Math.sin(ang);
      const n = Math.max(1, Math.round(Math.abs(len) / DESK_L));
      const line: Line = { hall: hallId, block: nextBlock(lines, hall.building, halls), start: [Math.round(a[0] * 100) / 100, Math.round(a[1] * 100) / 100], angle: len >= 0 ? ang : ang + Math.PI, segments: [n] };
      addStart.current = null;
      change([...lines, line]);
      setSel(lines.length);
      return;
    }
    if (tool === "image") {
      const bg = bgs[hallId];
      if (bg) drag.current = { kind: "image", ...panStart, bg: { x: bg.x, z: bg.z } };
      else drag.current = { kind: "pan", ...panStart };
      return;
    }
    const hit = hitLine(p);
    if (hit >= 0) {
      setSel(hit);
      history.current.push(clone(lines));
      drag.current = { kind: "line", ...panStart, start: [...lines[hit].start] as XZ };
    } else {
      setSel(null);
      drag.current = { kind: "pan", ...panStart };
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const { toW, k, W, H } = tf();
    pointer.current = toW(sx, sy);
    if (fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, [sx, sy]);
    if (pinch.current && fingers.current.size >= 2) {
      const [a, b] = [...fingers.current.values()];
      const pc = pinch.current;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const v = view.current;
      v.k = Math.min(80, Math.max(0.5, (pc.k0 * Math.hypot(a[0] - b[0], a[1] - b[1])) / Math.max(1, pc.d0)));
      // 始めたときの 2 本の指の真ん中の場所が、いまの真ん中に来るように
      v.u = pc.u - (mx - W / 2) / v.k;
      v.v = pc.v - (my - H / 2) / v.k;
      repaint();
      return;
    }
    const d = drag.current;
    if (!d) {
      if (tool === "add" && addStart.current) repaint();
      return;
    }
    const du = (sx - d.sx) / k, dv = (sy - d.sy) / k;
    const c = Math.cos(theta), s = Math.sin(theta);
    const dx = du * c - dv * s, dz = du * s + dv * c; // 画面の動き → 会場の動き
    if (d.kind === "pan") {
      view.current.u = d.u - du;
      view.current.v = d.v - dv;
      repaint();
    } else if (d.kind === "line" && sel !== null) {
      // 0.1m ごとに動かす
      const st: XZ = [Math.round((d.start![0] + dx) * 10) / 10, Math.round((d.start![1] + dz) * 10) / 10];
      setLines(lines.map((l, i) => (i === sel ? { ...l, start: st } : l)));
    } else if (d.kind === "image") {
      setBgs((b) => ({ ...b, [hallId]: { ...b[hallId], x: d.bg!.x + dx, z: d.bg!.z + dz } }));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    fingers.current.delete(e.pointerId);
    if (fingers.current.size < 2) pinch.current = null;
    drag.current = null;
  };

  // ホイール：地図だけを拡大する。ブラウザの既定の動き（ページのスクロールや、Ctrl＋ホイール・トラックパッドのピンチでのページ全体の拡大）は止める。
  // React の onWheel は止められない（passive）ので、canvas に直接つける
  const onWheel = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    onWheel.current = (e: WheelEvent) => {
      e.preventDefault();
      const r = cv.current!.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (tool === "image" && e.altKey && bgs[hallId]) {
        // Alt＋ホイールで下絵の大きさ
        const f = e.deltaY < 0 ? 1.02 : 1 / 1.02;
        setBgs((b) => ({ ...b, [hallId]: { ...b[hallId], mPerPx: b[hallId].mPerPx * f } }));
        return;
      }
      // トラックパッドのピンチ（Ctrl つき）は細かく、マウスのホイールは 1 段ずつ
      const f = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAt(sx, sy, view.current.k * f);
    };
  });
  useEffect(() => {
    const el = cv.current!;
    const h = (e: WheelEvent) => onWheel.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  // キーボード：Delete で消す、矢印で 0.1m（Shift で 1m）動かす、Ctrl+Z で戻す、Esc でやめる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === "Escape") {
        addStart.current = null;
        setSel(null);
        repaint();
        return;
      }
      if (sel === null) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        change(lines.filter((_, i) => i !== sel));
        setSel(null);
        return;
      }
      const step = e.shiftKey ? 1 : 0.1;
      const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (m) {
        e.preventDefault();
        const c = Math.cos(theta), s = Math.sin(theta);
        const l = lines[sel];
        updateSel({ start: [Math.round((l.start[0] + m[0] * c - m[1] * s) * 100) / 100, Math.round((l.start[1] + m[0] * s + m[1] * c) * 100) / 100] });
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [sel, lines, theta, undo, change, updateSel, repaint]);

  // ---- 選んだ島の操作 ----
  const selLine = sel !== null ? lines[sel] : null;
  const rotate90 = () => selLine && updateSel({ angle: selLine.angle + Math.PI / 2 });
  // 番号の向きを反対に：終点を始点にして、向きを 180° 回す
  const reverse = () => {
    if (!selLine) return;
    const len = lineLength(selLine);
    updateSel({ start: [selLine.start[0] + Math.cos(selLine.angle) * len, selLine.start[1] + Math.sin(selLine.angle) * len], angle: selLine.angle + Math.PI, segments: [...selLine.segments].reverse() });
  };
  // 平行にコピー：島の横（sign = 1 か -1）へ、間隔 copyGap で copyN 本。列の名前は次の文字
  const copyParallel = (sign: 1 | -1) => {
    if (!selLine) return;
    const nx = -Math.sin(selLine.angle) * sign, nz = Math.cos(selLine.angle) * sign;
    let next = [...lines];
    for (let i = 1; i <= copyN; i++) {
      next = [...next, { ...selLine, start: [selLine.start[0] + nx * copyGap * i, selLine.start[1] + nz * copyGap * i] as XZ, segments: [...selLine.segments], block: nextBlock(next, hall.building, halls) }];
    }
    change(next);
  };
  // コピーのボタンに、画面の上でどちらへ並ぶかを矢印で出す
  const sideArrow = (sign: 1 | -1) => {
    if (!selLine) return "";
    const nx = -Math.sin(selLine.angle) * sign, nz = Math.cos(selLine.angle) * sign;
    const c = Math.cos(theta), s = Math.sin(theta);
    const u = nx * c + nz * s, v = -nx * s + nz * c;
    return Math.abs(u) > Math.abs(v) ? (u > 0 ? "→" : "←") : v > 0 ? "↓" : "↑";
  };

  // ---- 下絵 ----
  const loadImage = (file: File) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // 最初はホールの幅に合わせる
      const xs = hall.poly.map((p) => p[0]);
      const w = Math.max(...xs) - Math.min(...xs);
      setBgs((b) => ({ ...b, [hallId]: { img, x: center[0], z: center[1], mPerPx: (w * 1.2) / img.width, rot: 0, opacity: 0.5 } }));
      setTool("image");
    };
    img.src = url;
  };
  const bg = bgs[hallId];
  const setBg = (patch: Partial<Bg>) => setBgs((b) => ({ ...b, [hallId]: { ...b[hallId], ...patch } }));

  // ---- ファイル ----
  const download = () => {
    const blob = new Blob([JSON.stringify(toLayoutFile(lines), null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `layout-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const upload = async (file: File) => {
    try {
      const got = parseLayoutFile(JSON.parse(await file.text()));
      if (!got) return setMsg("配置のファイルとして読めませんでした");
      change(got);
      setSel(null);
      setMsg(`${got.length} 本の列を読み込みました`);
    } catch {
      setMsg("ファイルを読めませんでした");
    }
  };
  const showOnMap = () => {
    if (!saveLayout(LAYOUT_KEY, lines)) return setMsg("端末に保存できませんでした");
    // メインの地図は、開いたときに保存した配置を読むので、ページごと開き直す
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 読み込み直しが要るため
    location.href = "/";
  };

  const hallLines = lines.filter((l) => l.hall === hallId).length;
  const hallSpaces = booths.filter((b) => b.hall === hallId).length;
  const hallProblems = problems.filter((p) => lines[p.line]?.hall === hallId);

  return (
    <div className="app" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "8px 12px", background: "var(--card)", borderBottom: "1px solid var(--line)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>島のエディタ</strong>
        <select aria-label="ホール" value={hallId} onChange={(e) => (setHallId(e.target.value), setSel(null), (addStart.current = null))}>
          {openHalls.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}（{h.level}F）
            </option>
          ))}
        </select>
        <div className="seg" role="group" aria-label="道具">
          {(
            [
              ["select", "選ぶ・動かす"],
              ["add", "島を置く"],
              ["image", "下絵を合わせる"],
            ] as const
          ).map(([t, label]) => (
            <button key={t} aria-pressed={tool === t} onClick={() => ((addStart.current = null), setTool(t))}>
              {label}
            </button>
          ))}
        </div>
        <button className="chip" onClick={() => setTurn((t) => (t + 1) % 4)}>
          見る向きを 90° 回す
        </button>
        <button className="chip" onClick={undo} disabled={!history.current.length}>
          戻す
        </button>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="chip" onClick={download}>
            書き出す
          </button>
          <label className="chip" style={{ display: "inline-flex", alignItems: "center", cursor: "pointer", border: "1px solid var(--line)", padding: "6px 10px" }}>
            読み込む
            <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
          <button
            className="chip"
            onClick={() => {
              if (confirm("見本の配置に戻しますか？いまの配置は消えます（書き出していなければ戻せません）")) {
                change(clone(sampleLines));
                setSel(null);
              }
            }}
          >
            見本に戻す
          </button>
          <button onClick={showOnMap} style={{ fontWeight: 700 }}>
            3D で確かめる
          </button>
        </span>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div ref={box} style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <canvas
            ref={cv}
            style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: tool === "add" ? "crosshair" : tool === "image" ? "move" : "default" }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
          <div style={{ ...HINT }}>
            {tool === "add"
              ? addStart.current
                ? "終わりの場所を押す（向きは壁にそろう。Shift で自由な向き）。Esc でやめる"
                : "島の列の始まり（番号 01 の側の端）を押す"
              : tool === "image"
                ? "ドラッグで下絵を動かす。Alt＋ホイールで大きさ。回転と濃さは右の欄で"
                : "島を押して選ぶ・ドラッグで動かす。矢印キーで 0.1m（Shift で 1m）。Delete で消す。何もない所のドラッグで地図を動かす"}
          </div>
        </div>
        <aside style={PANEL}>
          <section>
            <h3 style={H3}>{hall.name}</h3>
            <div style={{ fontSize: ".85rem", color: "var(--muted)" }}>
              列 {hallLines} 本・{hallSpaces} スペース
            </div>
            {msg && <div style={{ fontSize: ".85rem", marginTop: 4 }}>{msg}</div>}
          </section>

          <section>
            <h3 style={H3}>下絵（カタログの配置図など）</h3>
            <label className="chip" style={{ display: "inline-block", cursor: "pointer", border: "1px solid var(--line)", padding: "6px 10px" }}>
              画像を読み込む
              <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && loadImage(e.target.files[0])} />
            </label>
            <p style={NOTE}>画像はこの端末の中だけで使い、保存も送信もしません。</p>
            {bg && (
              <div style={{ display: "grid", gap: 6 }}>
                <label style={ROW}>
                  濃さ
                  <input type="range" min={0.1} max={1} step={0.05} value={bg.opacity} onChange={(e) => setBg({ opacity: Number(e.target.value) })} />
                </label>
                <label style={ROW}>
                  回転（°）
                  <input type="number" step={0.5} value={bg.rot} onChange={(e) => setBg({ rot: Number(e.target.value) })} style={{ width: 80 }} />
                </label>
                <div style={ROW}>
                  大きさ
                  <span style={{ display: "flex", gap: 4 }}>
                    {[0.9, 0.99, 1.01, 1.1].map((f) => (
                      <button key={f} className="chip small" onClick={() => setBg({ mPerPx: bg.mPerPx * f })}>
                        {f < 1 ? (f < 0.95 ? "−−" : "−") : f > 1.05 ? "＋＋" : "＋"}
                      </button>
                    ))}
                  </span>
                </div>
                <button className="chip small" onClick={() => setBgs((b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== hallId)))}>
                  下絵を消す
                </button>
              </div>
            )}
          </section>

          <section>
            <h3 style={H3}>選んだ列</h3>
            {!selLine && <p style={NOTE}>島を押すと、ここで直せます。「島を置く」で新しい列を置けます。</p>}
            {selLine && (
              <div style={{ display: "grid", gap: 6 }}>
                <label style={ROW}>
                  列の名前
                  <input value={selLine.block} onChange={(e) => updateSel({ block: e.target.value.trim() })} style={{ width: 80 }} />
                </label>
                <label style={ROW}>
                  机の数（区切り）
                  <input
                    defaultValue={selLine.segments.join(",")}
                    key={`${sel}-${selLine.segments.join(",")}`}
                    onBlur={(e) => {
                      const seg = e.target.value.split(/[,、\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
                      if (seg.length) updateSel({ segments: seg });
                    }}
                    style={{ width: 110 }}
                    placeholder="16,16"
                  />
                </label>
                <p style={NOTE}>横切る通路で区切られた区間ごとの机の数をカンマで（例：16,16）。机1つが番号1つ。</p>
                <label style={ROW}>
                  作品・ジャンル
                  <input value={selLine.genre ?? ""} onChange={(e) => updateSel({ genre: e.target.value || undefined })} style={{ width: 110 }} />
                </label>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  <button className="chip small" onClick={reverse}>
                    番号の向きを反対に
                  </button>
                  <button className="chip small" onClick={rotate90}>
                    90° 回す
                  </button>
                  <button
                    className="chip small"
                    onClick={() => {
                      change(lines.filter((_, i) => i !== sel));
                      setSel(null);
                    }}
                  >
                    消す
                  </button>
                </div>
                <div style={{ borderTop: "1px solid var(--line)", paddingTop: 6 }}>
                  <div style={{ fontSize: ".9rem", fontWeight: 700 }}>平行にコピー</div>
                  <label style={ROW}>
                    本数
                    <input type="number" min={1} max={40} value={copyN} onChange={(e) => setCopyN(Math.max(1, Number(e.target.value) || 1))} style={{ width: 70 }} />
                  </label>
                  <label style={ROW}>
                    間隔（m）
                    <input type="number" min={2} max={30} step={0.1} value={copyGap} onChange={(e) => setCopyGap(Number(e.target.value) || PITCH)} style={{ width: 70 }} />
                  </label>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button className="chip small" onClick={() => copyParallel(1)}>
                      {sideArrow(1)} へ {copyN} 本
                    </button>
                    <button className="chip small" onClick={() => copyParallel(-1)}>
                      {sideArrow(-1)} へ {copyN} 本
                    </button>
                  </div>
                  <p style={NOTE}>列の名前は、この建物でまだ使っていない次の文字になります。</p>
                </div>
              </div>
            )}
          </section>

          <section>
            <h3 style={H3}>気になるところ {hallProblems.length ? `（${hallProblems.length}）` : ""}</h3>
            {!hallProblems.length && <p style={NOTE}>このホールにはありません。</p>}
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: ".85rem" }}>
              {hallProblems.slice(0, 30).map((p, i) => (
                <li key={i}>
                  <button className="chip small" style={{ border: "none", padding: 0, background: "none", textAlign: "left" }} onClick={() => setSel(p.line)}>
                    {p.text}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

const PANEL: CSSProperties = { width: 300, maxWidth: "45vw", overflowY: "auto", borderLeft: "1px solid var(--line)", background: "var(--card)", padding: 10, display: "grid", gap: 14, alignContent: "start" };
const H3: CSSProperties = { fontSize: ".95rem", margin: "0 0 4px" };
const NOTE: CSSProperties = { fontSize: ".78rem", color: "var(--muted)", margin: "4px 0" };
const ROW: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: ".9rem" };
const HINT: CSSProperties = { position: "absolute", left: 8, bottom: 8, right: 8, fontSize: ".8rem", background: "rgba(255,255,255,.9)", color: "#1d1d1b", borderRadius: 8, padding: "4px 8px", pointerEvents: "none" };
