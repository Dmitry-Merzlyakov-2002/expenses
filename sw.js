const VERSION = 'v14';
const APP_SHELL = `ce-shell-${VERSION}`;
const STATIC_CACHE = `ce-static-${VERSION}`;
const RUNTIME_CACHE = `ce-runtime-${VERSION}`;

const SHELL_HTML_URL = './couple-expenses.html';

const SHELL_ASSETS = [
  SHELL_HTML_URL,
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/vendor/alpine.min.js',
  './assets/vendor/chart.umd.min.js',
  './assets/vendor/firebase-app-compat.js',
  './assets/vendor/firebase-auth-compat.js',
  './assets/vendor/firebase-firestore-compat.js',
  './assets/vendor/fonts.css',
  './assets/vendor/fonts/satoshi-400.woff2',
  './assets/vendor/fonts/satoshi-500.woff2',
  './assets/vendor/fonts/satoshi-700.woff2',
  './assets/vendor/fonts/satoshi-900.woff2',
  './assets/vendor/fonts/worksans-400.ttf',
  './assets/vendor/fonts/worksans-500.ttf',
  './assets/vendor/fonts/worksans-600.ttf'
];

// Minimal inline fallback shown ONLY if the app shell itself is somehow
// missing from every cache — this should never happen in normal operation,
// but guarantees we NEVER fall through to the browser's native offline page.
const EMERGENCY_HTML = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Расходы на переезд — офлайн</title>
<style>
body{font-family:sans-serif;background:#f7f6f2;color:#28251d;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.box{max-width:360px}
h1{font-size:20px;margin-bottom:8px}
p{color:#7a7974;font-size:14px;line-height:1.5}
button{margin-top:16px;padding:10px 20px;border-radius:999px;border:none;
background:#01696f;color:#fff;font-size:14px}
</style></head><body><div class="box">
<h1>Приложение временно недоступно офлайн</h1>
<p>Кэш приложения ещё не готов на этом устройстве. Подключитесь к интернету один раз, чтобы обновить кэш, затем офлайн-режим будет работать полностью.</p>
<button onclick="location.reload()">Обновить</button>
</div></body></html>`;

function emergencyResponse() {
  return new Response(EMERGENCY_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(APP_SHELL);
    // ИСПРАВЛЕНИЕ: раньше использовался shell.addAll(...), который работает
    // по принципу "всё или ничего" — если хотя бы один файл из списка (например,
    // отсутствующий шрифт или icon-512.png) отвечает не-200, ВЕСЬ шелл-кэш
    // не записывался вообще, включая критичные firebase-*.js и alpine.min.js,
    // а ошибка тихо проглатывалась в catch. Из-за этого установленное на
    // главный экран приложение могло долго работать на старой/пустой версии
    // кэша, и это было не видно в логах.
    // Теперь каждый файл кэшируется независимо через Promise.allSettled —
    // одна недостающая иконка/шрифт больше не блокирует кэширование остальных
    // файлов, а результат каждого файла логируется.
    const results = await Promise.allSettled(
      SHELL_ASSETS.map(async url => {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        await shell.put(url, res);
        return url;
      })
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn('[sw] Не удалось закэшировать при установке:', SHELL_ASSETS[i], r.reason);
      }
    });
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => ![APP_SHELL, STATIC_CACHE, RUNTIME_CACHE].includes(k)).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (e) {}
    }
    await self.clients.claim();
  })());
});

function matchesRateApi(url) {
  return url.hostname.includes('fawazahmed0') || url.hostname.includes('jsdelivr.net');
}

// Looks across ALL our caches (not just one), with ignoreSearch as a safety
// net against query-string mismatches (e.g. ?source=pwa on Android launch).
async function findInAnyCache(request) {
  const cacheNames = [APP_SHELL, STATIC_CACHE, RUNTIME_CACHE];
  for (const name of cacheNames) {
    const cache = await caches.open(name);
    let hit = await cache.match(request);
    if (hit) return hit;
    hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
  }
  return undefined;
}

async function getShellHtml() {
  const shell = await caches.open(APP_SHELL);
  return (await shell.match(SHELL_HTML_URL))
    || (await shell.match('./'))
    || (await findInAnyCache(new Request(SHELL_HTML_URL)));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (matchesRateApi(url)) {
      event.respondWith((async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        try {
          const res = await fetch(req);
          if (res && res.ok) await cache.put(req, res.clone());
          return res;
        } catch (e) {
          const cached = await cache.match(req);
          return cached || new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      })());
    }
    return;
  }

  // NAVIGATION REQUESTS — covers both cold start from the home-screen icon
  // AND a manual reload of the open PWA. This handler is guaranteed to
  // resolve with a valid Response in every branch, never undefined,
  // and never an unhandled rejection — that is what previously let the
  // browser's native "You're offline" interstitial take over on reload.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const shell = await caches.open(APP_SHELL);
          shell.put(SHELL_HTML_URL, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (networkError) {
        try {
          const cachedShell = await getShellHtml();
          if (cachedShell) return cachedShell;
        } catch (cacheError) {
          // fall through to emergency response below
        }
        return emergencyResponse();
      }
    })());
    return;
  }

  // ВАЖНО: для JS-файлов Firebase/Alpine/Chart используем "network-first,
  // затем кэш" вместо чистого "cache-first". Раньше устаревший кэш этих
  // файлов мог годами отдаваться из установленного PWA, даже после того как
  // на сервере файлы уже исправлены — именно это вызывало "auth is null"
  // в установленном приложении, пока в браузере всё работало нормально.
  const isCriticalScript = /\/assets\/vendor\/(firebase-|alpine|chart)/.test(url.pathname);
  if (isCriticalScript) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.ok) {
          const cache = await caches.open(STATIC_CACHE);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (e) {
        const cached = await findInAnyCache(req);
        return cached || Response.error();
      }
    })());
    return;
  }

  // ALL OTHER SAME-ORIGIN REQUESTS — cache-first, background revalidate,
  // with a final network attempt and a safe fallback that never rejects.
  event.respondWith((async () => {
    try {
      const cached = await findInAnyCache(req);
      if (cached) {
        event.waitUntil((async () => {
          try {
            const res = await fetch(req);
            if (res && res.ok) {
              const cache = await caches.open(STATIC_CACHE);
              await cache.put(req, res.clone());
            }
          } catch (e) {}
        })());
        return cached;
      }
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(STATIC_CACHE);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      const fallback = await findInAnyCache(req);
      return fallback || Response.error();
    }
  })());
});
