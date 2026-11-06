"use client";
// 初めて開いた人向けの使い方の案内：画面の部品を 1 つずつ明るく囲み、吹き出しで説明する（次へ・戻る・スキップ）。
// 部品が画面にないとき（モードによって出ない欄など）は、画面の真ん中に吹き出しだけ出す
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// menu：この段だけサイドバーを開く。mode：この段で地図のモードを切りかえる（切りかえは呼ぶ側の onStep がする）
export type TourStep = { target?: string; title: string; text: string; menu?: boolean; mode?: "register" | "plan" };

export default function Tour({ steps, onDone, onStep }: { steps: TourStep[]; onDone: () => void; onStep?: (step: TourStep) => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const bubble = useRef<HTMLDivElement>(null);
  const [bh, setBh] = useState(0);
  const step = steps[i];

  useLayoutEffect(() => {
    const measure = () => {
      const el = step.target ? (document.querySelector(step.target) as HTMLElement | null) : null;
      const r = el?.getBoundingClientRect();
      setRect(r && r.width > 0 && r.height > 0 ? r : null);
      setSize({ w: innerWidth, h: innerHeight });
      setBh(bubble.current?.offsetHeight ?? 0);
    };
    onStep?.(step);
    measure();
    // サイドバーが開く・閉じる動き（0.25 秒ほど）のあとに、もう一度測る
    const t = setTimeout(measure, 350);
    addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 段が変わったときだけ
  }, [step]);

  const next = () => (i + 1 < steps.length ? setI(i + 1) : onDone());
  useEffect(() => {
    // Enter は、はじめから選ばれている「次へ」ボタンが受ける
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") setI((k) => Math.max(0, k - 1));
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  const PAD = 6;
  const W = Math.min(320, size.w - 24);
  // 吹き出しの置き場所：部品の下（足りなければ上、右端の部品なら左）。部品がなければ真ん中
  let left = (size.w - W) / 2;
  let top = (size.h - bh) / 2;
  let arrow: { x: number; side: "top" | "bottom" | "right" | "left" } | null = null;
  if (rect) {
    const nearRight = rect.left > size.w * 0.6 && rect.width < 120;
    const tall = rect.height > size.h * 0.6 && rect.right + W + 30 < size.w;
    if (tall) {
      // 縦に長い部品（サイドバー）：右に
      left = rect.right + PAD + 14;
      top = Math.min(Math.max(12, size.h / 2 - bh / 2), size.h - bh - 12);
      arrow = { x: size.h / 2 - top, side: "left" };
    } else if (nearRight) {
      left = Math.max(12, rect.left - PAD - 14 - W);
      top = Math.min(Math.max(12, rect.top + rect.height / 2 - bh / 2), size.h - bh - 12);
      arrow = { x: rect.top + rect.height / 2 - top, side: "right" };
    } else {
      left = Math.min(Math.max(12, rect.left + rect.width / 2 - W / 2), size.w - W - 12);
      const below = rect.bottom + PAD + 14;
      if (below + bh < size.h - 12) {
        top = below;
        arrow = { x: rect.left + rect.width / 2 - left, side: "top" };
      } else {
        top = Math.max(12, rect.top - PAD - 14 - bh);
        arrow = { x: rect.left + rect.width / 2 - left, side: "bottom" };
      }
    }
  }
  return (
    <div className="tour" role="dialog" aria-label="使い方の案内" aria-live="polite">
      {/* 暗い幕。部品のまわりだけ明るく抜く */}
      {rect ? (
        <div
          className="tour-hole"
          style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      ) : (
        <div className="tour-dim" />
      )}
      <div ref={bubble} className="tour-bubble" style={{ left, top, width: W }}>
        {arrow && (
          <span
            className={"tour-arrow " + arrow.side}
            style={arrow.side === "right" || arrow.side === "left" ? { top: Math.min(Math.max(arrow.x - 8, 10), bh - 26) } : { left: Math.min(Math.max(arrow.x - 8, 12), W - 28) }}
          />
        )}
        <div className="tour-count">
          {i + 1} / {steps.length}
        </div>
        <strong className="tour-title">{step.title}</strong>
        <p className="tour-text">{step.text}</p>
        <div className="tour-buttons">
          <button className="tour-skip" onClick={onDone}>
            スキップ
          </button>
          <span style={{ flex: 1 }} />
          {i > 0 && <button onClick={() => setI(i - 1)}>戻る</button>}
          <button className="tour-next" onClick={next} autoFocus>
            {i + 1 < steps.length ? "次へ" : "はじめる"}
          </button>
        </div>
      </div>
    </div>
  );
}
