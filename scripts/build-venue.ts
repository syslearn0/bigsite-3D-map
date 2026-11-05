// data/osm/bigsight.json（OSM）から、画面で使う会場データ src/data/venue.json を作る。
// 座標は会場の中のメートル（x：東、z：南）。位置関係は OSM の緯度経度のまま（ホール同士の並びは地図どおり）。
// 南展示棟は OSM に外形1つ（ホール＋西展示棟へつなぐ通路）しかないので、ホールの部分を切り出して「形は概略」とする。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { centroid, minAreaRect, pointInPolygon, project, type XZ } from "../src/lib/geo";

type El = { type: string; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[]; lat?: number; lon?: number };
const osm = JSON.parse(readFileSync("data/osm/bigsight.json", "utf8")) as { fetchedAt: string; elements: El[] };
const ORIGIN = { lat: 35.6298, lon: 139.7942 };
// 床の高さ（m）。2F は連絡ブリッジ 6〜8m から。4F は OSM の西展示棟 4F 部分の min_height=15 より高く見せる（下の 1F のホールの
// 天井・壁との間が詰まって見えるので、見やすさのために 20m）
const FLOOR_Y: Record<number, number> = { 1: 0, 2: 6, 4: 20 };

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
type Hall = { id: string; name: string; building: "東" | "西" | "南"; level: number; poly: XZ[]; closed?: string; rough?: boolean; osm: string };
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

// 辺の真ん中（poly の i 番目の辺）と、2点をむすぶ幅 w の通路
const mid = (p: XZ[], i: number): XZ => [(p[i][0] + p[(i + 1) % p.length][0]) / 2, (p[i][1] + p[(i + 1) % p.length][1]) / 2];
function corridor(a: XZ, b: XZ, w: number): XZ[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nx = (-(b[1] - a[1]) / L) * (w / 2), nz = ((b[0] - a[0]) / L) * (w / 2);
  const r = (v: number) => Math.round(v * 10) / 10;
  return [[r(a[0] + nx), r(a[1] + nz)], [r(b[0] + nx), r(b[1] + nz)], [r(b[0] - nx), r(b[1] - nz)], [r(a[0] - nx), r(a[1] - nz)]];
}

// ホール以外の歩く場所（通路・広場）
type Area = { name: string; level: number; poly: XZ[]; see?: boolean }; // see：下が透けて見える床（半透明）
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
  // ガレリアの上の 2F の通路（東展示棟 2F）。北コンコース・連絡ブリッジから段差なしで入る。下のガレリアが見えるよう、地図では半透明
  { name: "東展示棟 2F", level: 2, poly: poly(byId(543048845)), see: true },
  { name: "南展示棟への通路", level: 1, poly: southPassage },
  // 4F でも、西4ホールと南3・4ホールは通路でつながる（ビッグサイトの館内図）。形は細かい図がないので、
  // 西4 の南東の壁の真ん中から、南3 の北西の壁の真ん中までの、幅 14m のまっすぐな通路にする
  { name: "南展示棟への通路（4F）", level: 4, poly: corridor(mid(halls.find((h) => h.id === "W4")!.poly, 1), mid(halls.find((h) => h.id === "S3")!.poly, 3), 14) },
  { name: "南展示棟", level: 1, poly: southRest },
];

