// Minimal, SAFE service worker:
// - no precache, no runtime cache
// - does not intercept or rewrite fetch requests
// This only exists to enable the PWA install prompt safely.
self.addEventListener('install', (event) => {
  // Activate immediately on first install
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  // Intentionally do nothing — let the network handle everything.
  // This avoids stale bundles and won’t interfere with wallet RPC or auth.
})
