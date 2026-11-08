// data/osm/bigsight.json（OSM）から、画面で使う会場データ src/data/venue.json を作る。
// 座標は会場の中のメートル（x：東、z：南）。位置関係は OSM の緯度経度のまま（ホール同士の並びは地図どおり）。
// 南展示棟は OSM に外形1つ（ホール＋西展示棟へつなぐ通路）しかないので、ホールの部分を切り出して「形は概略」とする。

import polygonClipping from "polygon-clipping";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { centroid, minAreaRect, pointInPolygon, project, type XZ } from "../src/lib/geo";

type El = { type: string; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[]; lat?: number; lon?: number };
const osm = JSON.parse(readFileSync("data/osm/bigsight.json", "utf8")) as { fetchedAt: string; elements: El[] };
const ORIGIN = { lat: 35.6298, lon: 139.7942 };
// 床の高さ（m）。見やすさのための高さで、実物とは違う。
// 2F は 1F のホールの壁の高さ（12m）にそろえる。4F は 2F から 2 階ぶん上なので、1F→2F と同じだけ上（24m）
const FLOOR_Y: Record<number, number> = { 1: 0, 2: 12, 4: 24 };
// エスカレーターの平面の長さ ÷ 高さ（どのエスカレーターも同じ傾き）
const ESC_RUN = 0.8;

const byName = (name: string) => {
  const e = osm.elements.find((x) => x.tags?.name === name && x.geometry);
  if (!e) throw new Error(`OSM に「${name}」がない`);
  return e;
};
const byId = (id: number) => {
  const e = osm.elements.find((x) => x.id === id && x.geometry);
  if (!e) throw new Error(`OSM に way ${id} がない`);
  return e;
};
const poly = (e: El): XZ[] => {
  const p = e.geometry!.map((g) => project(ORIGIN, g.lat, g.lon));
  if (p.length > 1 && p[0][0] === p.at(-1)![0] && p[0][1] === p.at(-1)![1]) p.pop();
  return p;
};

// C109（2026年冬）：東4〜6ホールは改修工事で使わない
type Hall = { id: string; name: string; building: "東" | "西" | "南"; level: number; poly: XZ[]; closed?: string; rough?: boolean; osm: string; inner?: XZ[] };
const halls: Hall[] = [];
const hall = (id: string, name: string, building: Hall["building"], level: number, extra: Partial<Hall> = {}) => {
  const e = byName(name);
  halls.push({ id, name, building, level, poly: poly(e), osm: `${e.type}/${e.id}`, ...extra });
};
for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) hall(`E${n}`, `東${n}ホール`, "東", 1, n >= 4 && n <= 6 ? { closed: "改修工事中（C109 では使わない）" } : {});
// 東1〜3ホールは、図面（白図）では 90m × 90m。OSM の形は東4〜6 との間の通路まで含んで長い向きに 103m ほどあるので、
// 通路側（東4〜6 に近い側）を削って 90m 四方の長方形にする（寸法だけを参考にし、図面の形はなぞらない）
{
  const far = centroid(["E4", "E5", "E6"].flatMap((id) => halls.find((h) => h.id === id)!.poly));
  for (const id of ["E1", "E2", "E3"]) {
    const h = halls.find((x) => x.id === id)!;
    const r = minAreaRect(h.poly);
    if (r.length <= 95) continue;
    const ax: XZ = [Math.cos(r.angle), Math.sin(r.angle)];
    const nx: XZ = [-ax[1], ax[0]];
    const endA: XZ = [r.center[0] - (ax[0] * r.length) / 2, r.center[1] - (ax[1] * r.length) / 2];
    const endB: XZ = [r.center[0] + (ax[0] * r.length) / 2, r.center[1] + (ax[1] * r.length) / 2];
    // 東4〜6 から遠い端を残し、そこから 90m
    const keepA = Math.hypot(endA[0] - far[0], endA[1] - far[1]) > Math.hypot(endB[0] - far[0], endB[1] - far[1]);
    const [from, dir]: [XZ, number] = keepA ? [endA, 1] : [endB, -1];
    const w = Math.min(90, r.width);
    h.poly = [
      [0, -w / 2],
      [90, -w / 2],
      [90, w / 2],
      [0, w / 2],
      // 端の点 from は OSM の長方形の中心線上なので、幅の向きは OSM の中心に合う
    ].map(([u, v]) => [Math.round((from[0] + ax[0] * u * dir + nx[0] * v) * 10) / 10, Math.round((from[1] + ax[1] * u * dir + nx[1] * v) * 10) / 10] as XZ);
  }
}
hall("W1", "西1ホール", "西", 1);
hall("W2", "西2ホール", "西", 1);
hall("W3", "西3ホール", "西", 4);
hall("W4", "西4ホール", "西", 4);
// 西3ホールは、図面（白図）では幅約44m × 長さ約106m（溝の範囲）。OSM の形は 40m × 93m と小さいので、
// OSM の長方形の向きのまま、図面の寸法の長方形にする。西4 との境目（可動間仕切）の端はそのままにして、反対側へ伸ばす
{
  const h = halls.find((x) => x.id === "W3")!;
  const r = minAreaRect(h.poly);
  const ax: XZ = [Math.cos(r.angle), Math.sin(r.angle)];
  const nx: XZ = [-ax[1], ax[0]];
  const w4 = centroid(halls.find((x) => x.id === "W4")!.poly);
  const toW4 = (w4[0] - r.center[0]) * ax[0] + (w4[1] - r.center[1]) * ax[1] > 0 ? 1 : -1;
  const keep = (toW4 * r.length) / 2; // 西4 側の端（中心から u 方向に）
  const far = keep - toW4 * 106;
  h.poly = [
    [keep, -22],
    [far, -22],
    [far, 22],
    [keep, 22],
  ].map(([u, v]) => [Math.round((r.center[0] + ax[0] * u + nx[0] * v) * 10) / 10, Math.round((r.center[1] + ax[1] * u + nx[1] * v) * 10) / 10] as XZ);
}

// 南展示場の外形：頂点 0〜4 と最後の頂点がホール、残りは西展示棟へ向かう通路
const south = byName("南展示場");
const sp = poly(south);
const southHall: XZ[] = [...sp.slice(0, 5), sp.at(-1)!];
const southPassage: XZ[] = sp.slice(4);
// 南展示棟の中のホールの位置。ビッグサイトの主催者向け図面（白図）を参考に、寸法だけを使って長方形で置く
// （図面の形はなぞらない。個人・非営利の参考としての利用は、ビッグサイトに確認済み）。
// ・南1ホール：建物を横切る向きに約67m、建物の長い向きに約73m（柱の間隔 12m から読んだ寸法）
// ・西展示棟の側の端から約36m は、エントランスホール・エレベーターなど
// ・南2は南1の奥に、可動の間仕切りをはさんで同じ大きさ。南3・南4は 4F で、それぞれ南1・南2の真上（フロアマップ）
const SOUTH = { width: 67, length: 73, entrance: 36 };
const rect = minAreaRect(southHall);
const ax: XZ = [Math.cos(rect.angle), Math.sin(rect.angle)];
const nx: XZ = [-ax[1], ax[0]];
const west = centroid(poly(byName("西展示棟")));
// 長い向きのどちらの端が西展示棟に近いか（その端から奥へ並べる）
const endA: XZ = [rect.center[0] - (ax[0] * rect.length) / 2, rect.center[1] - (ax[1] * rect.length) / 2];
const endB: XZ = [rect.center[0] + (ax[0] * rect.length) / 2, rect.center[1] + (ax[1] * rect.length) / 2];
const nearA = Math.hypot(endA[0] - west[0], endA[1] - west[1]) < Math.hypot(endB[0] - west[0], endB[1] - west[1]);
const [from, dir]: [XZ, number] = nearA ? [endA, 1] : [endB, -1];
const box = (u0: number, u1: number): XZ[] =>
  [
    [u0, -SOUTH.width / 2],
    [u1, -SOUTH.width / 2],
    [u1, SOUTH.width / 2],
    [u0, SOUTH.width / 2],
  ].map(([u, v]) => [Math.round((from[0] + ax[0] * u * dir + nx[0] * v) * 10) / 10, Math.round((from[1] + ax[1] * u * dir + nx[1] * v) * 10) / 10] as XZ);
const s1 = box(SOUTH.entrance, SOUTH.entrance + SOUTH.length);
const s2 = box(SOUTH.entrance + SOUTH.length, SOUTH.entrance + 2 * SOUTH.length);
const s = `${south.type}/${south.id}`;
halls.push({ id: "S1", name: "南1ホール", building: "南", level: 1, poly: s1, osm: s });
halls.push({ id: "S2", name: "南2ホール", building: "南", level: 1, poly: s2, osm: s });
halls.push({ id: "S3", name: "南3ホール", building: "南", level: 4, poly: s1, osm: s });
halls.push({ id: "S4", name: "南4ホール", building: "南", level: 4, poly: s2, osm: s });
// 南展示棟の建物の、ホール以外（エントランスホールなど）も床として見せる
const southRest: XZ[] = southHall;


// ホール以外の歩く場所（通路・広場）
type Area = { name: string; level: number; poly: XZ[]; see?: boolean; holes?: XZ[][]; under?: boolean; outdoor?: boolean; part?: boolean; sur?: boolean }; // sur：会場の外（やぐら橋など。「周辺も表示」のときだけ）。under：ほかの床の下に敷く（名前の札を出さない）。part：穴で切れた床のかけら（名前の札を出さない）
// その階の床（ホール・通路）の上か
function onFloor(p: XZ, lv: number): boolean {
  return halls.some((h) => h.level === lv && !h.closed && pointInPolygon(p, h.poly)) || areas.some((a) => a.level === lv && pointInPolygon(p, a.poly));
}
function southConcourse(): Area[] {
  if (!existsSync("data/osm/surroundings.json")) return [];
  const so = JSON.parse(readFileSync("data/osm/surroundings.json", "utf8")) as { elements: El[] };
  const e = so.elements.find((x) => x.id === 1127507757 && x.geometry);
  if (!e) return [];
  const line = e.geometry!.map((g) => project(ORIGIN, g.lat, g.lon));
  // 線の始めのうち、ほかの 2F の床（イベントプラザ・エントランスプラザ）の中を通る所は、その床があるので帯にしない
  const plazas = ["イベントプラザ", "エントランスプラザ"].map((n) => poly(byName(n)));
  let k0 = 0;
  while (k0 + 2 < line.length && plazas.some((pl) => pointInPolygon(line[k0 + 1], pl) || pointInPolygon([(line[k0][0] + line[k0 + 1][0]) / 2, (line[k0][1] + line[k0 + 1][1]) / 2], pl))) k0++;
  const pts: XZ[] = line.slice(k0);
  const w = 4; // 半分の幅
  const left: XZ[] = [], right: XZ[] = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
    const r = (v: number) => Math.round(v * 10) / 10;
    left.push([r(p[0] + nx * w), r(p[1] + nz * w)]);
    right.push([r(p[0] - nx * w), r(p[1] - nz * w)]);
  });
  return [{ name: "コンコース", level: 2, poly: [...left, ...right.reverse()] }];
}
// 西展示棟の向き：西3 の展示場の長い辺の向き（u）とそれに直角（v）。uv の座標 ↔ 会場の座標
const WEST_U: XZ = (() => {
  const p = halls.find((h) => h.id === "W3")!.poly;
  let best: [number, XZ] = [0, [1, 0]];
  p.forEach((a, i) => {
    const b = p[(i + 1) % p.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > best[0]) best = [L, [(b[0] - a[0]) / L, (b[1] - a[1]) / L]];
  });
  const [ux, uz] = best[1];
  return ux * 0.552 + uz * 0.834 >= 0 ? [ux, uz] : [-ux, -uz];
})();
const WEST_V: XZ = [-WEST_U[1], WEST_U[0]];
const fromUV = (q: XZ[]): XZ[] => q.map(([u, v]) => [Math.round((u * WEST_U[0] + v * WEST_V[0]) * 10) / 10, Math.round((u * WEST_U[1] + v * WEST_V[1]) * 10) / 10] as XZ);
const toUV = (p: XZ): XZ => [p[0] * WEST_U[0] + p[1] * WEST_U[1], p[0] * WEST_V[0] + p[1] * WEST_V[1]];
// 東ガレリアの東4〜6 の側の吹き抜けと、その中の階段・エスカレーターを東4〜6 の側へ寄せる長さ（m）
const E456_SHIFT = 6;
// 南展示棟の西の壁：OSM の建物の形は北西のすみだけ斜め（u 219〜230）だが、同じ OSM の形の西の通路の側の壁（u 230.2〜230.6）と
// 航空写真の屋根の端は、ホールに直角にまっすぐ（u 236。その西の u 214〜236 は、4F の通路のあいだの吹き抜け）
const southRestSq: XZ[] = southRest.map((p) => {
  const [u, v] = toUV(p);
  return u < 236 ? fromUV([[236, v]])[0] : p;
});
// 西と南のつなぎ目の角にある、ホールに 45° 傾いた四角い建物（航空写真：中心 u 227.5・v 104、角から角まで 34m、屋根に小さな
// ピラミッド）。公式フロアマップでは南展示棟の上り下りの所で、1F・2F は人の入れる床（下の「南の角の建物」）
const southEntrance: XZ[] = fromUV([[227.5, 87], [244.5, 104], [227.5, 121], [210.5, 104]]);
const blocks: { name: string; level: number; poly: XZ[]; height: number; holes?: XZ[][]; kind?: "room"; base?: number }[] = [];

// 2つのホールの列の、向かい合う壁の端の点を囲む四角（凸包）
function between(rowA: string[], rowB: string[]): XZ[] {
  const cen = (ids: string[]) => centroid(ids.flatMap((id) => halls.find((h) => h.id === id)!.poly));
  const facing = (id: string, toward: XZ): XZ[] => {
    const p = halls.find((h) => h.id === id)!.poly;
    let best: [number, XZ[]] = [Infinity, []];
    p.forEach((a, i) => {
      const b = p[(i + 1) % p.length];
      const d = Math.hypot((a[0] + b[0]) / 2 - toward[0], (a[1] + b[1]) / 2 - toward[1]);
      if (d < best[0]) best = [d, [a, b]];
    });
    return best[1];
  };
  const ca = cen(rowA), cb = cen(rowB);
  const pts = [...rowA.flatMap((id) => facing(id, cb)), ...rowB.flatMap((id) => facing(id, ca))];
  // 凸包（ギフト包装）
  const hull: XZ[] = [];
  let p0 = pts.reduce((m, q) => (q[0] < m[0] ? q : m));
  do {
    hull.push(p0);
    let next = pts[0];
    for (const q of pts) {
      const cr = (next[0] - p0[0]) * (q[1] - p0[1]) - (next[1] - p0[1]) * (q[0] - p0[0]);
      if (next === p0 || cr < 0) next = q;
    }
    p0 = next;
  } while (p0 !== hull[0] && hull.length < pts.length + 1);
  return hull;
} // see：下が透けて見える床（半透明）、holes：吹き抜け
const areas: Area[] = [
  ...[
    ["エントランスプラザ", 2],
    ["連絡ブリッジ", 2],
    ["北コンコース", 2],
    ["イベントプラザ", 2],
    ["1Ｆ アトリウム", 1],
    ["４Ｆ アトリウム", 4],
    ["屋上展示場", 4],
    ["中央ターミナル", 1],
    ["リンクスペース", 1],
  ].map(([name, level]) => ({ name: String(name).replace("Ｆ ", "F "), level: Number(level), poly: poly(byName(String(name))) })),
  // 東1〜3 と東4〜6 のあいだの通路（ガレリア）。OSM では名前が「西２F」と書かれている（way 543048845、東展示棟の通路）
  { name: "東ガレリア", level: 1, poly: poly(byId(543048844)) },
  // ホールとガレリアのあいだ（ホール前の部屋や通路の帯）。OSM のガレリアの形はホールの壁まで届いていないので、
  // 東1〜3 と東4〜6 の向かい合う壁のあいだを、床でうめる（ガレリアの下に敷く）
  { name: "ホール前", level: 1, poly: between(["E1", "E2", "E3"], ["E4", "E5", "E6"]), under: true },
  // ガレリアの上の 2F の通路（東展示棟 2F）。北コンコース・連絡ブリッジから段差なしで入る。下のガレリアが見えるよう、地図では半透明
  {
    name: "東展示棟 2F",
    level: 2,
    poly: poly(byId(543048845)),
    see: true,
    // 吹き抜け：施設案内の 2F全体図のガレリアの上の ×印の四角（scripts/extract-plan-toilets.py が data/plan-toilets.json に書く）
    // 東4〜6 の側（u < -3）の吹き抜けは、ユーザーの確認で丸ごと東4〜6 の側へ 6m ずらす（中の階段・エスカレーターも一緒に）
    holes: (existsSync("data/plan-toilets.json") ? ((JSON.parse(readFileSync("data/plan-toilets.json", "utf8")) as { voids?: XZ[][] }).voids ?? []) : [])
      .filter((v) => pointInPolygon(centroid(v), poly(byId(543048845))))
      .map((v) => {
        const cu = toUV(centroid(v))[0];
        if (cu >= -3) return v;
        return v.map((p) => {
          const [u, w] = toUV(p);
          return fromUV([[u - E456_SHIFT, w]])[0];
        });
      }),
  },
  { name: "南展示棟への通路", level: 1, poly: southPassage },
  // 4F でも、西4ホールと南3・4ホールは通路でつながる（ビッグサイトの館内図）。航空写真では、西4 の南東の壁（u 202）と
  // 南展示棟の西の壁のあいだが、壁に直角な四角い舗装面でつながっている（v 15.9〜103.3：西4 の外の通路の端から屋上展示場の端まで）
  // 南の側は、南展示棟の西の壁（u 236）まで、v 86 まで（その先、屋上展示場の北東の角の横は下まで暗く抜けている）。
  // まん中の u 216〜229・v 38.6〜69.7 は、下の階まで抜けた吹き抜けの穴（Google Earth の真上の写真から、角の 45° の建物を
  // 基準に測ったもの）。南3・4 の北の通路（v 19.2〜34.4）とは u 214 でつながる
  {
    name: "南展示棟への通路（4F）",
    level: 4,
    poly: fromUV([[202, 15.9], [214, 15.9], [214, 34.4], [236, 34.4], [236, 86], [202, 86]]),
    holes: [fromUV([[216, 38.6], [229, 38.6], [229, 69.7], [216, 69.7]])],
  },
  // コンコース（2F）：イベントプラザから南展示棟まで 2F のまま続く長い通路（公式フロアマップの「コンコース」）。
  // 形は OpenStreetMap の 2F の歩道の線（way 1127507757、layer=2）を幅 8m の帯にしたもの（南1・2 の西わきを南棟の駐車場まで続く）
  ...southConcourse(),
  // 南コンコース：エントランスホールの東の端から、西のアトリウムまでの 2F の屋内の通路（OSM way 154080986 の形のまま）。
  // ホールの壁に 45° の斜めの通路：航空写真でも、エントランスホールの角から西のアトリウムへ、屋根のある斜めの通路が続いている。
  // 公式フロアマップ（ホールの壁を ±30° に描く等角図）でも横一直線に描かれていて、これは平面で 45° の向き。
  // 公式の図ではここに 4F（17）・1F（10）へのエスカレーターが着く
  { name: "南コンコース", level: 2, poly: poly(byId(154080986)) },
  { name: "南展示棟", level: 1, poly: southRestSq },
  // 4F も、南3・4 のまわりのロビー・通路・トイレは南展示棟の建物の中（1F と同じ建物の形の床）
  { name: "南展示棟（4F）", level: 4, poly: southRestSq, under: true },
];

