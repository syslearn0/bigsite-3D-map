import assert from "node:assert/strict";
import { test } from "node:test";
import { applyChars, applyWorks, charsOf, charsText, parseTagsFile, splitChars, toTagsFile, workColor, worksOf, type Tags } from "../src/lib/tags";

test("作品を入れる・足す・外す（日ごと、複数の作品）", () => {
  let t: Tags = {};
  t = applyWorks(t, 1, ["東A-01a", "東A-01b", "東A-02a"], "set", ["ブルーアーカイブ"]);
  t = applyWorks(t, 1, ["東A-01a"], "add", ["原神"]);
  t = applyWorks(t, 2, ["東A-01a"], "set", ["原神"]);
  assert.deepEqual(t["1"]["東A-01a"].works, ["ブルーアーカイブ", "原神"]);
  assert.deepEqual(t["2"]["東A-01a"].works, ["原神"]); // 日が違えば別
  assert.deepEqual(worksOf(t, 1), [
    { work: "ブルーアーカイブ", count: 3 },
    { work: "原神", count: 1 },
  ]);
  // 作品を外すと、その作品のキャラも消える。全部外すとそのスペースの情報はなくなる
  t = applyChars(t, 1, ["東A-01a"], "原神", "set", ["パイモン"]);
  t = applyWorks(t, 1, ["東A-01a"], "remove", ["原神"]);
  assert.deepEqual(t["1"]["東A-01a"], { works: ["ブルーアーカイブ"] });
  t = applyWorks(t, 1, ["東A-01a"], "clear");
  assert.equal(t["1"]["東A-01a"], undefined);
});

test("キャラは作品ごと。その作品を扱っていないスペースは変えない", () => {
  let t: Tags = {};
  t = applyWorks(t, 1, ["a", "b"], "set", ["原神"]);
  t = applyWorks(t, 1, ["b"], "add", ["ブルーアーカイブ"]);
  t = applyWorks(t, 1, ["c"], "set", ["ブルーアーカイブ"]);
  t = applyChars(t, 1, ["a", "b", "c"], "原神", "set", ["パイモン", "蛍"]);
  t = applyChars(t, 1, ["b", "c"], "ブルーアーカイブ", "add", ["アリス"]);
  assert.deepEqual(t["1"]["b"].chars, { 原神: ["パイモン", "蛍"], ブルーアーカイブ: ["アリス"] });
  assert.equal(t["1"]["c"].chars?.["原神"], undefined); // c は原神を扱っていない
  assert.deepEqual(charsOf(t, 1, "原神"), [
    { char: "パイモン", count: 2 },
    { char: "蛍", count: 2 },
  ]);
  assert.equal(charsText(t["1"]["a"]), "パイモン、蛍");
  assert.equal(charsText(t["1"]["b"]), "パイモン、蛍（原神）／アリス（ブルーアーカイブ）");
  t = applyChars(t, 1, ["b"], "原神", "clear");
  assert.deepEqual(t["1"]["b"].chars, { ブルーアーカイブ: ["アリス"] });
});

test("ファイルの書き出しと読み込み（前の形も読める）・キャラの区切り・色", () => {
  const t: Tags = { "1": { "東A-01a": { works: ["原神"], chars: { 原神: ["パイモン"] } } } };
  assert.deepEqual(parseTagsFile(JSON.parse(JSON.stringify(toTagsFile(t)))), t);
  // 前の形：作品が1つ（work）、キャラが配列
  assert.deepEqual(parseTagsFile({ format: "comiket3d-tags", version: 1, days: { "1": { x: { work: "原神", chars: ["蛍"] } } } }), {
    "1": { x: { works: ["原神"], chars: { 原神: ["蛍"] } } },
  });
  assert.equal(parseTagsFile({ format: "x", days: {} }), null);
  assert.equal(parseTagsFile({ format: "comiket3d-tags", days: { "4": {} } }), null); // 4日目はない
  assert.deepEqual(splitChars("アリス, ユウカ、ヒナ　 ノア"), ["アリス", "ユウカ", "ヒナ", "ノア"]);
  assert.equal(workColor("原神"), workColor("原神"));
  assert.notEqual(workColor("原神"), workColor("ブルーアーカイブ"));
});
