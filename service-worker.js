"use strict";

const CACHE_NAME = "kaji-app-v9";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg"
];
// 静的アセットは stale-while-revalidate（キャッシュを即返し、裏で最新に差し替える）
const SWR_ASSETS = ["styles.css", "app.js", "manifest.json", "icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // 共有API（別ドメイン）はキャッシュしない
  if (url.origin !== self.location.origin) return;

  const isAsset = SWR_ASSETS.some((name) => url.pathname.endsWith("/" + name));
  if (isAsset) {
    // stale-while-revalidate：キャッシュがあれば即返し、裏で取得してキャッシュを更新する。
    // キャッシュが無い初回だけネットワークを待つ
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => cached);
        if (cached) {
          event.waitUntil(network.catch(() => {}));
          return cached;
        }
        return network;
      })
    );
    return;
  }

  // ページ本体（ナビゲーション／index.html）はネットワーク優先で版の不整合を防ぎ、
  // オフライン時のみキャッシュへフォールバックする
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")))
  );
});