// 4F アトリウム（屋内の L 字の通路）と屋上展示場：OSM の形の斜めの端を、西3・西4 の壁に直角にそろえる（公式の 4F 図では、白い L 字の通路と
// 灰色の屋上の縁は、どれもホールの壁と平行か直角）。L 字は西3 にそう腕（幅 20m）と西4 にそう腕（幅 20m）
{
  const a4 = areas.find((a) => a.name === "４F アトリウム");
  // 航空写真（Esri World Imagery を西展示棟の向きに回して測ったもの）：アトリウムの真ん中の天窓（下の 1F まで吹き抜け）は
  // u 78〜124・v -7〜39 の正方形。そのまわりの屋根の低い帯が L 字の 4F アトリウムで、西3 の壁（v -28.5）から天窓まで、
  // 西4 の壁（u 149.8）から天窓まで。天窓の西（u 56〜78）は 2F 南コンコースの上の屋根で、4F の床ではない
  // 西4 にそう腕の南の端は 45° の斜め：天窓の南東の角 (124, 39) から (142.2, 57.2) まで（航空写真で、腕の屋根の端が天窓の角から
  // 斜めに切れている。公式フロアマップの 4F 図でも、白い腕の端は天窓の角から西4 の角までの斜めの辺）。この斜めのガラスの面に、
  // 屋上展示場への出入口がある（斜めからの写真：ガラスの面のまん中に庇のある入口）。出入口は下の exits
  if (a4) a4.poly = fromUV([[56.6, -28.5], [149.8, -28.5], [149.8, 57.2], [142.2, 57.2], [124, 39], [124, -7], [56.6, -7]]);
  const roof = areas.find((a) => a.name === "屋上展示場");
  // 屋上展示場は天窓のすぐ南（v 39）から。天窓の西にも、白い破線の引かれた車の通路（u 70〜78）が 4F アトリウムの腕（v -7）まで続く
  // （航空写真・斜めからの写真。公式フロアマップの 4F 図でも、屋上展示場は吹き抜けの 2 辺を囲む）。その西は 2F 南コンコースの屋根。
  // 通路の南の端から屋上展示場の西の縁へは、写真のとおり斜めの縁（(70, 38)〜(61.5, 55.5)）
  if (roof) roof.poly = fromUV([[142.2, 57.2], [124, 39], [78, 39], [78, -7], [70, -7], [70, 38], [61.5, 55.5], [61.5, 103.2], [201.9, 103.3], [202.1, 57.2]]);
}
// 2F の形の手直し（公式フロアマップ・航空写真・OSM に合わせる）
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const unring = (r: [number, number][]): XZ[] => r.slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
  const size = (r: XZ[]) => Math.abs(r.reduce((s2, p, i) => s2 + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
  const biggest = (mp: [number, number][][][]): XZ[] => mp.map((pg) => unring(pg[0])).sort((a, b) => size(b) - size(a))[0];
  // イベントプラザとコンコースのあいだの 1m ほどのすき間（OSM の 2 つの形のずれ）をうめる
  const cc = areas.find((a) => a.name === "コンコース");
  if (cc) cc.poly = biggest(polygonClipping.union([ring(cc.poly)], [ring(fromUV([[-6.8, 103.5], [20.6, 103.5], [20.6, 106], [-6.8, 106]]))]));
  // 南コンコースの屋内と屋外：公式フロアマップでは、南コンコースはエントランスホールから一定の幅（16m ほど）でまっすぐ斜めに
  // のびる白い帯（屋内）で、西のアトリウムの側の端は帯に直角に切れている。北東のふちは、エントランスホールの角 (21.2,-71.5) から
  // OSM の端 (84.8,-10.8) までの 1 本の直線（OSM の形は途中で 5m ほどふくらむが、公式の図では直線）。南西のふちはそれに平行な 16m
  // 内側の直線で、エントランスプラザの東の縁（u 43.9）まで。エントランスホールの東の辺とプラザの角のあいだも屋内。
  // 帯の南西の、プラザの東の縁から西のアトリウムまでの舗装された中庭は屋根がない（屋外。エントランスプラザの続き）
  //
  // → 2F のエントランスまわり（エントランスホール・南コンコース・エントランスプラザ・イベントプラザ）は、まとめて描き直した：
  // 公式フロアマップ（斜めから見た図）を、会議棟の 4 本の柱の位置で上から見た形に直して（data/private の平面図）、それを見ながら
  // 形と位置関係をそろえて描いた形（u・v、0.5m 単位）。公式の図そのものが正確ではないので、ぴったりではなく、形と並びを合わせた
  {
    for (let i = areas.length - 1; i >= 0; i--)
      if (areas[i].level === 2 && ["エントランスホール", "南コンコース", "エントランスプラザ", "イベントプラザ"].includes(areas[i].name)) areas.splice(i, 1);
    // 屋内：エントランスホール。南の端は会議棟の前の 2 本の柱の手前（v -18）まで張り出し（ここの南の端に出口）、張り出しの両わきの
    // 奥に床のない切り欠き（エスカレーターの穴）。東は南コンコースの北東のふちまで屋内。西の辺（u -28.5）に北コンコースがつながる
    areas.push({
      name: "エントランスホール",
      level: 2,
      poly: fromUV([
        [-28.5, -143.5], [23, -143], [23, -92.5], [67.5, -92], [69, -30.5], [24, -75.5], [23.5, -44.5], [13, -44.5], [13, -36.5], [21.5, -36.5],
        [22.5, -17.5], [-34.5, -18], [-34.5, -38], [-19, -37.5], [-19, -45], [-28, -45],
      ]),
    });
    // 屋内：南コンコース。エントランスホールから西のアトリウムの側へ斜めにのびる帯。北東のふちは途中で 1 か所内へ折れ、
    // 南西のふちは中庭（屋外）に向かって段々になっている。アトリウムの側の端は u 85 の辺（v -0.5〜18.5）
    areas.push({
      name: "南コンコース",
      level: 2,
      poly: fromUV([
        [24, -75.5], [78, -21.5], [71.5, -14.5], [85, -0.5], [85.5, 18.5], [76, 9], [66, 9], [71, 3.5], [62.5, -5], [51.5, -5.5], [57, -10.5],
        [48.5, -19.5], [37.5, -20], [42.5, -25.5], [23.5, -44.5],
      ]),
    });
    // 屋外：エントランスプラザ（会議棟の下の広場）とイベントプラザ、西の駅への 2F の通路。北のふちは v -38（途中に V 字のくぼみ）、
    // 前の柱は張り出しの角のくぼみに、うしろの柱は四角い穴に入る。広場の中の吹き抜け（ひし形・三角・四角）は穴
    const plaza: XZ[] = fromUV([
      [-129.5, -39], [-66.5, -38], [-50.5, -21.5], [-35, -38], [-34.5, -9.5], [-26, -9.5], [-26, -18], [14, -17.5], [14.5, -9.5], [23, -9.5],
      [21.5, -36.5], [31.5, -36], [42.5, -25.5], [37.5, -20], [48.5, -19.5], [57, -10.5], [51.5, -5.5], [62.5, -5], [71, 3.5], [66, 9], [76, 9],
      [85.5, 18.5], [86, 28.5], [78, 20.5], [45.5, 20], [66, 40.5], [35.5, 71.5], [23, 59], [24, 104], [-80, 104], [-80, 56.5], [-106.5, 56],
      [-134.5, 84], [-140, 79], [-116.5, 55.5], [-127.5, 55.5], [-128, 23.5], [-168, 23], [-168.5, -9], [-129, -8],
    ]);
    const plazaHoles: XZ[][] = [
      [[-5.5, 2], [-14, 10.5], [-5.5, 18.5], [2.5, 10.5]], // ひし形の吹き抜け
      [[14.5, 31], [23, 31], [23, 39], [14.5, 39]], // うしろの柱
      [[-33, 29.5], [-24.5, 29.5], [-24.5, 38], [-33, 38]],
      [[-73.5, 5], [-62, 5], [-73.5, -6.5]], // X 字に並ぶ三角の吹き抜け
      [[-92, 4.5], [-80.5, 4.5], [-81, -6.5]],
      [[-73, 12.5], [-73, 23.5], [-62, 13]],
      [[-92, 12], [-80.5, 23.5], [-80.5, 12.5]],
      [[-48.5, 49], [-40, 49.5], [-40.5, 41.5]],
      [[-120, 39], [-119.5, 47], [-111, 47.5]],
      [[-121.5, -32], [-121.5, -23.5], [-113, -32]],
      [[-32, 81], [-23.5, 81], [-23.5, 89.5], [-32, 89.5]], // イベントプラザの吹き抜け
      [[-64, 72.5], [-47.5, 72.5], [-47.5, 89], [-64, 89]],
    ].map((h) => fromUV(h as XZ[]));
    let plazaMP: [number, number][][][] = [[ring(plaza)]];
    for (const h of plazaHoles) plazaMP = polygonClipping.difference(plazaMP, [ring(h)]);
    // 屋内：北コンコース（エントランスホールの西の辺から北西へのびる帯。南西のふちに 1 か所切り欠き）と、
    // 連絡ブリッジ（北コンコースの北西の端から、北東の東ガレリアへ。ブリッジの北東のふちは前の形とほぼ同じで、南西のふちは 5m 外、
    // 東ガレリアの側の端は v -250〜-255 まで）
    for (let i = areas.length - 1; i >= 0; i--) if (areas[i].level === 2 && ["北コンコース", "連絡ブリッジ"].includes(areas[i].name)) areas.splice(i, 1);
    const ncPoly = fromUV([[-28, -84.5], [-48, -105], [-53.5, -100], [-60.5, -107], [-55.5, -112.5], [-105, -162], [-85.5, -181.5], [-80, -176], [-59.5, -155], [-28.5, -124]]);
    const bridgePoly = fromUV([[-80, -176], [-74, -185.5], [-32, -255], [-2, -250.5], [-53.5, -165], [-59.5, -155]]);
    areas.push({ name: "北コンコース", level: 2, poly: ncPoly });
    areas.push({ name: "連絡ブリッジ", level: 2, poly: bridgePoly });
    // 東ガレリアの 2F（東展示棟 2F）は、ブリッジの端と同じ v -250 あたりから。その手前（v -250〜-221）は屋外（下の外のデッキの一部）
    const gal = areas.find((a) => a.level === 2 && a.name === "東展示棟 2F");
    if (gal) {
      const cutGal = fromUV([[-60, -200], [40, -200], [40, -250], [16, -250], [-2, -250.5], [-32, -255], [-60, -255]]);
      const mp = polygonClipping.difference([[ring(gal.poly), ...(gal.holes ?? []).map(ring)]], [ring(cutGal)]);
      const big = mp.map((pg) => ({ poly: unring(pg[0]), holes: pg.slice(1).map(unring) })).sort((a, b) => size(b.poly) - size(a.poly))[0];
      gal.poly = big.poly;
      gal.holes = big.holes;
    }
    // 屋外：外のデッキ（2F）。エントランスプラザの北のふちから北西へ、北コンコースの西を北へ（u -135〜-125）、東4〜6 の南の壁の
    // 手前（v -262〜-269）を東へ、東ガレリアの入口の手前の三角（v -250〜-221）まで。北コンコースの北西の端と南西のふちにも枝がつく。
    // 屋内（北コンコース・ブリッジ・東ガレリア）と重なる所は引く
    {
      const deck = fromUV([
        [-114, -39], [-131, -85], [-135.5, -269.5], [-48, -267.5], [-24, -267], [15, -265.5], [16, -221], [8.5, -221], [-35.5, -249], [-47.5, -256.5],
        [-47.5, -260], [-127, -262], [-125.5, -183], [-109, -166.5], [-105, -170.5], [-106, -201.5], [-86, -181.5], [-105.5, -162], [-68.5, -125],
        [-68.5, -114.5], [-125, -171.5], [-123, -86], [-106, -39],
      ]);
      let mp: [number, number][][][] = [[ring(deck)]];
      for (const a of areas.filter((x) => x.level === 2 && !x.outdoor && ["北コンコース", "連絡ブリッジ", "東展示棟 2F", "エントランスホール"].includes(x.name)))
        mp = polygonClipping.difference(mp, [ring(a.poly)]);
      mp.map((pg) => ({ poly: unring(pg[0]), holes: pg.slice(1).map(unring) }))
        .filter((pc) => size(pc.poly) > 20)
        .sort((a, b) => size(b.poly) - size(a.poly))
        .forEach((pc, i) => areas.push({ name: "外のデッキ（2F）", level: 2, poly: pc.poly, ...(pc.holes.length ? { holes: pc.holes } : {}), outdoor: true, ...(i > 0 ? { part: true } : {}) }));
    }
    // イベントプラザ（u -31〜24.5・v 59〜）と、そのほかのエントランスプラザに分ける（名前の札は大きい方の 1 つだけ）
    const ev = [ring(fromUV([[-31, 59], [24.5, 59], [24.5, 110], [-31, 110]]))];
    for (const [name, mp] of [
      ["イベントプラザ", polygonClipping.intersection(plazaMP, ev)],
      ["エントランスプラザ", polygonClipping.difference(plazaMP, ev)],
    ] as [string, [number, number][][][]][]) {
      mp.map((pg) => ({ poly: unring(pg[0]), holes: pg.slice(1).map(unring) }))
        .sort((a, b) => size(b.poly) - size(a.poly))
        .forEach((pc, i) => areas.push({ name, level: 2, poly: pc.poly, ...(pc.holes.length ? { holes: pc.holes } : {}), ...(i > 0 ? { part: true } : {}) }));
    }
  }
  // 1F の南展示棟への通路：南展示棟の建物の床と重ならないよう、その形を引く
  const sp1 = areas.find((a) => a.name === "南展示棟への通路");
  if (sp1) {
    sp1.poly = biggest(polygonClipping.difference([ring(sp1.poly)], [ring(southRestSq)]));
    // 西と南のあいだ：OSM の形の東の端（u 210〜230）は、斜めの切れ端が多く、南展示棟の壁ともすき間がある。
    // 東の端は、南展示棟の西の壁（u 236）までの、壁に直角な形にする：u 219〜236 の南北の通路（v 12.4〜106.3）と、
    // その南の端から西へのびる帯（v 106.3〜123.3）
    // 西の端（u -80：エントランスプラザの南の端から、道を渡る橋と階段のある所）までのばし、南の角の建物の南の端の外（v 118〜126）も
    // 帯でつなぐ（ユーザーの指示：西と南のあいだの 1F を、西の端から端まで青い床でつなぐ。航空写真で、建物の南の歩道が u -80 まで続き、
    // 角の建物の南の外も歩道）
    sp1.poly = biggest(
      polygonClipping.union(
        polygonClipping.intersection([ring(sp1.poly)], [ring(fromUV([[-1000, -1000], [216, -1000], [216, 1000], [-1000, 1000]]))]),
        [ring(fromUV([[-80, 103.8], [8, 103.8], [8, 118.6], [-80, 118.6]]))],
        [ring(fromUV([[190, 118], [236, 118], [236, 126], [190, 126]]))],
        [ring(fromUV([[213, 106.3], [236, 106.3], [236, 123.3], [213, 123.3]]))],
        [ring(fromUV([[219, 12.4], [236, 12.4], [236, 106.3], [219, 106.3]]))],
      ),
    );
  }
}
// 西3・西4 の外の 4F の通路（トラックが上がってくる搬入の通路。屋外）：航空写真で、西3 の北東の壁の外（v -97.5 まで、
// u 53 から）と、西4 の南東の壁の外（u 214 まで）に、車の止まった通路がある。南東の通路は南展示棟への通路（4F）につながる
areas.push({ name: "外の通路（4F）", level: 4, poly: fromUV([[53, -97.5], [214, -97.5], [214, 16], [202, 16], [202, -70.7], [149.8, -70.7], [149.8, -78.4], [53, -78.4]]) });
// 車のスロープ：航空写真・斜めからの写真で、北東の 4F の通路の外（v -116〜-104）を、南東の端（u 196〜214。通路の南東の角と
// つながる。写真ではここが高く、通路と同じ高さ）から北西へ（u 54 で地面）下りる幅 12m の坂。
// 南東の端の、通路とのつなぎの床（u 196〜214・v -116〜-97.5）も 4F の屋外
areas.push({ name: "外の通路（4F）", level: 4, poly: fromUV([[196, -116], [214, -116], [214, -97.5], [196, -97.5]]), part: true });

// 南展示棟の 2F：南1 の西の端と建物の西の壁（u 236）のあいだの帯（u 236〜254.9）。公式フロアマップの 2F 図では、コンコースの
// 南1 の側の端から、エレベーター・トイレ・AED・案内所のある白い床が南1 の西の端にそってのびている（館内の案内では「南1・2ホール入口」が 2F）。
// 1F のこの帯はトイレなどの部屋で、2F はその上の床。コンコース（v 106.3）までつなぐ。角の 45° の建物の所は引く
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const band = polygonClipping.difference([ring(fromUV([[236, 34.4], [254.9, 34.4], [254.9, 106.6], [236, 106.6]]))], [ring(southEntrance)]);
  for (const pg of band) areas.push({ name: "南1・2ホール入口（2F）", level: 2, poly: pg[0].slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ) });
}

// 屋外（屋根のない所）：公式フロアマップで灰色に塗られた所。ほかは屋内（白）
for (const a of areas) if (["屋上展示場", "エントランスプラザ", "イベントプラザ", "中央ターミナル", "南展示棟への通路", "南展示棟への通路（4F）", "外の通路（4F）"].includes(a.name)) a.outdoor = true;

// 階段（階のちがう2つの所をつなぐ）。屋上展示場（4F）からエントランスプラザ（2F）へ：OpenStreetMap の階段（way 381682023、
// layer=2）。屋上展示場の西の角から北西へ、エントランスプラザへ下りる。航空写真でも、ここに屋根のある幅 7m ほどの階段が見える
type Stair = { name: string; from: XZ; fromLevel: number; to: XZ; toLevel: number; width: number; kind?: "escalator" | "ramp"; outdoor?: boolean; sur?: boolean };
const stairs: Stair[] = [];
// 位置は航空写真と斜めからの写真に合わせる：階段の上の端は、45° に傾いた四角い踊り場（中心 u 59.5・v 82.5、角から角まで 15m）。
// 踊り場は半分ほど屋上展示場の西の縁（u 61.5）にくいこむ（写真：屋上の縁の角に踊り場がはまっている）。
// 階段は踊り場の南西の辺いっぱいの幅（9.5m）で、辺に直角に、45° の向きでエントランスプラザ（v 60 の縁）まで下りる
{
  const c: XZ = [59.5, 82.5], h = 7.5;
  const landing = fromUV([[c[0], c[1] - h], [c[0] + h, c[1]], [c[0], c[1] + h], [c[0] - h, c[1]]]);
  areas.push({ name: "屋上展示場", level: 4, poly: landing, part: true, outdoor: true });
  const d: XZ = [Math.SQRT1_2, Math.SQRT1_2];
  const mid: XZ = [c[0] - h / 2, c[1] - h / 2]; // 踊り場の南西の辺のまん中
  const [top, bottom] = fromUV([[mid[0] + d[0] * 0.5, mid[1] + d[1] * 0.5], [mid[0] + d[0] * (0.5 - 32), mid[1] + d[1] * (0.5 - 32)]]);
  stairs.push({ name: "階段", from: top, fromLevel: 4, to: bottom, toLevel: 2, width: 9.5, outdoor: true });
}

// やぐら橋：エントランスプラザ（2F）から北西へ、豊洲有明線の上と、ゆりかもめの高架の下を通る歩道橋（OSM way 541645572、layer=2）と、
// その先の大階段（会議棟の逆ピラミッドの前の階段）。航空写真（Google・Esri）と Street View から：
// ・橋はプラザと同じ高さのまま平ら（縞模様は床のタイル。Street View で、プラザの端から高架の下まで平ら）。高架の西で u -214 まで
// ・そこから地上へ、幅いっぱい（v -2〜24）の階段（OSM の階段 way 438228292 も u -239〜-208）。下の端は u -245
// ・下は地上の平らな所（OSM の「イーストプロムナード」）。両側の白い屋根の端が U の字につながる所（u -276）まで
// ・白い屋根：南の側は橋の全長（プラザの端から）、北の側は高架から西。U の字の端から、屋根のある歩道が西へ続く（りんかい線の駅の方へ。PLATEAU）
// エントランスプラザの OSM の形が、橋の根元（u -168 まで）を含んでいるので、その先から。
// 会場の外なので、橋・階段・地上の床・屋根は「周辺も表示」のときだけ出す（sur。ユーザーの指示）
const canopies: { level: number; pts: XZ[]; ys: number[]; w: number }[] = [];
{
  const D = FLOOR_Y[2], R = 3.3; // 屋根の下の高さ（床から）
  areas.push({ name: "やぐら橋", level: 2, poly: fromUV([[-168.3, -2], [-214, -2], [-214, 24], [-168.3, 24]]), outdoor: true, sur: true });
  const [top, bottom] = fromUV([[-214, 11], [-245, 11]]);
  stairs.push({ name: "階段", from: top, fromLevel: 2, to: bottom, toLevel: 1, width: 26, outdoor: true, sur: true });
  areas.push({ name: "イーストプロムナード", level: 1, poly: fromUV([[-245, -2], [-276, -2], [-276, 24], [-245, 24]]), outdoor: true, sur: true });
  // 屋根（中心の線・屋根の下の高さ・幅）。航空写真で測った帯：南 v 19〜24、北 v -2〜3、U の字の端 u -276〜-270
  const side = (v: number, u0: number) => ({ pts: fromUV([[u0, v], [-214, v], [-245, v], [-273, v]]), ys: [D + R, D + R, R, R] });
  canopies.push({ level: 2, w: 5, ...side(21.5, -124) });
  canopies.push({ level: 2, w: 5, ...side(0.5, -192) });
  canopies.push({ level: 1, w: 6, pts: fromUV([[-273, -7.5], [-273, 24]]), ys: [R, R] });
  // U の字の端から西（りんかい線の駅の方）へ続く屋根のある歩道は、PLATEAU の形と計測高さで描く（周辺の建物の kind "canopy"）
}

