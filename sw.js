/**
 * Solve Energy Training Portal — Service Worker
 * Strategy:
 *   • HTML + JS files → Network-first (always get updates, fall back to cache offline)
 *   • Images + CSS    → Cache-first (fast loads, rarely change)
 *   • API calls       → Network-first (fresh data when online, fallback offline message)
 */

const CACHE_NAME = 'solve-training-v3';

// Truly static assets that rarely change — served cache-first
const STATIC_ASSETS = [
  '/css/styles.css',
  '/solve_logo.png',
  '/solve_icon.png',
  '/pwa_download.png',
  '/manifest.json',
];

// Files that update with each deploy — always network-first
const NETWORK_FIRST_ASSETS = [
  '/',
  '/index.html',
  '/js/app.js',
  '/js/quiz-data.js',
];

// ── Install: pre-cache static assets ─────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching static assets');
      return cache.addAll([...STATIC_ASSETS, ...NETWORK_FIRST_ASSETS]);
    })
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: routing strategy ───────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // API calls → network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // HTML + JS → network-first (so deploys are picked up immediately)
  const isAppFile = NETWORK_FIRST_ASSETS.some(p => url.pathname === p || url.pathname === p + '/');
  if (isAppFile || url.pathname.endsWith('.html') || url.pathname.endsWith('.js')) {
    event.respondWith(networkFirstStatic(request));
    return;
  }

  // Images, CSS, fonts → cache-first
  event.respondWith(cacheFirst(request));
});

// Network-first for app files: fetch fresh, update cache, fall back to cache offline
async function networkFirstStatic(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Last resort offline page for navigation requests
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8">
       <meta name="viewport" content="width=device-width,initial-scale=1">
       <title>Solve Energy — Offline</title>
       <style>
         body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
                justify-content: center; min-height: 100vh; margin: 0;
                background: #f1f5f9; color: #1e293b; text-align: center; padding: 24px; }
         .card { background: white; border-radius: 16px; padding: 40px 32px;
                 box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 360px; }
         h1 { font-size: 20px; margin: 16px 0 8px; color: #1a7a4a; }
         p  { color: #64748b; font-size: 14px; line-height: 1.5; margin: 0; }
       </style>
       </head><body>
         <div class="card">
           <div style="font-size:48px">📶</div>
           <h1>You're offline</h1>
           <p>Please check your internet connection and try again. Your completed training progress is saved and will sync when you're back online.</p>
         </div>
       </body></html>`,
      { status: 503, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// Cache-first: try cache, fall back to network and update cache
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// Network-first for API: fresh data when online, clean error when offline
async function networkFirstApi(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({ error: 'You are offline. Please reconnect and try again.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
