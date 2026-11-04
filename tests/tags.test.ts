import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTag, parseTagsFile, splitChars, toTagsFile, workColor, worksOf, type Tags } from "../src/lib/tags";

test("作品・キャラを入れる・外す（日ごと）", () => {
  let t: Tags = {};
  t = applyTag(t, 1, ["東A-01a", "東A-01b", "東A-02a"], { work: "ブルーアーカイブ" });
  t = applyTag(t, 1, ["東A-01a"], { chars: ["アリス"], mode: "set" });
  t = applyTag(t, 1, ["東A-01a"], { chars: ["ユウカ", "アリス"], mode: "add" });
  t = applyTag(t, 2, ["東A-01a"], { work: "原神" });
  assert.deepEqual(t["1"]["東A-01a"], { work: "ブルーアーカイブ", chars: ["アリス", "ユウカ"] });
  assert.equal(t["2"]["東A-01a"].work, "原神"); // 日が違えば別
  assert.deepEqual(worksOf(t, 1), [{ work: "ブルーアーカイブ", count: 3 }]);
  // 作品を外し、キャラも消すと、そのスペースの情報はなくなる
  t = applyTag(t, 1, ["東A-01a"], { work: "", mode: "clear" });
  assert.equal(t["1"]["東A-01a"], undefined);
});

test("ファイルの書き出しと読み込み・キャラの区切り・色", () => {
  const t: Tags = { "1": { "東A-01a": { work: "原神", chars: ["パイモン"] } } };
  assert.deepEqual(parseTagsFile(JSON.parse(JSON.stringify(toTagsFile(t)))), t);
  assert.equal(parseTagsFile({ format: "x", days: {} }), null);
  assert.equal(parseTagsFile({ format: "comiket3d-tags", days: { "4": {} } }), null); // 4日目はない
  assert.deepEqual(splitChars("アリス, ユウカ、ヒナ　 ノア"), ["アリス", "ユウカ", "ヒナ", "ノア"]);
  assert.equal(workColor("原神"), workColor("原神"));
  assert.notEqual(workColor("原神"), workColor("ブルーアーカイブ"));
});