// 西の 4F の通路から 1F への車のスロープ（上の「外の通路（4F）」のところの説明）
{
  const [top, bottom] = fromUV([[196.5, -110], [54, -110]]);
  stairs.push({ name: "スロープ", kind: "ramp", from: top, fromLevel: 4, to: bottom, toLevel: 1, width: 12, outdoor: true });
}
// 南のスロープ：南3・南4 の北の 4F の外の通路（トラックヤード）の東の端から、立体駐車場の東の側にそって南へ地上まで下りる車のスロープ
// （ユーザーの指摘と斜めからの写真。航空写真で、駐車場の建物（u 429 まで）と白い手すりの壁（u 442）のあいだの幅 9m の帯が、
// v 30 ほどから v 105 ほどまで続き、その先は地上の車路）
{
  const [top, bottom] = fromUV([[437.5, 31], [437.5, 106]]);
  stairs.push({ name: "スロープ", kind: "ramp", from: top, fromLevel: 4, to: bottom, toLevel: 1, width: 9, outdoor: true });
}

// エスカレーター（ビッグサイトの館内図・図面にあるもの。位置と長さは目安）
{
  const r = (v: number) => Math.round(v * 10) / 10;
  const areaOf = (n: string) => areas.find((a) => a.name === n)!.poly;
  // 西・南のエスカレーター：公式フロアマップの、階どうしを点線でつないだエスカレーターの印から。
  // 印の位置は、その階のホールの四すみで公式の図を会場の座標に合わせて写したもの（誤差は 1〜9m）。
  // 向き：公式の図には向きがないので、西の 1F⇔4F はストリートビューで見た向き（南南西へ上がる）、ほかは近くの通路の向き
  {
    // エスカレーターの長さ（平面）：高さの 0.8 倍（50° ほど。実物より急だが、地図で上下の階のつながりが分かりやすいように）
    const run = (lo: number, hi: number) => (FLOOR_Y[hi] - FLOOR_Y[lo]) * ESC_RUN;
    const bearing = (deg: number): XZ => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];
    // 西 13：1F アトリウム ⇔ 4F アトリウム（屋内）。吹き抜け（天窓の下、u 78〜124・v -7〜39）の中を上がって、4F アトリウムの
    // 西4 にそう腕の縁（u 124）に、縁に直角につく（床に穴をあけて途中から出るのではない）。コミケの会場案内図の 4F 図でも、
    // 吹き抜けの西4 の側の角の近くに、u の向きに描かれている（v 33：吹き抜けの縁から 6m 内側）。
    // 傾きはほかのエスカレーターと同じ（ESC_RUN）。1F の端は吹き抜けの奥（西4 の側）に来る
    {
      const [top, bottom] = fromUV([[124.5, 33], [124.5 - run(1, 4), 33]]);
      stairs.push({ name: "エスカレーター", kind: "escalator", from: top, fromLevel: 4, to: bottom, toLevel: 1, width: 4 });
    }
    void bearing;
    // 西 10：2F 南コンコース ⇔ 1F アトリウム。南コンコースの帯（屋内）のアトリウムの側の端の辺（(85.5,18.5)〜(85,-0.5)）から、
    // 辺に直角に、1F アトリウムへ下りる（公式フロアマップ：白い南コンコースの端から 1F アトリウムへの点線）。目立つよう幅 4m
    {
      const [e0, e1] = [[85.5, 18.5], [85, -0.5]] as XZ[];
      const L = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]);
      const n: XZ = [(e1[1] - e0[1]) / L, -(e1[0] - e0[0]) / L].map((x) => -x) as XZ; // 外向き（アトリウムの側）
      const mid: XZ = [(e0[0] + e1[0]) / 2, (e0[1] + e1[1]) / 2];
      const [top, bottom] = fromUV([[mid[0] - n[0] * 0.5, mid[1] - n[1] * 0.5], [mid[0] + n[0] * (run(1, 2) - 0.5), mid[1] + n[1] * (run(1, 2) - 0.5)]]);
      stairs.push({ name: "エスカレーター", kind: "escalator", from: top, fromLevel: 2, to: bottom, toLevel: 1, width: 4 });
    }
    // 西 17：4F ⇔ 2F 南コンコース。上の端は 4F アトリウムの西3 にそう腕の西の端の辺（u 56.6。西3 の入口の角、AED の横）。
    // そこから辺に直角に（u の向きに）、下の 2F 南コンコースの帯へ下りる（v -27。西3 の壁 v -28.5 にそう）。目立つよう幅 3m
    {
      const [top, bottom] = fromUV([[57.1, -27], [57.1 - run(2, 4), -27]]);
      stairs.push({ name: "エスカレーター", kind: "escalator", from: top, fromLevel: 4, to: bottom, toLevel: 2, width: 3 });
    }
    // 南：11・12・18（4F ⇔ 2F）、19・20・21（2F ⇔ 1F）。公式フロアマップの印を、コンコース（u の向き）の上に寄せた所（u）と向き。
    // 公式の図では、どれも通路のふちから張り出した小さな踊り場から上り下りする：
    // 2F ⇔ 1F は、コンコースのホールの側のふち（v 104.9）から張り出した踊り場から、南1・南2 の壁ぎわ（v 102.6）を 1F へ下りる。
    // 4F ⇔ 2F は、4F の床のふち（v 111.5）から張り出した踊り場から、コンコースの外の側（v 113.2）を 2F へ下りる
    {
      const S_EDGE_4F = 111.5, S_EDGE_2F = 104.9;
      for (const [u, sgn, lo, hi] of [[285.5, 1, 2, 4], [358.7, 1, 2, 4], [244.3, -1, 2, 4], [221.2, 1, 1, 2], [356.3, 1, 1, 2], [283.4, 1, 1, 2]] as [number, number, number, number][]) {
        const w = 2, v = hi === 4 ? 113.2 : 102.6;
        const [top, bottom] = fromUV([[u, v], [u + sgn * run(lo, hi), v]]);
        stairs.push({ name: "エスカレーター", kind: "escalator", from: top, fromLevel: hi, to: bottom, toLevel: lo, width: w });
        // 踊り場：上の端の後ろ 4m から前 1m まで。ふちから段の外の側 1.5m まで
        const [ua, ub] = [u - sgn * 4, u + sgn * 1].sort((a, b) => a - b);
        // （コンコースのふちは、OSM の線のとおり少し斜め（v 104.9〜107.1）なので、2F の踊り場はコンコースの中まで重ねる）
        const [va, vb] = hi === 4 ? [S_EDGE_4F - 0.5, v + w / 2 + 1.5] : [v - w / 2 - 1.5, S_EDGE_2F + 3];
        areas.push({ name: hi === 4 ? "南展示棟（4F）" : "コンコース", level: hi, poly: fromUV([[ua, va], [ub, va], [ub, vb], [ua, vb]]), part: true });
      }
      // 4F の南展示棟の床は、ホールの外の部屋の帯（トイレ。v 111 まで）のふちまで。その外（コンコースの上）は空
      const s4 = areas.find((a) => a.name === "南展示棟（4F）" && !a.part)!;
      const cut = polygonClipping.intersection([[...s4.poly, s4.poly[0]].map(([x, z]) => [x, z] as [number, number])], [[...fromUV([[-1000, -1000], [1000, -1000], [1000, S_EDGE_4F], [-1000, S_EDGE_4F]]), fromUV([[-1000, -1000]])[0]].map(([x, z]) => [x, z] as [number, number])]);
      s4.poly = cut[0][0].slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
    }
  }
  // 東ガレリアから東展示棟 2F の通路へ：図面の「ES」の所（図面から読めたものだけ）に、ガレリアの長い向きに 12m
  {
    const g = areaOf("東ガレリア");
    const gi = g.map((p, i) => [p, g[(i + 1) % g.length]] as [XZ, XZ]).sort((x, y) => Math.hypot(y[1][0] - y[0][0], y[1][1] - y[0][1]) - Math.hypot(x[1][0] - x[0][0], x[1][1] - x[0][1]))[0];
    const GL = Math.hypot(gi[1][0] - gi[0][0], gi[1][1] - gi[0][1]);
    let ux = (gi[1][0] - gi[0][0]) / GL, uz = (gi[1][1] - gi[0][1]) / GL;
    // 上る向き：東1〜3 の図面では、ES の「UP」の矢印は図面の右向き。図面の下が東4〜6 の側（ガレリア）なので、
    // 図面の右 = 「東1 から東5 への向き」を時計回りに 90° 回した向き（scripts/extract-plan-toilets.py の向きの決め方と同じ）
    {
      const [ax, az] = centroid(halls.find((h) => h.id === "E1")!.poly), [bx, bz] = centroid(halls.find((h) => h.id === "E5")!.poly);
      const dl = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / dl, dz = (bz - az) / dl;
      const rx = dz, rz = -dx;
      if (ux * rx + uz * rz < 0) [ux, uz] = [-ux, -uz];
    }
    const planDoors = existsSync("data/plan-toilets.json") ? ((JSON.parse(readFileSync("data/plan-toilets.json", "utf8")) as { doors?: { at: XZ; kind: string; hall: string }[] }).doors ?? []) : [];
    const es = planDoors.filter((d) => d.kind === "ES" && /^E[123]$/.test(d.hall)).map((d) => ({ hall: d.hall, at: d.at }));
    // 吹き抜けの中の階段とエスカレーター（施設案内の 2F全体図で、吹き抜けの端に描かれた段から読んだもの。scripts/extract-plan-toilets.py）。
    // ストリートビューでも、吹き抜けの下で、エスカレーターと幅の広い階段が並んで 2F へ上がっている
    const vs = existsSync("data/plan-toilets.json") ? ((JSON.parse(readFileSync("data/plan-toilets.json", "utf8")) as { voidStairs?: { kind: string; from: XZ; to: XZ; width: number }[] }).voidStairs ?? []) : [];
    // 公式フロアマップ（bigsight_map_color_j.pdf）の点線でつながったエスカレーターは東ガレリアに 7 本。その 1F の端の位置
    // （ホールの四すみで合わせて会場の座標に写したもの）にいちばん近い吹き抜けのエスカレーターだけ残す。階段は全部残す
    const OFFICIAL_EAST: XZ[] = [[223.2, -122.5], [260.7, -147], [222.4, -147.4], [287.3, -191.2], [336.1, -198], [362.3, -240.2], [411.4, -248]];
    const escs = vs.filter((v) => v.kind === "escalator");
    // 印 1 つに、まだ選んでいないいちばん近いエスカレーターを 1 本ずつ
    const keep = new Set<(typeof escs)[number]>();
    for (const o of OFFICIAL_EAST) {
      const m = (x: (typeof escs)[number]): number => Math.hypot((x.from[0] + x.to[0]) / 2 - o[0], (x.from[1] + x.to[1]) / 2 - o[1]);
      const best = escs.filter((e) => !keep.has(e)).sort((x, y) => m(x) - m(y))[0];
      if (best) keep.add(best);
    }
    for (const v0 of vs.filter((x) => x.kind !== "escalator" || keep.has(x)))
    {
      // 東4〜6 の側の吹き抜けの中のものは、吹き抜けと同じだけ東4〜6 の側へ
      const sh = (p: XZ): XZ => {
        const [u, w] = toUV(p);
        return fromUV([[u - E456_SHIFT, w]])[0];
      };
      const v = toUV(v0.from)[0] < -3 ? { ...v0, from: sh(v0.from), to: sh(v0.to) } : v0;
      // 上の端（2F）はそのまま、長さを 2F の高さに合わせる（30° ほど）
      // 長さ：エスカレーターはほかと同じ傾き（高さの ESC_RUN 倍）、階段は 30° ほど（高さの 1.8 倍）
      const L0 = Math.hypot(v.to[0] - v.from[0], v.to[1] - v.from[1]) || 1, L = (FLOOR_Y[2] - FLOOR_Y[1]) * (v.kind === "escalator" ? ESC_RUN : 1.8);
      const ux = (v.to[0] - v.from[0]) / L0, uz = (v.to[1] - v.from[1]) / L0;
      // 上の端が 2F の床に、下の端が 1F の床に乗るよう、向きに沿っていちばん少なく（15m まで）ずらす
      // 床の端ぎりぎりに沿うもの（東1 の端の吹き抜け）は、横にも 4m まで内へ寄せる
      const at = (k: number, w: number, t: number): XZ => [v.from[0] + ux * (k + t) - uz * w, v.from[1] + uz * (k + t) + ux * w];
      // 段の両わき（幅の半分 + 0.3m）まで、上の端は 2F・下の端は 1F の床の中に入ること
      const hw = v.width / 2 + 0.3;
      const fits = (k: number, w: number): boolean => [w - hw, w, w + hw].every((x) => onFloor(at(k, x, 0), 2) && onFloor(at(k, x, L), 1));
      let shift = 0, side = 0;
      search: for (let w = 0; w <= 4; w += 0.5)
        for (const ws of w ? [w, -w] : [0])
          for (let d = 0; d <= 15; d += 0.5)
            for (const k of d ? [-d, d] : [0])
              if (fits(k, ws)) {
                [shift, side] = [k, ws];
                break search;
              }
      const f = at(shift, side, 0);
      const from: XZ = [r(f[0]), r(f[1])];
      const to: XZ = [r(from[0] + ux * L), r(from[1] + uz * L)];
      // 幅：ユーザーの確認で太く（エスカレーター 3m、階段は図面の 1.5 倍）
      stairs.push({ name: v.kind === "escalator" ? "エスカレーター" : "階段", ...(v.kind === "escalator" ? { kind: "escalator" as const } : {}), from, fromLevel: 2, to, toLevel: 1, width: v.kind === "escalator" ? 3 : Math.round(v.width * 15) / 10 });
    }
    void es;
    void ux;
    void uz;
  }
}