// 階段（階のちがう2つの所をつなぐ）。屋上展示場（4F）からエントランスプラザ（2F）へ：
// 会議棟の横のエントランスプラザの辺（プラザの1本目の辺の 55% の所）から、1F アトリウム（低くなった中庭）の上を
// まっすぐ渡って、屋上展示場の北東の辺につながる（航空写真の橋と階段の位置。OSM に階段の形がないので、その目安）
const linkRoutes: { level: number; pts: XZ[] }[] = []; // 連絡通路への道（地図で太い矢印の線）
type Stair = { name: string; from: XZ; fromLevel: number; to: XZ; toLevel: number; width: number; kind?: "escalator" };
const stairs: Stair[] = [];
{
  const roof = areas.find((a) => a.name === "屋上展示場")!.poly, plaza = areas.find((a) => a.name === "エントランスプラザ")!.poly;
  const [a, b] = [plaza[0], plaza[1]];
  const P: XZ = [a[0] + (b[0] - a[0]) * 0.55, a[1] + (b[1] - a[1]) * 0.55];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let n: XZ = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  if (pointInPolygon([P[0] + n[0] * 0.5, P[1] + n[1] * 0.5], plaza)) n = [-n[0], -n[1]]; // プラザの外（屋上展示場の側）へ
  // P から n の向きに進んで、屋上展示場の辺に当たる所
  let hit = Infinity;
  roof.forEach((p, i) => {
    const q = roof[(i + 1) % roof.length];
    const dx = q[0] - p[0], dz = q[1] - p[1], den = n[0] * dz - n[1] * dx;
    if (Math.abs(den) < 1e-9) return;
    const t = ((p[0] - P[0]) * dz - (p[1] - P[1]) * dx) / den, u = ((p[0] - P[0]) * n[1] - (p[1] - P[1]) * n[0]) / den;
    if (t > 0 && u >= 0 && u <= 1) hit = Math.min(hit, t);
  });
  if (!Number.isFinite(hit)) throw new Error("屋上展示場への階段：屋上展示場の辺が見つからない");
  const r = (v: number) => Math.round(v * 10) / 10;
  // 両端を、それぞれの床の内側へ 1.5m のばす
  stairs.push({ name: "屋上展示場への階段", from: [r(P[0] + n[0] * (hit + 1.5)), r(P[1] + n[1] * (hit + 1.5))], fromLevel: 4, to: [r(P[0] - n[0] * 1.5), r(P[1] - n[1] * 1.5)], toLevel: 2, width: 6 });
}

