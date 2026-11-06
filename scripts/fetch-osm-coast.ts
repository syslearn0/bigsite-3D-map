// 会場のまわりの海岸線（OSM の natural=coastline）と、運河などの水面（natural=water）を取り、data/osm/coast.json に保存する。「周辺も表示」の海に使う。
// 範囲は、周辺の道（fetch-osm-surroundings.ts）より広く、画面の遠くまで海が青くなるように。
// 使い方：npm run fetch:coast → npm run build:venue
// © OpenStreetMap contributors（ODbL 1.0）

import { mkdirSync, writeFileSync } from "node:fs";

const BBOX = "35.600,139.760,35.660,139.830"; // 南,西,北,東
const query = `[out:json][timeout:90];
(
  way(${BBOX})[natural=coastline];
  way(${BBOX})[natural=water];
  relation(${BBOX})[natural=water];
);
out geom;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "comiket-3d-prototype" },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) throw new Error(`Overpass ${res.status}`);
const json = await res.json();
mkdirSync("data/osm", { recursive: true });
writeFileSync("data/osm/coast.json", JSON.stringify({ fetchedAt: new Date().toISOString(), bbox: BBOX, attribution: "© OpenStreetMap contributors (ODbL 1.0)", elements: json.elements }));
console.log(`${json.elements.length} 件を data/osm/coast.json に保存`);