// 階段・エスカレーターの上にかかる床に穴をあける：上の端の階の床は段の下の端から上の端の 1m 手前まで、途中の階の床は段がその 6m 下に来る所から上まで。
// 穴は段のまわりに 2.5m ずつ広い四角（実物の吹き抜けは段よりずっと大きい）。床の形から四角を引き算するので、
// 床のふちにかかる穴は「切り欠き」に、もとの吹き抜けと重なる穴は吹き抜けとひとつになる。
// 引き算で床が切れて分かれてしまうときは、穴のまわりの余白を 1m・0.3m とせまくしてみて、それでも分かれるなら、かけらも床として残す
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const unring = (r: [number, number][]): XZ[] => {
    const out: XZ[] = [];
    for (const [x, z] of r.slice(0, -1)) {
      const q: XZ = [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
      if (!out.length || out[out.length - 1][0] !== q[0] || out[out.length - 1][1] !== q[1]) out.push(q);
    }
    if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    return out;
  };
  const areaOfRing = (r: XZ[]) => Math.abs(r.reduce((s2, p, i) => s2 + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
  for (const st of stairs) {
    const len = Math.hypot(st.from[0] - st.to[0], st.from[1] - st.to[1]);
    if (len < 1) continue;
    const ux = (st.from[0] - st.to[0]) / len, uz = (st.from[1] - st.to[1]) / len, nx = -uz, nz = ux;
    const y0 = FLOOR_Y[st.toLevel], y1 = FLOOR_Y[st.fromLevel];
    for (const a of [...areas]) {
      if (!(a.level > st.toLevel && a.level <= st.fromLevel)) continue;
      const fy = FLOOR_Y[a.level];
      // 上の端の階の床は、段の下の端から（段がその床の下にもぐって、途中で切れて見えないように）。
      // 途中の階の床は、段がその床の 6m 下に来る所から
      const t0 = a.level === st.fromLevel ? -2 / len : Math.max(-2 / len, Math.min(1, (fy - 6 - y0) / (y1 - y0)) - 2 / len);
      const t1 = a.level === st.fromLevel ? Math.max(t0, 1 - 1 / len) : Math.min(1, (fy - y0) / (y1 - y0) + 0.5 / len);
      if (t1 - t0 < 0.02) continue;
      const rect = (hw: number): XZ[] => {
        const p0: XZ = [st.to[0] + ux * len * t0, st.to[1] + uz * len * t0], p1: XZ = [st.to[0] + ux * len * t1, st.to[1] + uz * len * t1];
        return [[p0[0] + nx * hw, p0[1] + nz * hw], [p1[0] + nx * hw, p1[1] + nz * hw], [p1[0] - nx * hw, p1[1] - nz * hw], [p0[0] - nx * hw, p0[1] - nz * hw]];
      };
      const floor: [number, number][][] = [ring(a.poly), ...(a.holes ?? []).map(ring)];
      if (!polygonClipping.intersection(floor, [ring(rect(st.width / 2))]).length) continue; // 段の上にこの床はない
      let res: ReturnType<typeof polygonClipping.difference> = [];
      for (const margin of a.level === st.fromLevel ? [0.5, 0.3] : [2.5, 1, 0.3]) {
        res = polygonClipping.difference(floor, [ring(rect(st.width / 2 + margin))]);
        if (res.length <= 1) break;
      }
      const pieces = res
        .map((pg) => ({ poly: unring(pg[0]), holes: pg.slice(1).map(unring).filter((h) => h.length >= 3) }))
        .filter((pg) => pg.poly.length >= 3)
        .sort((p, q) => areaOfRing(q.poly) - areaOfRing(p.poly));
      if (!pieces.length) continue;
      a.poly = pieces[0].poly;
      a.holes = pieces[0].holes.length ? pieces[0].holes : undefined;
      for (const pc of pieces.slice(1)) if (areaOfRing(pc.poly) > 4) areas.push({ ...a, poly: pc.poly, holes: pc.holes.length ? pc.holes : undefined, part: true });
    }
  }
}

// まわりの建物（位置の手がかり。足元の形だけ）
const context = osm.elements
  .filter((e) => e.geometry && e.tags?.building && !e.tags?.indoor && !/ホール|展示/.test(e.tags?.name ?? ""))
  .map((e) => ({ name: e.tags?.name ?? "", height: Number(e.tags?.height) || 10, poly: poly(e) }))
  .filter((b) => b.poly.length >= 3);

// 「周辺も表示」で立体にする建物（OSM の height・min_height・building:levels から）。
// 会議棟の逆ピラミッドは、OSM に段ごとの部品（Conference Tower Inverted Pyramid L2〜L8）があるので、積むとそれらしい形になる。
// 展示ホールの建物（東・東新・西・南の展示棟と、その中の部品）は、中のホールが見えなくなるので立体にしない
const hallBuildings = ["東展示棟", "東新展示棟", "西展示棟", "南展示場"].map((n) => poly(byName(n)));
const inHallBuilding = (p: XZ[]) => {
  const c = centroid(p);
  return hallBuildings.some((b) => pointInPolygon(c, b));
};
const parts3d = osm.elements
  .filter((e) => e.geometry && (e.tags?.building || e.tags?.["building:part"]) && !e.tags?.indoor && !/ホール|展示|West Hall/.test(e.tags?.name ?? ""))
  .map((e) => {
    const t = e.tags!;
    const levels = Number(t["building:levels"]) || 0;
    const max = Number(t.height) || (levels ? levels * 4 : 10);
    const min = Number(t.min_height) || (Number(t["building:min_level"]) || 0) * 4;
    // 会議棟（柱と逆ピラミッド）は 1.4 倍の高さに：地図の階の高さは見やすいよう実物より高く（2F 12m・4F 24m）してあるので、
    // 実物の高さのままだと逆ピラミッドの下の端（25m）が 4F の床のすぐ上に来て低く見える（ユーザーの確認）
    const k = /Conference Tower|会議棟/.test(t.name ?? "") ? 1.4 : 1;
    return { poly: poly(e), min: Math.round(min * k * 10) / 10, max: Math.round(max * k * 10) / 10, color: t["building:colour"] ?? null, name: t.name ?? "", part: !!t["building:part"] };
  })
  .filter((b) => b.poly.length >= 3 && b.max > b.min && !inHallBuilding(b.poly))
  // 部品（building:part）がある建物は、部品だけを立てる（外形と部品が重ならないように）
  .filter((b, _, all) => b.part || !all.some((x) => x.part && pointInPolygon(centroid(x.poly), b.poly)));

// トイレ（OSM にあるものだけ。実際よりずっと少ない）
// トイレ・救護室：図面（白図）から読んだもの（data/plan-toilets.json、scripts/extract-plan-toilets.py が作る）を優先し、
// 図面を読めていない所は OSM のトイレで補う（図面のトイレから 15m 以内の OSM のトイレは同じものとみなす）
type Toilet = { at: XZ; level: number | null; kinds?: string[]; src: string };
const plan = existsSync("data/plan-toilets.json")
  ? (JSON.parse(readFileSync("data/plan-toilets.json", "utf8")) as {
      toilets: { at: XZ; level: number; kinds: string[] }[];
      firstAid: { at: XZ; level: number }[];
      doors?: { at: XZ; level: number; kind: "出入口" | "搬入口" | "ES"; hall: string }[];
    })
  : { toilets: [], firstAid: [], doors: [] };
const osmToilets: Toilet[] = osm.elements
  .filter((e) => e.tags?.amenity === "toilets")
  .map((e) => {
    const p = e.geometry ? e.geometry : [{ lat: e.lat!, lon: e.lon! }];
    const c = p.reduce((a, g) => ({ lat: a.lat + g.lat / p.length, lon: a.lon + g.lon / p.length }), { lat: 0, lon: 0 });
    return { at: project(ORIGIN, c.lat, c.lon), level: e.tags?.level ? Number(e.tags.level) : null, src: `osm:${e.type}/${e.id}` };
  });
// 図面の「WC」「出入口」の文字は、その場所から少し（数m〜十数m）離れて書かれている。そのままだと通路（ガレリアなど）の
// 真ん中に札が出るので、そのホールの壁に寄せる：出入口・搬入口は壁の線の上、トイレは壁の 1.5m 内側。
// 工事中のホール（東4〜6）のものは使えないので出さない
const hallOf = new Map(halls.map((h) => [h.id, h]));
// となりのホールと分け合う辺（東1〜3 の境など）。ここは壁がないので、出入口やトイレを寄せない
function sharedEdge(hid: string, a: XZ, b: XZ): boolean {
  const h = hallOf.get(hid)!;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
  const mid: XZ = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return halls.some((o) => o.id !== hid && o.level === h.level && o.poly.some((p, j) => {
    const q = o.poly[(j + 1) % o.poly.length];
    const OL = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, ox = (q[0] - p[0]) / OL, oz = (q[1] - p[1]) / OL;
    if (Math.abs(ux * oz - uz * ox) > 0.1) return false;
    const v = Math.abs(-(mid[0] - p[0]) * oz + (mid[1] - p[1]) * ox), t = ((mid[0] - p[0]) * ox + (mid[1] - p[1]) * oz) / OL;
    return v < 3 && t > 0 && t < 1;
  }));
}
function toWall(hid: string, p: XZ, inset: number): XZ {
  const poly = hallOf.get(hid)!.poly;
  let best: [number, XZ, XZ] = [Infinity, p, [0, 0]];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    if (sharedEdge(hid, a, b)) return;
    const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1, L = Math.sqrt(L2);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
    const q: XZ = [a[0] + t * dx, a[1] + t * dz];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best[0]) best = [d, q, [-dz / L, dx / L]];
  });
  const [, q, n0] = best;
  // 内側を向く法線
  const n: XZ = pointInPolygon([q[0] + n0[0] * 0.1, q[1] + n0[1] * 0.1], poly) ? n0 : [-n0[0], -n0[1]];
  return [Math.round((q[0] + n[0] * inset) * 10) / 10, Math.round((q[1] + n[1] * inset) * 10) / 10];
}
const usable = (hid: string | undefined) => !hid || (hallOf.has(hid) && !hallOf.get(hid)!.closed);
// 東1〜3 の図面には、ガレリアの向こう側（東4〜6 の部屋の帯。工事中で使わない）と、となりのホールの端のトイレも描かれている。
// それらは除く（となりのホールのものは、そのホールの図面から読んだものがある）
const eastRow = (t: { at: XZ; hall?: string }) => {
  if (!["E1", "E2", "E3"].includes(t.hall ?? "")) return true;
  const [u, v] = toUV(t.at);
  if (u < 0) return false;
  const probe = fromUV([[60, v]])[0];
  return !["E1", "E2", "E3"].some((id) => id !== t.hall && pointInPolygon(probe, halls.find((h) => h.id === id)!.poly));
};
// 東2 の図面から読んだものは、ガレリアの側へ 5.5m ずれている（下のトイレの囲みと同じ。そこで説明）
const planToilets = (plan.toilets as { at: XZ; level: number; kinds: string[]; hall?: string }[])
  .filter((t) => usable(t.hall) && eastRow(t))
  .map((t) => (t.hall === "E2" ? { ...t, at: fromUV([[toUV(t.at)[0] + 5.5, toUV(t.at)[1]]])[0] } : t));
const toilets: Toilet[] = [
  // トイレはホールの外（壁の外の部屋）にある。図面の文字の位置をそのまま使う。ただし壁から 15m より離れたもの
  // （文字がガレリアの真ん中などに書かれているもの）は、そのホールの壁の 3m 外に寄せる。ホールの中へは寄せない
  ...planToilets.map((t) => {
    if (!t.hall) return { at: t.at, level: t.level, kinds: t.kinds, src: "plan" };
    const w = toWall(t.hall, t.at, 0);
    const far = Math.hypot(w[0] - t.at[0], w[1] - t.at[1]) > 15;
    return { at: far ? toWall(t.hall, t.at, -3) : t.at, level: t.level, kinds: t.kinds, src: "plan" };
  }),
  ...osmToilets.filter((o) => !plan.toilets.some((t) => Math.hypot(t.at[0] - o.at[0], t.at[1] - o.at[1]) < 15)),
];
// トイレの部屋の囲み（図面の壁から読んだ四角。scripts/extract-plan-toilets.py）。工事中のホールのものは出さない
// ホールの壁から 15m より離れたもの（トイレの札を壁の外へ寄せたもの）は、位置が合わないので出さない
const toiletRooms = ((plan as { toiletRooms?: { hall: string; level: number; poly: XZ[] }[] }).toiletRooms ?? []).filter((r) => {
  if (!usable(r.hall)) return false;
  const c = centroid(r.poly), w = toWall(r.hall, c, 0);
  return Math.hypot(w[0] - c[0], w[1] - c[1]) <= 15;
});
// 東2 の図面から読んだトイレの囲みは、ガレリアの側へ 5.5m ずれている（図面のホールの溝が東1 より小さく、溝の中心で合わせたため。
// 図面の出入口の文字は、どのホールでも帯のホールの側の壁から 7.3m。東2 だけ図面から読んだ会場データでは 12.9m）。帯の中へ戻す
for (const r of toiletRooms) if (r.hall === "E2") r.poly = fromUV(r.poly.map((p) => [toUV(p)[0] + 5.5, toUV(p)[1]] as XZ));
// ホールの外壁：会場データのホールの形（OSM）は展示場の床だけで、トイレ・事務室などの部屋の帯はその外に出ている。
// コミケの配置図でもビッグサイトの図面でも、トイレは外壁の内側にあるので、トイレ（図面の位置・部屋の囲み）がはみ出している辺を、
// トイレを囲むところまで外へずらす（20m まで。ほかのホールと分け合う辺は動かさない）。展示場の床の形は inner に残す
// アトリウムや通路など、ほかの床の上にあるトイレは、そこにあるものなので数えない（床のない所にはみ出しているものだけ）
for (const h of halls) {
  if (h.closed) continue;
  const onArea = (p: XZ) => areas.some((a) => a.level === h.level && a.name !== "ホール前" && pointInPolygon(p, a.poly));
  const pts: XZ[] = [
    ...planToilets.filter((t) => t.hall === h.id && !onArea(t.at)).map((t) => t.at),
    ...toiletRooms.filter((r) => r.hall === h.id && !onArea(centroid(r.poly))).flatMap((r) => r.poly),
  ].filter((p) => !pointInPolygon(p, h.poly));
  if (!pts.length) continue;
  const poly0 = h.poly.map((q) => [...q] as XZ);
  // 外へずらす辺：辺の番号 → 外向きの向きと、ずらす長さ
  const pushed = new Map<number, { nx: number; nz: number; k: number }>();
  poly0.forEach((a, i) => {
    const b = poly0[(i + 1) % poly0.length];
    if (sharedEdge(h.id, a, b)) return;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1) return;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let nx = -uz, nz = ux;
    const m: XZ = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (pointInPolygon([m[0] + nx * 0.1, m[1] + nz * 0.1], poly0)) [nx, nz] = [-nx, -nz]; // 外向き
    let far = 0;
    for (const p of pts) {
      const t = (p[0] - a[0]) * ux + (p[1] - a[1]) * uz, d = (p[0] - a[0]) * nx + (p[1] - a[1]) * nz;
      if (t >= -1 && t <= L + 1 && d > 0 && d <= 20) far = Math.max(far, d);
    }
    if (far <= 0) return;
    const k = far + 1.5;
    // 広げた所の 3 割より多くが、同じ階のほかの床（アトリウムなど）に重なるなら、その辺は動かさない（トイレはその床の側にある）
    const swept: [number, number][] = [a, b, [b[0] + nx * k, b[1] + nz * k], [a[0] + nx * k, a[1] + nz * k], a].map(([x, z]) => [x, z]);
    const sz = (mp: [number, number][][][]) =>
      mp.reduce((s2, pg) => s2 + Math.abs(pg[0].reduce((t, q, j2) => (j2 + 1 < pg[0].length ? t + q[0] * pg[0][j2 + 1][1] - pg[0][j2 + 1][0] * q[1] : t), 0) / 2), 0);
    const others = areas.filter((o) => o.level === h.level && !o.under && o.name !== "ホール前");
    const hit = others.reduce((s2, o) => s2 + sz(polygonClipping.intersection([swept], [[...o.poly, o.poly[0]].map(([x, z]) => [x, z] as [number, number])])), 0);
    if (hit > 0.3 * L * k) return;
    pushed.set(i, { nx, nz, k });
  });
  if (!pushed.size) continue;
  // 新しい形 = もとの形 ＋ ずらした辺の帯の四角（＋ となり合う 2 辺をともにずらした角の四角）。
  // ずらさない辺とのあいだは、斜めにならず、壁に直角な段になる
  const pr = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const parts: [number, number][][][] = [];
  for (const [i, e] of pushed) {
    const a = poly0[i], b = poly0[(i + 1) % poly0.length];
    parts.push([pr([a, b, [b[0] + e.nx * e.k, b[1] + e.nz * e.k], [a[0] + e.nx * e.k, a[1] + e.nz * e.k]])]);
    const prev = pushed.get((i - 1 + poly0.length) % poly0.length);
    if (prev) parts.push([pr([a, [a[0] + prev.nx * prev.k, a[1] + prev.nz * prev.k], [a[0] + prev.nx * prev.k + e.nx * e.k, a[1] + prev.nz * prev.k + e.nz * e.k], [a[0] + e.nx * e.k, a[1] + e.nz * e.k]])]);
  }
  const merged = polygonClipping.union([pr(poly0)], ...parts);
  const outer = merged.map((pg) => pg[0]).sort((x, y) => Math.abs(y.reduce((t, q, j2) => (j2 + 1 < y.length ? t + q[0] * y[j2 + 1][1] - y[j2 + 1][0] * q[1] : t), 0)) - Math.abs(x.reduce((t, q, j2) => (j2 + 1 < x.length ? t + q[0] * x[j2 + 1][1] - x[j2 + 1][0] * q[1] : t), 0)))[0];
  h.inner = poly0;
  h.poly = outer.slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
}

// ホールの外の屋外の床：航空写真（Esri World Imagery を西展示棟の向き u・v に回して測ったもの）で、トラックや車の止まっている
// 舗装の所。u・v の四角から、同じ階のホールとほかの床を引いたもの（ホールの壁をトイレを囲むために広げたあとで引く）。
// carve の床（南展示棟（4F）のような、建物の形をそのまま敷いた下じきの床）からは、この屋外の所を切りとる
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const unring = (r: [number, number][]): XZ[] => {
    const out: XZ[] = [];
    for (const [x, z] of r.slice(0, -1)) {
      const q: XZ = [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
      if (!out.length || out[out.length - 1][0] !== q[0] || out[out.length - 1][1] !== q[1]) out.push(q);
    }
    return out;
  };
  const size = (r: XZ[]) => Math.abs(r.reduce((s2, p, i) => s2 + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
  const outside = (name: string, level: number, rects: XZ[][], carve: string[] = [], add = true) => {
    let res = polygonClipping.union([ring(fromUV(rects[0]))], ...rects.slice(1).map((r) => [ring(fromUV(r))]));
    const others = [...halls.filter((h) => h.level === level).map((h) => h.poly), ...areas.filter((a) => a.level === level && !carve.includes(a.name)).map((a) => a.poly)];
    for (const o of others) res = polygonClipping.difference(res, [ring(o)]);
    for (const a of areas.filter((x) => x.level === level && carve.includes(x.name))) {
      const left = polygonClipping.difference([ring(a.poly), ...(a.holes ?? []).map(ring)], res);
      const big = left.map((pg) => ({ poly: unring(pg[0]), holes: pg.slice(1).map(unring) })).sort((p, q) => size(q.poly) - size(p.poly));
      if (big.length) {
        a.poly = big[0].poly;
        a.holes = big[0].holes.length ? big[0].holes : undefined;
      }
    }
    if (!add) return;
    for (const pg of res) {
      const poly = unring(pg[0]);
      if (poly.length >= 3 && size(poly) > 30) areas.push({ name, level, poly, holes: pg.length > 1 ? pg.slice(1).map(unring) : undefined, outdoor: true });
    }
  };
  // 東ガレリアの北の端と、東7・リンクスペース・東8 のあいだ（航空写真：屋根のある通路でつながっている）。屋内の床。
  // 南の端は v -529 まで（東ガレリアの北の端は v -534 ほどで、切れこみもある。v -538 からだと、すき間に地面が見えていた：ユーザーの指摘）。
  // ほかの床と重なる所は引くので、すき間だけが埋まる
  {
    let res = polygonClipping.union([ring(fromUV([[-33, -572], [18, -572], [18, -529], [-33, -529]]))]);
    for (const o of [...halls.filter((h) => h.level === 1).map((h) => h.poly), ...areas.filter((a) => a.level === 1).map((a) => a.poly)]) res = polygonClipping.difference(res, [ring(o)]);
    for (const pg of res) {
      const poly = unring(pg[0]);
      if (size(poly) > 10) areas.push({ name: "東ガレリア", level: 1, poly, part: true });
    }
  }
  // 東：東1〜3 の外（搬入口の側）と、東1 の端・東3 の端の広場。名前はコミケの会場案内図の「トラックヤード」。
  // 航空写真の舗装のふち（u 138・東1 の端 v -172・東3 の端 v -526）までの 1 つの形で、外の角は丸く（半径 14m）
  {
    const roundRect = (u0: number, v0: number, u1: number, v1: number, r: number, corners: boolean[]): XZ[] => {
      const out: XZ[] = [];
      const arc = (cu: number, cv: number, a0: number) => {
        for (let k = 0; k <= 6; k++) {
          const a = a0 + (k / 6) * (Math.PI / 2);
          out.push([cu + r * Math.cos(a), cv + r * Math.sin(a)]);
        }
      };
      // 左上（u0, v0）→ 右上（u1, v0）→ 右下（u1, v1）→ 左下（u0, v1）。corners は [右上, 右下] を丸めるか
      out.push([u0, v0]);
      if (corners[0]) arc(u1 - r, v0 + r, -Math.PI / 2);
      else out.push([u1, v0]);
      if (corners[1]) arc(u1 - r, v1 - r, 0);
      else out.push([u1, v1]);
      out.push([u0, v1]);
      return out;
    };
    outside("トラックヤード", 1, [roundRect(8, -528, 138, -172, 14, [true, true])]);
  }
  // 東7・東8 の北東の大きな駐車場（公式フロアマップの「東棟屋外臨時駐車場」。コミケでは一般参加者の待機列に使う所）。
  // 航空写真で測った形：北東は海ぞいの縁（(-255,-945) から (81,-741)、そこから (175,-560)）、南西は東7・東8 の斜めの辺の
  // 延長線（v = -701.5 + 0.624 (u + 140.3)）、北西は道の曲がり（(-150,-735)・(-300,-800)・(-300,-905)）
  outside("東棟屋外臨時駐車場", 1, [[[-255, -945], [81, -741], [175, -560], [180, -515], [180, -501.6], [-145, -704.6], [-150, -735], [-300, -800], [-300, -905]]]);
  // 東7 の西わきの道
  outside("外の通路（1F）", 1, [[[-168, -705], [-140, -705], [-140, -545], [-168, -545]]]);
  // 西：西1 の外（北東の 4F の通路の下と、南東の側）と、車のスロープの下の端（北西）の前（u 30〜60・v -118〜-98）
  outside("外の通路（1F）", 1, [
    [[56, -98], [222, -98], [222, -83], [56, -83]],
    [[202, -98], [222, -98], [222, 16], [202, 16]],
    [[30, -118], [60, -118], [60, -98], [30, -98]],
  ]);
  // 南棟立体駐車場：南2・南4 の東の端（航空写真で屋上に車が止まっている所。公式フロアマップ・コミケの会場案内図にも「立体駐車場」）。
  // 南展示棟の床（建物の形をそのまま敷いたもの）から切りとって、1F に駐車場として置く（会場の床ではない）
  // 駐車場の建物は u 429 まで（航空写真で屋上の車の止まる所の東のふち）。その東（u 429〜446）は、4F の外の通路（トラックヤード）から
  // 地上へ下りる車のスロープ（下の「南のスロープ」）と、その下の地面なので、南展示棟の床から切りとるだけ
  outside("南棟立体駐車場", 1, [[[401, 34.4], [429, 34.4], [429, 124], [401, 124]]], ["南展示棟"]);
  outside("南棟立体駐車場", 4, [[[401, 34.4], [429, 34.4], [429, 124], [401, 124]]], ["南展示棟（4F）"], false);
  outside("スロープの下", 1, [[[429, 34.4], [446, 34.4], [446, 124], [429, 124]]], ["南展示棟"], false);
  outside("スロープの下", 4, [[[429, 34.4], [446, 34.4], [446, 124], [429, 124]]], ["南展示棟（4F）"], false);
  // 南：南3・南4 の北の 4F の通路（図面の「トラックヤード」。西4 の外の通路から、南展示棟への通路（4F）を通って続く）。
  // 外のふちは v 19.2：航空写真で、建物の北のふち（v 31.7）から、トラックの止まる明るい帯の外のふちまで 12.5m。
  // 図面のトラックヤードの幅（建物の北の外壁から 11.5〜13.4m）と合う。トイレなどの部屋の帯（v 28〜34）の外に 9m の車路が残る
  outside("外の通路（4F）", 4, [[[214, 19.2], [444.6, 19.2], [444.6, 34.4], [214, 34.4]]], ["南展示棟（4F）"]);
}

// 床のない所（ホール・通路の床の外）にあるトイレ：近くに部屋の囲みがあれば札をその部屋の真ん中へ、なければ壁ぎわ（壁の 1m 外）へ。
// 会場から離れた OpenStreetMap のトイレ（会場の床から 15m より遠い）は「周辺」の扱いにして、「周辺も表示」のときだけ出す
{
  const floorsAt = (lv: number) => [...halls.filter((h) => h.level === lv && !h.closed).map((h) => h.poly), ...areas.filter((a) => a.level === lv && !a.sur).map((a) => a.poly)]; // やぐら橋など会場の外の床（sur）のそばのトイレは、会場の外のトイレ
  const gap = (p: XZ, lv: number) => {
    let best = Infinity;
    for (const f of floorsAt(lv)) {
      if (pointInPolygon(p, f)) return 0;
      f.forEach((a, i) => {
        const b = f[(i + 1) % f.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
        best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz));
      });
    }
    return best;
  };
  for (const t of toilets) {
    const lv = t.level ?? 1;
    const g = gap(t.at, lv);
    if (g <= 1) continue;
    if (t.src !== "plan") {
      if (g > 15) (t as Toilet & { outside?: boolean }).outside = true;
      continue;
    }
    const room = toiletRooms.find((r) => r.level === lv && (pointInPolygon(t.at, r.poly) || Math.hypot(centroid(r.poly)[0] - t.at[0], centroid(r.poly)[1] - t.at[1]) < 6));
    if (room) {
      const c = centroid(room.poly);
      t.at = [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10];
    } else {
      const hall = halls
        .filter((h) => h.level === lv && !h.closed)
        .map((h) => ({ h, d: Math.hypot(...(toWall(h.id, t.at, 0).map((v, i) => v - t.at[i]) as [number, number])) }))
        .sort((x, y) => x.d - y.d)[0];
      if (hall && hall.d < 20) t.at = toWall(hall.h.id, t.at, -1);
    }
  }
}
const firstAid = plan.firstAid.map((a) => ({ at: a.at, level: a.level }));
// 出入口・搬入口（シャッター）。図面から読んだもの
const doors = (plan.doors ?? []).filter((d) => d.kind !== "ES" && usable(d.hall)).map((d) => {
  // ホールの壁から 15m より離れた出入口（東1 の西の端の、地上からのエントランスなど）は、ホールの扉ではないので寄せない
  const w = toWall(d.hall, d.at, 0);
  return { at: Math.hypot(w[0] - d.at[0], w[1] - d.at[1]) > 15 ? d.at : w, level: d.level, kind: d.kind, hall: d.hall } as { at: XZ; level: number; kind: string; hall: string; width?: number };
});
// 東7・東8 とリンクスペースのあいだのシャッター開口（図面：東7 は W 6.0m・12.0m・12.0m、東8 は W 12.0m × 2。高さ 7.9m）。
// 当日はリンクスペースとひと続きに使うので、開けて出入口にする。位置は図面の、リンクスペースの道（ガレリア）の側の端から
// 開口のまん中までの長さ。会場データの東7 は図面より長い（OSM の形）ので、ホールの角からではなく、この端から測る
{
  const link = areas.find((a) => a.name === "リンクスペース")!.poly;
  const gal = areas.filter((a) => a.name === "東ガレリア").map((a) => a.poly);
  const nearGal = (p: XZ) => Math.min(...gal.flatMap((g) => g.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1]))));
  for (const [hid, list] of [["E7", [[8.8, 12], [22.3, 12], [34.7, 6]]], ["E8", [[10.8, 12], [23.2, 12]]]] as [string, [number, number][]][]) {
    const poly = halls.find((h) => h.id === hid)!.poly;
    // ホールの辺のうち、両端がリンクスペースの角にある辺
    const onLink = (p: XZ) => link.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.5);
    const i = poly.findIndex((p, k) => onLink(p) && onLink(poly[(k + 1) % poly.length]));
    let [a, b] = [poly[i], poly[(i + 1) % poly.length]];
    if (nearGal(b) < nearGal(a)) [a, b] = [b, a]; // a：ガレリアの側の端
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (const [t, w] of list) doors.push({ at: [Math.round((a[0] + ((b[0] - a[0]) * t) / L) * 10) / 10, Math.round((a[1] + ((b[1] - a[1]) * t) / L) * 10) / 10], level: 1, kind: "出入口", hall: hid, width: w });
  }
}
// 東7 の外側の搬入口（図面：道の側に W 8.0m × 2、北西の斜めの壁に W 6.0m、トイレの側の壁に W 8.0m）。
// 会場データの東7 は図面より長いので、図面の角からは測らず、ホールの中の机の列との位置関係で置いた目安の位置：
// 道の側の 2 つは机の列の 8 本目と 4 本目（トイレの側から数えて）の正面、斜めの壁とトイレの側の壁のものは、
// 道の側の半分と、リンクスペースの側の半分のあいだの横の通路の高さ。図面から読んだ道の側の 2 つは、これに置きかえる
{
  for (let i = doors.length - 1; i >= 0; i--) if (doors[i].hall === "E7" && doors[i].kind === "搬入口") doors.splice(i, 1);
  for (const [at, width] of [
    [[430.3, -452.7], 8],
    [[455.9, -469.7], 8],
    [[509.5, -431.2], 6],
    [[430.2, -375.8], 8],
  ] as [XZ, number][])
    doors.push({ at, level: 1, kind: "搬入口", hall: "E7", width });
}
// 東1〜3 のホールとガレリアのあいだの部屋の帯の部屋（主催者事務室・商談室・東VIPルーム・多目的室・給湯室・階段・EV）。
// 来場者の入れない所なので、黒い低い箱（kind "room"）で描く。トイレは別に描いている。
// 図面（白図）の四角 [x0, y0, x1, y1] を、u = 帯のホールの側の壁（展示場の床のふち）−（y − 図面の壁の y）× 縮尺、
// v = 図面の出入口の文字の位置から（x − その x）× 縮尺 で置く（出入口とエスカレーターの位置が、図面から読んだ会場データと合う置き方）。
// となりのホールの図面にも描かれている部屋（ホールのさかいの商談室など）は 1 つだけ
{
  const PT = (0.0254 / 72) * 200; // 東1・東2：1/200 の A1 の 1pt
  const PX3 = ((0.6 * 0.0254) / 72) * 566; // 東3：A4 の図面の画像の 1px
  const sheets: { s: number; x0: number; v0: number; y0: number; u0: number; rooms: [string, number, number, number, number][] }[] = [
    {
      s: PT, x0: 637, v0: -273.6, y0: 1479, u0: 28.8, // 東1
      rooms: [["商談室", 59, 1567, 196, 1682], ["給湯室", 196, 1641, 226, 1700], ["主催者事務室", 226, 1522, 509, 1700], ["階段", 719, 1479, 834, 1570],
        ["給湯室", 1017, 1522, 1053, 1547], ["多目的室", 1019, 1679, 1087, 1763], ["東VIPルーム", 1119, 1679, 1344, 1763]],
    },
    {
      s: PT, x0: 727, v0: -367.66, y0: 1470, u0: 29.5, // 東2
      rooms: [["商談室", 150, 1483, 283, 1690], ["給湯室", 290, 1627, 317, 1690], ["主催者事務室", 317, 1513, 600, 1693], ["階段", 783, 1470, 923, 1560], ["給湯室", 1107, 1520, 1153, 1543]],
    },
    {
      s: PX3, x0: 575, v0: -439.17, y0: 870, u0: 29.5, // 東3
      rooms: [["主催者事務室", 180, 895, 350, 985], ["給湯室", 165, 950, 178, 985], ["階段", 460, 870, 540, 925], ["給湯室", 650, 897, 670, 912], ["EV", 647, 957, 675, 982]],
    },
  ];
  for (const sh of sheets)
    for (const [name, x0, y0, x1, y1] of sh.rooms) {
      const U = (y: number) => sh.u0 - (y - sh.y0) * sh.s, V = (x: number) => sh.v0 + (x - sh.x0) * sh.s;
      blocks.push({ name, level: 1, kind: "room", height: 3.5, poly: fromUV([[U(y0), V(x0)], [U(y0), V(x1)], [U(y1), V(x1)], [U(y1), V(x0)]]) });
    }
}

