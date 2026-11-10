import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, search } from "../src/lib/search";
import type { Circle } from "../src/lib/published";

const circle: Circle = { day: 1, codes: ["東A-01a", "東A-01b"], name: "サンプル工房", works: ["ブルーアーカイブ"], chars: {}, x: "", url: "", image: "", images: [], thumb: "" };
const codes = ["東A-01a", "東A-01b", "東A-02a", "東B-10a"];
const tags = { "東A-01a": { works: ["ブルーアーカイブ"], chars: { ブルーアーカイブ: ["ホシノ"] } }, "東A-02a": { works: ["原神"] }, "東B-10a": { works: ["ブルーアーカイブ"] } };

test("ひらがな・カタカナ・全角半角を気にしない", () => {
  assert.equal(fold("ＡＢ　ホシノ"), fold("abほしの"));
});
test("サークル名は 1 つにまとめる", () => {
  const h = search("さんぷる", codes, tags, { "東A-01a": circle, "東A-01b": circle });
  assert.equal(h.filter((x) => x.kind === "circle").length, 1);
});
test("作品はその机をまとめる", () => {
  // 伸ばす音を気にしないので、「ブルアカ」でも見つかる
  assert.ok(search("ブルアカ", codes, tags, {}).some((x) => x.kind === "work"));
  const w = search("ブルーアーカイブ", codes, tags, {}).find((x) => x.kind === "work")!;
  assert.deepEqual(w.codes, ["東A-01a", "東B-10a"]);
});
test("配置番号は書き方の揺れを吸収", () => {
  const h = search("東a1", codes, tags, {});
  assert.ok(h.some((x) => x.kind === "code" && x.label === "東A-01a"));
});
test("名前のない作品があっても落ちない", () => {
  assert.doesNotThrow(() => search("a", codes, { "東A-01a": { works: [undefined as unknown as string], chars: { x: [undefined as unknown as string] } } }, {}));
});
