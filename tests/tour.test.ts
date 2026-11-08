import { test } from "node:test";
import assert from "node:assert/strict";
import { planTour, type Stop } from "../src/lib/tour";

const S = (id: string, x: number, z = 0, building = "東", level = 1): Stop => ({ id, p: [x, z], level, building });

test("一直線の机は、端から順に", () => {
  const r = planTour([S("c", 20), S("a", 0), S("d", 30), S("b", 10)]);
  const ids = r.order.map((s) => s.id).join("");
  assert.ok(ids === "abcd" || ids === "dcba", ids);
  assert.equal(Math.round(r.length), 30);
});

test("始める所があれば、そこから近い側から", () => {
  const r = planTour([S("a", 0), S("b", 10), S("c", 20)], { p: [25, 0], level: 1, building: "東" });
  assert.equal(r.order.map((s) => s.id).join(""), "cba");
});

test("建物をまたぐのは 1 回だけ", () => {
  const r = planTour([S("e1", 0), S("w1", 5, 0, "西"), S("e2", 10), S("w2", 15, 0, "西")]);
  let switches = 0;
  for (let k = 1; k < r.order.length; k++) if (r.order[k].building !== r.order[k - 1].building) switches++;
  assert.equal(switches, 1);
});
