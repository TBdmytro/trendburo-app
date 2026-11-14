// Нужен только чтобы Android предлагал «Установить приложение». Ничего не кэширует: сайт всегда грузится свежим.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