// 周辺の道・線路・駅（data/osm/surroundings.json、npm run fetch:surroundings が作る）。「周辺も表示」で使う。
// 高さは OSM の layer（何層目か）から：歩道・道路は 1層＝2F の高さ（2F の歩行者デッキと同じ）。ゆりかもめの高架（layer 2〜4）は、
// どこも同じ 17m（2F の歩行者デッキ 12m と、やぐら橋の白い屋根 15.3m の上を通る高さ。OSM の layer は区間・線ごとにまちまちで、
// そのまま高さにすると 2 本の線路の高さがずれる）。ホームは 17.5m
// 地下（tunnel・layer がマイナス）は描かない（りんかい線は駅の名前だけ）
// esc：エスカレーター（OSM の conveying）。br：運河をわたる、地面の高さの橋（橋の板の厚みと手すりをつけて描く）
// fill：橋の車線と歩道のあいだ（中央分離帯など）を埋める板
type SLine = { pts: XZ[]; y: number; w: number; kind: "road" | "walk" | "steps" | "rail" | "deck"; esc?: boolean; br?: boolean; fill?: boolean };
type SArea = { poly: XZ[]; y: number; kind: "walk" | "platform" | "water"; name?: string; labels?: XZ[]; holes?: XZ[][] };
type SStation = { name: string; line: string; at: XZ; y: number };
const sur = { lines: [] as SLine[], areas: [] as SArea[], stations: [] as SStation[] };
const RAIL_Y = 17; // ゆりかもめの高架の高さ（上の説明）
const deckSteps: { pts: XZ[]; esc: boolean }[] = []; // 歩行者デッキへ上る階段（OSM の layer ≥ 1 の steps）
const gateLines: XZ[][] = []; // 駅の改札口へ行くデッキの歩道（OSM の名前に「改札」）
const deckAreas: XZ[][] = []; // 歩行者デッキの広場（OSM の layer ≥ 1 の閉じた pedestrian・area=yes）
// 橋（OSM の bridge=yes で layer ≥ 1 の道・歩道）と、地上の道の点（両端が地上の道につながる橋かを見る）。海の形ができてから決める
const bridgeWays: { line: SLine; pts: XZ[]; walk: boolean; name: string }[] = [];
const groundPts: XZ[] = [];
if (existsSync("data/osm/surroundings.json")) {
  const so = JSON.parse(readFileSync("data/osm/surroundings.json", "utf8")) as { elements: El[] };
  const WIDTH: Record<string, number> = { motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 7, unclassified: 6, residential: 6, service: 4, pedestrian: 6, footway: 2.5, path: 2, cycleway: 2, steps: 2.5 };
  for (const e of so.elements) {
    const t = e.tags ?? {};
    const layer = Number(t.layer) || 0;
    if (t.tunnel === "yes" || layer < 0 || Number(t.level) < 0) continue;
    if (e.type === "node" && (t.railway === "station" || (t.public_transport === "station" && t.railway))) {
      const line = t.light_rail === "yes" ? "ゆりかもめ" : "りんかい線";
      sur.stations.push({ name: `${t.name}駅`, line, at: project(ORIGIN, e.lat!, e.lon!), y: line === "ゆりかもめ" ? RAIL_Y : 0 });
      continue;
    }
    if (!e.geometry) continue;
    const pts = e.geometry.map((g) => project(ORIGIN, g.lat, g.lon));
    if (t.railway === "platform") {
      sur.areas.push({ poly: pts, y: RAIL_Y + 0.5, kind: "platform" });
    } else if (t.railway && t.railway !== "station") {
      sur.lines.push({ pts, y: layer > 0 ? RAIL_Y : 0.1, w: layer > 0 ? 7 : 3, kind: "rail" });
    } else if (t.highway) {
      const walk = /^(pedestrian|footway|path|cycleway|steps)$/.test(t.highway);
      // 2F 以上の歩道（OSM の layer ≥ 1）は、まわりの建物をつなぐ歩行者デッキ。会場の 2F の床と同じ高さ（12m）の板にする
      // （会場の床の上の所は、あとで会場の床にかかる所を切り取るので重ならない）。デッキへ上る階段は、デッキにつく端を 12m に（deckSteps）
      // 閉じた歩行者用の道（highway=pedestrian の輪、area=yes）はデッキの広場（面）。ふちを線として描くと、手すりのついた細い道が
      // 輪になって重なる（ユーザーの指摘：駅までの道がおかしい）
      // ただし layer 1 で、橋（bridge）でも階（level）の指定もない長い歩道（ビッグサイト駅から南の水ぎわの遊歩道 way 577631977 など）は、
      // 航空写真では地上の道（影がない）なので、地上に描く
      const elevated = layer >= 2 || t.highway === "pedestrian" || t.bridge === "yes" || t.level !== undefined;
      if (walk && layer >= 1 && elevated) {
        const closed = pts.length > 3 && pts[0][0] === pts.at(-1)![0] && pts[0][1] === pts.at(-1)![1];
        if (t.highway === "steps") deckSteps.push({ pts, esc: t.conveying === "yes" });
        else if (t.area === "yes" || (t.highway === "pedestrian" && closed)) deckAreas.push(pts.slice(0, -1));
        else if (/改札/.test(t.name ?? "")) gateLines.push(pts);
        else {
          sur.lines.push({ pts, y: FLOOR_Y[2], w: t.highway === "pedestrian" ? 8 : 5, kind: "deck" });
          if (t.bridge === "yes") bridgeWays.push({ line: sur.lines.at(-1)!, pts, walk: true, name: t.name ?? t["bridge:name"] ?? `way ${e.id}` });
        }
        continue;
      }
      if (layer <= 0 && !t.bridge) groundPts.push(...pts);
      // 高架の道路は、2F の床より少し下（8m）に
      const y = layer >= 1 && !walk ? 8 : walk ? 0.06 : 0.03;
      if (t.area === "yes" && pts.length > 3) sur.areas.push({ poly: pts, y, kind: "walk" });
      else {
        sur.lines.push({ pts, y, w: WIDTH[t.highway] ?? 3, kind: t.highway === "steps" ? "steps" : walk ? "walk" : "road", ...(t.conveying === "yes" ? { esc: true } : {}) });
        if (layer >= 1 && t.bridge === "yes") bridgeWays.push({ line: sur.lines.at(-1)!, pts, walk, name: t.name ?? t["bridge:name"] ?? `way ${e.id}` });
      }
    }
  }
}

