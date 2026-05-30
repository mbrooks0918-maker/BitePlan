import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Step 19 — PWA / offline. The handoff doc's offline policy is
    // implemented here via Workbox runtime caching strategies plus a
    // precache that includes the habitat / depth / station data files
    // dropped into public/data/ by the fetch script.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: [
        // Hand-rolled placeholder icons (Step 21 will replace with final art)
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/maskable-512.png',
      ],
      manifest: {
        name: 'BitePlan',
        short_name: 'BitePlan',
        description: 'Eliminate water. Find the bite.',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        theme_color: '#0a0e1a',
        background_color: '#0a0e1a',
        orientation: 'any',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell is auto-included by the plugin (JS / CSS / HTML built
        // by Vite). We explicitly add the public/data files so habitat,
        // depth grid + contours, and tide station metadata are precached
        // on install — these are the "critical app data" per spec B.2.
        globPatterns: [
          '**/*.{js,css,html,svg,png,ico,woff,woff2}',
        ],
        // The depth + wetlands payloads are large; let the precache list
        // include up to ~80 MB worth of entries (Workbox default is 2 MB
        // per file, total cap is much higher — but we set a generous
        // ceiling so a future scaled-out coverage area doesn't silently
        // get truncated).
        maximumFileSizeToCacheInBytes: 80 * 1024 * 1024,
        // We need to manually precache /data/* because the plugin's glob
        // runs inside the dist/ output and the data files live under
        // public/ (Vite copies them to dist/ at build time, but the
        // precache glob picks them up via the standard relative path).
        additionalManifestEntries: [
          { url: '/data/seagrass.geojson', revision: null },
          { url: '/data/oysters.geojson', revision: null },
          { url: '/data/wetlands.geojson', revision: null },
          { url: '/data/tide_stations.json', revision: null },
          { url: '/data/depth_grid.json', revision: null },
          { url: '/data/depth_contours.geojson', revision: null },
          // Step 20: precomputed convergence primitives. Tiny (~12 KB)
          // and load-critical — habitat init falls back to the slow
          // runtime detector if this is missing.
          { url: '/data/convergence_index.json', revision: null },
        ],
        runtimeCaching: [
          // B.1 — Esri World Imagery tiles: CacheFirst, 30 day TTL, LRU
          // 500 entries. Big visual hit when offline if a tile's missed
          // its turn in cache, but the LRU keeps the cache bounded.
          {
            urlPattern: /^https:\/\/server\.arcgisonline\.com\/.*$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'biteplan-map-tiles',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // B.1.2 — NOAA Chart Display Service tiles (paper-chart + ENC).
          // Same CacheFirst strategy as Esri imagery. Both NOAA endpoints
          // live on `gis.charttools.noaa.gov` so a single cache entry
          // holds tiles from both styles (the URL path encodes which
          // service produced each tile, so collisions can't happen). 500
          // entries gives us ~16 km^2 of coverage at zoom 14 per style.
          {
            urlPattern: /^https:\/\/gis\.charttools\.noaa\.gov\/.*\/tile\/.*$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'biteplan-noaa-charts',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // B.3 — NOAA tide API: StaleWhileRevalidate, 1h fresh window.
          // The store's SWR layer is also in front; runtime cache gives
          // us truly-offline fallback after that has expired.
          {
            urlPattern: /^https:\/\/api\.tidesandcurrents\.noaa\.gov\/.*$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'biteplan-noaa-tides',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // B.4 — NWS Weather API: same shape as NOAA tides.
          {
            urlPattern: /^https:\/\/api\.weather\.gov\/.*$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'biteplan-nws-weather',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // Always serve the dev-mode SW (off by default, kept disabled here
      // so the dev experience matches what Step 17/18 saw — only build
      // and `npm run preview` exercise the real worker).
      devOptions: {
        enabled: false,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