// エスカレーター（ビッグサイトの館内図・図面にあるもの。位置と長さは目安）
{
  const r = (v: number) => Math.round(v * 10) / 10;
  const areaOf = (n: string) => areas.find((a) => a.name === n)!.poly;
  const near = (p: XZ, poly: XZ[]): [number, XZ] => {
    let b: [number, XZ] = [Infinity, p];
    poly.forEach((a, i) => {
      const c = poly[(i + 1) % poly.length];
      const dx = c[0] - a[0], dz = c[1] - a[1], L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
      const q: XZ = [a[0] + t * dx, a[1] + t * dz];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < b[0]) b = [d, q];
    });
    return b;
  };
  // 西のアトリウム：1F から 4F（4F アトリウム）へ、まっすぐ上がる大きなエスカレーター。4F アトリウムの、1F アトリウムの真ん中に向いた辺から下りる
  {
    const a1 = areaOf("1F アトリウム"), a4 = areaOf("４F アトリウム");
    const c1 = centroid(a1);
    const [, top] = near(c1, a4);
    const L = Math.hypot(c1[0] - top[0], c1[1] - top[1]), ux = (c1[0] - top[0]) / L, uz = (c1[1] - top[1]) / L;
    const run = FLOOR_Y[4] * 1.8; // 30° ほどの傾き
    stairs.push({ name: "エスカレーター（1F⇔4F）", kind: "escalator", from: [r(top[0] - ux * 1.5), r(top[1] - uz * 1.5)], fromLevel: 4, to: [r(top[0] + ux * run), r(top[1] + uz * run)], toLevel: 1, width: 5 });
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
    for (const e of es) {
      if (!pointInPolygon(e.at, g)) continue;
      stairs.push({ name: "エスカレーター（1F⇔2F）", kind: "escalator", from: [r(e.at[0] + ux * 6), r(e.at[1] + uz * 6)], fromLevel: 2, to: [r(e.at[0] - ux * 6), r(e.at[1] - uz * 6)], toLevel: 1, width: 3 });
    }
    // 連絡通路への道（2F）：エスカレーターを上がった所から、ガレリアの上の真ん中の線を西へ進み、北コンコース・連絡ブリッジを通って
    // エントランスプラザまで。地図では太い矢印の線にして、東ホールから西・会議棟への行き方がすぐ分かるようにする
    {
      const gc = centroid(g);
      const along = (p: XZ) => (p[0] - gc[0]) * ux + (p[1] - gc[1]) * uz;
      const onLine = (t: number): XZ => [r(gc[0] + ux * t), r(gc[1] + uz * t)];
      const nc = areaOf("北コンコース"), br = areaOf("連絡ブリッジ"), ep = areaOf("エントランスプラザ");
      // ガレリアの真ん中の線の、連絡ブリッジに近い方の端（西の端）。そこから連絡ブリッジ → 北コンコース → エントランスプラザ
      const brc = centroid(br), ncc = centroid(nc);
      const ts = g.map(along), tMin = Math.min(...ts), tMax = Math.max(...ts);
      const westIsMin = Math.abs(along(brc) - tMin) < Math.abs(along(brc) - tMax);
      const tWest = westIsMin ? tMin + 6 : tMax - 6;
      const [, plazaIn] = near(ncc, ep);
      const tops = stairs.filter((st) => st.name === "エスカレーター（1F⇔2F）").map((st) => st.from);
      const tFar = westIsMin ? Math.max(...tops.map(along)) : Math.min(...tops.map(along));
      const main: XZ[] = [onLine(tFar), onLine(tWest), brc.map(r) as XZ, ncc.map(r) as XZ, [r(plazaIn[0]), r(plazaIn[1])]];
      linkRoutes.push({ level: 2, pts: main });
      // それぞれのエスカレーターの上から、真ん中の線へ
      for (const t of tops) linkRoutes.push({ level: 2, pts: [t, onLine(along(t))] });
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
  ...planToilets.map((t) => ({ at: t.hall && !pointInPolygon(t.at, hallOf.get(t.hall)!.poly) ? toWall(t.hall, t.at, 1.5) : t.at, level: t.level, kinds: t.kinds, src: "plan" })),
  ...osmToilets.filter((o) => !plan.toilets.some((t) => Math.hypot(t.at[0] - o.at[0], t.at[1] - o.at[1]) < 15)),
];
const firstAid = plan.firstAid.map((a) => ({ at: a.at, level: a.level }));
// 出入口・搬入口（シャッター）。図面から読んだもの
const doors = (plan.doors ?? []).filter((d) => d.kind !== "ES" && usable(d.hall)).map((d) => {
  // ホールの壁から 15m より離れた出入口（東1 の西の端の、地上からのエントランスなど）は、ホールの扉ではないので寄せない
  const w = toWall(d.hall, d.at, 0);
  return { at: Math.hypot(w[0] - d.at[0], w[1] - d.at[1]) > 15 ? d.at : w, level: d.level, kind: d.kind, hall: d.hall };
});

// 周辺の道・線路・駅（data/osm/surroundings.json、npm run fetch:surroundings が作る）。「周辺も表示」で使う。
// 高さは OSM の layer（何層目か）から：歩道・道路は 1層 6m（2F の歩行者デッキと同じ）、ゆりかもめの高架は 4m + 1層 2.5m。
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
      const y = layer * 6 + (walk ? 0.06 : 0.03);
      if (t.area === "yes" && pts.length > 3) sur.areas.push({ poly: pts, y, kind: "walk" });
      else sur.lines.push({ pts, y, w: WIDTH[t.highway] ?? 3, kind: t.highway === "steps" ? "steps" : walk ? "walk" : "road" });
    }
  }
}

mkdirSync("src/data", { recursive: true });
writeFileSync(
  "src/data/venue.json",
  JSON.stringify({ origin: ORIGIN, floorY: FLOOR_Y, attribution: "© OpenStreetMap contributors (ODbL 1.0)", osmFetchedAt: osm.fetchedAt, halls, areas, context, parts3d, surroundings: sur, toilets, firstAid, doors, stairs, linkRoutes }),
);
console.log(`ホール ${halls.length}・通路 ${areas.length}・建物 ${context.length}（立体 ${parts3d.length}）・トイレ ${toilets.length}（図面 ${plan.toilets.length}）・救護室 ${firstAid.length}・出入口と搬入口 ${doors.length}・周辺の道と線路 ${sur.lines.length}・駅 ${sur.stations.length} を src/data/venue.json に`);
