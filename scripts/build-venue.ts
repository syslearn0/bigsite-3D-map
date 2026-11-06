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
type Area = { name: string; level: number; poly: XZ[]; see?: boolean; holes?: XZ[][]; under?: boolean; outdoor?: boolean; part?: boolean }; // under：ほかの床の下に敷く（名前の札を出さない）。part：穴で切れた床のかけら（名前の札を出さない）
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
// ピラミッド）。人は入れないので床にはせず、地面から 4F の上まで続く障害物（箱）として描く（斜めからの写真：下の方まで続く）。
// ただし 2F の床（コンコースと踊り場）と、中を通るエスカレーターの所はあける（下の「南の角の建物」）
const southEntrance: XZ[] = fromUV([[227.5, 87], [244.5, 104], [227.5, 121], [210.5, 104]]);
const blocks: { name: string; level: number; poly: XZ[]; height: number; holes?: XZ[][] }[] = [];

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
  // 基準に測ったもの）。南3・4 の北の通路（v 12.4〜34.4）とは u 214〜236 でつながる
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
  if (a4) a4.poly = fromUV([[56.6, -28.5], [149.8, -28.5], [149.8, 57.2], [124, 57.2], [124, -7], [56.6, -7]]);
  const roof = areas.find((a) => a.name === "屋上展示場");
  // 屋上展示場は天窓のすぐ南（v 39）から。天窓の西にも、白い破線の引かれた車の通路（u 70〜78）が 4F アトリウムの腕（v -7）まで続く
  // （航空写真・斜めからの写真。公式フロアマップの 4F 図でも、屋上展示場は吹き抜けの 2 辺を囲む）。その西は 2F 南コンコースの屋根。
  // 通路の南の端から屋上展示場の西の縁へは、写真のとおり斜めの縁（(70, 38)〜(61.5, 55.5)）
  if (roof) roof.poly = fromUV([[124, 57.2], [124, 39], [78, 39], [78, -7], [70, -7], [70, 38], [61.5, 55.5], [61.5, 103.2], [201.9, 103.3], [202.1, 57.2]]);
}
// 2F の形の手直し（公式フロアマップ・航空写真・OSM に合わせる）
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const unring = (r: [number, number][]): XZ[] => r.slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
  const size = (r: XZ[]) => Math.abs(r.reduce((s2, p, i) => s2 + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
  const biggest = (mp: [number, number][][][]): XZ[] => mp.map((pg) => unring(pg[0])).sort((a, b) => size(b) - size(a))[0];
  // エントランスホール：OSM の北コンコースの形には、会議棟の北のガラス屋根の建物（OSM の建物 154080987、layer=2）がまるごと
  // 入っている。公式フロアマップでは、ここはエントランスホール（北コンコースは、そこから東展示棟へ斜めにのびる所）
  const eh = poly(byId(154080987));
  const nc = areas.find((a) => a.name === "北コンコース")!;
  nc.poly = biggest(polygonClipping.difference([ring(nc.poly)], [ring(eh)]));
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
    // 奥に床のない切り欠き（エスカレーターの穴）。東は南コンコースの北東のふちまで屋内。西の辺は北コンコースとつながる所（u -31）
    areas.push({
      name: "エントランスホール",
      level: 2,
      poly: fromUV([
        [-31, -143.5], [23, -143], [23, -92.5], [67.5, -92], [69, -30.5], [24, -75.5], [23.5, -44.5], [13, -44.5], [13, -36.5], [21.5, -36.5],
        [22.5, -17.5], [-34.5, -18], [-34.5, -38], [-19, -37.5], [-19, -45], [-28, -45], [-28, -84], [-31, -84],
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
    sp1.poly = biggest(
      polygonClipping.union(
        polygonClipping.intersection([ring(sp1.poly)], [ring(fromUV([[-1000, -1000], [216, -1000], [216, 1000], [-1000, 1000]]))]),
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

// 屋外（屋根のない所）：公式フロアマップで灰色に塗られた所。ほかは屋内（白）
for (const a of areas) if (["屋上展示場", "エントランスプラザ", "イベントプラザ", "中央ターミナル", "南展示棟への通路", "南展示棟への通路（4F）", "外の通路（4F）"].includes(a.name)) a.outdoor = true;

// 階段（階のちがう2つの所をつなぐ）。屋上展示場（4F）からエントランスプラザ（2F）へ：OpenStreetMap の階段（way 381682023、
// layer=2）。屋上展示場の西の角から北西へ、エントランスプラザへ下りる。航空写真でも、ここに屋根のある幅 7m ほどの階段が見える
type Stair = { name: string; from: XZ; fromLevel: number; to: XZ; toLevel: number; width: number; kind?: "escalator" | "ramp"; outdoor?: boolean };
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

// 西の 4F の通路から 1F への車のスロープ（上の「外の通路（4F）」のところの説明）
{
  const [top, bottom] = fromUV([[196.5, -110], [54, -110]]);
  stairs.push({ name: "スロープ", kind: "ramp", from: top, fromLevel: 4, to: bottom, toLevel: 1, width: 12, outdoor: true });
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
    return { poly: poly(e), min, max, color: t["building:colour"] ?? null, name: t.name ?? "", part: !!t["building:part"] };
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
const planToilets = (plan.toilets as { at: XZ; level: number; kinds: string[]; hall?: string }[]).filter((t) => usable(t.hall));
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
  // 東ガレリアの北の端と、東7・リンクスペース・東8 のあいだ（航空写真：屋根のある通路でつながっている）。屋内の床
  {
    let res = polygonClipping.union([ring(fromUV([[-33, -572], [18, -572], [18, -538], [-33, -538]]))]);
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
  outside("南棟立体駐車場", 1, [[[401, 34.4], [446, 34.4], [446, 124], [401, 124]]], ["南展示棟"]);
  outside("南棟立体駐車場", 4, [[[401, 34.4], [446, 34.4], [446, 124], [401, 124]]], ["南展示棟（4F）"], false);
  // 南：南3・南4 の北の 4F の通路（西4 の外の通路から、南展示棟への通路（4F）を通って続く。航空写真で v 12〜34）
  outside("外の通路（4F）", 4, [[[214, 12.4], [444.6, 12.4], [444.6, 34.4], [214, 34.4]]], ["南展示棟（4F）"]);
}

// 床のない所（ホール・通路の床の外）にあるトイレ：近くに部屋の囲みがあれば札をその部屋の真ん中へ、なければ壁ぎわ（壁の 1m 外）へ。
// 会場から離れた OpenStreetMap のトイレ（会場の床から 15m より遠い）は「周辺」の扱いにして、「周辺も表示」のときだけ出す
{
  const floorsAt = (lv: number) => [...halls.filter((h) => h.level === lv && !h.closed).map((h) => h.poly), ...areas.filter((a) => a.level === lv).map((a) => a.poly)];
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
  return { at: Math.hypot(w[0] - d.at[0], w[1] - d.at[1]) > 15 ? d.at : w, level: d.level, kind: d.kind, hall: d.hall };
});

// 周辺の道・線路・駅（data/osm/surroundings.json、npm run fetch:surroundings が作る）。「周辺も表示」で使う。
// 高さは OSM の layer（何層目か）から：歩道・道路は 1層＝2F の高さ（2F の歩行者デッキと同じ）、ゆりかもめの高架は 4m + 1層 2.5m。
// 地下（tunnel・layer がマイナス）は描かない（りんかい線は駅の名前だけ）
type SLine = { pts: XZ[]; y: number; w: number; kind: "road" | "walk" | "steps" | "rail" };
type SArea = { poly: XZ[]; y: number; kind: "walk" | "platform" | "water"; name?: string; labels?: XZ[]; holes?: XZ[][] };
type SStation = { name: string; line: string; at: XZ; y: number };
const sur = { lines: [] as SLine[], areas: [] as SArea[], stations: [] as SStation[] };
if (existsSync("data/osm/surroundings.json")) {
  const so = JSON.parse(readFileSync("data/osm/surroundings.json", "utf8")) as { elements: El[] };
  const WIDTH: Record<string, number> = { motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 7, unclassified: 6, residential: 6, service: 4, pedestrian: 6, footway: 2.5, path: 2, cycleway: 2, steps: 2.5 };
  for (const e of so.elements) {
    const t = e.tags ?? {};
    const layer = Number(t.layer) || 0;
    if (t.tunnel === "yes" || layer < 0 || Number(t.level) < 0) continue;
    if (e.type === "node" && (t.railway === "station" || (t.public_transport === "station" && t.railway))) {
      const line = t.light_rail === "yes" ? "ゆりかもめ" : "りんかい線";
      sur.stations.push({ name: `${t.name}駅`, line, at: project(ORIGIN, e.lat!, e.lon!), y: line === "ゆりかもめ" ? 9 : 0 });
      continue;
    }
    if (!e.geometry) continue;
    const pts = e.geometry.map((g) => project(ORIGIN, g.lat, g.lon));
    if (t.railway === "platform") {
      sur.areas.push({ poly: pts, y: 4 + Math.max(2, layer) * 2.5 + 0.5, kind: "platform" });
    } else if (t.railway && t.railway !== "station") {
      sur.lines.push({ pts, y: layer > 0 ? 4 + layer * 2.5 : 0.1, w: layer > 0 ? 7 : 3, kind: "rail" });
    } else if (t.highway) {
      const walk = /^(pedestrian|footway|path|cycleway|steps)$/.test(t.highway);
      // 2F 以上の歩道・階段（OSM の layer ≥ 1）は、会場の 2F の床・階段として描いているので出さない（重なって、床の上に変な線が浮く）。
      // 高架の道路は、2F の床より少し下（8m）に
      if (walk && layer >= 1) continue;
      const y = layer >= 1 ? 8 : walk ? 0.06 : 0.03;
      if (t.area === "yes" && pts.length > 3) sur.areas.push({ poly: pts, y, kind: "walk" });
      else sur.lines.push({ pts, y, w: WIDTH[t.highway] ?? 3, kind: t.highway === "steps" ? "steps" : walk ? "walk" : "road" });
    }
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

// 南の角の建物（45° の四角）：地面（1F）から 4F の床の 6m 上まで。2F の床と、中を通るエスカレーター（幅 +1m、下の端の 2m 先まで）
// の所は引く。1F の床（南展示棟への通路）からは、この建物の形を引く（4F の床とは重なってよい）
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  let shape: [number, number][][][] = [[ring(southEntrance)]];
  for (const a of areas.filter((x) => x.level === 2)) shape = polygonClipping.difference(shape, [ring(a.poly)]);
  // 中を通るのは 2F から 1F へ下りるエスカレーターだけ（4F からのものはコンコースの上を通る）
  for (const st of stairs.filter((x) => x.fromLevel === 2 && x.toLevel === 1)) {
    const L = Math.hypot(st.from[0] - st.to[0], st.from[1] - st.to[1]) || 1, ux = (st.from[0] - st.to[0]) / L, uz = (st.from[1] - st.to[1]) / L;
    const hw = st.width / 2 + 0.5, a: XZ = [st.to[0] - ux * 2, st.to[1] - uz * 2], b = st.from;
    shape = polygonClipping.difference(shape, [ring([[a[0] - uz * hw, a[1] + ux * hw], [b[0] - uz * hw, b[1] + ux * hw], [b[0] + uz * hw, b[1] - ux * hw], [a[0] + uz * hw, a[1] - ux * hw]])]);
  }
  for (const pg of shape) {
    const un = (r: [number, number][]) => r.slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
    if (Math.abs(pg[0].reduce((t, q, i) => (i + 1 < pg[0].length ? t + q[0] * pg[0][i + 1][1] - pg[0][i + 1][0] * q[1] : t), 0)) / 2 < 30) continue; // 細い切れ端は出さない
    blocks.push({ name: "南の角の建物", level: 1, poly: un(pg[0]), height: FLOOR_Y[4] + 6, holes: pg.length > 1 ? pg.slice(1).map(un) : undefined });
  }
  for (const a of areas.filter((x) => x.level === 1 && x.name === "南展示棟への通路")) {
    const left = polygonClipping.difference([ring(a.poly)], ...shape);
    const area2 = (r: [number, number][]) => Math.abs(r.reduce((t, q, i) => (i + 1 < r.length ? t + q[0] * r[i + 1][1] - r[i + 1][0] * q[1] : t), 0));
    if (left.length) a.poly = left.map((pg) => pg[0]).sort((p, q) => area2(q) - area2(p))[0].slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ);
  }
}

// 屋内と屋外：公式フロアマップの色分け（白が屋内、灰が屋外）に合わせる。
// 連絡ブリッジは屋内（ユーザーの確認：屋根と壁のある通路）。コンコースは、イベントプラザから南展示棟の入口（45° の四角）までが灰（屋外）、
// そこから先の南1・南2 にそう所は白（屋内）なので、そこで 2 つに分ける
{
  const ring = (r: XZ[]): [number, number][] => [...r, r[0]].map(([x, z]) => [x, z]);
  const half = (west: boolean) => ring(fromUV(west ? [[-1000, -1000], [236, -1000], [236, 1000], [-1000, 1000]] : [[236, -1000], [2000, -1000], [2000, 1000], [236, 1000]]));
  for (const a of areas) if (a.name === "連絡ブリッジ") a.outdoor = false; // 連絡ブリッジは屋根と壁のある屋内の通路
  for (const a of areas.filter((x) => x.name === "コンコース" && x.level === 2)) {
    const pieces = [true, false].flatMap((west) =>
      polygonClipping.intersection([ring(a.poly), ...(a.holes ?? []).map(ring)], [half(west)]).map((pg) => ({
        ...a,
        poly: pg[0].slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ),
        holes: pg.length > 1 ? pg.slice(1).map((h) => h.slice(0, -1).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as XZ)) : undefined,
        outdoor: west,
      })),
    );
    // 名前の札は 1 つだけ（最初のかけら＝屋外の長い本体）。ほかのかけらにも出すと、同じ名前が並ぶ
    pieces.forEach((pc, k) => {
      if (k > 0 && !a.part) pc.part = true;
    });
    areas.splice(areas.indexOf(a), 1, ...pieces);
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
  const footprints = [...halls.map((h) => h.poly), ...areas.map((a) => a.poly), southEntrance, ...ramps];
  const inVenue = (p: XZ) => footprints.some((f) => pointInPolygon(p, f));
  for (let i = parts3d.length - 1; i >= 0; i--) {
    const b = parts3d[i];
    if (/Conference Tower|会議棟/.test(b.name)) continue;
    if (inVenue(centroid(b.poly))) parts3d.splice(i, 1);
  }
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
}

// 屋内と屋外の境目の仕切りにあける出口。公式フロアマップの赤い「入口」（エントランスホールからエントランスプラザへ。
// ユーザーの確認でコミケでは出口専用）。公式マップは斜めから見た図なので、会議棟の 4 本の柱の位置で座標に直した。
// エントランスホールの屋内が会議棟の前の柱の手前まで張り出した所の、南の端（v -18）
const exits = [{ at: fromUV([[-4.5, -17.8]])[0], level: 2, name: "出口", width: 6 }];

mkdirSync("src/data", { recursive: true });
writeFileSync(
  "src/data/venue.json",
  JSON.stringify({ origin: ORIGIN, floorY: FLOOR_Y, attribution: "© OpenStreetMap contributors (ODbL 1.0)", osmFetchedAt: osm.fetchedAt, halls, areas, context, parts3d, surroundings: sur, toilets, toiletRooms, firstAid, doors, exits, stairs, blocks }),
);
console.log(`ホール ${halls.length}・通路 ${areas.length}・建物 ${context.length}（立体 ${parts3d.length}）・トイレ ${toilets.length}（図面 ${plan.toilets.length}）・救護室 ${firstAid.length}・出入口と搬入口 ${doors.length}・周辺の道と線路 ${sur.lines.length}・駅 ${sur.stations.length} を src/data/venue.json に`);
