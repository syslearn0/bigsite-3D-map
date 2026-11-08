import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRails, moveOnRails, nearestOnRails, railPath, railPoint } from "../src/lib/rails";
import { expandBooths, type HallLike, type Line } from "../src/lib/layout";

// 2 つの島が 7m おきに並んだ、四角いホール
const hall: HallLike = { id: "H", building: "東", level: 1, poly: [[-20, -20], [80, -20], [80, 40], [-20, 40]] };
const lines: Line[] = [0, 7].map((z, i) => ({ hall: "H", block: "AB"[i], start: [0, z], angle: 0, segments: [10] }));
const booths = expandBooths(lines, [hall]);
const rails = buildRails(lines, booths, [hall]);

test("線は机をよけて、通路にある", () => {
  for (const nd of rails.nodes) for (const b of booths) assert.ok(Math.hypot(nd.p[0] - b.at[0], nd.p[1] - b.at[1]) > 0.9);
});

test("2 つの島のあいだの線は、まん中（z = 3.5）に 1 本", () => {
  const mid = rails.nodes.filter((n) => n.p[1] > 1 && n.p[1] < 6);
  assert.ok(mid.length > 0);
  for (const n of mid) assert.ok(Math.abs(n.p[1] - 3.5) < 0.2, String(n.p));
});

test("島の端をまわって、反対側の通路へ行ける", () => {
  const from = nearestOnRails(rails, [9, -3])!; // 島 A の外
  const to = nearestOnRails(rails, [9, 10])!; // 島 B の外
  const path = railPath(rails, from, to);
  assert.ok(path && path.length > 2);
});

test("線の上を進むと、線からはずれない", () => {
  let q = nearestOnRails(rails, [5, 3.5])!;
  for (let k = 0; k < 40; k++) {
    const m = moveOnRails(rails, q, [1, 0], 0.5);
    q = { ...m.pos, at: railPoint(rails, m.pos), d: 0 };
    assert.ok(nearestOnRails(rails, q.at)!.d < 1e-6);
  }
  assert.ok(q.at[0] > 15);
});
