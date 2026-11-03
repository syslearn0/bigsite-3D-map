// 見本の机の配置 src/data/layout-sample.json を作る。C109 の本当の配置ではない（カタログが出たら、みんなで入れ直す）。

import { readFileSync, writeFileSync } from "node:fs";
import { expandBooths, sampleLayout, type HallLike } from "../src/lib/layout";

const venue = JSON.parse(readFileSync("src/data/venue.json", "utf8")) as { halls: HallLike[] };
const lines = sampleLayout(venue.halls);
writeFileSync("src/data/layout-sample.json", JSON.stringify({ sample: true, note: "見本の配置。C109 の本当の配置ではない", lines }));
const booths = expandBooths(lines, venue.halls);
const per = new Map<string, number>();
for (const b of booths) per.set(b.hall, (per.get(b.hall) ?? 0) + 1);
console.log(`列 ${lines.length}・スペース ${booths.length}`, Object.fromEntries(per));