// 外のデッキ（2F）のうち、エントランスプラザの北から北へ、東4〜6 の手前を東へ行く細い歩道橋は、航空写真の歩道橋に合っているのは
// OSM の歩行者デッキの広場（way 174407849・174407850・174407854）のほうで、上で手で描いた形は 8〜13m ずれて二重に見えていた
// （ユーザーの指摘、2026-11-08）。この区間（u -140〜-40・v -275〜-36）は手で描いた形を捨てて OSM の形にする。
// 屋内の床（北コンコース・連絡ブリッジ・東ガレリアの 2F・エントランスホール）にかかる所は、これまでどおり引く
{
  const rg = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const ur = (r: [number, number][]): XZ[] => r.slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
  const sz = (r: XZ[]) => Math.abs(r.reduce((s2, p, i) => s2 + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
  const zone = [rg(fromUV([[-140, -36], [-40, -36], [-40, -275], [-140, -275]]))];
  const osm = deckAreas.filter((pl) => {
    const [u, v] = toUV(centroid(pl));
    return u > -140 && u < -40 && v > -275 && v < -36;
  });
  const olds = areas.filter((a) => a.name === "外のデッキ（2F）");
  if (osm.length && olds.length) {
    let mp = polygonClipping.union([rg(olds[0].poly), ...(olds[0].holes ?? []).map(rg)], ...olds.slice(1).map((a) => [rg(a.poly), ...(a.holes ?? []).map(rg)]));
    mp = polygonClipping.difference(mp, zone);
    mp = polygonClipping.union(mp, ...osm.map((pl) => [rg(pl)]));
    for (const a of areas.filter((x) => x.level === 2 && !x.outdoor && ["北コンコース", "連絡ブリッジ", "東展示棟 2F", "エントランスホール"].includes(x.name)))
      mp = polygonClipping.difference(mp, [rg(a.poly), ...(a.holes ?? []).map(rg)]);
    for (let i = areas.length - 1; i >= 0; i--) if (areas[i].name === "外のデッキ（2F）") areas.splice(i, 1);
    mp.map((pg) => ({ poly: ur(pg[0]), holes: pg.slice(1).map(ur) }))
      .filter((pc) => sz(pc.poly) > 20)
      .sort((a, b) => sz(b.poly) - sz(a.poly))
      .forEach((pc, i) => areas.push({ name: "外のデッキ（2F）", level: 2, poly: pc.poly, ...(pc.holes.length ? { holes: pc.holes } : {}), outdoor: true, ...(i > 0 ? { part: true } : {}) }));
    console.log(`外のデッキ（2F）：歩道橋の区間を OSM の形に（${osm.length} 個）→ ${areas.filter((a) => a.name === "外のデッキ（2F）").length} 枚`);
  }
}

// 海（「周辺も表示」のときだけ）：OSM の海岸線（data/osm/coast.json、npm run fetch:coast が作る）から作る。
// 航空写真と重ねて、岸が合っていることを確かめた。海岸線は「進む向きの右が海」なので、範囲の四角で切った線を、
// 四角のふちを時計回り（北が上の地図で見て）にたどってつなぐと、海の形になる。四角の中で閉じた輪は島（反時計回り）か池
if (existsSync("data/osm/coast.json")) {
  type G = { lat: number; lon: number }[];
  const co = JSON.parse(readFileSync("data/osm/coast.json", "utf8")) as {
    bbox: string;
    elements: { type: string; tags?: Record<string, string>; geometry?: G; members?: { type: string; role: string; geometry?: G }[] }[];
  };
  const [bs, bw, bn, be] = co.bbox.split(",").map(Number);
  // 取った範囲より 400m 内側の四角（線の端が四角の外に出るように）
  const [xw, zn] = project(ORIGIN, bn, bw).map((v) => v + 400) as XZ;
  const [xe, zs] = project(ORIGIN, bs, be).map((v) => v - 400) as XZ;
  const RW = xe - xw, RH = zs - zn, PER = 2 * (RW + RH);
  const inside = ([x, z]: XZ) => x > xw && x < xe && z > zn && z < zs;
  // 四角のふちの点の、北西の角から時計回りの距離
  const tOf = ([x, z]: XZ) => {
    const d = [Math.abs(z - zn), Math.abs(x - xe), Math.abs(z - zs), Math.abs(x - xw)];
    const k = d.indexOf(Math.min(...d));
    return k === 0 ? x - xw : k === 1 ? RW + (z - zn) : k === 2 ? RW + RH + (xe - x) : 2 * RW + RH + (zs - z);
  };
  const corners: [number, XZ][] = [[0, [xw, zn]], [RW, [xe, zn]], [RW + RH, [xe, zs]], [2 * RW + RH, [xw, zs]]];
  // 線をつなぐ（端の点が同じ線どうし）
  const key = (p: { lat: number; lon: number }) => `${p.lat},${p.lon}`;
  const join = (list: G[]) => {
    const ways = [...list];
    const out: G[] = [];
    while (ways.length) {
      let c = ways.shift()!;
      for (let grew = true; grew; ) {
        grew = false;
        for (let i = 0; i < ways.length; i++) {
          if (key(ways[i][0]) === key(c[c.length - 1])) c = [...c, ...ways[i].slice(1)];
          else if (key(ways[i][ways[i].length - 1]) === key(c[0])) c = [...ways[i], ...c.slice(1)];
          else continue;
          ways.splice(i, 1);
          grew = true;
          break;
        }
      }
      out.push(c);
    }
    return out;
  };
  const chains = join(co.elements.filter((e) => e.tags?.natural === "coastline" && e.geometry).map((e) => e.geometry!));
  // 四角で切る：四角に入ってから出るまでの切れ端
  const pieces: XZ[][] = [];
  const rings: XZ[][] = [];
  for (const c of chains) {
    let pts = c.map((g) => project(ORIGIN, g.lat, g.lon));
    const closed = key(c[0]) === key(c[c.length - 1]);
    if (closed && pts.every(inside)) {
      rings.push(pts.slice(0, -1));
      continue;
    }
    // 閉じた輪は、四角の外の点から始める（範囲の中から始めると、最初と最後の切れ端がつながらない）
    if (closed) {
      const o = pts.findIndex((q) => !inside(q));
      pts = [...pts.slice(o, -1), ...pts.slice(0, o + 1)];
    }
    let cur: XZ[] | null = null;
    if (inside(pts[0])) console.warn("海岸線の端が範囲の中にある（切れ端は捨てる）");
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      // Liang–Barsky
      let t0 = 0, t1 = 1;
      const dx = bx - ax, dz = bz - az;
      let ok = true;
      for (const [p, q] of [[-dx, ax - xw], [dx, xe - ax], [-dz, az - zn], [dz, zs - az]] as [number, number][]) {
        if (p === 0) {
          if (q < 0) ok = false;
        } else {
          const r = q / p;
          if (p < 0) t0 = Math.max(t0, r);
          else t1 = Math.min(t1, r);
        }
      }
      if (!ok || t0 > t1) continue;
      const at = (t: number): XZ => [ax + dx * t, az + dz * t];
      if (t0 > 0) cur = [at(t0)]; // 外から入った
      if (!cur) continue; // 範囲の中で始まった線（捨てる）
      if (t1 < 1) {
        cur.push(at(t1)); // 外へ出た
        pieces.push(cur);
        cur = null;
      } else cur.push([bx, bz]);
    }
  }
  // 切れ端を、四角のふちを時計回りにたどってつなぐ
  const used = new Set<number>();
  let sea: [number, number][][][] = [];
  for (let s0 = 0; s0 < pieces.length; s0++) {
    if (used.has(s0)) continue;
    const ring: XZ[] = [];
    for (let k = s0; ; ) {
      used.add(k);
      ring.push(...pieces[k]);
      const tOut = tOf(pieces[k][pieces[k].length - 1]);
      // 時計回りで次に来る、切れ端の入り口
      let best = -1, bestD = Infinity;
      for (let j = 0; j < pieces.length; j++) {
        const d = (((tOf(pieces[j][0]) - tOut) % PER) + PER) % PER;
        if (d < bestD && (j === s0 || !used.has(j))) [best, bestD] = [j, d];
      }
      // 間の四角の角
      const between = corners
        .map(([ct, cp]) => [(((ct - tOut) % PER) + PER) % PER, cp] as [number, XZ])
        .filter(([d]) => d > 0 && d < bestD)
        .sort((p, q) => p[0] - q[0]);
      for (const [, cp] of between) ring.push(cp);
      if (best === s0 || best < 0) break;
      k = best;
    }
    sea = polygonClipping.union(sea, [[...ring, ring[0]].map(([x, z]) => [x, z] as [number, number])]);
  }
  // 四角の中で閉じた輪：反時計回り（右が海＝外が海）は島なので引く、時計回りは池なので足す
  for (const r of rings) {
    let a = 0;
    for (let i = 0; i < r.length; i++) a += r[i][0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * r[i][1];
    const g = [[...r, r[0]].map(([x, z]) => [x, z] as [number, number])];
    // x 東・z 南（北が上の地図）で a > 0 は時計回り
    sea = a > 0 ? polygonClipping.union(sea, g) : polygonClipping.difference(sea, g);
  }
  // 運河・川・湾の水面（OSM の natural=water。処理場の水槽や公園の池は除く）も海に足す
  const clip: [number, number][][] = [[[xw, zn], [xe, zn], [xe, zs], [xw, zs], [xw, zn]]];
  const ringOf = (g: G) => g.map((q) => project(ORIGIN, q.lat, q.lon) as [number, number]);
  for (const e of co.elements) {
    const t = e.tags ?? {};
    if (t.natural !== "water" || !(t.water === undefined || ["canal", "river", "bay"].includes(t.water))) continue;
    let shape: [number, number][][][] = [];
    if (e.type === "way" && e.geometry && key(e.geometry[0]) === key(e.geometry[e.geometry.length - 1])) shape = [[ringOf(e.geometry)]];
    else if (e.type === "relation") {
      const outer = join((e.members ?? []).filter((m) => m.role !== "inner" && m.geometry).map((m) => m.geometry!));
      const inner = join((e.members ?? []).filter((m) => m.role === "inner" && m.geometry).map((m) => m.geometry!));
      for (const r of outer) if (key(r[0]) === key(r[r.length - 1])) shape = polygonClipping.union(shape, [ringOf(r)]);
      for (const r of inner) if (key(r[0]) === key(r[r.length - 1])) shape = polygonClipping.difference(shape, [ringOf(r)]);
    }
    if (shape.length) sea = polygonClipping.union(sea, polygonClipping.intersection(shape, clip));
  }
  // 「海」の文字の場所（航空写真で海の上：会場の北東、西ホールの西の運河の先、南東の大きな海、北西の晴海の沖）
  const labels: XZ[] = [fromUV([[160, -760]])[0], [-235, 246], [1227, 1244], [-1940, -1460]];
  for (const p of sea) {
    const [outer, ...holes] = p.map((r) => r.slice(0, -1) as XZ[]);
    const here = labels.filter((l) => pointInPolygon(l, outer) && !holes.some((h) => pointInPolygon(l, h)));
    sur.areas.push({ poly: outer, holes, y: 0, kind: "water", ...(here.length ? { name: "海", labels: here } : {}) });
  }
  const lost = labels.filter((l) => !sur.areas.some((a) => a.labels?.includes(l)));
  if (lost.length) console.warn("海の上にない「海」の文字", lost);
  console.log(`海：海岸線 ${chains.length} 本 → 切れ端 ${pieces.length}・島や池 ${rings.length} → 海 ${sea.length} 面`);
}

// 運河をわたる橋（あけみ橋など）：layer ≥ 1 の橋は、道路は 8m、歩道は 2F のデッキ（12m）の高さにしていたので、運河の上で宙に浮き、
// 岸で途切れていた（ユーザーの指摘）。航空写真では、両岸の地面の高さのまま運河をわたる橋。長さの半分より多くが海（運河）の上で、
// 両端が地上の道につながる橋は、地面の高さ（水面より少し上）に、橋の板の厚みと手すりをつけて描く
{
  const water = sur.areas.filter((a) => a.kind === "water");
  const onWater = (q: XZ) => water.some((a) => pointInPolygon(q, a.poly) && !(a.holes ?? []).some((h) => pointInPolygon(q, h)));
  const atGround = (q: XZ) => groundPts.some((g) => Math.hypot(g[0] - q[0], g[1] - q[1]) < 0.5);
  const done: string[] = [];
  for (const bw of bridgeWays) {
    let n = 0, wet = 0;
    for (let i = 0; i + 1 < bw.pts.length; i++) {
      const [a2, b2] = [bw.pts[i], bw.pts[i + 1]], L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
      for (let d = 0; d < L; d += 2, n++) if (onWater([a2[0] + ((b2[0] - a2[0]) * d) / L, a2[1] + ((b2[1] - a2[1]) * d) / L])) wet++;
    }
    if (!n || wet / n <= 0.5 || !atGround(bw.pts[0]) || !atGround(bw.pts.at(-1)!)) continue;
    Object.assign(bw.line, { kind: bw.walk ? "walk" : "road", y: 0.5, br: true }, bw.walk ? { w: 2.5 } : {});
    done.push(bw.name);
  }
  // 上り・下りの車線と歩道は OSM では別々の線なので、あいだに水面が見えていた。航空写真では 1 枚の橋なので、となりあう橋の線
  // （どこでも、ふちとふちのあいだが 15m 未満）のあいだを、まん中の線に沿った板で埋める
  const brs = sur.lines.filter((l) => l.br);
  const nearestOn = (q: XZ, pts: XZ[]) => {
    let best = { d: Infinity, p: q };
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a2, b2] = [pts[i], pts[i + 1]], dx = b2[0] - a2[0], dz = b2[1] - a2[1], L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((q[0] - a2[0]) * dx + (q[1] - a2[1]) * dz) / L2));
      const p: XZ = [a2[0] + t * dx, a2[1] + t * dz], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best.d) best = { d, p };
    }
    return best;
  };
  const sample = (pts: XZ[], n: number) => {
    const segs = pts.slice(1).map((q, k) => ({ a: pts[k], b: q, L: Math.hypot(q[0] - pts[k][0], q[1] - pts[k][1]) }));
    const total = segs.reduce((s2, g) => s2 + g.L, 0), out: XZ[] = [];
    for (let k = 0; k <= n; k++) {
      let d = (total * k) / n;
      for (const g of segs) {
        if (d <= g.L + 1e-6 || g === segs.at(-1)) {
          const t = Math.min(1, d / (g.L || 1));
          out.push([g.a[0] + (g.b[0] - g.a[0]) * t, g.a[1] + (g.b[1] - g.a[1]) * t]);
          break;
        }
        d -= g.L;
      }
    }
    return out;
  };
  let fills = 0;
  brs.forEach((A, i) =>
    brs.slice(i + 1).forEach((B) => {
      const qs = sample(A.pts, 12).slice(1, -1).map((q) => ({ q, ...nearestOn(q, B.pts) }));
      const gaps = qs.map((x) => x.d - (A.w + B.w) / 2);
      if (gaps.some((g) => g < 0.3 || g > 15)) return;
      const mid: XZ[] = qs.map((x) => [Math.round(((x.q[0] + x.p[0]) / 2) * 10) / 10, Math.round(((x.q[1] + x.p[1]) / 2) * 10) / 10]);
      const w = gaps.reduce((s2, g) => s2 + g, 0) / gaps.length + 0.8;
      sur.lines.push({ pts: mid, y: Math.min(A.y, B.y) - 0.02, w, kind: "road", br: true, fill: true });
      fills++;
    }),
  );
  console.log(`運河をわたる地面の高さの橋：${done.length} 本（${[...new Set(done)].join("・")}）・あいだを埋める板 ${fills}`);
}

// 南の角の建物（45° の四角）：公式フロアマップでは、1F・2F・3F・4F の同じ所にエスカレーター・エレベーター・トイレが重なる、
// 南展示棟の上り下りの所（1F は白い床、2F は南1・2ホール入口のロビー（コインロッカー・案内所・AED）、3F は喫煙所とトイレ）。
// 人の入れる建物として、1F と 2F に屋内の床を敷く（2F は、中を通るコンコースも屋内。下の「屋内と屋外」で分ける）。
// 3F（会場データにない階）から屋根（4F の床の 6m 上）までは箱で描く（4F を見ているときだけ出す）。1F の南展示棟への通路からは、この形を引く
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const un = (r: [number, number][]) => r.slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
  const area2 = (r: [number, number][]) => Math.abs(r.reduce((t, q, i) => (i + 1 < r.length ? t + q[0] * r[i + 1][1] - r[i + 1][0] * q[1] : t), 0)) / 2;
  areas.push({ name: "南の角の建物（1F）", level: 1, poly: southEntrance });
  let rest: [number, number][][][] = [[ring(southEntrance)]];
  for (const a of areas.filter((x) => x.level === 2)) rest = polygonClipping.difference(rest, [ring(a.poly)]);
  // 中を 1F へ下りるエスカレーターの上は、2F の床を開ける（吹き抜け。上の端の踊り場から下の端まで、幅 +0.6m）
  for (const st of stairs.filter((x) => x.fromLevel === 2 && x.toLevel === 1 && pointInPolygon(x.to, southEntrance))) {
    const L = Math.hypot(st.from[0] - st.to[0], st.from[1] - st.to[1]) || 1, ux = (st.to[0] - st.from[0]) / L, uz = (st.to[1] - st.from[1]) / L;
    const hw = st.width / 2 + 0.3, a: XZ = st.from, b: XZ = [st.to[0] + ux * 0.5, st.to[1] + uz * 0.5];
    rest = polygonClipping.difference(rest, [ring([[a[0] - uz * hw, a[1] + ux * hw], [b[0] - uz * hw, b[1] + ux * hw], [b[0] + uz * hw, b[1] - ux * hw], [a[0] + uz * hw, a[1] - ux * hw]])]);
  }
  for (const pg of rest) if (area2(pg[0]) >= 1) areas.push({ name: "南1・2ホール入口（2F）", level: 2, poly: un(pg[0]), part: true, ...(pg.length > 1 ? { holes: pg.slice(1).map(un) } : {}) });
  blocks.push({ name: "南の角の建物", level: 2, base: 4, poly: southEntrance, height: FLOOR_Y[4] + 6 - FLOOR_Y[2] - 4 });
  for (const a of areas.filter((x) => x.level === 1 && x.name === "南展示棟への通路")) {
    const left = polygonClipping.difference([ring(a.poly)], [ring(southEntrance)]);
    if (left.length) a.poly = un(left.map((pg) => pg[0]).sort((p, q) => area2(q) - area2(p))[0]);
  }
}

// 屋内と屋外：公式フロアマップの色分け（白が屋内、灰が屋外）に合わせる。
// 連絡ブリッジは屋内（ユーザーの確認：屋根と壁のある通路）。コンコースは、イベントプラザから南展示棟の入口（45° の四角の建物）までが
// 灰（屋外）、その建物の中と、そこから先の南1・南2 にそう所は白（屋内）なので、そこで 2 つに分ける
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const inside = polygonClipping.union([ring(southEntrance)], [ring(fromUV([[236, -1000], [2000, -1000], [2000, 1000], [236, 1000]]))]);
  const part = (west: boolean, pg: [number, number][][]) =>
    west ? polygonClipping.difference(pg, ...inside) : polygonClipping.intersection(pg, ...inside);
  for (const a of areas) if (a.name === "連絡ブリッジ") a.outdoor = false; // 連絡ブリッジは屋根と壁のある屋内の通路
  for (const a of areas.filter((x) => x.name === "コンコース" && x.level === 2)) {
    const pieces = [true, false].flatMap((west) =>
      part(west, [ring(a.poly), ...(a.holes ?? []).map(ring)]).map((pg) => ({
        // 建物の角と u 236 のあいだに残る小さな三角（数 m²）は屋内にまぜる（仕切りを立てない）
        tiny: Math.abs(pg[0].reduce((t, q, i) => (i + 1 < pg[0].length ? t + q[0] * pg[0][i + 1][1] - pg[0][i + 1][0] * q[1] : t), 0)) / 2 < 5,
        ...a,
        poly: pg[0].slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ),
        holes: pg.length > 1 ? pg.slice(1).map((h) => h.slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ)) : undefined,
        outdoor: west,
      })).map(({ tiny, ...pc }) => (tiny ? { ...pc, outdoor: false } : pc)),
    );
    // 名前の札は 1 つだけ（最初のかけら＝屋外の長い本体）。ほかのかけらにも出すと、同じ名前が並ぶ
    pieces.forEach((pc, k) => {
      if (k > 0 && !a.part) pc.part = true;
    });
    areas.splice(areas.indexOf(a), 1, ...pieces);
  }
}

