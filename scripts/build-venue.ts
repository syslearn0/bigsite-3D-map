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
let southLine: XZ[] = [];
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
  southLine = pts;
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
// ホール a の、ホール b に向かい合う辺を、b の向かい合う辺の線まで直角にのばした四角
function rectBetween(a: string, b: string, extra: XZ[] = []): XZ[] {
  const pa = halls.find((h) => h.id === a)!.poly, pb = halls.find((h) => h.id === b)!.poly;
  const facing = (p: XZ[], toward: XZ): [XZ, XZ] => {
    let best: [number, [XZ, XZ]] = [Infinity, [p[0], p[1]]];
    p.forEach((q, i) => {
      const r2 = p[(i + 1) % p.length];
      const d = Math.hypot((q[0] + r2[0]) / 2 - toward[0], (q[1] + r2[1]) / 2 - toward[1]);
      if (d < best[0]) best = [d, [q, r2]];
    });
    return best[1];
  };
  const [p1, p2] = facing(pa, centroid(pb)), [q1, q2] = facing(pb, centroid(pa));
  const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), ux = (p2[0] - p1[0]) / L, uz = (p2[1] - p1[1]) / L;
  const nx = -uz, nz = ux;
  // extra の点のうち、a の辺の線の上（3m 以内）にあるものまで、辺をのばす
  let t0 = 0, t1 = L;
  for (const q of extra) {
    const t = (q[0] - p1[0]) * ux + (q[1] - p1[1]) * uz, v = (q[0] - p1[0]) * nx + (q[1] - p1[1]) * nz;
    if (Math.abs(v) <= 3) [t0, t1] = [Math.min(t0, t), Math.max(t1, t)];
  }
  const s1: XZ = [p1[0] + ux * t0, p1[1] + uz * t0], s2: XZ = [p1[0] + ux * t1, p1[1] + uz * t1];
  const off = (q1[0] - p1[0]) * nx + (q1[1] - p1[1]) * nz; // b の辺の線までの距離（a の辺に直角に）
  const r = (v: number) => Math.round(v * 10) / 10;
  return [[r(s1[0]), r(s1[1])], [r(s2[0]), r(s2[1])], [r(s2[0] + nx * off), r(s2[1] + nz * off)], [r(s1[0] + nx * off), r(s1[1] + nz * off)]];
  void q2;
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
const southLinkRoof: XZ[] = poly(byName("屋上展示場")); // 西4〜南3 の 4F の面を、屋上展示場の端までのばすのに使う
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
    holes: (existsSync("data/plan-toilets.json") ? ((JSON.parse(readFileSync("data/plan-toilets.json", "utf8")) as { voids?: XZ[][] }).voids ?? []) : []).filter((v) =>
      pointInPolygon(centroid(v), poly(byId(543048845))),
    ),
  },
  { name: "南展示棟への通路", level: 1, poly: southPassage },
  // 4F でも、西4ホールと南3・4ホールは通路でつながる（ビッグサイトの館内図）。形は細かい図がないので、
  // 西4 の南東の壁の真ん中から、南3 の北西の壁の真ん中までの、幅 14m のまっすぐな通路にする
  // 西4 と南3 のあいだの 4F の通路・広場。航空写真では、西4 と南3 の向かい合う壁のあいだが、壁に直角な四角い舗装面でつながっている。
  // 西4 の向かい合う壁と、同じ線の上に続く屋上展示場の端（航空写真：ホールの外の屋上がそのまま南へ続く）を合わせた辺を、
  // 南3 の壁の線まで直角にのばした四角にする
  { name: "南展示棟への通路（4F）", level: 4, poly: rectBetween("W4", "S3", southLinkRoof) },
  // コンコース（2F）：イベントプラザから南展示棟まで 2F のまま続く長い通路（公式フロアマップの「コンコース」）。
  // 形は OpenStreetMap の 2F の歩道の線（way 1127507757、layer=2）を幅 8m の帯にしたもの（南1・2 の西わきを南棟の駐車場まで続く）
  ...southConcourse(),
  // 南コンコース（西）：エントランスプラザと西の 4F アトリウムのあいだの 2F の通路（OSM way 154080986）。公式の図ではここに 4F・1F へのエスカレーターが着く
  // 南コンコース（西）：エントランスプラザの東、西のアトリウムまで。OSM の形は斜めの辺が多いので、西展示棟の壁の向き（下の WEST_U・WEST_V）
  // にそろえた四角 2 つにする：アトリウムの西の縁 (u=75.6) とエントランスプラザの東の縁 (u=43.7) のあいだと、エントランスホールへ北へのびる所
  { name: "南コンコース", level: 2, poly: fromUV([[43.7, -38.3], [75.6, -38.3], [75.6, 22.7], [43.7, 22.7]]) },
  { name: "南コンコース", level: 2, poly: fromUV([[21.2, -71.4], [50.5, -71.4], [50.5, -38.3], [21.2, -38.3]]), under: true },
  { name: "南展示棟", level: 1, poly: southRest },
  // 4F も、南3・4 のまわりのロビー・通路・トイレは南展示棟の建物の中（1F と同じ建物の形の床）
  { name: "南展示棟（4F）", level: 4, poly: southRest, under: true },
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
  // 屋上展示場は天窓のすぐ南（v 39）から。天窓より西は v 57 から（写真で屋根のちがう所）
  if (roof) roof.poly = fromUV([[124, 57.2], [124, 39], [78, 39], [78, 57.1], [61.5, 57.1], [61.5, 103.2], [201.9, 103.3], [202.1, 57.2]]);
}
// 西3・西4 の外の 4F の通路（トラックが上がってくる搬入の通路。屋外）：航空写真で、西3 の北東の壁の外（v -97.5 まで、
// u 53 から）と、西4 の南東の壁の外（u 214 まで）に、車の止まった通路がある。南東の通路は南展示棟への通路（4F）につながる
areas.push({ name: "外の通路（4F）", level: 4, poly: fromUV([[53, -97.5], [214, -97.5], [214, 16], [202, 16], [202, -70.7], [149.8, -70.7], [149.8, -78.4], [53, -78.4]]) });

