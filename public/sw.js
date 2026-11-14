// Service worker do Ateliê Local.
// - Pré-cacheia o shell (index.html + assets referenciados por ele) na instalação.
// - GET same-origin: cache-first com fallback para a rede (e cacheia em runtime).
// - Nunca intercepta huggingface.co nem qualquer outra origem.
const VERSION = 'v1';
const CACHE = `atelie-local-${VERSION}`;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const base = self.registration.scope;
    const urls = new Set(SHELL.map((u) => new URL(u, base).href));
    try {
      const html = await (await fetch(new URL('./index.html', base), { cache: 'reload' })).text();
      for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const u = new URL(m[1], base);
        if (u.origin === self.location.origin) urls.add(u.href);
      }
    } catch { /* offline na instalação: segue só com o que der */ }
    await Promise.all([...urls].map((u) => cache.add(u).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('atelie-local-') && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // huggingface.co etc.: não intercepta
  if (req.headers.has('range')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Navegação: rede primeiro (evita shell velho apontando para assets antigos), cache como fallback offline.
    if (req.mode === 'navigate') {
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) || (await cache.match(new URL('./index.html', self.registration.scope).href)) || Response.error();
      }
    }
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  })());
});