// 2F の床は、1F のホールの上にかぶらないよう、ホールの形で切る（ホールの壁でまっすぐ切れる）。公式フロアマップから写した
// エントランスホールの東側・南コンコースが西1 の北の端に、外のデッキ・東ガレリアの 2F が東1〜3 の壁ぎわに少しかぶっていて、
// 1F のホールの机が見にくかった（ユーザーの確認）。南のコンコースの、エスカレーターの踊り場（わざと壁ぎわに重ねた所）は切らない
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const unring = (r: [number, number][]): XZ[] => r.slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
  const size = (r: XZ[]) => Math.abs(r.reduce((s2, p, i) => s2 + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
  const hall1 = halls.filter((h) => h.level === 1).map((h) => [ring(h.poly)]);
  for (const a of [...areas]) {
    if (a.level !== 2 || a.name === "コンコース") continue;
    const before = [[ring(a.poly), ...(a.holes ?? []).map(ring)]];
    const after = polygonClipping.difference(before, ...hall1);
    const pieces = after.map((pg) => ({ poly: unring(pg[0]), holes: pg.slice(1).map(unring) })).filter((pc) => size(pc.poly) > 2).sort((x, y) => size(y.poly) - size(x.poly));
    const total = (mp: { poly: XZ[]; holes: XZ[][] }[]) => mp.reduce((t, pc) => t + size(pc.poly) - pc.holes.reduce((u, h) => u + size(h), 0), 0);
    const was = size(a.poly) - (a.holes ?? []).reduce((u, h) => u + size(h), 0);
    if (!pieces.length || was - total(pieces) < 1) continue;
    a.poly = pieces[0].poly;
    if (pieces[0].holes.length) a.holes = pieces[0].holes;
    else delete a.holes;
    for (const pc of pieces.slice(1)) areas.push({ ...a, poly: pc.poly, ...(pc.holes.length ? { holes: pc.holes } : { holes: undefined }), part: true });
  }
}

// 「周辺も表示」の OSM の建物・道のうち、会場の床（ホール・通路・広場・南の角の建物）の中にあるものは出さない。
// 会場の床として描いているので、重なって床の上に箱や線が浮く（会議棟の逆ピラミッドと柱は、目印なので残す）
{
  // 車のスロープ（幅のまわり 8m まで）も：OSM のスロープの線が、ずれた所に高架の道として残り、スロープの下に帯が見えていた
  const ramps = stairs
    .filter((st) => st.kind === "ramp")
    .map((st) => {
      const dx = st.from[0] - st.to[0], dz = st.from[1] - st.to[1], L = Math.hypot(dx, dz);
      const ux = dx / L, uz = dz / L, h = st.width / 2 + 8;
      return [
        [st.to[0] - uz * h, st.to[1] + ux * h],
        [st.from[0] - uz * h, st.from[1] + ux * h],
        [st.from[0] + uz * h, st.from[1] - ux * h],
        [st.to[0] + uz * h, st.to[1] - ux * h],
      ] as XZ[];
    });
  // やぐら橋の大階段（会場の外の階段）の形も：OSM の橋の歩道（layer 2）が、階段の上に歩行者デッキとして残らないよう
  const bigStairs = stairs
    .filter((st) => st.sur)
    .map((st) => {
      const dx = st.from[0] - st.to[0], dz = st.from[1] - st.to[1], L = Math.hypot(dx, dz);
      const ux = dx / L, uz = dz / L, h = st.width / 2 + 2;
      return [[st.to[0] - uz * h - ux * 3, st.to[1] + ux * h - uz * 3], [st.from[0] - uz * h + ux * 3, st.from[1] + ux * h + uz * 3], [st.from[0] + uz * h + ux * 3, st.from[1] - ux * h + uz * 3], [st.to[0] + uz * h - ux * 3, st.to[1] - ux * h - uz * 3]] as XZ[];
    });
  const footprints = [...halls.map((h) => h.poly), ...areas.filter((a) => a.name !== "外のデッキ（2F）").map((a) => a.poly), southEntrance, ...ramps, ...bigStairs];
  const inVenue = (p: XZ) => footprints.some((f) => pointInPolygon(p, f));
  // まわりの建物は、下の PLATEAU の建物（sur.buildings）で描くので、OSM の部品は会議棟（逆ピラミッドと柱）だけ残す
  for (let i = parts3d.length - 1; i >= 0; i--) if (!/Conference Tower|会議棟/.test(parts3d[i].name)) parts3d.splice(i, 1);
  // 道・歩道の線は、会場の床にかかる所だけ切り取る（線ごと消すと会場の外の部分まで消え、残すと床の上に帯が出る）。
  // 線路（高架）は会場の上を通るので、そのまま
  const cut: typeof sur.lines = [];
  for (const l of sur.lines) {
    if (l.kind === "rail") {
      cut.push(l);
      continue;
    }
    let run: XZ[] = [];
    const flush = () => {
      if (run.length >= 2) cut.push({ ...l, pts: run });
      run = [];
    };
    for (let i = 0; i < l.pts.length; i++) {
      const p = l.pts[i];
      if (inVenue(p)) {
        flush();
        continue;
      }
      if (run.length) {
        // 前の点からの区間が、途中で会場の床を通るなら、そこで切る
        const q = run[run.length - 1];
        const n = Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / 2);
        let through = false;
        for (let k = 1; k < n && !through; k++) through = inVenue([q[0] + ((p[0] - q[0]) * k) / n, q[1] + ((p[1] - q[1]) * k) / n]);
        if (through) flush();
      }
      run.push(p);
    }
    flush();
  }
  sur.lines = cut;
  sur.areas = sur.areas.filter((a) => a.kind === "water" || !inVenue(centroid(a.poly)));
  // デッキの広場：会場の床にかかる所を切りとる。広場の上を通る線（デッキの真ん中の道など）は、広場で描くので出さない
  const ringOf = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  // 会場の 2F の床（外のデッキ（2F）も）と重なる所も切りとる（同じ高さの床が 2 枚重なってちらつく）
  const fpRings = [...footprints, ...areas.filter((a) => a.level === 2).map((a) => a.poly)].map((f) => [ringOf(f)] as [number, number][][]);
  const decks: { poly: XZ[]; holes?: XZ[][] }[] = [];
  for (const a of deckAreas) {
    let res = polygonClipping.union([ringOf(a)]);
    res = polygonClipping.difference(res, ...fpRings);
    for (const pg of res) {
      const pl = pg[0].slice(0, -1).map(([x, z]) => [x, z] as XZ);
      if (Math.abs(pl.reduce((s2, q, i) => s2 + q[0] * pl[(i + 1) % pl.length][1] - pl[(i + 1) % pl.length][0] * q[1], 0) / 2) < 20) continue;
      const holes = pg.slice(1).map((h) => h.slice(0, -1).map(([x, z]) => [x, z] as XZ));
      decks.push({ poly: pl, ...(holes.length ? { holes } : {}) });
    }
  }
  const onDeck = (q: XZ) => decks.some((d) => pointInPolygon(q, d.poly) && !(d.holes ?? []).some((h) => pointInPolygon(q, h)));
  sur.lines = sur.lines.filter((l) => {
    if (l.kind !== "deck") return true;
    const n = l.pts.length;
    return l.pts.filter((q) => onDeck(q)).length < n * 0.6;
  });
  Object.assign(sur, { decks });

  // ---- 周辺をくわしく（ユーザーの指示：駅までの道など、まわりをくわしく、リアルに）
  // 建物：国土交通省 PLATEAU（3D 都市モデル 東京都23区 2020 年度。data/plateau/buildings.json）の屋根の形と計測高さ。
  // PLATEAU にない建物（2020 年度より後に建ったもの）は OSM（data/osm/detail.json）の形で、高さは OSM の height・階数、
  // それもなければ下の表（公表の階数・高さ）、それもなければ 10m（est に理由を書く）。
  // 細長い低いもの（平均の幅 7m 未満・長さが幅の 4 倍より長い・高さ 8m 以下）は、屋根のある歩道の屋根（kind "canopy"：屋根の板と柱）
  const det = existsSync("data/osm/detail.json") ? (JSON.parse(readFileSync("data/osm/detail.json", "utf8")) as { elements: El[] }).elements : [];
  const plateau = existsSync("data/plateau/buildings.json")
    ? (JSON.parse(readFileSync("data/plateau/buildings.json", "utf8")) as { buildings: { id: string; h: number; poly: [number, number][] }[] }).buildings
    : [];
  const ringArea = (r: XZ[]) => Math.abs(r.reduce((a2, q, i) => a2 + q[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * q[1], 0) / 2);
  const ringLen = (r: XZ[]) => r.reduce((a2, q, i) => a2 + Math.hypot(r[(i + 1) % r.length][0] - q[0], r[(i + 1) % r.length][1] - q[1]), 0);
  const tower = parts3d.filter((b) => /Conference Tower|会議棟/.test(b.name)).map((b) => b.poly);
  // やぐら橋のまわり（橋の屋根と U の字の端の屋根は、会場の 2F の高さに合わせて自分で描いている）
  const nearBridge = (q: XZ) => {
    const [u, v] = toUV(q);
    return u < -120 && u > -282 && v > -14 && v < 32;
  };
  const skip = (pl: XZ[]) => {
    const c = centroid(pl);
    return inVenue(c) || inHallBuilding(pl) || tower.some((t2) => pointInPolygon(c, t2) || t2.some((q) => pointInPolygon(q, pl))) || nearBridge(c);
  };
  // OSM の形：way はそのまま、relation（マルチポリゴン）は outer の線を端でつないだ輪
  const shapesOf = (e: El): XZ[][] => {
    if (e.type === "way") return e.geometry ? [poly(e)] : [];
    const parts = ((e as El & { members?: { role: string; geometry?: { lat: number; lon: number }[] }[] }).members ?? [])
      .filter((m) => m.role === "outer" && m.geometry?.length)
      .map((m) => m.geometry!.map((g) => project(ORIGIN, g.lat, g.lon)));
    const same = (a2: XZ, b2: XZ) => Math.hypot(a2[0] - b2[0], a2[1] - b2[1]) < 0.05;
    const out: XZ[][] = [];
    while (parts.length) {
      let c = parts.shift()!;
      for (let grew = true; grew && !same(c[0], c.at(-1)!); ) {
        grew = false;
        for (let i = 0; i < parts.length; i++) {
          const w = parts[i];
          if (same(w[0], c.at(-1)!)) c = [...c, ...w.slice(1)];
          else if (same(w.at(-1)!, c.at(-1)!)) c = [...c, ...[...w].reverse().slice(1)];
          else if (same(w.at(-1)!, c[0])) c = [...w, ...c.slice(1)];
          else if (same(w[0], c[0])) c = [...[...w].reverse(), ...c.slice(1)];
          else continue;
          parts.splice(i, 1);
          grew = true;
          break;
        }
      }
      if (same(c[0], c.at(-1)!)) c.pop();
      if (c.length >= 3) out.push(c);
    }
    return out;
  };
  // 点の升目（2m 間隔）
  const inside = (pl: XZ[]) => {
    const xs = pl.map((q) => q[0]), zs = pl.map((q) => q[1]);
    const out: XZ[] = [];
    for (let x = Math.min(...xs) + 1; x <= Math.max(...xs); x += 2)
      for (let z = Math.min(...zs) + 1; z <= Math.max(...zs); z += 2) if (pointInPolygon([x, z], pl)) out.push([x, z]);
    return out;
  };
  // kind "station"：高架の線路が上を通る建物（ゆりかもめの駅）。線路とホームが見えるよう、高架の下の低い部分（body の高さまで）と、
  // ホームの上の屋根（h の高さ）に分けて描く
  // kind "bridgeHouse"：駅の出口の歩道橋の、道の上を渡る通路と出口の建物（base の高さから上だけ。下は柱）。
  // kind "tube"：歩道橋から地上へ下りる、屋根つきのエスカレーター（slope の上の端から下の端へ、床と屋根が傾く）
  type SBuilding = {
    poly: XZ[]; h: number; name?: string; kind?: "canopy" | "station" | "bridgeHouse" | "tube"; est?: string; body?: number; base?: number;
    slope?: { from: XZ; to: XZ; y: number };
  };
  const railPts: { p: XZ; y: number }[] = [];
  for (const l of sur.lines.filter((x) => x.kind === "rail" && x.y > 1))
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [a2, b2] = [l.pts[i], l.pts[i + 1]], L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
      for (let d = 0; d < L; d += 2) railPts.push({ p: [a2[0] + ((b2[0] - a2[0]) * d) / L, a2[1] + ((b2[1] - a2[1]) * d) / L], y: l.y });
    }
  const pBuildings = plateau
    .map((b) => ({ poly: b.poly.map(([la, lo]) => project(ORIGIN, la, lo)), h: b.h }))
    .filter((b) => b.poly.length >= 3 && !skip(b.poly));
  const oBuildings = det
    .filter((e) => e.tags?.building)
    .flatMap((e) => shapesOf(e).map((pl) => ({ t: e.tags!, poly: pl })))
    .filter((b) => !skip(b.poly));
  // PLATEAU（2020 年度）と OSM（今）の突き合わせ：PLATEAU の建物の点が OSM の建物に入る割合（fP）と、
  // OSM の建物の点が PLATEAU の建物に入る割合（fO）。
  // ・PLATEAU の建物が OSM の建物と重なり（fP ≥ 0.3）、その OSM の建物が PLATEAU にほとんど入っていない（fO < 0.5）なら、
  //   2020 年より後に建てかわった所（東京ドリームパークなど）なので、PLATEAU の古い建物は使わず OSM の建物にする
  // ・OSM にない PLATEAU の建物（小さい建物など）は、そのまま使う
  const pPts = pBuildings.map((b) => inside(b.poly));
  const oPts = oBuildings.map((b) => inside(b.poly));
  const fO = oBuildings.map((_, i) => (oPts[i].length ? oPts[i].filter((q) => pBuildings.some((b) => pointInPolygon(q, b.poly))).length / oPts[i].length : 1));
  const buildings: SBuilding[] = [];
  const usedP = new Set<number>();
  pBuildings.forEach((b, i) => {
    const pts = pPts[i];
    const hits = oBuildings.map((o) => pts.filter((q) => pointInPolygon(q, o.poly)).length);
    const best = hits.indexOf(Math.max(...hits));
    const fP = pts.length ? hits[best] / pts.length : 0;
    if (fP >= 0.3 && fO[best] < 0.5) return;
    usedP.add(i);
    // 細長い低いもの（平均の幅 7m 未満・長さが幅の 4 倍より長い・高さ 8m 以下）は屋根
    const wMean = (2 * ringArea(b.poly)) / ringLen(b.poly);
    const thin = wMean < 7 && ringArea(b.poly) / (wMean * wMean) > 4 && b.h <= 8;
    const onRail = railPts.filter((r) => pointInPolygon(r.p, b.poly));
    if (onRail.length >= 10 && b.h > 12) {
      // 屋根はホームの上 4.5m より高く（地図の高架は実物より高いので、PLATEAU の高さのままだとホームにめりこむ）
      const ry = Math.max(...onRail.map((r) => r.y));
      // 高架の下の部分は、2F の歩行者デッキの高さ（改札のある階。デッキがそのまま駅につながる）まで
      buildings.push({ poly: b.poly, h: Math.max(b.h, ry + 4.5), kind: "station", body: FLOOR_Y[2] });
      return;
    }
    buildings.push({ poly: b.poly, h: b.h, ...(thin ? { kind: "canopy" as const } : {}) });
  });
  // 駅の建物が PLATEAU で 2 棟に分かれている所（有明駅：北西と南東の半分が 50m² 重なる）は 1 棟にまとめる。
  // 分かれたままだと、高さの違う屋根が 2 枚ずれて重なって見えた（ユーザーの指摘：有明駅のまわりが崩れている）
  for (let i = buildings.length - 1; i >= 0; i--) {
    const a = buildings[i];
    if (a.kind !== "station") continue;
    const j = buildings.findIndex((b2, k) => k !== i && b2.kind === "station" && (a.poly.some((q) => pointInPolygon(q, b2.poly)) || b2.poly.some((q) => pointInPolygon(q, a.poly))));
    if (j < 0) continue;
    const b2 = buildings[j];
    const u = polygonClipping.union([[...a.poly, a.poly[0]].map(([x, z]) => [x, z] as [number, number])], [[...b2.poly, b2.poly[0]].map(([x, z]) => [x, z] as [number, number])]);
    if (u.length !== 1) continue;
    b2.poly = u[0][0].slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
    b2.h = Math.max(a.h, b2.h);
    buildings.splice(i, 1);
  }
  // 高い建物の上の庭の小道（OSM の layer ≥ 1 の歩道。有明駅の東の、有明の丘の防災拠点のあたりの way）は、デッキの高さ（12m）だと
  // 建物の中を通って見えた（ユーザーの指摘：有明駅のまわりが崩れている）。その建物のどの高さの屋上か資料で決められないので、描かない
  sur.lines = sur.lines.filter(
    (l) => l.kind !== "deck" || !buildings.some((b) => !b.kind && b.h >= FLOOR_Y[2] + 2 && l.pts.filter((q) => pointInPolygon(q, b.poly)).length / l.pts.length >= 0.6),
  );
  // 名前：OSM の名前のある大きい建物（1500m² 以上）を、いちばん重なる PLATEAU の建物に付ける（名前の札にする）
  oBuildings.forEach((o, i) => {
    if (!o.t.name || ringArea(o.poly) < 1500 || fO[i] < 0.5) return;
    const count = new Map<SBuilding, number>();
    for (const q of oPts[i]) for (const b of buildings) if (!b.kind && pointInPolygon(q, b.poly)) count.set(b, (count.get(b) ?? 0) + 1);
    const best = [...count].sort((x, y) => y[1] - x[1])[0];
    if (best && !best[0].name) best[0].name = o.t.name.split(";")[0];
  });
  // PLATEAU にない（入っていない）OSM の建物。高さは OSM の height・階数、なければ公表の高さ・階数：
  // 東京ドリームパーク：建設中の報道の高さ約 52m（竣工時は地上 9 階）。コナミクリエイティブフロント東京ベイ：地上 8 階。
  // 有明ガーデン（商業施設）・東京ガーデンシアター：完成後の高さ・階数の公表が見つからない（都市計画の素案では、商業・ホテル・ホールの
  // 街区の最高高さ 58m・44m だが、ホテルの塔などを含む高さ）。見た目の目安として、商業施設 30m・劇場 40m にする（資料なしの目安）。
  // どれもなければ 10m（est に理由を書く）
  const KNOWN: Record<string, { h?: number; levels?: number; est: string }> = {
    東京ドリームパーク: { h: 52, est: "建設中の報道の高さ約 52m" },
    コナミクリエイティブフロント東京ベイ: { levels: 8, est: "地上 8 階（1 階 4m）" },
    "有明ガーデン;モール&スパ": { h: 30, est: "資料なしの目安（街区の計画の最高高さ 58m より低い商業施設の部分）" },
    東京ガーデンシアター: { h: 40, est: "資料なしの目安（街区の計画の最高高さ 44m 以下）" },
  };
  oBuildings.forEach((o, i) => {
    if (fO[i] >= 0.5) return;
    const t = o.t;
    // PLATEAU の建物（使うもの）で、もう大半がおおわれている所は重ねない
    const cov = oPts[i].length ? oPts[i].filter((q) => buildings.some((b) => pointInPolygon(q, b.poly))).length / oPts[i].length : 1;
    if (cov >= 0.5) return;
    const k = KNOWN[t.name ?? ""];
    const levels = Number(t["building:levels"]) || k?.levels || 0;
    const h = Number(t.height) || k?.h || levels * 4 || 0;
    buildings.push({
      poly: o.poly, h: h || 10,
      ...(t.name && ringArea(o.poly) >= 1500 ? { name: t.name.split(";")[0] } : {}),
      ...(k ? { est: k.est } : Number(t.height) ? {} : levels ? { est: `OSM の階数 ${levels}（1 階 4m）` } : { est: "高さ・階数の資料なし（10m）" }),
    });
  });
  // 緑地（公園・庭・芝生・林・植え込み・運動場）と駐車場
  type SGreen = { poly: XZ[]; kind: "grass" | "wood" | "pitch" | "parking" };
  const greens: SGreen[] = [];
  for (const e of det) {
    const t = e.tags ?? {};
    if (e.type !== "way" || !e.geometry || e.geometry.length < 4 || t.building) continue;
    const kind: SGreen["kind"] | null =
      t.amenity === "parking" ? "parking"
      : t.leisure === "pitch" ? "pitch"
      : t.landuse === "forest" || t.natural === "wood" || t.natural === "scrub" ? "wood"
      : /^(park|garden|playground)$/.test(t.leisure ?? "") || /^(grass|meadow|village_green|recreation_ground|flowerbed)$/.test(t.landuse ?? "") || t.natural === "grassland" ? "grass"
      : null;
    if (!kind) continue;
    const pl = poly(e);
    if (pl.length >= 3 && !inVenue(centroid(pl))) greens.push({ poly: pl, kind });
  }
  // 木：OSM の木（1 本ずつ）と並木（7m ごと）。林は 7m の升目に（少しずらして）並べる
  const trees: XZ[] = [];
  const jit = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1;
  for (const e of det) {
    const t = e.tags ?? {};
    if (t.natural === "tree" && e.lat) trees.push(project(ORIGIN, e.lat, e.lon!));
    if (t.natural === "tree_row" && e.geometry) {
      const pl = e.geometry.map((g) => project(ORIGIN, g.lat, g.lon));
      for (let i = 0; i + 1 < pl.length; i++) {
        const L = Math.hypot(pl[i + 1][0] - pl[i][0], pl[i + 1][1] - pl[i][1]);
        for (let d = 0; d < L; d += 7) trees.push([pl[i][0] + ((pl[i + 1][0] - pl[i][0]) * d) / L, pl[i][1] + ((pl[i + 1][1] - pl[i][1]) * d) / L]);
      }
    }
  }
  for (const g of greens.filter((g2) => g2.kind === "wood")) {
    const xs = g.poly.map((q) => q[0]), zs = g.poly.map((q) => q[1]);
    let i = 0;
    for (let x = Math.min(...xs) + 3; x < Math.max(...xs); x += 7)
      for (let z = Math.min(...zs) + 3; z < Math.max(...zs); z += 7) {
        i++;
        const q: XZ = [x + jit(i) * 2.5, z + jit(i + 99) * 2.5];
        if (pointInPolygon(q, g.poly)) trees.push(q);
      }
  }
  const treesOut = trees.filter((q) => !inVenue(q) && !buildings.some((b) => !b.kind && pointInPolygon(q, b.poly))).map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10] as XZ);
  // 横断歩道（OSM の footway=crossing の線）
  const crossings = det
    .filter((e) => e.type === "way" && e.tags?.footway === "crossing" && e.geometry)
    .map((e) => e.geometry!.map((g) => project(ORIGIN, g.lat, g.lon)))
    .filter((pl) => !inVenue(pl[0]) && !inVenue(pl.at(-1)!));
  // 駅の出入口（いちばん近い駅の名前を付ける）・バス停（同じ名前で 40m 以内は 1 つ）・タクシー乗り場
  const near = (q: XZ) => [...sur.stations].sort((a2, b2) => Math.hypot(a2.at[0] - q[0], a2.at[1] - q[1]) - Math.hypot(b2.at[0] - q[0], b2.at[1] - q[1]))[0];
  const entrances = det
    .filter((e) => (e.tags?.railway === "train_station_entrance" || e.tags?.railway === "subway_entrance") && e.lat)
    .map((e) => {
      const at = project(ORIGIN, e.lat!, e.lon!);
      const st = near(at);
      return { at, name: `${st.name} 出入口${e.tags?.ref ? ` ${e.tags.ref}` : ""}`, line: st.line };
    });
  const busStops: { at: XZ; name: string }[] = [];
  for (const e of det.filter((e2) => e2.tags?.highway === "bus_stop" && e2.lat)) {
    const at = project(ORIGIN, e.lat!, e.lon!), name = e.tags!.name ?? "バス停";
    if (inVenue(at) || busStops.some((b) => b.name === name && Math.hypot(b.at[0] - at[0], b.at[1] - at[1]) < 40)) continue;
    busStops.push({ at, name });
  }
  const taxis = det.filter((e) => e.tags?.amenity === "taxi" && e.lat).map((e) => project(ORIGIN, e.lat!, e.lon!));
  // 歩行者デッキと地上をむすぶ階段・エスカレーター：OSM の階段（layer のないものも）のうち、片方の端がデッキ（広場・線）か
  // 会場の 2F の床にかかっているもの。その端を 2F の高さ、もう片方を地上にする（ユーザーの指摘：駅への道のデッキから 1F に降りられない。
  // 東京ビッグサイト駅の前の階段 way 243799255・243799257 などは layer がなく、地上の平らな帯として描いていた）
  const segDist = (q: XZ, a2: XZ, b2: XZ) => {
    const dx = b2[0] - a2[0], dz = b2[1] - a2[1], L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((q[0] - a2[0]) * dx + (q[1] - a2[1]) * dz) / L2));
    return Math.hypot(q[0] - a2[0] - t * dx, q[1] - a2[1] - t * dz);
  };
  const polyDist = (q: XZ, pl: XZ[]) => (pointInPolygon(q, pl) ? 0 : Math.min(...pl.map((a2, i) => segDist(q, a2, pl[(i + 1) % pl.length]))));
  const lv2Polys = areas.filter((a) => a.level === 2).map((a) => a.poly);
  const deckDist = (q: XZ) =>
    Math.min(
      ...decks.map((d) => polyDist(q, d.poly)),
      ...sur.lines.filter((l) => l.kind === "deck").map((l) => Math.min(...l.pts.slice(1).map((b2, i) => segDist(q, l.pts[i], b2))) - l.w / 2),
      ...lv2Polys.map((pl) => polyDist(q, pl)),
    );
  // y：上の端の高さ（ないときは 2F）。pts：折り返す階段の道すじ（上の端から下の端へ。まっすぐな階段にはない）
  const deckStairs: { from: XZ; to: XZ; w: number; esc?: boolean; y?: number; tower?: boolean; pts?: XZ[] }[] = [];
  const pathLen = (pts: XZ[]) => pts.slice(1).reduce((s2, q, i) => s2 + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0);
  // 両方の端がデッキの広場の中にある階段は、広場の形が階段の上まで含んでいる（東京ビッグサイト駅の南の、屋根つきの
  // エスカレーターと階段 way 243799255：OSM の広場の細い尾）。階段の形（幅＋1m）を広場から切りとってから、上の端を決める
  const stairRect = (pts: XZ[], w: number): [number, number][] => {
    const [a2, b2] = [pts[0], pts.at(-1)!], L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]) || 1;
    const ux = (b2[0] - a2[0]) / L, uz = (b2[1] - a2[1]) / L, h = w / 2 + 0.5;
    const r: XZ[] = [[a2[0] - uz * h - ux * 0.5, a2[1] + ux * h - uz * 0.5], [b2[0] - uz * h + ux * 0.5, b2[1] + ux * h + uz * 0.5], [b2[0] + uz * h + ux * 0.5, b2[1] - ux * h + uz * 0.5], [a2[0] + uz * h - ux * 0.5, a2[1] - ux * h - uz * 0.5]];
    return [...r, r[0]].map(([x, z]) => [x, z]);
  };
  for (const l of sur.lines.filter((x) => x.kind === "steps")) {
    const inDeck = (q: XZ) => decks.some((d) => pointInPolygon(q, d.poly));
    if (!inDeck(l.pts[0]) || !inDeck(l.pts.at(-1)!)) continue;
    const cut2 = stairRect(l.pts, Math.max(3, l.w));
    for (let i = decks.length - 1; i >= 0; i--) {
      const d = decks[i];
      const res = polygonClipping.difference([[...d.poly, d.poly[0]].map(([x, z]) => [x, z] as [number, number]), ...(d.holes ?? []).map((h) => [...h, h[0]].map(([x, z]) => [x, z] as [number, number]))], [cut2]);
      decks.splice(i, 1, ...res.filter((pg) => pg[0].length > 3).map((pg) => ({ poly: pg[0].slice(0, -1).map(([x, z]) => [x, z] as XZ), ...(pg.length > 1 ? { holes: pg.slice(1).map((h) => h.slice(0, -1).map(([x, z]) => [x, z] as XZ)) } : {}) })));
    }
  }
  const cand = [
    ...deckSteps.map((d) => ({ pts: d.pts, esc: d.esc, w: 3, line: null as SLine | null })),
    ...sur.lines.filter((l) => l.kind === "steps").map((l) => ({ pts: l.pts, esc: !!l.esc, w: Math.max(3, l.w), line: l as SLine | null })),
  ];
  const usedSteps = new Set<SLine>();
  // 会場の階段（stairs）と同じ所を通る OSM の階段は、会場の階段のほうで描くので描かない。エントランスプラザ（2F）から
  // 西の屋上展示場（4F）へ上がる外の階段（way 381682023、layer 2）を、プラザから地上へ下りる階段と取りちがえて二重に描いていた
  const sameAsVenueStair = (pts: XZ[]) => {
    const [p, q] = [pts[0], pts.at(-1)!];
    const d = (a2: XZ, b2: XZ) => Math.hypot(a2[0] - b2[0], a2[1] - b2[1]);
    return stairs.some((s) => Math.min(d(p, s.from) + d(q, s.to), d(p, s.to) + d(q, s.from)) < 12);
  };
  for (const c of cand) {
    const [a2, b2] = [c.pts[0], c.pts.at(-1)!];
    if (sameAsVenueStair(c.pts)) {
      if (c.line) usedSteps.add(c.line);
      continue;
    }
    const da = deckDist(a2), db = deckDist(b2);
    if (Math.min(da, db) > 3 || Math.abs(da - db) < 1) continue; // どちらの端もデッキから遠い（地上の階段）か、両方の端がデッキの上
    if (inVenue(centroid(c.pts)) && !c.line) continue;
    // 折り返す階段（OSM の線が、両端を結ぶ直線より 2 割以上長い）は、線のとおりに描く。両端を結ぶ直線で描くと、
    // 短い所で高さを上るので壁のように立つ（デッキの角の下の階段 way 642798317：直線 9m・線 27m。航空写真でも 2 本並ぶ）
    const path = da < db ? [...c.pts] : [...c.pts].reverse();
    const fold = c.pts.length > 2 && pathLen(c.pts) > 1.2 * Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
    // 上の端がデッキの少し手前（3m まで）で止まっているときは、最初の向きのままデッキの上 1m まで伸ばす
    const g0 = Math.min(da, db);
    if (g0 > 0.2) {
      const [p0, p1] = [path[0], path[1]], L = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
      const ext: XZ = [p0[0] + ((p0[0] - p1[0]) / L) * (g0 + 1), p0[1] + ((p0[1] - p1[1]) / L) * (g0 + 1)];
      if (deckDist(ext) <= 0) path.unshift([Math.round(ext[0] * 10) / 10, Math.round(ext[1] * 10) / 10]);
    }
    deckStairs.push({ from: path[0], to: path.at(-1)!, w: c.w, ...(c.esc ? { esc: true } : {}), ...(fold || path.length > c.pts.length ? { pts: path } : {}) });
    if (c.line) usedSteps.add(c.line);
  }
  sur.lines = sur.lines.filter((l) => !usedSteps.has(l));
  // 駅とデッキのつなぎ：駅（kind "station"）の 10m 以内までデッキ（広場・線）が来ている所は、いちばん近い所どうしを幅 6m のデッキで
  // つなぐ（OSM の改札口の歩道（way 381908109 など）は、駅の建物（PLATEAU）の 3m ほど手前で終わっていて、デッキが駅に届かなかった）
  // OSM の改札口の歩道があれば、それを駅の建物のふちの 1.5m 先まで伸ばす
  const toEdge = (q: XZ, poly: XZ[]) => {
    let best2: { d: number; e: XZ } = { d: Infinity, e: q };
    poly.forEach((p0, i) => {
      const p1 = poly[(i + 1) % poly.length];
      const dx = p1[0] - p0[0], dz = p1[1] - p0[1], L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((q[0] - p0[0]) * dx + (q[1] - p0[1]) * dz) / L2));
      const e: XZ = [p0[0] + t * dx, p0[1] + t * dz], d = Math.hypot(q[0] - e[0], q[1] - e[1]);
      if (d < best2.d) best2 = { d, e };
    });
    return best2;
  };
  const gated = new Set<SBuilding>();
  for (const g of gateLines) {
    const st = buildings.filter((b) => b.kind === "station").map((b) => ({ b, ...toEdge(g[0], b.poly) })).sort((x, y) => x.d - y.d)[0];
    if (!st || st.d > 20) continue;
    const near0 = toEdge(g[0], st.b.poly).d < toEdge(g.at(-1)!, st.b.poly).d;
    const pts = near0 ? [...g].reverse() : [...g]; // 駅の側を最後に
    const end = toEdge(pts.at(-1)!, st.b.poly);
    const ux = (end.e[0] - pts.at(-1)![0]) / (end.d || 1), uz = (end.e[1] - pts.at(-1)![1]) / (end.d || 1);
    sur.lines.push({ pts: [...pts, [end.e[0] + ux * 1.5, end.e[1] + uz * 1.5]], y: FLOOR_Y[2], w: 6, kind: "deck" });
    gated.add(st.b);
  }
  for (const st of buildings.filter((b) => b.kind === "station" && !gated.has(b))) {
    const deckPts: XZ[] = [...decks.flatMap((d) => d.poly), ...sur.lines.filter((l) => l.kind === "deck").flatMap((l) => l.pts)];
    let best: { d: number; a: XZ; b: XZ } | null = null;
    for (const q of deckPts)
      st.poly.forEach((p0, i) => {
        const p1 = st.poly[(i + 1) % st.poly.length];
        const dx = p1[0] - p0[0], dz = p1[1] - p0[1], L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((q[0] - p0[0]) * dx + (q[1] - p0[1]) * dz) / L2));
        const e: XZ = [p0[0] + t * dx, p0[1] + t * dz], d = Math.hypot(q[0] - e[0], q[1] - e[1]);
        if (!best || d < best.d) best = { d, a: q, b: e };
      });
    if (!best) continue;
    const bb = best as { d: number; a: XZ; b: XZ };
    if (bb.d > 10 || bb.d < 0.3) continue;
    const ux = (bb.b[0] - bb.a[0]) / bb.d, uz = (bb.b[1] - bb.a[1]) / bb.d;
    sur.lines.push({ pts: [[bb.a[0] - ux * 2, bb.a[1] - uz * 2], [bb.b[0] + ux * 1.5, bb.b[1] + uz * 1.5]], y: FLOOR_Y[2], w: 6, kind: "deck" });
  }
  // 広場のふちの手すり：ふちの 1m ごとに、すぐ外がほかのデッキ（広場・線）でも会場の 2F の床でもない所だけ
  const lv2 = areas.filter((a) => a.level === 2).map((a) => a.poly);
  const deckLines2 = sur.lines.filter((l) => l.kind === "deck");
  const nearLine = (q: XZ) =>
    deckLines2.some((l) => l.pts.some((p0, i) => {
      const p1 = l.pts[i + 1];
      if (!p1) return false;
      const dx = p1[0] - p0[0], dz = p1[1] - p0[1], L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((q[0] - p0[0]) * dx + (q[1] - p0[1]) * dz) / L2));
      return Math.hypot(q[0] - p0[0] - t * dx, q[1] - p0[1] - t * dz) < l.w / 2 + 0.3;
    }));
  const deckRails: XZ[][] = [];
  for (const d of decks)
    for (const r of [d.poly, ...(d.holes ?? [])])
      r.forEach((p0, i) => {
        const p1 = r[(i + 1) % r.length], L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        if (L < 0.3) return;
        const ux = (p1[0] - p0[0]) / L, uz = (p1[1] - p0[1]) / L;
        const mid: XZ = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        let nx = -uz, nz = ux;
        if (onDeck([mid[0] + nx * 0.3, mid[1] + nz * 0.3])) [nx, nz] = [-nx, -nz]; // 外向き
        const n = Math.max(1, Math.round(L));
        let run: XZ[] = [];
        const flush = () => {
          if (run.length >= 2) deckRails.push(run);
          run = [];
        };
        for (let k = 0; k <= n; k++) {
          const q: XZ = [p0[0] + (ux * L * k) / n, p0[1] + (uz * L * k) / n];
          const out: XZ = [q[0] + nx * 0.8, q[1] + nz * 0.8];
          // 階段・エスカレーターの上の端も開ける
          const atStair = deckStairs.some((st) => Math.hypot(q[0] - st.from[0], q[1] - st.from[1]) < st.w / 2 + 2);
          const open = onDeck(out) || lv2.some((pl) => pointInPolygon(out, pl)) || nearLine(out) || inVenue(out) || atStair;
          if (open) flush();
          else run.push([Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]);
        }
        flush();
      });
  Object.assign(sur, { decks, deckRails });
  // 駅の出口の歩道橋（有明駅）：PLATEAU では、道の上を渡る通路・出口の建物・屋根つきのエスカレーターが、まとめて地面から
  // 屋根まで詰まった 1 つの箱（高さ 13〜14m）になっていて、エスカレーターが建物の壁に貼りついて見えた（ユーザーの指摘）。
  // OSM のエスカレーター（conveying）が床の 2 割より多くを通る、小さめの建物（100〜1500 m²）を、
  // ・エスカレーターに沿った帯（幅 9m）→ 傾いた屋根つきの通路（kind "tube"）
  // ・残り → 歩道橋の高さから上だけの建物（kind "bridgeHouse"、下は柱で、車や人が通れる）
  // に分ける。歩道橋の床の高さは資料がないので、PLATEAU の屋根の高さから 3.5m（通路の天井まで）引いた見当
  {
    const rg = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
    const ringA = (r: XZ[]) => Math.abs(r.reduce((s2, p, i) => s2 + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
    const mpA = (mp: [number, number][][][]) => mp.reduce((s2, pg) => s2 + ringA(pg[0].slice(0, -1) as XZ[]) - pg.slice(1).reduce((s3, h) => s3 + ringA(h.slice(0, -1) as XZ[]), 0), 0);
    const band = (a2: XZ, b2: XZ, hw: number, ext0: number, ext1: number): [number, number][] => {
      const L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]) || 1, ux = (b2[0] - a2[0]) / L, uz = (b2[1] - a2[1]) / L;
      const p0: XZ = [a2[0] + ux * ext0, a2[1] + uz * ext0], p1: XZ = [b2[0] + ux * ext1, b2[1] + uz * ext1];
      const r: XZ[] = [[p0[0] - uz * hw, p0[1] + ux * hw], [p1[0] - uz * hw, p1[1] + ux * hw], [p1[0] + uz * hw, p1[1] - ux * hw], [p0[0] + uz * hw, p0[1] - ux * hw]];
      return [...r, r[0]].map(([x, z]) => [x, z]);
    };
    const escs = deckStairs.filter((st) => st.esc);
    const found: { i: number; b: SBuilding; tubes: { poly: XZ[]; st: (typeof deckStairs)[number] }[]; rest: XZ[][] }[] = [];
    buildings.forEach((b, i) => {
      if (b.kind) return;
      const A = ringA(b.poly);
      if (A < 100 || A > 1500) return;
      const own = [rg(b.poly)];
      const hit = escs.filter((st) => mpA(polygonClipping.intersection(own, [band(st.from, st.to, 4, 0, 0)])) > 0.2 * A);
      if (!hit.length) return;
      // 帯は、上の端から 3m 下りた所から、下の端の 2m 先まで（上の端のまわりは出口の建物のほう）
      const tubes = hit.flatMap((st) =>
        polygonClipping.intersection(own, [band(st.from, st.to, 4.5, 3, 2)]).map((pg) => ({ poly: pg[0].slice(0, -1).map(([x, z]) => [x, z] as XZ), st })),
      );
      const rest = polygonClipping
        .difference(own, ...hit.map((st) => [band(st.from, st.to, 4.5, 3, 2)]))
        .filter((pg) => ringA(pg[0].slice(0, -1) as XZ[]) >= 10)
        .map((pg) => pg[0].slice(0, -1).map(([x, z]) => [x, z] as XZ));
      found.push({ i, b, tubes, rest });
    });
    if (found.length) {
      const deckY = Math.round((found.reduce((s2, f) => s2 + f.b.h, 0) / found.length - 3.5) * 2) / 2;
      const est = `歩道橋の床の高さ ${deckY}m は、PLATEAU の屋根の高さから 3.5m 引いた見当`;
      const near = (q: XZ, poly: XZ[], d: number) => pointInPolygon(q, poly) || polyDist(q, poly) < d;
      // 歩道橋の床（OSM のデッキの線）：分けた建物にかかる線と、それにつながる線（駅とのつなぎも）を、この高さにする
      const all = found.flatMap((f) => [...f.rest, ...f.tubes.map((t) => t.poly)]);
      const lines = sur.lines.filter((l) => l.kind === "deck");
      const on = new Set(lines.filter((l) => l.pts.some((q) => all.some((pl) => near(q, pl, 1)))));
      for (let grow = true; grow; ) {
        grow = false;
        for (const l of lines)
          if (!on.has(l) && [l.pts[0], l.pts.at(-1)!].some((q) => [...on].some((o) => Math.min(...o.pts.slice(1).map((b2, k) => segDist(q, o.pts[k], b2))) < 2))) {
            on.add(l);
            grow = true;
          }
      }
      for (const l of on) l.y = deckY;
      // 階段・エスカレーターの上の端も、この高さから。OSM の短い階段（長さが高さの 1.2 倍に足りない：折り返しの階段を短い線で
      // 描いている）は、まっすぐ描くと壁のように立つので、まわり 5m 四方を地面から歩道橋の床までの階段室（箱）にする
      for (const st of deckStairs) {
        if (!all.some((pl) => near(st.from, pl, 3))) continue;
        st.y = deckY;
        if (!st.esc && pathLen(st.pts ?? [st.from, st.to]) < deckY * 1.2) {
          st.tower = true;
          const r = band(st.from, st.to, 2.5, -1, 1).slice(0, -1).map(([x, z]) => [x, z] as XZ);
          buildings.push({ poly: r, h: deckY - 0.8, est: `折り返しの階段の階段室（${est}）` });
        }
      }
      for (const f of [...found].reverse()) {
        buildings.splice(
          f.i,
          1,
          ...f.rest.map((poly) => ({ poly, h: f.b.h, kind: "bridgeHouse" as const, base: deckY - 0.8, est })),
          ...f.tubes.map((t) => ({ poly: t.poly, h: f.b.h, kind: "tube" as const, slope: { from: t.st.from, to: t.st.to, y: deckY }, est })),
        );
      }
      console.log(`駅の出口の歩道橋：PLATEAU の箱 ${found.length} 個を、通路・出口の建物 ${found.reduce((s2, f) => s2 + f.rest.length, 0)} と屋根つきのエスカレーター ${found.reduce((s2, f) => s2 + f.tubes.length, 0)} に分けた（床 ${deckY}m・デッキの線 ${on.size} 本）`);
    }
  }
  Object.assign(sur, { buildings, greens, trees: treesOut, crossings, entrances, busStops, taxis, deckStairs });
  console.log(`周辺：建物 ${buildings.filter((b) => !b.kind).length}（PLATEAU にないもの ${buildings.filter((b) => b.est).length}）・屋根 ${buildings.filter((b) => b.kind).length}・緑地と駐車場 ${greens.length}・木 ${treesOut.length}・横断歩道 ${crossings.length}・駅の出入口 ${entrances.length}・バス停 ${busStops.length}・デッキ ${sur.lines.filter((l) => l.kind === "deck").length}・デッキの階段 ${deckStairs.length}`);
  for (const b of buildings.filter((b2) => b2.est)) console.log(`  高さの目安：${b.name ?? "（名前なし）"} ${b.h}m（${b.est}）`);
}

