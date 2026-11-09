import { test } from "node:test";
import assert from "node:assert/strict";
import { dayOf, decodeChecklist, parseCsv, readChecklist } from "../src/lib/checklist";

const W = ["火", "水", "木"];
const CSV = [
  "Header,ComicMarketCD-ROMCatalog,ComicMarket109,UTF-8,Web 1.0",
  "Color,1,ff944a,ff944a,絶対",
  "Color,2,ff00ff,ff00ff,",
  'Circle,123,1,10,3,火,東,Ａ,01,100,"サークル,A",よみ,ペン,本,https://example.com,,補足,"新刊2冊\n午前",1,2,0,0',
  "Circle,124,2,11,4,水,西,あ,5,100,サークルB,,,,,,,,1,2,0,1",
  "Circle,125,3,11,4,木,南,a,12,100,サークルC,,,,,,,メモ,1,2,0,0",
  "Circle,126,1,11,4,金,東,ア,01,100,ちがう日,,,,,,,,1,2,0,0",
  "Circle,127,1,11,4,火,,,,100,場所なし,,,,,,,,1,2,0,0",
  "UnKnown,サークルD,よみ,ペン,メモ",
].join("\r\n");

test("CSV：くくった中の , と改行、空の項目", () => {
  const rows = parseCsv('a,"b,c","d\ne",\n"x""y",');
  assert.deepEqual(rows, [["a", "b,c", "d\ne", ""], ['x"y', ""]]);
});

test("参加日：曜日・数字・〇日目", () => {
  assert.equal(dayOf("火", W), 1);
  assert.equal(dayOf("木曜日", W), 3);
  assert.equal(dayOf("２", W), 2);
  assert.equal(dayOf("1日目", W), 1);
  assert.equal(dayOf("金", W), null);
});

test("チェックリストを読む：配置番号（全角・a/b・番号の 0 うめ）、色、メモ、読めない行", () => {
  const c = readChecklist(CSV, W);
  assert.equal(c.event, "ComicMarket109");
  assert.deepEqual(c.colors, { 1: "絶対", 2: "" });
  assert.deepEqual(
    c.circles.map((x) => [x.day, x.code, x.color, x.name, x.memo]),
    [
      [1, "東A-01a", 1, "サークル,A", "新刊2冊\n午前"],
      [2, "西あ-05b", 2, "サークルB", ""],
      [3, "南a-12a", 3, "サークルC", "メモ"],
      [null, "東ア-01a", 1, "ちがう日", ""],
    ],
  );
  assert.equal(c.skipped, 1);
});

test("UTF-8（BOM つき）を読む", () => {
  const bytes = new TextEncoder().encode("﻿" + CSV);
  assert.ok(decodeChecklist(bytes.buffer as ArrayBuffer).startsWith("Header,"));
});