// 屋外（屋根のない所）：公式フロアマップで灰色に塗られた所。ほかは屋内（白）
for (const a of areas) if (["屋上展示場", "エントランスプラザ", "イベントプラザ", "中央ターミナル", "南展示棟への通路", "南展示棟への通路（4F）", "外の通路（4F）"].includes(a.name)) a.outdoor = true;

// 階段（階のちがう2つの所をつなぐ）。屋上展示場（4F）からエントランスプラザ（2F）へ：OpenStreetMap の階段（way 381682023、
// layer=2）。屋上展示場の西の角から北西へ、エントランスプラザへ下りる。航空写真でも、ここに屋根のある幅 7m ほどの階段が見える
type Stair = { name: string; from: XZ; fromLevel: number; to: XZ; toLevel: number; width: number; kind?: "escalator" };
const stairs: Stair[] = [];
{
  const so = existsSync("data/osm/surroundings.json") ? (JSON.parse(readFileSync("data/osm/surroundings.json", "utf8")) as { elements: El[] }) : { elements: [] };
  const e = so.elements.find((x) => x.id === 381682023 && x.geometry);
  if (!e) throw new Error("屋上展示場への階段：OSM の way 381682023 がない");
  const g = e.geometry!.map((q) => project(ORIGIN, q.lat, q.lon));
  const top = g[0], bottom = g[g.length - 1];
  const L = Math.hypot(top[0] - bottom[0], top[1] - bottom[1]), ux = (top[0] - bottom[0]) / L, uz = (top[1] - bottom[1]) / L;
  const r = (v: number) => Math.round(v * 10) / 10;
  // 上の端は屋上展示場の中へ 1.5m のばす
  stairs.push({ name: "階段", from: [r(top[0] + ux * 1.5), r(top[1] + uz * 1.5)], fromLevel: 4, to: [r(bottom[0]), r(bottom[1])], toLevel: 2, width: 7 });
}

