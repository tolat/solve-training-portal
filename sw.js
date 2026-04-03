/**
 * Solve Energy Training Portal — Service Worker
 * Strategy:
 *   • Static assets  → Cache-first (fast loads, works offline)
 *   • API calls      → Network-first (fresh data when online, fallback offline message)
 */

const CACHE_NAME = 'solve-training-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/quiz-data.js',
  '/solve_logo.png',
  '/solve_icon.png',
  '/pwa_download.png',
  '/manifest.json',
];

// ── Install: pre-cache all static assets ─────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching static assets');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // Activate immediately without waiting for old SW to be replaced
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
  // Take control of all open tabs immediately
  self.clients.claim();
});

// ── Fetch: routing strategy ───────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // API calls → network-first, with offline fallback JSON
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // Static assets → cache-first
  event.respondWith(cacheFirst(request));
});

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
    // If we have no cache and no network, return a simple offline page
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

// Network-first: try network, fall back to offline JSON error
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
