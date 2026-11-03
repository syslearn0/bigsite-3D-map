// data/osm/bigsight.json（OSM）から、画面で使う会場データ src/data/venue.json を作る。
// 座標は会場の中のメートル（x：東、z：南）。位置関係は OSM の緯度経度のまま（ホール同士の並びは地図どおり）。
// 南展示棟は OSM に外形1つ（ホール＋西展示棟へつなぐ通路）しかないので、ホールの部分を切り出して「形は概略」とする。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { centroid, clipHalf, minAreaRect, project, type XZ } from "../src/lib/geo";

type El = { type: string; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[]; lat?: number; lon?: number };
const osm = JSON.parse(readFileSync("data/osm/bigsight.json", "utf8")) as { fetchedAt: string; elements: El[] };
const ORIGIN = { lat: 35.6298, lon: 139.7942 };
const FLOOR_Y: Record<number, number> = { 1: 0, 2: 6, 4: 15 }; // 床の高さ（m）。OSM の西展示棟 4F 部分の min_height=15、連絡ブリッジ 6〜8m から

const byName = (name: string) => {
  const e = osm.elements.find((x) => x.tags?.name === name && x.geometry);
  if (!e) throw new Error(`OSM に「${name}」がない`);
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
hall("W1", "西1ホール", "西", 1);
hall("W2", "西2ホール", "西", 1);
hall("W3", "西3ホール", "西", 4);
hall("W4", "西4ホール", "西", 4);

// 南展示場の外形：頂点 0〜4 と最後の頂点がホール、残りは西展示棟へ向かう通路
const south = byName("南展示場");
const sp = poly(south);
const southHall: XZ[] = [...sp.slice(0, 5), sp.at(-1)!];
const southPassage: XZ[] = sp.slice(4);
// ホールの部分を長い向きに2つに分ける（南1と南2は可動の間仕切りで隣り合う）。
// 西展示棟に近い側が南1（4F は南3）。分け目の位置は半分にした概略で、図面の形はなぞっていない
const rect = minAreaRect(southHall);
const axis: XZ = [Math.cos(rect.angle), Math.sin(rect.angle)];
const halfA = clipHalf(southHall, rect.center, [-axis[1], axis[0]].map((v) => -v) as XZ);
const halfB = clipHalf(southHall, rect.center, [-axis[1], axis[0]] as XZ);
const west = centroid(poly(byName("西展示棟")));
const dist = (p: XZ[]) => Math.hypot(centroid(p)[0] - west[0], centroid(p)[1] - west[1]);
const [nearWest, farWest] = dist(halfA) < dist(halfB) ? [halfA, halfB] : [halfB, halfA];
const s = `${south.type}/${south.id}`;
halls.push({ id: "S1", name: "南1ホール", building: "南", level: 1, poly: nearWest, rough: true, osm: s });
halls.push({ id: "S2", name: "南2ホール", building: "南", level: 1, poly: farWest, rough: true, osm: s });
halls.push({ id: "S3", name: "南3ホール", building: "南", level: 4, poly: nearWest, rough: true, osm: s });
halls.push({ id: "S4", name: "南4ホール", building: "南", level: 4, poly: farWest, rough: true, osm: s });

// ホール以外の歩く場所（通路・広場）
type Area = { name: string; level: number; poly: XZ[] };
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
  { name: "南展示棟への通路", level: 1, poly: southPassage },
];

// まわりの建物（位置の手がかり。足元の形だけ）
const context = osm.elements
  .filter((e) => e.geometry && e.tags?.building && !e.tags?.indoor && !/ホール|展示/.test(e.tags?.name ?? ""))
  .map((e) => ({ name: e.tags?.name ?? "", height: Number(e.tags?.height) || 10, poly: poly(e) }))
  .filter((b) => b.poly.length >= 3);

// トイレ（OSM にあるものだけ。実際よりずっと少ない）
const toilets = osm.elements
  .filter((e) => e.tags?.amenity === "toilets")
  .map((e) => {
    const p = e.geometry ? e.geometry : [{ lat: e.lat!, lon: e.lon! }];
    const c = p.reduce((a, g) => ({ lat: a.lat + g.lat / p.length, lon: a.lon + g.lon / p.length }), { lat: 0, lon: 0 });
    return { at: project(ORIGIN, c.lat, c.lon), level: e.tags?.level ? Number(e.tags.level) : null, osm: `${e.type}/${e.id}` };
  });

mkdirSync("src/data", { recursive: true });
writeFileSync(
  "src/data/venue.json",
  JSON.stringify({ origin: ORIGIN, floorY: FLOOR_Y, attribution: "© OpenStreetMap contributors (ODbL 1.0)", osmFetchedAt: osm.fetchedAt, halls, areas, context, toilets }),
);
console.log(`ホール ${halls.length}・通路 ${areas.length}・建物 ${context.length}・トイレ ${toilets.length} を src/data/venue.json に`);
