// サービスワーカー：電波がなくても地図と自分の印が開けるように、画面を端末に持っておく。
// 会場のデータと机の配置は画面の JS の中に入っているので、画面の JS・CSS を持てば足りる。
// ・画面（HTML）：まず通信、2.5秒で返らなければ持っている版（新しい版を出したら、電波があるときに入れ替わる）
// ・/_next/static：ファイル名が中身ごとに変わるので、持っていればそれを使う
// ・アイコンなど：持っている版をすぐ返し、裏で新しくする

const CACHE = "comiket3d-v1"; // 持つものを変えたら上げる（古い入れ物は消える）
const PAGES = ["/"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  // 1つ失敗しても残りは持っておく
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all([...PAGES, "/manifest.webmanifest", "/icon-192.png"].map((u) => c.add(u).catch(() => {})))));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

// 画面が読み込んだファイル（JS・CSS）の一覧を受け取って持っておく。初めて開いた回は、まだサービスワーカーが働いていないため
self.addEventListener("message", (e) => {
  if (e.data?.type !== "cache-urls") return;
  const urls = (e.data.urls ?? []).filter((u) => new URL(u, self.location.origin).origin === self.location.origin);
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(urls.map((u) => c.match(u).then((hit) => hit || c.add(u).catch(() => {}))))));
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

async function networkFirst(req, key) {
  const c = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), timeout(2500)]);
    if (res.ok) c.put(key, res.clone());
    return res;
  } catch {
    return (await c.match(key)) ?? (await c.match("/")) ?? Response.error();
  }
}

async function staleWhileRevalidate(e, req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok) c.put(req, res.clone());
      return res;
    })
    .catch(() => undefined);
  if (hit) {
    e.waitUntil(fresh);
    return hit;
  }
  return (await fresh) ?? Response.error();
}

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.mode === "navigate") return e.respondWith(networkFirst(req, url.pathname));
  if (url.pathname.startsWith("/_next/static/")) return e.respondWith(cacheFirst(req));
  if (/\.(png|ico|webmanifest)$/.test(url.pathname)) return e.respondWith(staleWhileRevalidate(e, req));
});
