"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import layoutJson from "@/data/layout-sample.json";
import venueJson from "@/data/venue.json";
import { minAreaRect, type XZ } from "@/lib/geo";
import { DESK_D, DESK_L, expandBooths, islandEnds, layoutProblems, lineLength, nextBlock, wallLabelSpots, parseLayoutFeatures, parseLayoutFile, PITCH, toLayoutFile, type HallLike, type LayoutFeatures, type Line } from "@/lib/layout";
import { EditorServerBar } from "./EditorServerBar";
import { DRAFT_KEY, LAYOUT_KEY, loadLayout, loadLayoutFeatures, saveLayout } from "@/lib/saved-layout";
import { applyChars, applyWorks, charsOf, DAYS, loadTags, parseTagsFile, saveTags, splitChars, TAGS_DRAFT_KEY, TAGS_KEY, toTagsFile, workColor, worksOf, type Day, type Tags } from "@/lib/tags";

// 島のエディタ。2つの作業がある。
// ・作品・キャラを入れる（協力者）：スペースを選んで、作品（ブルーアーカイブ・原神など）を広い範囲に入れ、次にキャラを入れる。日ごとに分けて持つ
// ・机の配置（管理用）：カタログの配置図を下絵に重ねて、島の列（ブロック）を並べる。机の位置は作者が用意する
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
// 上から描いている机の真ん中（机の奥行きを THICK 倍に描き、島の外側へのばした分だけずらす）
const drawnCenter = (b: { at: XZ; angle: number; side: number }): XZ => {
  const off = (b.side * DESK_D * (THICK - 1)) / 2;
  return [b.at[0] - Math.sin(b.angle) * off, b.at[1] + Math.cos(b.angle) * off];
};
// 列の名前（○）の場所：島の列の両端の少し外（メインの地図と同じ）
const blockSpots = (l: Line): XZ[] => {
  if (l.wall) return wallLabelSpots(l, 2.4); // 壁ぞいの列は、まとまった机ごとにホールの内側へ
  const c = Math.cos(l.angle), s = Math.sin(l.angle), len = lineLength(l);
  return [
    [l.start[0] - c * 2.2, l.start[1] - s * 2.2],
    [l.start[0] + c * (len + 2.2), l.start[1] + s * (len + 2.2)],
  ];
};
const clone = (l: Line[]) => l.map((x) => ({ ...x, start: [...x.start] as XZ, segments: [...x.segments], ...(x.desks ? { desks: x.desks.map((d) => ({ ...d })) } : {}) }));

// ホールを島がまっすぐになる向きに回す角（ホールの長い辺を横に。北がなるべく上）
function viewAngle(h: Hall) {
  let t = minAreaRect(h.poly).angle;
  if (Math.cos(t) < 0) t += Math.PI;
  return t;
}

