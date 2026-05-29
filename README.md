# BitePlan

**Eliminate water. Find the bite.**

A mobile-first kayak-fishing PWA that scores nearshore zones by stacking the cues
that actually drive fish behavior — tide phase, moon, wind, pressure trend,
front timing, habitat edges, depth breaks, and structural convergence — then
shows you only the spots where enough of those signals line up. Built for the
Florida Gulf Coast, primarily the Pensacola → Perdido Key → Orange Beach
corridor, with all data sourced from public NOAA / NWS / USGS / state seagrass
and oyster-bed datasets.

**Live:** [biteplan.vercel.app](https://biteplan.vercel.app)

---

## Why this exists

Most fishing apps tell you everything. BitePlan tries to do the opposite: rule
out 90% of the map so the remaining 10% is worth paddling to. The scoring
philosophy is **convergence-based** — a tile only earns a `FIRE` or `HOT` tier
when several independent cues stack at the same place and time. Single-cue
tiles get demoted on purpose, even if one signal looks great in isolation,
because chasing a single signal is what burns a day on the water.

Zones come in three tiers:

- **FIRE** — multi-cue convergence, including at least one structural feature
- **HOT** — strong stack of bio + environmental cues
- **DRIVE-BY** — worth a drift, not a trip

Tap a zone to see *why* it scored — every factor that contributed and every
factor that's pulling it down. Save the ones you fish so you can rebuild
intuition over a season.

## Stack

- **Vite + React 19 + TypeScript** — single-page app
- **Tailwind v4 + shadcn/ui** — dark, sun-readable UI
- **react-leaflet** over Esri World Imagery + ocean basemap
- **Zustand** store, with a dedicated **Web Worker** for scoring (Florida Gulf
  shoreline runs ~60k habitat units; main thread stays interactive)
- **vite-plugin-pwa + Workbox** — service worker, install prompt, offline
  fallback (Esri tiles `CacheFirst` 30-day TTL, NOAA / NWS `StaleWhileRevalidate`)
- **turf** for geometry, **rbush** for habitat lookup, **suncalc** for moon
- **GeoTIFF** depth contours from NOAA bathymetry (offline-cached at fetch time)

Deployed to **Vercel** as `bite-plan` → `biteplan.vercel.app`.

## Local dev

```bash
npm install
npm run dev       # vite dev server
npm run build     # tsc -b && vite build (also generates the SW)
npm run preview   # serve dist/ exactly as Vercel will
npm run fetch-data  # one-time: pull NOAA bathy + state habitat data into public/data
```

`fetch-data` is a one-off Node script that downloads the raw GeoJSON +
GeoTIFF inputs, pre-computes convergence primitives (chokepoints, points,
confluences, depth breaks), and writes simplified habitat polygons +
`convergence_index.json` into `public/data/`. The runtime never re-derives
this; everything ships pre-baked.

## Data credits

- Habitat polygons: **NOAA / Florida FWC / USGS** seagrass, oyster bed, and
  estuarine wetland datasets (public domain)
- Tides + currents: **NOAA Tides & Currents** API
- Weather + pressure trend + front timing: **NWS** `/points` and
  `/gridpoints` endpoints
- Bathymetry: **NOAA NCEI** GeoTIFF tiles, simplified to 1/2/4 ft contours
- Basemap: **Esri World Imagery** + ocean reference layer

All third-party data is public. BitePlan stores nothing on a server — every
saved waypoint, every setting, every preference lives in your browser's
`localStorage`.

## Notes

This is a personal-use app built for a Perdido Key trip, not a commercial
product. There is no signup, no analytics, no telemetry. The scoring model is
opinionated and tuned to a particular coastline and a particular style of
shallow-water fishing — your mileage will vary outside the Gulf Coast.

If you want to ship it for your own water, the convergence detector and
scoring rules in `src/lib/` are the parts to retune. The rest of the app is
generic.

See [`DEPLOY.md`](./DEPLOY.md) for deploy + install instructions.
