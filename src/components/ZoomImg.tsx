"use client";

// 指で拡大できる画像（2 本指で広げる・ダブルタップで拡大／元に戻す・拡大したら 1 本指で動かす。パソコンはホイール・ダブルクリック）。
// 全画面で見るサークルの画像に使う（お品書きの小さい文字も読めるように）。
// onOutside：拡大していないときに、画像の外（まわりの暗い所）を押した
import { useRef, useState } from "react";

const MAX = 5;

export function ZoomImg({ src, width, height, onOutside }: { src: string; width: string; height: string; onOutside?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const pic = useRef<HTMLImageElement>(null);
  const [v, setState] = useState({ s: 1, x: 0, y: 0 }); // 倍率と、まん中からのずれ（px）
  // 指の動きは描きなおしより速く来るので、いまの値はここから読む（古い値で計算しないように）
  const cur = useRef(v);
  const setV = (n: typeof v) => {
    cur.current = n;
    setState(n);
  };
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ d: number; mx: number; my: number; v: typeof v } | null>(null);
  const lastTap = useRef(0);
  const downAt = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  // まん中を原点にした、箱の中の位置
  const local = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: cx - r.left - r.width / 2, y: cy - r.top - r.height / 2 };
  };
  // 画像の見えている大きさ（箱の中に収めたとき）
  const shown = () => {
    const r = box.current!.getBoundingClientRect();
    const im = pic.current;
    const k = im && im.naturalWidth ? Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight) : 0;
    return { r, cw: k ? im!.naturalWidth * k : r.width, ch: k ? im!.naturalHeight * k : r.height };
  };
  // はみ出して画像の外が見えないように、ずれをおさえる（横長・縦長の画像は、上下・左右の余白まで動かさない）
  const fit = (s: number, x: number, y: number) => {
    const { r, cw, ch } = shown();
    const mx = Math.max(0, (s * cw - r.width) / 2), my = Math.max(0, (s * ch - r.height) / 2);
    return { s, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  };
  // (px, py) の点を動かさずに、倍率を s2 にする
  const zoomAt = (o: typeof v, s2: number, px: number, py: number) => {
    s2 = Math.max(1, Math.min(MAX, s2));
    const k = s2 / o.s;
    return fit(s2, px - (px - o.x) * k, py - (py - o.y) * k);
  };

  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    // 指が画像の外に出ても追いかける（できないブラウザ・指もある。そのときも続ける）
    try {
      box.current!.setPointerCapture(e.pointerId);
    } catch {}
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.current.values()];
    if (p.length === 2) {
      downAt.current = null;
      const m = local((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
      start.current = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx: m.x, my: m.y, v: cur.current };
    } else if (p.length === 1) {
      downAt.current = { x: e.clientX, y: e.clientY, moved: false };
      const m = local(e.clientX, e.clientY);
      start.current = { d: 0, mx: m.x, my: m.y, v: cur.current };
      // ダブルタップ：拡大していなければ、その所を 2.5 倍に。拡大していれば元に戻す
      const now = performance.now();
      if (now - lastTap.current < 300) {
        lastTap.current = 0;
        downAt.current = null;
        setV(cur.current.s > 1.05 ? { s: 1, x: 0, y: 0 } : zoomAt(cur.current, 2.5, m.x, m.y));
        start.current = null;
      } else lastTap.current = now;
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId) || !start.current) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (downAt.current && Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) > 8) downAt.current.moved = true;
    const p = [...pts.current.values()];
    const st = start.current;
    if (p.length >= 2 && st.d > 0) {
      const m = local((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      // 広げた分だけ拡大し、2 本の指のまん中についていく
      const z = zoomAt(st.v, (st.v.s * d) / st.d, st.mx, st.my);
      setV(fit(z.s, z.x + m.x - st.mx, z.y + m.y - st.my));
    } else if (p.length === 1 && st.v.s > 1) {
      const m = local(e.clientX, e.clientY);
      setV(fit(st.v.s, st.v.x + m.x - st.mx, st.v.y + m.y - st.my));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId);
    const p = [...pts.current.values()];
    // 拡大していないときに、画像の外を押した（動かさずにはなした）：閉じる。ダブルタップの 1 回目とまぎれないよう、少し待つ
    const tap = downAt.current;
    downAt.current = null;
    if (!p.length && tap && !tap.moved && cur.current.s <= 1.05 && onOutside) {
      const { r, cw, ch } = shown();
      const lx = e.clientX - r.left - r.width / 2, ly = e.clientY - r.top - r.height / 2;
      if (Math.abs(lx) > cw / 2 || Math.abs(ly) > ch / 2) {
        const t = lastTap.current;
        setTimeout(() => lastTap.current === t && onOutside(), 300);
      }
    }
    // 2 本のうち 1 本をはなしたら、残りの指で動かせるように始めなおす
    if (p.length === 1) {
      const m = local(p[0].x, p[0].y);
      start.current = { d: 0, mx: m.x, my: m.y, v: cur.current };
    } else if (!p.length) start.current = null;
  };

  return (
    <div style={{ position: "relative" }}>
      <div
        ref={box}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => {
          const m = local(e.clientX, e.clientY);
          setV(zoomAt(cur.current, cur.current.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), m.x, m.y));
        }}
        style={{ width, height, overflow: "hidden", touchAction: "none", cursor: v.s > 1 ? "grab" : "zoom-in" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={pic}
          src={src}
          alt=""
          draggable={false}
          style={{ display: "block", width: "100%", height: "100%", objectFit: "contain", transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`, transformOrigin: "center", userSelect: "none" }}
        />
      </div>
      {v.s > 1.05 && (
        <button
          className="chip small"
          style={{ position: "absolute", left: "50%", bottom: 8, transform: "translateX(-50%)" }}
          onClick={(e) => {
            e.stopPropagation();
            setV({ s: 1, x: 0, y: 0 });
          }}
        >
          元の大きさ
        </button>
      )}
    </div>
  );
}