// 屋内と屋外の境目の仕切りにあける出口。公式フロアマップの赤い「入口」（エントランスホールからエントランスプラザへ。
// ユーザーの確認でコミケでは出口専用）。公式マップは斜めから見た図なので、会議棟の 4 本の柱の位置で座標に直した。
// エントランスホールの屋内が会議棟の前の柱の手前まで張り出した所の、南の端（v -18）
const exits = [
  { at: fromUV([[-4.5, -17.8]])[0], level: 2, name: "出口", width: 6 },
  // 4F アトリウムの斜めの端（上の 4F アトリウムの説明）から屋上展示場へ
  { at: fromUV([[133.1, 48.1]])[0], level: 4, name: "出入口", width: 6 },
  // 2F のコンコース（屋外）が南の角の建物（屋内）に入る所（建物の南西の 45° の面。公式フロアマップでは、コンコースがそのまま
  // 南1・2ホール入口へ続く）。通路が面を斜めに横切るので、横切る長さ（11m）ほど開ける
  { at: fromUV([[216.5, 110.2]])[0], level: 2, name: "出入口", width: 12 },
  // 4F：西4 からの通路（南展示棟への通路（4F））が南展示棟に入る所（建物の西の壁 u 236、v 34.4〜86）。公式フロアマップの 4F 図では、
  // 吹き抜けのある通路の床が、南3 の西の端のロビー（AED・エスカレーター・エレベーター）へ壁なしでひと続き。仕切りがふさいでいたので開ける
  { at: fromUV([[236, 60.2]])[0], level: 4, name: "出入口", width: 51 },
];

mkdirSync("src/data", { recursive: true });
writeFileSync(
  "src/data/venue.json",
  JSON.stringify({ origin: ORIGIN, floorY: FLOOR_Y, attribution: "© OpenStreetMap contributors (ODbL 1.0)・周辺の建物：国土交通省 PLATEAU（CC BY 4.0）を加工", osmFetchedAt: osm.fetchedAt, halls, areas, context, parts3d, surroundings: sur, toilets, toiletRooms, firstAid, doors, exits, stairs, blocks, canopies }),
);
console.log(`ホール ${halls.length}・通路 ${areas.length}・建物 ${context.length}（立体 ${parts3d.length}）・トイレ ${toilets.length}（図面 ${plan.toilets.length}）・救護室 ${firstAid.length}・出入口と搬入口 ${doors.length}・周辺の道と線路 ${sur.lines.length}・駅 ${sur.stations.length} を src/data/venue.json に`);
