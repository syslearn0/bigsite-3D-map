// 会場のまわりの道・線路・駅（OSM）を取り、data/osm/surroundings.json に保存する。「周辺も表示」で使う。
// 範囲は、ゆりかもめの東京ビッグサイト駅・りんかい線の国際展示場駅まで入るように広めに。
// 使い方：npm run fetch:surroundings → npm run build:venue
// © OpenStreetMap contributors（ODbL 1.0）

import { mkdirSync, writeFileSync } from "node:fs";

const BBOX = "35.6225,139.7835,35.6375,139.8045"; // 南,西,北,東
const query = `[out:json][timeout:90];
(
  way(${BBOX})[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|pedestrian|footway|path|steps|cycleway)$"];
  way(${BBOX})[railway~"^(rail|light_rail|monorail|subway|platform)$"];
  way(${BBOX})[public_transport=platform];
  nwr(${BBOX})[railway=station];
  nwr(${BBOX})[public_transport=station];
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
  "data/osm/surroundings.json",
  JSON.stringify({ fetchedAt: new Date().toISOString(), bbox: BBOX, attribution: "© OpenStreetMap contributors (ODbL 1.0)", elements: json.elements }),
);
console.log(`${json.elements.length} 件を data/osm/surroundings.json に保存`);
