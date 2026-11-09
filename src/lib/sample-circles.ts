// 公開版の見本の配置（架空）につける、見本のサークル情報（サークル名とカットの画像）。ユーザーの指示：テキトーでいい。
// 名前も画像もその場で作る架空のもの（実在のサークルと関係なし）。X・サイトは、実在のアカウントに当たらないよう入れない。
// 本当の配置・公開されたサークル情報があるときは使わない

import type { CirclesByDay } from "@/lib/published";
import { DAYS } from "@/lib/tags";

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  // となりの番号どうしで似た値にならないよう、よく混ぜる
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const HEAD = ["ねこ", "ほし", "あお", "しろ", "よる", "そら", "ゆめ", "つき", "はな", "かぜ", "みかん", "こはく", "あめ", "ゆき", "くじら", "うさぎ", "ことり", "きつね", "まめ", "ひかり"];
const TAIL = ["屋", "工房", "堂", "企画", "製作所", "研究会", "ノート", "日和", "の森", "ラボ", "書房", "茶房", "本舗", "通信", "倶楽部"];
// カットの絵：背景の色と、真ん中の形
const SHAPES = ["circle", "star", "heart", "moon", "diamond"] as const;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// 見本のカット（正方形の SVG）。サークル名と「見本」の字
function cut(name: string, h: number): string {
  const hue = h % 360, hue2 = (hue + 40 + ((h >>> 9) % 80)) % 360;
  const shape = SHAPES[(h >>> 5) % SHAPES.length];
  const fg = `hsl(${hue2},70%,96%)`;
  const mark =
    shape === "circle"
      ? `<circle cx="128" cy="104" r="52" fill="${fg}" opacity=".9"/>`
      : shape === "star"
        ? `<polygon points="128,44 146,90 196,92 156,122 170,170 128,142 86,170 100,122 60,92 110,90" fill="${fg}" opacity=".9"/>`
        : shape === "heart"
          ? `<path d="M128 168 C60 120 64 62 104 62 C120 62 128 76 128 84 C128 76 136 62 152 62 C192 62 196 120 128 168Z" fill="${fg}" opacity=".9"/>`
          : shape === "moon"
            ? `<circle cx="128" cy="104" r="54" fill="${fg}" opacity=".9"/><circle cx="152" cy="88" r="46" fill="hsl(${hue},55%,52%)"/>`
            : `<polygon points="128,46 182,104 128,162 74,104" fill="${fg}" opacity=".9"/>`;
  const fs = name.length > 6 ? 24 : 30;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,58%)"/><stop offset="1" stop-color="hsl(${hue},55%,40%)"/></linearGradient></defs>` +
    `<rect width="256" height="256" rx="18" fill="url(#g)"/>${mark}` +
    `<text x="128" y="214" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${fs}" fill="#fff">${esc(name)}</text>` +
    `<text x="244" y="26" text-anchor="end" font-family="sans-serif" font-size="16" fill="#fff" opacity=".85">見本</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// 配置番号ごとに 1 つのサークル（日ごとに別のサークル）。1 割ほどは「まだ登録されていない」机として空けておく
export function fillSampleCircles(out: CirclesByDay, booths: { code: string }[]) {
  for (const day of DAYS)
    for (const b of booths) {
      const h = hash(`${day}:${b.code}:circle`);
      if (h % 10 === 0) continue;
      const name = HEAD[h % HEAD.length] + TAIL[(h >>> 8) % TAIL.length];
      out[day][b.code] = { day, codes: [b.code], name, works: [], chars: {}, x: "", url: "", image: cut(name, h) };
    }
}
