// 「周辺も表示」をくわしくするための OSM：駅まで入る広い範囲の建物（高さ・階数・色）、緑地（公園・芝生・植え込み）、木と並木、
// 駐車場、横断歩道、駅の出入口、バス停・タクシー乗り場、橋の形。data/osm/detail.json に保存する。
// 範囲は fetch-osm-surroundings.ts と同じ（ゆりかもめの東京ビッグサイト駅・りんかい線の国際展示場駅まで入る）。
// 使い方：npm run fetch:detail → npm run build:venue
// © OpenStreetMap contributors（ODbL 1.0）

import { mkdirSync, writeFileSync } from "node:fs";

const BBOX = "35.6225,139.7835,35.6375,139.8045"; // 南,西,北,東
const query = `[out:json][timeout:120];
(
  way(${BBOX})[building];
  way(${BBOX})["building:part"];
  relation(${BBOX})[building];
  way(${BBOX})[leisure~"^(park|garden|pitch|playground)$"];
  relation(${BBOX})[leisure~"^(park|garden)$"];
  way(${BBOX})[landuse~"^(grass|forest|meadow|village_green|recreation_ground|flowerbed)$"];
  way(${BBOX})[natural~"^(wood|scrub|grassland|tree_row)$"];
  node(${BBOX})[natural=tree];
  way(${BBOX})[amenity=parking];
  node(${BBOX})[highway=crossing];
  way(${BBOX})[footway=crossing];
  node(${BBOX})[railway=subway_entrance];
  node(${BBOX})[railway=train_station_entrance];
  node(${BBOX})[highway=bus_stop];
  node(${BBOX})[amenity=taxi];
  way(${BBOX})[man_made=bridge];
  way(${BBOX})[highway][covered=yes];
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
writeFileSync(
  "data/osm/detail.json",
  JSON.stringify({ fetchedAt: new Date().toISOString(), bbox: BBOX, attribution: "© OpenStreetMap contributors (ODbL 1.0)", elements: json.elements }),
);
console.log(`${json.elements.length} 件を data/osm/detail.json に保存`);
