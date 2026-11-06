// 公開版の見本の机の情報（ジャンル・作品・キャラまたはグループ）。本当の配置・作品ではない。
// 作品名とキャラは架空のもの（実在の作品・サークルと関係なし）。島（列）ごとに 1 つの作品、机ごとにキャラを少し変える。
// 日ごとに作品の割り当てを変える（同じ配置番号でも日が違えば別のサークル）

import { DAYS, type SpaceTag, type Tags } from "@/lib/tags";

// ジャンル（コミケのジャンル分けに近い大まかな分類）→ 作品 → キャラ・グループ
const SAMPLE: { genre: string; work: string; chars: string[] }[] = [
  { genre: "男性向", work: "鋼鉄のアウラ", chars: ["アウラ", "ノエル", "第三小隊"] },
  { genre: "男性向", work: "ねこみみ喫茶ミケ", chars: ["ミケ", "クロ", "店員ズ"] },
  { genre: "女性向", work: "花冠の騎士団", chars: ["レオン", "シオン", "騎士団長"] },
  { genre: "女性向", work: "放課後探偵部", chars: ["ハルト", "ソウ", "探偵部"] },
  { genre: "ゲーム", work: "星海アーカイブ", chars: ["ユズハ", "ミオ", "生徒会", "調査部"] },
  { genre: "ゲーム", work: "ドラゴンロード戦記", chars: ["勇者リク", "魔王軍"] },
  { genre: "アニメ", work: "夜明けのリフレイン", chars: ["カナタ", "ヒカリ", "リフレイン（5人組）"] },
  { genre: "創作（少年）", work: "オリジナル（ファンタジー）", chars: [] },
  { genre: "創作（少女）", work: "オリジナル（恋愛）", chars: [] },
  { genre: "評論・情報", work: "鉄道・旅行", chars: [] },
];

// 決まった並びの数（配置番号から）。端末が違っても同じ見本になるように
function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h;
}

export const SAMPLE_GENRE_LIST = [...new Set(SAMPLE.map((x) => x.genre))];

export function sampleTags(booths: { code: string; line: number }[]): Tags {
  const out: Tags = {};
  for (const day of DAYS) {
    const d: Record<string, SpaceTag> = {};
    for (const b of booths) {
      const pick = SAMPLE[hash(`${day}:${b.line}`) % SAMPLE.length];
      const tag: SpaceTag = { genre: pick.genre, works: [pick.work] };
      if (pick.chars.length) {
        const h = hash(`${day}:${b.code}`);
        // 机ごとに 1〜2 人（グループ）。3 割ほどはキャラなし（作品全体）
        if (h % 10 >= 3) {
          const c1 = pick.chars[h % pick.chars.length];
          const c2 = pick.chars[(h >> 4) % pick.chars.length];
          tag.chars = { [pick.work]: c1 === c2 || h % 3 ? [c1] : [c1, c2] };
        }
      }
      d[b.code] = tag;
    }
    out[day] = d;
  }
  return out;
}
