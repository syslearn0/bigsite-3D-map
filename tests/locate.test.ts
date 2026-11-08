import { test } from "node:test";
import assert from "node:assert/strict";
import { hallAt, makeSteady, type HallLite } from "../src/lib/locate";

const sq = (x: number): HallLite["poly"] => [[x, 0], [x + 50, 0], [x + 50, 50], [x, 50]];
const halls: HallLite[] = [
  { id: "A", name: "A", level: 1, poly: sq(0) },
  { id: "B", name: "B", level: 1, poly: sq(60) },
  { id: "C", name: "C", level: 4, poly: sq(0) },
];

test("中ならそのホール、外なら近いホールの付近", () => {
  assert.equal(hallAt([10, 10], halls, [1]).hall?.id, "A");
  const w = hallAt([57, 10], halls, [1]);
  assert.equal(w.hall?.id, "B");
  assert.equal(w.inside, false);
  assert.equal(hallAt([10, 10], halls, [4]).hall?.id, "C");
  assert.equal(hallAt([500, 500], halls, [1]).hall, null);
});

test("ゆれても、2 回つづくまでは切りかえない", () => {
  const st = makeSteady(2);
  assert.equal(st(hallAt([10, 10], halls, [1])).hall?.id, "A");
  assert.equal(st(hallAt([55, 10], halls, [1])).hall?.id, "A"); // 外で B に近い：まだ A
  assert.equal(st(hallAt([10, 10], halls, [1])).hall?.id, "A");
  assert.equal(st(hallAt([70, 10], halls, [1])).hall?.id, "A"); // B の中：1 回目はまだ
  assert.equal(st(hallAt([72, 12], halls, [1])).hall?.id, "B"); // 2 回つづいた
});
