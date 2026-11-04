import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pointInPolygon, type XZ } from "../src/lib/geo";
import { expandBooths, islandEnds, layoutProblems, nextBlock, parseCode, parseLayoutFile, sampleLayout, toLayoutFile, type HallLike, type Line } from "../src/lib/layout";

const venue = JSON.parse(readFileSync("src/data/venue.json", "utf8")) as { halls: HallLike[] };

test("見本の配置：配置番号が重ならず、机はすべてホールの中、工事中のホールには置かない", () => {
  const lines = sampleLayout(venue.halls);
  const booths = expandBooths(lines, venue.halls);
  assert.ok(booths.length > 5000);
  assert.equal(new Set(booths.map((b) => b.code)).size, booths.length);
  const poly = new Map(venue.halls.map((h) => [h.id, h.poly as XZ[]]));
  for (const b of booths) assert.ok(pointInPolygon(b.at, poly.get(b.hall)!), `${b.code} がホールの外`);
  for (const id of ["E4", "E5", "E6"]) assert.ok(!booths.some((b) => b.hall === id));
});

test("番号は A側を進み、B側を戻る。机1つが番号1つ、a・b は机の半分", () => {
  const halls: HallLike[] = [{ id: "X", building: "東", level: 1, poly: [[-50, -50], [50, -50], [50, 50], [-50, 50]] }];
  const booths = expandBooths([{ hall: "X", block: "ア", start: [0, 0], angle: 0, segments: [2, 2] }], halls);
  assert.deepEqual(
    booths.map((b) => b.code),
    ["01a", "01b", "02a", "02b", "03a", "03b", "04a", "04b", "05a", "05b", "06a", "06b", "07a", "07b", "08a", "08b"].map((s) => `東ア-${s}`),
  );
  // 01 と 08 は同じ端の背中合わせ
  assert.ok(Math.abs(booths[0].at[0] - booths[15].at[0]) < 0.01);
  assert.notEqual(booths[0].side, booths[15].side);
});

test("配置番号の書き方の揺れ", () => {
  assert.deepEqual(parseCode("東ア-12a"), { prefix: "東", block: "ア", num: 12, half: "a" });
  assert.deepEqual(parseCode("東ア12 b"), { prefix: "東", block: "ア", num: 12, half: "b" });
  assert.deepEqual(parseCode("西あ-03"), { prefix: "西", block: "あ", num: 3, half: undefined });
  assert.deepEqual(parseCode("東Ａ－０１ａ".replace("－", "-")), { prefix: "東", block: "A", num: 1, half: "a" });
  assert.equal(parseCode("こんにちは"), null);
});

test("島の端の番号：区間ごとの両端に、A側と B側の机の番号", () => {
  const ends = islandEnds([{ hall: "X", block: "ア", start: [0, 0], angle: 0, segments: [2, 2] }]);
  // 区間1：始め A1・B8、終わり A2・B7。区間2：始め A3・B6、終わり A4・B5（expandBooths の番号と同じ）
  assert.deepEqual(
    ends.map((e) => `${e.side === -1 ? "A" : "B"}${e.num}`),
    ["A1", "B8", "A2", "B7", "A3", "B6", "A4", "B5"],
  );
});

test("次の列の名前・配置の困ったところ・配置のファイル", () => {
  const halls: HallLike[] = [{ id: "X", building: "東", level: 1, poly: [[-50, -50], [50, -50], [50, 50], [-50, 50]] }];
  const a: Line = { hall: "X", block: "A", start: [-10, 0], angle: 0, segments: [4] };
  assert.equal(nextBlock([a], "東", halls), "B");
  // 使い切ったら「'」つき
  const many = "abcdefghijklmnopqrstuvwxyz".split("").map((b) => ({ ...a, block: b }));
  assert.equal(nextBlock(many, "南", [{ ...halls[0], building: "南" }]), "a'");
  assert.deepEqual(layoutProblems([a], halls), []);
  // 同じ名前・はみ出し
  const dup = { ...a, start: [0, 10] as [number, number] };
  const far = { ...a, block: "C", start: [45, 0] as [number, number] };
  const texts = layoutProblems([a, dup, far], halls).map((p) => p.text);
  assert.ok(texts.some((t) => t.includes("同じ名前")));
  assert.ok(texts.some((t) => t.includes("はみ出し")));
  // 重なり（ずらした同じ列）
  const over = { ...a, block: "D", start: [-9.5, 0] as [number, number] };
  assert.ok(layoutProblems([a, over], halls).some((p) => p.text.includes("重なっている")));
  // 見本の配置には困ったところがない
  assert.deepEqual(layoutProblems(sampleLayout(venue.halls), venue.halls), []);
  // ファイルの書き出しと読み込み
  assert.deepEqual(parseLayoutFile(JSON.parse(JSON.stringify(toLayoutFile([a])))), [a]);
  assert.equal(parseLayoutFile({ format: "x", lines: [] }), null);
  assert.equal(parseLayoutFile({ format: "comiket3d-layout", lines: [{ ...a, segments: [0] }] }), null);
});
