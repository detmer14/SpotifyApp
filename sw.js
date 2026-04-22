const CACHE_NAME = 'mixer-cache-v1';
const ASSETS_TO_CACHE = [
  './',
  '/style.css',
  '/icons/launchericon-192x192.png',
  '/icons/launchericon-512x512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of ASSETS_TO_CACHE) {
          try {
              await cache.add(asset);
          } catch (err) {
              // This will tell you EXACTLY which file is missing
              console.error(`PWA Error: Could not find file ${asset}`);
          }
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim()); // Takes control of all open tabs immediately
});

// Fetch Event: Custom strategy
self.addEventListener('fetch', (event) => {
  // 1. SKIP caching for any POST, PUT, or DELETE requests
  if (event.request.method !== 'GET') {
    return; // Let the browser handle these normally without the Service Worker
  }

  const url = new URL(event.request.url);

  // 2. Also SKIP caching for Spotify API calls (they require fresh data)
  if (url.hostname.includes('spotify.com')) {
    return;
  }

  // 3. Your existing Network-First logic for HTML/JS
  // NETWORK-FIRST for HTML and JS (The "logic" of your app)
  // This ensures they stay in sync and are always the latest version
  if (url.pathname === '/' || url.pathname.endsWith('index.html') || url.pathname.endsWith('app.js')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Only cache successful, standard responses
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          const clonedResponse = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clonedResponse));
          return response;
        })
        .catch(() => caches.match(event.request)) // Fallback to cache ONLY if offline
    );
  } else {
    // 4. Cache-First for static assets
    event.respondWith(
      caches.match(event.request).then((response) => response || fetch(event.request))
    );
  }
});