export function IslandEditor() {
  const [lines, setLines] = useState<Line[]>(() => loadLayout(DRAFT_KEY) ?? loadLayout(LAYOUT_KEY) ?? clone(sampleLines));
  // 配置といっしょに写した柱・壁の切れ目（配置図から作ったファイルを読み込んだときだけ）。配置と同じ所から読む
  const [features, setFeatures] = useState<LayoutFeatures | null>(() => (loadLayout(DRAFT_KEY) ? loadLayoutFeatures(DRAFT_KEY) : loadLayoutFeatures(LAYOUT_KEY)));
  const [hallId, setHallId] = useState("E1");
  const [sel, setSel] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [turn, setTurn] = useState(0); // 見る向きを 90° ずつ回す
  const [copyN, setCopyN] = useState(5);
  const [copyGap, setCopyGap] = useState(PITCH);
  const [bgs, setBgs] = useState<Record<string, Bg>>({});
  const [msg, setMsg] = useState("");
  // いまの作業：作品・キャラを入れる（協力者）／机の配置（管理用）
  const [mode, setMode] = useState<"tags" | "layout">("tags");
  // 作品・キャラを入れる作業の段階：① 作品を広い範囲に ② 作品を1つ選んでキャラ ③ お品書き（準備中）
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [focusWork, setFocusWork] = useState<string | null>(null); // ② でキャラを入れる作品
  const [day, setDay] = useState<Day>(1);
  const [tags, setTags] = useState<Tags>(() => loadTags(TAGS_DRAFT_KEY) ?? loadTags(TAGS_KEY) ?? {});
  const [picked, setPicked] = useState<Set<string>>(new Set()); // 選んだスペース（配置番号）
  const [workInput, setWorkInput] = useState("");
  const [charInput, setCharInput] = useState("");
  const anchor = useRef<string | null>(null); // Shift＋押すで範囲を選ぶときの始まり
  const tagHistory = useRef<Tags[]>([]);
  const boxSel = useRef<{ x0: number; y0: number; x1: number; y1: number; add: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const history = useRef<Line[][]>([]);
  const view = useRef({ k: 4, u: 0, v: 0 }); // 1m の px・画面の真ん中に見る位置（回した座標）
  const pointer = useRef<XZ | null>(null);
  const addStart = useRef<XZ | null>(null);
  const drag = useRef<{ kind: "pan" | "line" | "image" | "box"; sx: number; sy: number; u: number; v: number; start?: XZ; bg?: { x: number; z: number } } | null>(null);
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
  const codeIdx = useMemo(() => new Map(booths.map((b, i) => [b.code, i])), [booths]);
  const ends = useMemo(() => islandEnds(lines), [lines]);
  const dayTags = tags[day] ?? {};
  const problems = useMemo(() => layoutProblems(lines, halls), [lines]);
  const badLines = useMemo(() => new Set(problems.map((p) => p.line)), [problems]);

  // 端末に書きかけを保存（自動）
  useEffect(() => {
    saveLayout(DRAFT_KEY, lines, features);
  }, [lines, features]);
  useEffect(() => {
    saveTags(TAGS_DRAFT_KEY, tags);
  }, [tags]);
  const changeTags = useCallback(
    (next: Tags) => {
      tagHistory.current.push(tags);
      if (tagHistory.current.length > 80) tagHistory.current.shift();
      setTags(next);
    },
    [tags],
  );
  const undoTags = useCallback(() => {
    const prev = tagHistory.current.pop();
    if (prev) setTags(prev);
  }, []);

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
      const dt = dayTags[b.code];
      if (mode === "tags") {
        const none = b.hall === hallId ? "#c3cad4" : "#dde1e6";
        const ws = dt?.works ?? [];
        if (picked.has(b.code)) g.fillStyle = "#ffb000";
        else if (step === 1) g.fillStyle = ws[0] ? workColor(ws[0]) : none;
        else if (step === 2 && focusWork)
          // 選んだ作品を扱うスペースだけ：その作品のキャラが入った所は濃く、まだの所は薄く。ほかは目立たせない
          g.fillStyle = ws.includes(focusWork) ? workColor(focusWork, !dt?.chars?.[focusWork]?.length) : "#e6e9ed";
        else g.fillStyle = ws[0] ? workColor(ws[0], true) : none;
        g.fill();
        // ① で作品が2つ以上なら、斜め半分を2つ目の作品の色に
        if (step === 1 && !picked.has(b.code) && ws.length > 1) {
          poly([corner(hl, -hd), corner(hl, hd), corner(-hl, hd)]);
          g.fillStyle = workColor(ws[1]);
          g.fill();
        }
      } else {
        g.fillStyle = b.line === sel ? "#ffb000" : badLines.has(b.line) ? "#e05a5a" : b.hall === hallId ? "#7d93b6" : "#b7c2cf";
        g.fill();
      }
    }
    // 柱（配置図から写したとき）。0.8m 角の黒い四角（机を太く描いているので、机の上に重ねる）
    for (const p of features?.pillars ?? []) {
      if (!onLevel.has(p.hall)) continue;
      const [sx, sy] = toS(p.at);
      const r = p.wall ? Math.max(2, 0.4 * k) : Math.max(1.5, 0.2 * k); // 島の中の柱は小さな印
      g.fillStyle = "#3a3f3c";
      g.fillRect(sx - r, sy - r, 2 * r, 2 * r);
    }
    // 列の名前（始点）と、番号の進む向き（始点から A側へ）
    g.textAlign = "center";
    g.textBaseline = "middle";
    lines.forEach((l, i) => {
      if (!onLevel.has(l.hall)) return;
      const c = Math.cos(l.angle), s = Math.sin(l.angle);
      const r = Math.max(8, k * 1.1);
      for (const spot of blockSpots(l)) {
        const [sx, sy] = toS(spot);
        g.fillStyle = mode === "layout" && i === sel ? "#ffb000" : "#fff";
        g.strokeStyle = "#1d1d1b";
        g.lineWidth = 1;
        g.beginPath();
        g.arc(sx, sy, r, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillStyle = "#1d1d1b";
        g.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`;
        g.fillText(l.block, sx, sy);
      }
      if (mode === "layout" && i === sel) {
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
    // 番号（メインの地図と同じ考え方）：引いているときは島の端の番号、寄ると机ごとの番号、もっと寄るとスペースごと（05a）
    const label = (text: string, [sx, sy]: [number, number], px: number) => {
      if (sx < -30 || sy < -30 || sx > W + 30 || sy > H + 30) return;
      g.font = `600 ${px}px system-ui, sans-serif`;
      g.strokeStyle = "rgba(255,255,255,.9)";
      g.lineWidth = 3;
      g.strokeText(text, sx, sy);
      g.fillStyle = "#1d1d1b";
      g.fillText(text, sx, sy);
    };
    if (k * (DESK_L / 2) >= 9) {
      // スペースごと
      for (const b of booths) if (onLevel.has(b.hall)) label(`${String(b.num).padStart(2, "0")}${b.half}`, toS(drawnCenter(b)), Math.round(Math.max(9, Math.min(14, k * 0.45))));
    } else if (k * DESK_L >= 14) {
      // 机ごと
      for (let i = 0; i + 1 < booths.length; i++) {
        const a = booths[i], b = booths[i + 1];
        if (!onLevel.has(a.hall) || a.half !== "a" || b.num !== a.num || b.line !== a.line) continue;
        const [ax, az] = drawnCenter(a), [bx, bz] = drawnCenter(b);
        label(String(a.num).padStart(2, "0"), toS([(ax + bx) / 2, (az + bz) / 2]), Math.round(Math.min(13, k * 0.7)));
      }
    } else if (k >= 3) {
      // 島の端：区間の両端に、A側・B側の端の机の番号（端の机の上、太く描いた列の真ん中）
      for (const e of ends) {
        const l = lines[e.line];
        if (!onLevel.has(l.hall)) continue;
        const c = Math.cos(l.angle), s = Math.sin(l.angle);
        const u = e.u - e.out * (DESK_L / 2);
        const v = e.side * Math.max((DESK_D / 2) * THICK, 8 / k);
        label(String(e.num).padStart(2, "0"), toS([l.start[0] + u * c - v * s, l.start[1] + u * s + v * c]), 11);
      }
    }
    // 囲んで選んでいる四角
    if (boxSel.current) {
      const b = boxSel.current;
      g.fillStyle = "rgba(212,85,154,.08)";
      g.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeStyle = "#d4559a";
      g.lineWidth = 1.5;
      g.setLineDash([6, 4]);
      g.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.setLineDash([]);
    }
    // 置いている途中の島
    if (mode === "layout" && tool === "add" && addStart.current && pointer.current) {
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
        // 机1つずつの列は、いちばん近い机までの近さ（壁ぞいの列は角を曲がるので、列の線では調べられない）
        const d = l.desks
          ? Math.min(...l.desks.map((k) => Math.hypot(Math.max(0, Math.abs(u - k.u) - DESK_L / 2), Math.max(0, Math.abs(v - k.v) - DESK_D / 2))))
          : Math.hypot(Math.max(0, -u, u - lineLength(l)), v);
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

  // 押した所のスペース（太く描いた机の中）
  const spaceAt = useCallback(
    (p: XZ) => {
      for (const b of booths) {
        if (b.hall !== hallId) continue;
        const [cx, cz] = drawnCenter(b);
        const c = Math.cos(b.angle), s = Math.sin(b.angle);
        const du = (p[0] - cx) * c + (p[1] - cz) * s, dv = -(p[0] - cx) * s + (p[1] - cz) * c;
        if (Math.abs(du) <= DESK_L / 4 && Math.abs(dv) <= (DESK_D / 2) * THICK) return b.code;
      }
      return null;
    },
    [booths, hallId],
  );
  // 押した所の列の名前（○）。その列を全部選ぶ
  const blockAt = useCallback(
    (sx: number, sy: number) => {
      const { toS, k } = tf();
      const r = Math.max(8, k * 1.1);
      return lines.findIndex((l) => {
        if (l.hall !== hallId) return false;
        return blockSpots(l).some((spot) => {
          const [x, y] = toS(spot);
          return Math.hypot(x - sx, y - sy) <= r;
        });
      });
    },
    [lines, hallId, tf],
  );

  // 選べるスペース：① はどこでも、② は選んだ作品のスペースだけ、③ は選ばない
  const limit = (codes: string[]) => (step === 1 ? codes : step === 2 && focusWork ? codes.filter((c) => dayTags[c]?.works?.includes(focusWork)) : []);

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
    if (mode === "tags") {
      // 右・真ん中のボタンのドラッグで地図を動かす
      if (e.button === 1 || e.button === 2) {
        drag.current = { kind: "pan", ...panStart };
        return;
      }
      const li = blockAt(sx, sy);
      if (li >= 0) {
        const codes = limit(booths.filter((b) => b.line === li).map((b) => b.code));
        setPicked((prev) => (e.shiftKey || e.ctrlKey || e.metaKey ? new Set([...prev, ...codes]) : new Set(codes)));
        anchor.current = null;
        return;
      }
      const code = spaceAt(p);
      if (code && !limit([code]).length) return; // ② で、選んだ作品ではないスペース
      if (code) {
        const a = anchor.current !== null ? codeIdx.get(anchor.current) : undefined;
        const i = codeIdx.get(code)!;
        if (e.shiftKey && a !== undefined && booths[a].line === booths[i].line) {
          // 同じ列の中で、前に押した所からここまで（番号の並びの順に）
          const [i0, i1] = a < i ? [a, i] : [i, a];
          setPicked((prev) => new Set([...prev, ...limit(booths.slice(i0, i1 + 1).map((b) => b.code))]));
        } else if (e.ctrlKey || e.metaKey) {
          setPicked((prev) => {
            const n = new Set(prev);
            if (n.has(code)) n.delete(code);
            else n.add(code);
            return n;
          });
          anchor.current = code;
        } else {
          setPicked(new Set([code]));
          anchor.current = code;
        }
        return;
      }
      // 何もない所からドラッグ：囲んで選ぶ
      boxSel.current = { x0: sx, y0: sy, x1: sx, y1: sy, add: e.shiftKey || e.ctrlKey || e.metaKey };
      drag.current = { kind: "box", ...panStart };
      return;
    }
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
    if (d.kind === "box" && boxSel.current) {
      boxSel.current.x1 = sx;
      boxSel.current.y1 = sy;
      repaint();
    } else if (d.kind === "pan") {
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
    if (drag.current?.kind === "box" && boxSel.current) {
      const b = boxSel.current;
      const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
      if (x1 - x0 + (y1 - y0) > 6) {
        const { toS } = tf();
        // 四角に少しでもかかった机を選ぶ（太く描いた机の四すみの範囲で調べる）
        const hl = DESK_L / 4 - 0.02, hd = (DESK_D / 2) * THICK;
        const codes = booths
          .filter((bt) => {
            if (bt.hall !== hallId) return false;
            const [cx, cz] = drawnCenter(bt);
            const c = Math.cos(bt.angle), sn = Math.sin(bt.angle);
            const pts = [
              [-hl, -hd],
              [hl, -hd],
              [hl, hd],
              [-hl, hd],
            ].map(([du, dv]) => toS([cx + du * c - dv * sn, cz + du * sn + dv * c]));
            const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
            return Math.max(...xs) >= x0 && Math.min(...xs) <= x1 && Math.max(...ys) >= y0 && Math.min(...ys) <= y1;
          })
          .map((bt) => bt.code);
        const ok = limit(codes);
        setPicked((prev) => (b.add ? new Set([...prev, ...ok]) : new Set(ok)));
      } else if (!b.add) setPicked(new Set());
      boxSel.current = null;
      repaint();
    }
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
      if (mode === "tags") {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          undoTags();
        } else if (e.key === "Escape") setPicked(new Set());
        else if ((e.key === "Delete" || e.key === "Backspace") && picked.size) {
          // 選んだ所の作品・キャラを消す（Ctrl+Z で戻せる）
          e.preventDefault();
          // ① は作品とキャラを、② はキャラだけを消す
          if (step === 1) changeTags(applyWorks(tags, day, [...picked], "clear"));
          else if (step === 2 && focusWork) changeTags(applyChars(tags, day, [...picked], focusWork, "clear"));
        }
        return;
      }
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
      const nudge = e.shiftKey ? 1 : 0.1;
      const m = { ArrowLeft: [-nudge, 0], ArrowRight: [nudge, 0], ArrowUp: [0, -nudge], ArrowDown: [0, nudge] }[e.key];
      if (m) {
        e.preventDefault();
        const c = Math.cos(theta), s = Math.sin(theta);
        const l = lines[sel];
        updateSel({ start: [Math.round((l.start[0] + m[0] * c - m[1] * s) * 100) / 100, Math.round((l.start[1] + m[0] * s + m[1] * c) * 100) / 100] });
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [sel, lines, theta, undo, change, updateSel, repaint, mode, undoTags, picked, changeTags, tags, day, step, focusWork]);

  // ---- 選んだ島の操作 ----
  const selLine = sel !== null ? lines[sel] : null;
  const rotate90 = () => selLine && updateSel({ angle: selLine.angle + Math.PI / 2 });
  // 番号の向きを反対に：終点を始点にして、向きを 180° 回す
  const reverse = () => {
    if (!selLine) return;
    const len = lineLength(selLine);
    updateSel({
      start: [selLine.start[0] + Math.cos(selLine.angle) * len, selLine.start[1] + Math.sin(selLine.angle) * len],
      angle: selLine.angle + Math.PI,
      segments: [...selLine.segments].reverse(),
      // 机1つずつの列：机は動かさず、列の向きだけ反対にする（机の座る側も、向きが反対になったぶん入れかえる）
      ...(selLine.desks ? { desks: selLine.desks.map((d) => ({ ...d, u: len - d.u, v: -d.v, side: (-d.side) as 1 | -1 })) } : {}),
    });
  };
  // 平行にコピー：島の横（sign = 1 か -1）へ、間隔 copyGap で copyN 本。列の名前は次の文字
  const copyParallel = (sign: 1 | -1) => {
    if (!selLine) return;
    const nx = -Math.sin(selLine.angle) * sign, nz = Math.cos(selLine.angle) * sign;
    let next = [...lines];
    for (let i = 1; i <= copyN; i++) {
      next = [...next, { ...selLine, start: [selLine.start[0] + nx * copyGap * i, selLine.start[1] + nz * copyGap * i] as XZ, segments: [...selLine.segments], ...(selLine.desks ? { desks: selLine.desks.map((d) => ({ ...d })) } : {}), block: nextBlock(next, hall.building, halls) }];
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
    const blob = new Blob([JSON.stringify(toLayoutFile(lines, features), null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `layout-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // ---- 作品・キャラ ----
  const pickedList = [...picked];
  const pickedWorks = [...new Set(pickedList.flatMap((c) => dayTags[c]?.works ?? []))];
  const pickedChars = focusWork ? [...new Set(pickedList.flatMap((c) => dayTags[c]?.chars?.[focusWork] ?? []))] : [];
  const works = worksOf(tags, day);
  const focusChars = focusWork ? charsOf(tags, day, focusWork) : [];
  const focusCount = focusWork ? Object.values(dayTags).filter((t) => t.works?.includes(focusWork)).length : 0;
  const focusDone = focusWork ? Object.values(dayTags).filter((t) => t.works?.includes(focusWork) && t.chars?.[focusWork]?.length).length : 0;
  const selectChar = (c: string) => focusWork && setPicked(new Set(Object.entries(dayTags).filter(([, t]) => t.chars?.[focusWork]?.includes(c)).map(([code]) => code)));
  const setWorks = (how: "set" | "add" | "remove" | "clear") => picked.size && changeTags(applyWorks(tags, day, pickedList, how, [workInput]));
  const setChars = (how: "set" | "add" | "clear") => picked.size && focusWork && changeTags(applyChars(tags, day, pickedList, focusWork, how, splitChars(charInput)));
  const selectWork = (w: string) => setPicked(new Set(Object.entries(dayTags).filter(([, t]) => t.works?.includes(w)).map(([c]) => c)));
  const downloadTags = () => {
    const blob = new Blob([JSON.stringify(toTagsFile(tags), null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tags-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // 読み込む：配置のファイルか、作品・キャラのファイルかを中身で見分ける（いまの段階に関係なく読める）
  const uploadAny = async (file: File) => {
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      return setMsg("ファイルを読めませんでした（JSON ではない）");
    }
    const layout = parseLayoutFile(json);
    if (layout) {
      change(layout);
      setFeatures(parseLayoutFeatures(json));
      setSel(null);
      return setMsg(`配置を読み込みました（列 ${layout.length} 本・机 ${expandBooths(layout, halls).length / 2}）。「3D で確かめる」でメインの地図に出ます`);
    }
    const got = parseTagsFile(json);
    if (got) {
      changeTags(got);
      return setMsg("作品・キャラを読み込みました。「3D で確かめる」でメインの地図に出ます");
    }
    setMsg("配置のファイルとしても、作品・キャラのファイルとしても読めませんでした");
  };

  const showOnMap = () => {
    if (!saveLayout(LAYOUT_KEY, lines, features) || !saveTags(TAGS_KEY, tags)) return setMsg("端末に保存できませんでした");
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
        <div className="seg" role="group" aria-label="作業">
          {(
            [
              [1, "① 作品"],
              [2, "② キャラ"],
              [3, "③ お品書き"],
            ] as const
          ).map(([n, label]) => (
            <button key={n} aria-pressed={mode === "tags" && step === n} onClick={() => ((addStart.current = null), setPicked(new Set()), setMode("tags"), setStep(n))}>
              {label}
            </button>
          ))}
          <button aria-pressed={mode === "layout"} onClick={() => (setPicked(new Set()), setMode("layout"))}>
            机の配置（管理用）
          </button>
        </div>
        <select aria-label="ホール" value={hallId} onChange={(e) => (setHallId(e.target.value), setSel(null), (addStart.current = null))}>
          {openHalls.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}（{h.level}F）
            </option>
          ))}
        </select>
        {mode === "tags" && (
          <div className="seg" role="group" aria-label="日">
            {DAYS.map((d) => (
              <button key={d} aria-pressed={day === d} onClick={() => (setDay(d), setPicked(new Set()))}>
                {d}日目
              </button>
            ))}
          </div>
        )}
        {mode === "layout" && <div className="seg" role="group" aria-label="道具">
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
        </div>}
        <button className="chip" onClick={() => setTurn((t) => (t + 1) % 4)}>
          見る向きを 90° 回す
        </button>
        <button className="chip" onClick={mode === "tags" ? undoTags : undo}>
          戻す
        </button>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="chip" onClick={mode === "tags" ? downloadTags : download}>
            書き出す
          </button>
          <label className="chip" style={{ display: "inline-flex", alignItems: "center", cursor: "pointer", border: "1px solid var(--line)", padding: "6px 10px" }}>
            読み込む
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                if (e.target.files?.[0]) uploadAny(e.target.files[0]);
                e.target.value = ""; // 同じファイルをもう一度選んでも読む
              }}
            />
          </label>
          {mode === "layout" && <button
            className="chip"
            onClick={() => {
              if (confirm("見本の配置に戻しますか？いまの配置は消えます（書き出していなければ戻せません）")) {
                change(clone(sampleLines));
                setFeatures(null);
                setSel(null);
              }
            }}
          >
            見本に戻す
          </button>}
          <button onClick={showOnMap} style={{ fontWeight: 700 }}>
            3D で確かめる
          </button>
        </span>
      </header>
      <EditorServerBar
        tags={tags}
        setTags={changeTags}
        lines={lines}
        features={features}
        setLayout={(json) => {
          const l = parseLayoutFile(json);
          if (!l) return setMsg("サーバーの配置が読めませんでした");
          change(l);
          setFeatures(parseLayoutFeatures(json));
          setSel(null);
        }}
      />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div ref={box} style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <canvas
            ref={cv}
            style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: tool === "add" ? "crosshair" : tool === "image" ? "move" : "default" }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div style={{ ...HINT }}>
            {mode === "tags"
              ? step === 1
                ? "① 作品：作品を入れる範囲を選ぶ。列の名前（○）でその列を全部、何もない所からドラッグで囲む。Shift＋押すで同じ列の範囲、Ctrl＋押すで足す・外す。右ドラッグで地図を動かす"
                : step === 2
                  ? focusWork
                    ? `② キャラ：「${focusWork}」のスペースだけ選べます（ほかは薄く出ています）。選び方は ① と同じ`
                    : "② キャラ：右の欄で、キャラを入れる作品を選ぶ"
                  : "③ お品書き：まだ入れられません"
              : tool === "add"
              ? addStart.current
                ? "終わりの場所を押す（向きは壁にそろう。Shift で自由な向き）。Esc でやめる"
                : "島の列の始まり（番号 01 の側の端）を押す"
              : tool === "image"
                ? "ドラッグで下絵を動かす。Alt＋ホイールで大きさ。回転と濃さは右の欄で"
                : "島を押して選ぶ・ドラッグで動かす。矢印キーで 0.1m（Shift で 1m）。Delete で消す。何もない所のドラッグで地図を動かす"}
          </div>
        </div>
        <aside style={PANEL}>
          {mode === "tags" && (
            <>
              <section>
                <h3 style={H3}>
                  {hall.name}・{day}日目
                </h3>
                <div style={{ fontSize: ".85rem", color: "var(--muted)" }}>
                  作品が入ったスペース {booths.filter((b) => b.hall === hallId && dayTags[b.code]?.works?.length).length} ／ {booths.filter((b) => b.hall === hallId).length}
                </div>
                {msg && <div style={{ fontSize: ".85rem", marginTop: 4 }}>{msg}</div>}
              </section>
              {step === 1 && (
                <>
                  <section>
                    <h3 style={H3}>① 作品を入れる</h3>
                    <p style={NOTE}>まず、作品ごとのまとまり（例：この3列はブルーアーカイブ）を広い範囲で入れます。キャラは次の ② で入れます。</p>
                    <div style={{ fontSize: ".9rem", margin: "4px 0" }}>
                      選んだスペース {picked.size}
                      {picked.size > 0 && `（いまの作品：${pickedWorks.length ? pickedWorks.join("・") : "なし"}）`}
                    </div>
                    <div style={{ display: "grid", gap: 4 }}>
                      {works.length > 0 && (
                        <select aria-label="登録した作品から選ぶ" value="" onChange={(e) => e.target.value && setWorkInput(e.target.value)}>
                          <option value="">登録した作品から選ぶ（{works.length}）</option>
                          {works.map((w) => (
                            <option key={w.work} value={w.work}>
                              {w.work}（{w.count}）
                            </option>
                          ))}
                        </select>
                      )}
                      <input list="works" value={workInput} onChange={(e) => setWorkInput(e.target.value)} placeholder="新しい作品は、ここに名前を入れる" aria-label="作品" />
                      <datalist id="works">
                        {works.map((w) => (
                          <option key={w.work} value={w.work} />
                        ))}
                      </datalist>
                      <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <button className="chip small" disabled={!picked.size || !workInput.trim()} onClick={() => setWorks("set")} title="選んだ所の作品を、この作品だけにする">
                          この作品にする
                        </button>
                        <button className="chip small" disabled={!picked.size || !workInput.trim()} onClick={() => setWorks("add")} title="いまの作品はそのままで、この作品も扱う">
                          この作品を足す
                        </button>
                        <button className="chip small" disabled={!picked.size || !workInput.trim()} onClick={() => setWorks("remove")}>
                          この作品を外す
                        </button>
                        <button className="chip small" disabled={!picked.size} onClick={() => setWorks("clear")}>
                          全部外す
                        </button>
                      </span>
                      <p style={NOTE}>1つのサークルが複数の作品を扱うときは「足す」。2つ以上の作品がある所は、斜め半分が2つ目の作品の色になります。作品を外すと、その作品のキャラも消えます。</p>
                    </div>
                  </section>
                  <section>
                    <h3 style={H3}>この日の作品 {works.length ? `（${works.length}）` : ""}</h3>
                    {!works.length && <p style={NOTE}>まだありません。</p>}
                    <div style={{ display: "grid", gap: 3 }}>
                      {works.map((w) => (
                        <button
                          key={w.work}
                          className="chip small"
                          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, textAlign: "left" }}
                          onClick={() => (selectWork(w.work), setWorkInput(w.work))}
                          title="この作品のスペースを全部選ぶ"
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <i style={{ width: 12, height: 12, borderRadius: 3, background: workColor(w.work), display: "inline-block" }} />
                            {w.work}
                          </span>
                          <span style={{ color: "var(--muted)" }}>{w.count}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                </>
              )}
              {step === 2 && (
                <>
                  <section>
                    <h3 style={H3}>② キャラを入れる</h3>
                    <p style={NOTE}>キャラを入れる作品を選んでください。その作品のスペースだけが選べるようになります。作品は ① で入れます。</p>
                    {!works.length && <p style={NOTE}>この日の作品がまだありません。先に ① で作品を入れてください。</p>}
                    <div style={{ display: "grid", gap: 3 }}>
                      {works.map((w) => (
                        <button
                          key={w.work}
                          className="chip small"
                          aria-pressed={focusWork === w.work}
                          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, textAlign: "left" }}
                          onClick={() => (setFocusWork(w.work), setPicked(new Set()))}
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <i style={{ width: 12, height: 12, borderRadius: 3, background: workColor(w.work), display: "inline-block" }} />
                            {w.work}
                          </span>
                          <span>{w.count}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                  {focusWork && (
                    <>
                      <section>
                        <h3 style={H3}>「{focusWork}」</h3>
                        <div style={{ fontSize: ".85rem", color: "var(--muted)" }}>
                          キャラが入ったスペース {focusDone} ／ {focusCount}
                        </div>
                        <div style={{ display: "flex", gap: 10, fontSize: ".8rem", margin: "4px 0" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <i style={{ width: 12, height: 12, borderRadius: 3, background: workColor(focusWork), display: "inline-block" }} />
                            キャラが入った
                          </span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <i style={{ width: 12, height: 12, borderRadius: 3, background: workColor(focusWork, true), display: "inline-block" }} />
                            まだ
                          </span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <i style={{ width: 12, height: 12, borderRadius: 3, background: "#ffb000", display: "inline-block" }} />
                            選んでいる
                          </span>
                        </div>
                        <div style={{ fontSize: ".9rem", margin: "6px 0 4px" }}>
                          選んだスペース {picked.size}
                          {picked.size > 0 && `（いまのキャラ：${pickedChars.length ? pickedChars.slice(0, 8).join("、") + (pickedChars.length > 8 ? " …" : "") : "なし"}）`}
                        </div>
                        <div style={{ display: "grid", gap: 4 }}>
                          {focusChars.length > 0 && (
                            <select
                              aria-label="登録したキャラから選ぶ"
                              value=""
                              onChange={(e) => {
                                const c = e.target.value;
                                // 選んだキャラを入力欄に足す（何人でも）
                                if (c) setCharInput((v) => (splitChars(v).includes(c) ? v : [...splitChars(v), c].join("、")));
                              }}
                            >
                              <option value="">登録したキャラから足す（{focusChars.length}）</option>
                              {focusChars.map((c) => (
                                <option key={c.char} value={c.char}>
                                  {c.char}（{c.count}）
                                </option>
                              ))}
                            </select>
                          )}
                          <input list="chars" value={charInput} onChange={(e) => setCharInput(e.target.value)} placeholder="アリス、ユウカ" aria-label="キャラ" />
                          <datalist id="chars">
                            {focusChars.map((c) => (
                              <option key={c.char} value={c.char} />
                            ))}
                          </datalist>
                          <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            <button className="chip small" disabled={!picked.size || !splitChars(charInput).length} onClick={() => setChars("set")}>
                              この内容にする
                            </button>
                            <button className="chip small" disabled={!picked.size || !splitChars(charInput).length} onClick={() => setChars("add")}>
                              足す
                            </button>
                            <button className="chip small" disabled={!picked.size} onClick={() => setChars("clear")}>
                              キャラを消す
                            </button>
                          </span>
                          <p style={NOTE}>キャラは「、」かカンマで区切って何人でも。</p>
                        </div>
                      </section>
                      <section>
                        <h3 style={H3}>この作品のキャラ {focusChars.length ? `（${focusChars.length}）` : ""}</h3>
                        {!focusChars.length && <p style={NOTE}>まだありません。</p>}
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {focusChars.map((c) => (
                            <button key={c.char} className="chip small" onClick={() => (selectChar(c.char), setCharInput(c.char))} title="このキャラのスペースを全部選ぶ">
                              {c.char} {c.count}
                            </button>
                          ))}
                        </div>
                      </section>
                    </>
                  )}
                </>
              )}
              {step === 3 && (
                <section>
                  <h3 style={H3}>③ お品書き・サークルの画像</h3>
                  <p style={NOTE}>
                    サークルのお品書きや画像は、準備会に確認してから、サークル本人に入れてもらう予定です。本人確認とアップロードの仕組みが要るので、まだ入れられません。
                  </p>
                </section>
              )}
            </>
          )}
          {mode === "layout" && <>
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
                {selLine.desks ? (
                  <p style={NOTE}>
                    机 {selLine.desks.length} 個（{selLine.wall ? "壁ぞいの列" : "島の列"}）。配置図から机1つずつの位置を写した列なので、机の数はここでは変えられません。列ごとの移動・回転・向きの反対はできます。
                  </p>
                ) : (
                  <>
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
                  </>
                )}
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
          </>}
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