// エスカレーター（ビッグサイトの館内図・図面にあるもの。位置と長さは目安）
{
  const r = (v: number) => Math.round(v * 10) / 10;
  const areaOf = (n: string) => areas.find((a) => a.name === n)!.poly;
  // 西・南のエスカレーター：公式フロアマップの、階どうしを点線でつないだエスカレーターの印から。
  // 印の位置は、その階のホールの四すみで公式の図を会場の座標に合わせて写したもの（誤差は 1〜9m）。
  // 向き：公式の図には向きがないので、西の 1F⇔4F はストリートビューで見た向き（南南西へ上がる）、ほかは近くの通路の向き
  {
    const run = (lo: number, hi: number) => (FLOOR_Y[hi] - FLOOR_Y[lo]) * 1.8; // 30° ほどの傾き
    const put = (center: XZ, dir: XZ, lo: number, hi: number, width = 2) => {
      const L = run(lo, hi) / 2, n = Math.hypot(dir[0], dir[1]);
      let ux = dir[0] / n, uz = dir[1] / n;
      // 上の端がその階の床に乗らないときは、向きを反対にする（反対なら乗るとき）
      const top = (k: number): XZ => [center[0] + ux * L * k, center[1] + uz * L * k];
      if (!onFloor(top(1), hi) && onFloor(top(-1), hi)) [ux, uz] = [-ux, -uz];
      stairs.push({ name: "エスカレーター", kind: "escalator", from: [r(center[0] + ux * L), r(center[1] + uz * L)], fromLevel: hi, to: [r(center[0] - ux * L), r(center[1] - uz * L)], toLevel: lo, width });
    };
    const bearing = (deg: number): XZ => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];
    // 西 13：1F アトリウム ⇔ 4F アトリウム（屋内）。1F の端は公式の図の印の所 (31, 103)。上の端は屋内の 4F アトリウムの中
    // （屋外の屋上展示場ではない）：公式の 4F 図で、エスカレーターは白い屋内の通路から吹き抜けへ下りている。
    // 4F アトリウムの、1F の端からちょうど長さ（30° ほど）の所 (42, 138)。ストリートビューで見た南南西への向きとも 25° ほどの差
    {
      const top: XZ = [42, 138], bottom: XZ = [31, 103];
      const L = run(1, 4), d = Math.hypot(bottom[0] - top[0], bottom[1] - top[1]);
      stairs.push({ name: "エスカレーター", kind: "escalator", from: top, fromLevel: 4, to: [r(top[0] + ((bottom[0] - top[0]) / d) * L), r(top[1] + ((bottom[1] - top[1]) / d) * L)], toLevel: 1, width: 4 });
    }
    void bearing;
    // 西 10：2F 南コンコース ⇔ 1F アトリウム（西1 の入口の近く、(44, 68)）。上は 2F の南コンコース（西）の側
    {
      const c2 = centroid(poly(byId(154080986)));
      put([44 + (c2[0] - 44) * 0.15, 68 + (c2[1] - 68) * 0.15], [c2[0] - 44, c2[1] - 68], 1, 2);
    }
    // 西 17：4F（西3 の入口の角）⇔ 2F 南コンコース。上の端は 4F アトリウムの西3 にそう腕の西の端（西3 の入口の角、AED の横）、
    // 公式の図の点線のとおり、エントランスホールの方（2F 南コンコースの北へのびる所）へ斜めに下りる
    {
      const [top, aim] = fromUV([[60, -20], [35, -55]]);
      const L = run(2, 4), d = Math.hypot(aim[0] - top[0], aim[1] - top[1]);
      stairs.push({ name: "エスカレーター", kind: "escalator", from: top, fromLevel: 4, to: [r(top[0] + ((aim[0] - top[0]) / d) * L), r(top[1] + ((aim[1] - top[1]) / d) * L)], toLevel: 2, width: 2 });
    }
    // 南：11・12・18（4F ⇔ 2F）、19・20・21（2F ⇔ 1F）。印をコンコースの線の上に寄せ、コンコースの向きにそろえる
    if (southLine.length >= 2) {
      const onLine = (p: XZ): [XZ, XZ] => {
        let best: [number, XZ, XZ] = [Infinity, p, [1, 0]];
        for (let k = 0; k + 1 < southLine.length; k++) {
          const a = southLine[k], b = southLine[k + 1];
          const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
          const q: XZ = [a[0] + t * dx, a[1] + t * dz], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          if (d < best[0]) best = [d, q, [dx, dz]];
        }
        return [best[1], best[2]];
      };
      for (const [p, lo, hi] of [[[70, 309], 2, 4], [[110.7, 369.8], 2, 4], [[55, 243.7], 2, 4], [[53.2, 243.2], 1, 2], [[123.8, 358.4], 1, 2], [[83.1, 297.9], 1, 2]] as [XZ, number, number][]) {
        const [q, d] = onLine(p);
        put(q, [-d[0], -d[1]], lo, hi); // 上（高い階）は北（エントランスプラザ）の側
      }
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
    const keep = new Set(OFFICIAL_EAST.map((o) => escs.reduce((best, e) => {
      const m = (x: typeof e): number => Math.hypot((x.from[0] + x.to[0]) / 2 - o[0], (x.from[1] + x.to[1]) / 2 - o[1]);
      return m(e) < m(best) ? e : best;
    }, escs[0])));
    for (const v of vs.filter((x) => x.kind !== "escalator" || keep.has(x)))
    {
      // 上の端（2F）はそのまま、長さを 2F の高さに合わせる（30° ほど）
      const L0 = Math.hypot(v.to[0] - v.from[0], v.to[1] - v.from[1]) || 1, L = (FLOOR_Y[2] - FLOOR_Y[1]) * 1.8;
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
      stairs.push({ name: v.kind === "escalator" ? "エスカレーター" : "階段", ...(v.kind === "escalator" ? { kind: "escalator" as const } : {}), from, fromLevel: 2, to, toLevel: 1, width: v.width });
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
      for (const margin of [2.5, 1, 0.3]) {
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
  const shift = poly0.map(() => [0, 0] as XZ);
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
    for (const j of [i, (i + 1) % poly0.length]) {
      shift[j][0] += nx * k;
      shift[j][1] += nz * k;
    }
  });
  if (shift.every((q) => q[0] === 0 && q[1] === 0)) continue;
  h.inner = poly0;
  h.poly = poly0.map((q, i) => [Math.round((q[0] + shift[i][0]) * 10) / 10, Math.round((q[1] + shift[i][1]) * 10) / 10] as XZ);
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
  const outside = (name: string, level: number, rects: XZ[][], carve: string[] = []) => {
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
    for (const pg of res) {
      const poly = unring(pg[0]);
      if (poly.length >= 3 && size(poly) > 30) areas.push({ name, level, poly, holes: pg.length > 1 ? pg.slice(1).map(unring) : undefined, outdoor: true });
    }
  };
  // 東：東1〜3 の外（搬入口の側）と、東1 の端・東3 の端の広場。東7・東8 の北東の大きな駐車場と、東7 の西わきの道
  outside("外の通路（1F）", 1, [
    [[105, -500], [140, -500], [140, -175], [105, -175]],
    [[0, -218], [140, -218], [140, -172], [0, -172]],
    [[10, -528], [140, -528], [140, -494], [10, -494]],
    [[-90, -722], [120, -722], [120, -545], [-90, -545]],
    [[-168, -705], [-140, -705], [-140, -545], [-168, -545]],
  ]);
  // 西：西1 の外（北東の 4F の通路の下と、南東の側）
  outside("外の通路（1F）", 1, [
    [[56, -98], [222, -98], [222, -83], [56, -83]],
    [[202, -98], [222, -98], [222, 16], [202, 16]],
  ]);
  // 南：南3・南4 の北の 4F の通路（西4 の外の通路から、南展示棟への通路（4F）を通って続く。航空写真で v 12〜34）
  outside("外の通路（4F）", 4, [[[255, 12.4], [444.6, 12.4], [444.6, 34.4], [255, 34.4]]], ["南展示棟（4F）"]);
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
type SArea = { poly: XZ[]; y: number; kind: "walk" | "platform" };
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
      const walk = /^(pedestrian|footway|path|cycleway)$/.test(t.highway);
      const y = layer * FLOOR_Y[2] + (walk ? 0.06 : 0.03);
      if (t.area === "yes" && pts.length > 3) sur.areas.push({ poly: pts, y, kind: "walk" });
      else sur.lines.push({ pts, y, w: WIDTH[t.highway] ?? 3, kind: t.highway === "steps" ? "steps" : walk ? "walk" : "road" });
    }
  }
}

mkdirSync("src/data", { recursive: true });
writeFileSync(
  "src/data/venue.json",
  JSON.stringify({ origin: ORIGIN, floorY: FLOOR_Y, attribution: "© OpenStreetMap contributors (ODbL 1.0)", osmFetchedAt: osm.fetchedAt, halls, areas, context, parts3d, surroundings: sur, toilets, toiletRooms, firstAid, doors, stairs }),
);
console.log(`ホール ${halls.length}・通路 ${areas.length}・建物 ${context.length}（立体 ${parts3d.length}）・トイレ ${toilets.length}（図面 ${plan.toilets.length}）・救護室 ${firstAid.length}・出入口と搬入口 ${doors.length}・周辺の道と線路 ${sur.lines.length}・駅 ${sur.stations.length} を src/data/venue.json に`);
