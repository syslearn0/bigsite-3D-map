import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGrid, findPath, type NavVenue } from "../src/lib/nav";
import venueJson from "../src/data/venue.json";
import layout from "../src/data/layout-sample.json";
import { expandBooths, type HallLike, type Line } from "../src/lib/layout";

// 2 つの部屋（ホール）を、壁の出入口 1 つでつなぐ
const v: NavVenue = {
  halls: [
    { id: "A", level: 1, poly: [[0, 0], [20, 0], [20, 20], [0, 20]] },
    { id: "B", level: 1, poly: [[20, 0], [40, 0], [40, 20], [20, 20]] },
  ],
  areas: [],
  doors: [{ at: [20, 18], level: 1, hall: "A", width: 2 }],
};

test("壁は出入口の所だけ通る", () => {
  const g = buildGrid(v, 1, []);
  const r = findPath(g, [10, 2], [[30, 2]])!;
  assert.ok(r);
  assert.ok(r.path.some(([x, z]) => Math.abs(x - 20) < 2.5 && z > 15), JSON.stringify(r.path));
  assert.ok(r.length > 30); // まっすぐなら 20m、出入口をまわると 38m ほど
});

test("会場：東2 の机から、いちばん近いトイレへ行ける", () => {
  const venue = venueJson as unknown as NavVenue & { toilets: { at: [number, number]; level: number | null }[]; halls: HallLike[] };
  const lines = (layout as unknown as { lines: Line[] }).lines;
  const booths = expandBooths(lines, venue.halls);
  const g = buildGrid(venue, 1, booths.map((b) => b.at));
  const from = booths.find((b) => b.code === "東K-13a")!.at;
  const t0 = performance.now();
  const r = findPath(g, from, venue.toilets.filter((t) => (t.level ?? 1) === 1).map((t) => t.at));
  const ms = performance.now() - t0;
  assert.ok(r, "道がない");
  assert.ok(r.length < 250, String(r.length));
  assert.ok(ms < 1500, `${ms}ms`);
});
