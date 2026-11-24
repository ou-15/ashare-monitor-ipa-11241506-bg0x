/* 仅缓存 App 外壳；行情数据一律走网络，保证「实时」 */
const CACHE = "ashare-board-v8";
const ASSETS = ["./", "./index.html", "./style.css", "./app.js",
                "./manifest.webmanifest", "./icon-180.png", "./icon-192.png",
                "./fund.html", "./fund.css", "./fund.js", "./fund_direct.js",
                "./us.html", "./news.html", "./tabbar.css", "./tabbar.js",
                "./manifest.fund.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.indexOf("/api/") >= 0) return;          // 数据接口不缓存
  if (url.origin !== self.location.origin) return;         // 外部行情交给网络
  const isHtml = req.mode === "navigate" || url.pathname.endsWith(".html");
  if (isHtml) {
    event.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req)));
    return;
  }
  event.respondWith(fetch(req).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
    return res;
  }).catch(() => caches.match(req)));
});
