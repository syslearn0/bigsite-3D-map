// コミケ Web カタログ（と CD-ROM カタログ）が書き出すチェックリストの CSV を読む。
// 形はコミックマーケット準備会の「チェックリスト(Ver2)仕様書」のとおり：
//   Header,ComicMarketCD-ROMCatalog,ComicMarket109,UTF-8,（作ったプログラム）
//   Color,番号,チェック色,印刷色,説明
//   Circle,通し番号,チェック色,ページ,カット位置,参加日（曜日）,地区,ブロック,スペース番号,ジャンル,サークル名,よみ,ペンネーム,
//          本の名前,URL,メール,補足,メモ,地図X,地図Y,机の向き,スペース番号補助（0=a・1=b）, …
// 文字コードは Header の 4 つめ（UTF-8・Shift_JIS など）。項目は " でくくってあってもよく、くくった中の改行もそのまま
import { normCode } from "./layout";
import type { Day } from "./tags";

export type ChecklistCircle = { day: Day | null; dayText: string; code: string; color: number; name: string; memo: string };
export type Checklist = { event: string; colors: Record<number, string>; circles: ChecklistCircle[]; skipped: number };

// CSV を行（項目のならび）に分ける。" でくくった項目の中の , ・改行・"" も読む
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    f = "",
    q = false,
    started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += ch;
      continue;
    }
    if (ch === '"' && !f) {
      q = true;
      started = true;
    } else if (ch === ",") {
      row.push(f);
      f = "";
      started = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (started || f) row.push(f);
      if (row.length) rows.push(row);
      row = [];
      f = "";
      started = false;
    } else {
      f += ch;
      started = true;
    }
  }
  if (started || f) row.push(f);
  if (row.length) rows.push(row);
  return rows;
}

// ファイルの中身（バイト）を文字にする。Header の文字コードを見て、UTF-8 でなければ読みなおす
export function decodeChecklist(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "");
  const head = parseCsv(utf8.split(/\r?\n/, 1)[0] ?? "")[0] ?? [];
  const enc = (head[0] === "Header" ? head[3] : "")?.trim().toLowerCase() ?? "";
  const label = /shift_?jis|sjis|cp932|windows-31j/.test(enc) ? "shift_jis" : /euc-?jp/.test(enc) ? "euc-jp" : /iso-2022-jp/.test(enc) ? "iso-2022-jp" : "";
  // 書いていないときも、UTF-8 として読めない（置きかえ文字が出る）なら Shift_JIS（Windows の CD-ROM カタログ）
  const want = label || (utf8.includes("�") ? "shift_jis" : "");
  return want ? new TextDecoder(want).decode(buf) : utf8;
}

// 参加日（「火」「水」「木」・「1」「1日目」など）を何日目かに。weekdays：1・2・3 日目の曜日
export function dayOf(text: string, weekdays: string[]): Day | null {
  const t = text.normalize("NFKC").trim();
  const n = /^([123])(日目)?$/.exec(t);
  if (n) return Number(n[1]) as Day;
  const w = weekdays.findIndex((d) => t.startsWith(d));
  return w >= 0 && w < 3 ? ((w + 1) as Day) : null;
}

export function readChecklist(text: string, weekdays: string[]): Checklist {
  const out: Checklist = { event: "", colors: {}, circles: [], skipped: 0 };
  for (const r of parseCsv(text)) {
    if (r[0] === "Header") out.event = r[2] ?? "";
    else if (r[0] === "Color") {
      const n = Number(r[1]);
      if (n > 0) out.colors[n] = (r[4] ?? "").trim();
    } else if (r[0] === "Circle") {
      const area = (r[6] ?? "").normalize("NFKC").trim().charAt(0);
      const block = (r[7] ?? "").trim();
      const space = (r[8] ?? "").normalize("NFKC").trim();
      if (!/^[東西南]$/.test(area) || !block || !/^\d{1,2}$/.test(space)) {
        out.skipped++;
        continue;
      }
      const half = (r[21] ?? "").trim() === "1" ? "b" : "a";
      out.circles.push({
        day: dayOf(r[5] ?? "", weekdays),
        dayText: (r[5] ?? "").trim(),
        code: normCode(`${area}${block}-${space}${half}`),
        color: Number(r[2]) || 0,
        name: (r[10] ?? "").trim(),
        memo: (r[17] ?? "").trim(),
      });
    }
  }
  return out;
}
