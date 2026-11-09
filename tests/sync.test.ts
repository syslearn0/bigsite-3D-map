import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { flatten, noteLocal, syncWith, unflatten } from "../src/lib/sync";

// 端末の保存とサーバー（sync.php と同じ決まり：時刻の新しいほうが勝つ）のまね
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
let server: Record<string, { v: string | null; t: number }> = {};
(globalThis as unknown as { fetch: unknown }).fetch = async (_: string, init: { body: string }) => {
  const { entries } = JSON.parse(init.body) as { entries: typeof server };
  for (const [k, e] of Object.entries(entries)) if (!server[k] || e.t > server[k].t) server[k] = e;
  return new Response(JSON.stringify({ entries: server }), { status: 200 });
};
beforeEach(() => {
  store.clear();
  server = {};
});

test("初めて合わせる古い端末の印は、ほかの端末で消したものを生き返らせない", async () => {
  server = { "m|1|東A-01a": { v: null, t: 1000 } }; // ほかの端末で消した
  noteLocal({ "m|1|東A-01a": "want", "m|1|東B-02a": "maybe" }); // この端末には、消す前の印が残っている
  const next = await syncWith({ "m|1|東A-01a": "want", "m|1|東B-02a": "maybe" }, 7);
  assert.deepEqual(next, { "m|1|東B-02a": "maybe" }); // 消したものは消え、サーバーになかった印は残る
  assert.equal(server["m|1|東B-02a"].v, "maybe");
});

test("この端末で変えたものは、サーバーへ送られる", async () => {
  noteLocal({});
  await syncWith({}, 7);
  noteLocal({ "n|2|東C-03b": "新刊" });
  await syncWith({ "n|2|東C-03b": "新刊" }, 7);
  assert.equal(server["n|2|東C-03b"].v, "新刊");
});

test("ちがうアカウントでログインしたら、手元の印は送らない", async () => {
  noteLocal({});
  await syncWith({}, 7);
  noteLocal({ "m|1|東A-01a": "want" });
  await syncWith({ "m|1|東A-01a": "want" }, 7);
  server = {};
  await syncWith({ "m|1|東A-01a": "want" }, 8);
  assert.deepEqual(server, {});
});

test("使う金額（p）も行き来する。0 円は送らない", () => {
  const e = () => ({ 1: {}, 2: {}, 3: {} });
  const f = flatten(e(), e(), e(), { 1: { "東A-01a": 1500, "東B-02b": 0 }, 2: {}, 3: { "西あ-03a": 800 } });
  assert.deepEqual(f, { "p|1|東A-01a": "1500", "p|3|西あ-03a": "800" });
  assert.deepEqual(unflatten(f).budgets, { 1: { "東A-01a": 1500 }, 2: {}, 3: { "西あ-03a": 800 } });
});
