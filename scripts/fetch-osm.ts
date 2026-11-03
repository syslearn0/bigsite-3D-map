// 東京ビッグサイトの周りの OSM データ（建物・ホール・通路・トイレ）を取り、data/osm/bigsight.json に保存する。
// 使い方：npm run fetch:osm → npm run build:venue
// © OpenStreetMap contributors（ODbL 1.0）

import { mkdirSync, writeFileSync } from "node:fs";

const BBOX = "35.6265,139.789,35.6335,139.800"; // 南,西,北,東
const query = `[out:json][timeout:60];
(
  way(${BBOX})[building];
  way(${BBOX})["building:part"];
  way(${BBOX})[indoor];
  way(${BBOX})[amenity=exhibition_centre];
  nwr(${BBOX})[amenity=toilets];
  node(${BBOX})[entrance];
  node(${BBOX})[highway=elevator];
);
out geom tags;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "comiket-3d-prototype" },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) throw new Error(`Overpass ${res.status}`);
const json = await res.json();
mkdirSync("data/osm", { recursive: true });
writeFileSync(
  "data/osm/bigsight.json",
  JSON.stringify({ fetchedAt: new Date().toISOString(), bbox: BBOX, attribution: "© OpenStreetMap contributors (ODbL 1.0)", elements: json.elements }),
);
console.log(`${json.elements.length} 件を data/osm/bigsight.json に保存`);
