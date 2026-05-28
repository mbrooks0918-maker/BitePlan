# BitePlan — App Build Handoff

## Concept

BitePlan generates color-coded fishing zones on a map based on real-time conditions — tide, weather, habitat, structure, time of day, season. **No preloaded waypoints**. The angler pans/zooms anywhere from Mobile Bay to Port St. Joe and sees red/orange/yellow heat zones across all viable inshore water. A time slider scrubs through the next 24 hours or 7 days, re-scoring zones as conditions change.

**Tagline:** "Eliminate water. Find the bite."

## Naming history (decided)

Final name: **BitePlan** (camelCase, one word). Chosen because it rhymes with "flight plan" — exact mental model the user wanted. Rejected candidates included Tideline, Saltbed, Edge, Pattern, Plot, Read, AnglerPlan.

## Color tiers (locked — primary visual language)

- **Red** (score 8-10): Fire. Anchor here, work it 30+ minutes.
- **Orange** (score 5-7): Hot. Real stop, fish it 15-30 minutes.
- **Yellow** (score 0-4): Drive-by. A few casts in passing, 5-10 minutes.

No "skip" tier. Every visible scored zone is worth at least a few casts. Color tells the angler how to allocate time.

## Vocabulary (locked — plain English, NO aviation theme)

- A saved fishing spot = **"waypoint"** (universal angler/navigator language without forcing the flight-plan metaphor)
- The conditions readout = "Today's Conditions"
- Daily 1-10 score = "Conditions Score"
- Main save action = "Save Waypoint"
- Past trips = "Logbook" (Phase 3 stub)

## Coverage

Inshore waters from Alabama (Dauphin Island / Mobile Bay) through Port St. Joe, FL.

Bounding box: West -88.30, East -85.20, South 29.70, North 30.80.

Default map view: centered on Perdido Bay (30.317, -87.436) at a zoom that shows Garcon Rd through the FL/AL line islands. User pans freely anywhere in the coverage area.

## Trip Mode (locked behavior)

- **Auto-activation window:** May 30 – June 14, 2026 (hardcoded)
- When active, day picker shows 12 cards for Jun 1–12 instead of generic "next 7 days"
- Each card shows that day's best 3-hour window + Conditions Score + tier counts
- "Trip Mode: Jun 1–12" banner appears at top of bottom sheet
- Manual toggle in settings to override
- After June 12, auto-deactivates; falls back to "next 7 days from today"

## Save Waypoint flow (locked)

- **Default label format:** `"Waypoint — {Mon DD, h:mm AM/PM}"` (e.g., "Waypoint — Jun 4, 7:42 AM") in local time
- **Single tap save** — no modal, no form
- **Toast appears** at bottom for 4-5 seconds: "Saved as 'Waypoint — Jun 4, 7:42 AM' — tap to rename"
- **If user taps toast within window:** inline edit field slides up with default text pre-filled and selected
- **Auto-captured with the waypoint** (not user-editable): lat/lon, timestamp, current tide state, current Conditions Score, current scored tier of underlying zone (if any), current species filter (if set)

## Stack (locked)

- Vite + React + TypeScript
- Tailwind CSS + shadcn/ui
- react-leaflet for the map
- @turf/turf for geospatial math
- Workbox + vite-plugin-pwa for offline / PWA
- Lucide icons
- date-fns for dates
- Zustand for state
- suncalc for moon phase + sunrise/sunset
- Deployed to Vercel as project `bite-plan`, subdomain `biteplan.vercel.app`
- Future: register `biteplan.app` domain on Cloudflare or Porkbun

## Project structure

```
bite-plan/
├── public/
│   ├── data/
│   │   ├── seagrass.geojson
│   │   ├── oysters.geojson
│   │   ├── wetlands.geojson
│   │   └── tide_stations.json
│   ├── icons/
│   └── manifest.json
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── Map/
│   │   │   ├── MapView.tsx
│   │   │   ├── HabitatLayers.tsx
│   │   │   ├── ScoredZones.tsx
│   │   │   ├── SavedWaypoints.tsx
│   │   │   ├── UserLocation.tsx
│   │   │   └── ZonePopup.tsx
│   │   ├── TimeStrip/
│   │   │   ├── TimeSlider.tsx
│   │   │   ├── DayPicker.tsx
│   │   │   └── ModeToggle.tsx
│   │   ├── BottomSheet/
│   │   │   ├── BottomSheet.tsx
│   │   │   ├── ConditionsPanel.tsx
│   │   │   ├── TideReadout.tsx
│   │   │   ├── WeatherReadout.tsx
│   │   │   ├── SpeciesFilter.tsx
│   │   │   ├── TierFilter.tsx
│   │   │   ├── LayerToggles.tsx
│   │   │   └── WaypointsList.tsx
│   │   ├── Trip/
│   │   │   ├── TripToggle.tsx
│   │   │   └── TripStrip.tsx
│   │   ├── SaveWaypoint/
│   │   │   ├── SaveButton.tsx
│   │   │   ├── SaveToast.tsx
│   │   │   └── RenameInline.tsx
│   │   ├── OnWater/
│   │   │   └── OnWaterMode.tsx
│   │   ├── ui/   (shadcn)
│   │   └── LocateButton.tsx
│   ├── lib/
│   │   ├── tides.ts
│   │   ├── weather.ts
│   │   ├── scoring.ts
│   │   ├── habitat.ts
│   │   ├── projection.ts
│   │   ├── geo.ts
│   │   ├── storage.ts
│   │   ├── moon.ts
│   │   └── stations.ts
│   ├── store/
│   │   └── useBitePlanStore.ts
│   ├── types.ts
│   ├── main.tsx
│   └── index.css
├── scripts/
│   └── fetch-data.ts
├── vite.config.ts
├── tailwind.config.ts
└── README.md
```

## Data sources (all public, free, no auth)

### Seagrass (FWC)
- Hub: https://geodata.myfwc.com/datasets/myfwc::seagrass-habitat-in-florida
- Authoritative endpoint: `https://gis.myfwc.com/hosting/rest/services/Open_Data/Seagrass_Statewide/MapServer/15` (verified in Step 3)
- Query FeatureService with `f=geojson` and `geometry` envelope matching coverage bbox
- Save filtered output to `public/data/seagrass.geojson`

### Oyster beds (FWC)
- Hub: https://geodata.myfwc.com/datasets/myfwc::oyster-beds-in-florida
- Authoritative endpoint: `gis.myfwc.com/hosting/rest/services/Open_Data/Oyster_Beds_Statewide/MapServer/17`
- Same pattern, save to `public/data/oysters.geojson`

### Alabama Perdido Bay artificial reefs (AMRD)
- ArcGIS service: `https://conservationgis.alabama.gov/adcnrweb/rest/services/Perdido_Inshore_Reef_Sonar_Images/MapServer`
- 4 reefs with verified GPS coordinates (see "Verified Data Inventory" below)
- Has center points, boundaries, AND side-scan sonar images
- Supports `generateKml` endpoint

### Wetlands (USFWS NWI)
- REST (working): `https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0`
- Deprecated: `https://www.fws.gov/wetlandsmapservice/services/Wetlands/MapServer/0` — returns 403 as of Step 3
- Query with `f=geojson`, filter to estuarine/marine wetland types only. Use the `IN` form — the OR-equals form 500s on the server because the layer joins to a code table:
  `Wetlands.WETLAND_TYPE IN ('Estuarine and Marine Wetland', 'Estuarine and Marine Deepwater')`
- Joined WHERE is server-expensive over large bboxes; tile the coverage area into smaller pieces (Step 3 uses a 4×2 grid)
- Save to `public/data/wetlands.geojson`

**Failure handling:** If any FWC/USFWS endpoint fails or doesn't respond in the fetch-data script, log clearly and continue. Stub with empty FeatureCollection so the app doesn't crash.

### Tide predictions (NOAA CO-OPS API, browser-side, CORS OK)

Multi-station support. Stations in coverage area:

| Station | ID | Lat | Lon |
|---|---|---|---|
| Dauphin Island, AL | 8735180 | 30.250 | -88.075 |
| Mobile State Docks, AL | 8737048 | 30.708 | -88.043 |
| Bon Secour, AL | 8736897 | 30.328 | -87.730 |
| Nix Point, Perdido Bay, FL | 8729962 | 30.413 | -87.448 |
| Pensacola, FL | 8729840 | 30.404 | -87.211 |
| Navarre Beach, FL | 8729214 | 30.376 | -86.866 |
| Destin, FL (Panama City Beach gauge) | 8729210 | 30.215 | -85.879 |
| Panama City, FL | 8729108 | 30.152 | -85.667 |
| Apalachicola, FL | 8728690 | 29.727 | -84.981 |

API endpoint pattern:
```
https://api.tidesandcurrents.noaa.gov/api/prod/datagetter
  ?product=predictions
  &application=BitePlan
  &begin_date={YYYYMMDD}
  &end_date={YYYYMMDD}
  &datum=MLLW
  &station={STATION_ID}
  &time_zone=lst_ldt
  &units=english
  &interval=hilo        (or interval=6 for smooth curve)
  &format=json
```

**Critical:** Whenever user pans the map, compute the nearest tide station to map center via haversine. Use that station's predictions for scoring. Cache predictions per station with stale-while-revalidate (1-hour fresh window).

**Cross-day bracketing (also critical):** Gulf-coast tides are largely diurnal, and at subordinate stations (e.g. Nix Point) a single calendar day can publish just one hi/lo event. `getCurrentTideState` must find the previous and next bracketing events EVEN WHEN THEY SIT ON YESTERDAY OR TOMORROW — otherwise any time after the day's single event reads as "slack" forever, falsely killing the tide factor across all afternoon/evening windows. Callers should pass a multi-day merged event list assembled via `assembleTideWindow(stationId, around)` (yesterday + today + tomorrow). The projection engine fetches days −1 → +7 for the same reason. The cache:tide:{stationId}:{YYYYMMDD} SWR cache makes the extra fetches free after the first call.

### Weather (NOAA NWS API, browser-side, CORS OK)

Step 1: `https://api.weather.gov/points/{lat},{lon}` → returns the grid point office and coordinates.
Step 2: `https://api.weather.gov/gridpoints/{office}/{x},{y}/forecast/hourly` → returns hourly forecast.

Use wind speed/direction and precipitation in scoring and in the conditions panel. Refresh every hour.

## The scoring engine — generative, not curated

The heart of the app. No preloaded fishing spots. The engine scores habitat polygons and derived edges from FWC + USFWS data, in real time, at the current map view.

### Algorithm (runs on view change or time scrub)

1. **Get visible habitat polygons** in current map bounds via spatial filter against loaded GeoJSON
2. **For each polygon, derive scoring units:**
   - Small polygon (<5000 sq m): score whole polygon as one unit
   - Larger polygon: derive its boundary as a LineString edge, sample points along the edge every 20-50m, score each point
3. **For each scoring unit, call `scoreUnit(unit, ctx)`** where:
   - `unit`: `{ type: 'seagrass'|'oyster'|'wetland'|'edge', geometry, depthBucket?, adjacentTo? }`
   - `ctx`: `{ tideState, hour, species, moon, wind, date, station }`
4. **Cluster scored units into heat zones:**
   - Group nearby units of the same tier (DBSCAN-style, 100m epsilon)
   - For clusters of 3-200 members: compute convex hull + 50m buffer (turf.js) and render as a soft-shaded zone in tier color
   - For clusters of 200+ members (e.g., continuous coastline grass beds): SKIP the polygon — the per-unit dots are the heat indicator. A convex hull over hundreds of points along a long coastline produces a misleading bay-spanning ribbon that doesn't reflect where the bite actually is. The dots already cluster visually wherever the density is.
   - Cluster eps is tied to edge sample density (currently 100m) — increase eps if edge sampling tightens in a future perf pass.
5. **Render individual scored units** as small colored dots/lines on top of heat zones for fine detail when zoomed in

### Scoring rules — TypeScript types

```typescript
interface ScoringFactor {
  fired: boolean;
  description: string;        // e.g., "Falling tide (preferred for drainage mouths)"
  delta: number;              // positive magnitude
  category: 'tide' | 'time' | 'species' | 'habitat' | 'moon' | 'wind' | 'season' | 'depth';
}

interface ScoringResult {
  score: number;              // 0-10
  tier: 'fire' | 'hot' | 'driveby';
  timeInvestment: string;     // "30+ minutes" | "15-30 minutes" | "5-10 minutes"
  firedFactors: ScoringFactor[];
  missingFactors: ScoringFactor[];
  projectedNextFire: { when: Date; score: number; reason: string } | null;
}
```

### Scoring rules (every rule produces a visible factor)

**Habitat type baseline:**
- Seagrass edge: +2
- Oyster bed: +2
- Marsh edge (wetland boundary): +2
- Interior of large seagrass polygon: +0

**Tide stage:**
- Marsh edges: +2 rising, 0 falling, -1 slack
- Drainage mouths (wetland-to-open-water transitions): +2 falling, +1 rising, -1 slack
- Oyster bars: +1 moving water either direction, -1 slack
- Grass edges: +1 moving water either direction

**Time of day** (sunrise/sunset from suncalc for current map center):
- Dawn (sunrise ±1.5 hr): +2
- Dusk (sunset ±1.5 hr): +2
- Mid-morning (sunrise+1.5hr to 10am): +1
- Midday (10am-4pm): -1 in summer (May-Sep), 0 otherwise
- Afternoon (4pm to sunset−1.5hr): 0 — neutral daylight band so late-afternoon doesn't fall into night
- Night (sunset+1.5hr to sunrise−1.5hr): -2 — true dark only

**Season (current month):**
- May-Jun: +1 to all (peak inshore)
- Jul-Aug: -2 midday (heat penalty applies)
- Sep-Oct: +2 across the board (fall transition)
- Dec-Feb: -1 to grass flats, 0 to docks/passes

**Species filter (when active):**
- Redfish: +1 to marsh edges, oyster bars
- Trout: +1 to seagrass edges, grass-to-sand transitions
- Flounder: +1 to sand-adjacent grass, drainage mouths

**Moon phase (suncalc):**
- Illumination >0.9 or <0.1 (new/full): +0.5
- First/last quarter: 0

**Wind (NWS data):**
- <10 kt: 0
- 10-15 kt: -0.5
- 15-20 kt: -1
- >20 kt: -2

**Daily tide range** (from station hi/lo data):
- >1.2 ft: +0.5
- <0.5 ft: -0.5

Final score clamped to 0-10. Tier:
- 8-10: fire (red)
- 5-7: hot (orange)
- 0-4: driveby (yellow)

### Forward projection (`projection.ts`)

For any scored unit, compute `projectNextFireWindow()`:
1. Iterate next 7 days in 3-hour windows
2. For each window, build synthetic context (use tide predictions + suncalc + season; assume wind = current observed wind)
3. Score the unit at each window
4. Return the first window where score ≥ 8 with the projected score and a plain-English reason string ("falling tide + dawn")
5. If no window hits fire in 7 days, return the highest hot window
6. If nothing hits hot either, return null

Compute lazily on zone tap. Cache result for the session.

### Performance requirements

- Initial map render: <2 sec on cellular 4G with empty cache
- View pan/zoom: scored zones redraw within 300ms
- Time scrub: zones redraw within 200ms per step
- **Strategy:** pre-compute habitat polygon spatial index (rbush) on app init; scoring runs synchronously for visible polygons only; debounce map move events at 200ms; move scoring to a web worker if main-thread performance suffers
- Worker watchdog: the signature-based recompute coalescing (added in the Step 8/9 bugfix) leaves inFlightSignature locked if the worker dies or never responds, which silently halts all further recomputes until reload. Step 20 should add a ~90s timeout watchdog that clears inFlightSignature and surfaces an error if no 'scored' response arrives.

## UI: tier-color heat zones as primary visual

### Color tier rendering

**Red — Fire (score 8-10):**
- Heat zone fill: `rgba(239, 68, 68, 0.25)`, no border
- Individual unit dot: `#ef4444`, 14px radius, pulsing animation (2s cycle, scale 1.0→1.3, opacity 1.0→0.4)
- Z-index: highest among zones

**Orange — Hot (score 5-7):**
- Heat zone fill: `rgba(249, 115, 22, 0.18)`, no border
- Individual unit dot: `#f97316`, 10px radius, no animation
- Static halo at 20% opacity

**Yellow — Drive-by (score 0-4):**
- Heat zone fill: `rgba(234, 179, 8, 0.12)`, no border
- Individual unit dot: `#eab308` at 80% opacity, 8px radius
- No halo, no animation

**Always visible regardless of zoom.** Zones may aggregate at low zoom and split into individual dots at high zoom.

### Map base style

- **Tile source:** Esri World Imagery (free, no key needed):
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
- **App theme:** dark slate background (`#0a0e1a`)
- **Habitat layer toggles** (off by default to reduce clutter):
  - Seagrass: `rgba(20, 184, 166, 0.30)` fill, teal stroke
  - Oysters: `rgba(245, 158, 11, 0.40)` fill, amber stroke
  - Wetlands: `rgba(132, 204, 22, 0.25)` fill, lime stroke

### Zone Popup (tap-on-zone → why this score)

When user taps any colored zone or unit, show slide-up card with:

- Header bar in tier color (red/orange/yellow) with tier label ("FIRE" / "HOT" / "DRIVE-BY")
- Score readout (e.g., "Score: 9/10")
- Time investment recommendation ("Plan to spend 30+ minutes")
- Habitat type and short description ("Marsh edge, eastern shore")
- **Why-this-score section:**
  - For fire/hot: "Why it's [fire/hot] right now:" with `firedFactors` listed (✓ icon, plain English, delta as "+2", "+1", etc.)
  - For driveby: "Why it's not better right now:" with `missingFactors` listed (✗ icon, what's missing, what it would add)
- **Forward projection section:** "Lights up: Wed Jun 4 at 6:30 AM (9/10) — falling tide + dawn"
- Two CTAs: "Save Waypoint" and "Directions" (opens native maps app with lat/lon)

The factor lists are the trust layer — every score is fully explained with no hidden math.

## Bottom sheet — 3 snap points

**Peek** (10% screen): always visible
- Current tide state pill ("FALLING → 2:14 to low")
- Conditions Score for today (1-10, color-coded)
- Time slider thumb position

**Half** (50%): default open
- Time slider (24-hr mode) OR day picker (7-day mode); user toggles
- Top 5 fire/hot zones in current view (tap to fly to)
- Tier filter chips: [All] [🔥 Fire+] [🟠 Hot+]
- Species filter chips: [All] [Redfish] [Trout] [Flounder]

**Full** (90%): swipe up
- All of half-sheet content
- Layer toggles (Seagrass / Oysters / Wetlands / Heat / Waypoints)
- Saved Waypoints list
- Trip Mode toggle (auto-on during Jun 1-12)
- Settings (units, on-water mode, about)

## Time slider — two modes

**24-hour mode (default):**
- Horizontal slider, 24 hours, current time marked
- Drag thumb to scrub forward/backward
- Map re-scores live as thumb moves
- Snap points at significant tide events (high/low/slack)
- Tide curve shown behind the slider for visual reference

**7-day mode:**
- Switch via toggle near the slider
- 7 (or 12 in Trip Mode) day cards in horizontal scroll
- Each card shows: day of week, date, Conditions Score, count of fire zones, best 3-hour window
- Tap a card → that day at its best window loads on the map

## On-Water Mode

Toggle in settings (or button overlay on map). When ON:

- Bottom sheet collapses fully (no peek)
- Map fills 100% of screen
- Top-left overlay: giant tide pill ("FALLING — 2:14 to low") with Conditions Score badge
- Top-right overlay: GPS dot button (taps to recenter on user)
- Bottom-right overlay: Save Waypoint button (large, thumb-reachable)
- Time slider hidden (locked to "now")
- All other UI hidden

**Purpose:** one-thumb, sun-readable, on-the-water use. Tap anywhere on the map to bring up the zone popup briefly, then it auto-dismisses after 6 seconds.

**Auto-trigger heuristic:** if device is moving >2 mph for 5+ minutes and geolocation is in coverage bbox, prompt once to enable On-Water Mode.

## PWA / offline

- **Service worker (Workbox):**
  - Map tiles: CacheFirst, 30-day max age
  - Habitat GeoJSON: precache at install
  - Tide API: StaleWhileRevalidate, 1-hour fresh window
  - Weather API: StaleWhileRevalidate, 1-hour fresh window
- **Manifest:** name "BitePlan", short_name "BitePlan", display "standalone", theme_color "#0a0e1a", background_color "#0a0e1a"
- Custom iOS install prompt (Safari doesn't auto-prompt for PWA)
- App must remain functional with no network once first loaded

## Storage keys (`window.storage`)

- `waypoints:{uuid}` — saved waypoints (label, lat/lon, captured conditions, created timestamp)
- `settings:user` — user preferences (units, on-water mode auto, species filter default)
- `trip:active` — boolean override for Trip Mode (null = auto)
- `cache:tide:{stationId}:{YYYYMMDD}` — cached tide predictions
- `cache:weather:{lat}:{lon}` — cached weather data

## Mobile-first UI requirements

- Map fills 100% of screen behind everything
- All controls thumb-reachable in bottom 40% of screen
- Tap targets minimum 44x44 px
- Dark theme by default; high-contrast colors for sun readability
- No keyboard input required for primary flows (slider, taps, chips only). Save Waypoint rename is the only keyboard interaction
- Geolocation opt-in via "Locate me" button (don't drain battery by default)
- Aggressive offline caching

## Build order (Phase 1)

Work this sequence. Commit after each numbered step.

1. **Scaffold:** Vite + React + TS + Tailwind + shadcn/ui. Init repo, install deps, configure Tailwind, set up shadcn primitives
2. **Map shell:** react-leaflet, Esri tiles, default view on Perdido Bay
3. **Habitat data fetch:** write `scripts/fetch-data.ts`. Pull FWC seagrass, FWC oysters, USFWS wetlands. Filter to coverage bbox. Save to `public/data/`. Stub empty FeatureCollection if any source fails. Generate `tide_stations.json` from table above
4. **Habitat layers:** render the GeoJSON layers (toggleable, off by default)
5. **NOAA tide integration:** `lib/tides.ts` + `lib/stations.ts`. Pull today's hi/lo from nearest station to map center. Show TideReadout
6. **Scoring engine:** `lib/scoring.ts`. Implement all rules above. Score visible habitat polygons + derived edges on map move
7. **Heat zone rendering:** `ScoredZones.tsx`. Cluster scored units into colored zones via turf.js convex hull + buffer. Render with proper z-order: yellow → orange → red
8. **Zone Popup:** tap any zone → slide-up card with score breakdown (firedFactors and missingFactors) + forward projection
9. **Forward projection:** `lib/projection.ts`. Implement `projectNextFireWindow()` for any scoring unit
10. **Time slider:** 24-hour mode with tide curve background. Scrubbing updates `ctx` and re-runs scoring
11. **Day picker:** 7-day mode. Compute Conditions Score per day + tier counts
12. **Trip Mode:** detect May 30–Jun 14 window, switch day picker to 12 cards for Jun 1–12. Banner in bottom sheet
13. **NOAA weather integration:** `lib/weather.ts`. Pull wind for map center. Feed into scoring engine
14. **Save Waypoint flow:** SaveButton + SaveToast + RenameInline. Stored via `window.storage`
15. **Saved Waypoints list:** render in bottom sheet, render as map pins
16. **Bottom sheet:** all 3 snap points, swipe gestures, tier/species filter chips
17. **Locate Me:** geolocation button, blue dot with pulsing ring
18. **On-Water Mode:** toggle + collapsed UI. Optional auto-trigger heuristic
19. **PWA setup:** manifest, service worker, install prompt, offline caching strategy
20. **Performance pass:** rbush spatial index for habitat, debounce map moves, web worker for scoring if needed
21. **Polish:** animations on tier pulse, smooth time scrub, transitions
22. **Deploy to Vercel** at `biteplan.vercel.app`

## Working principles

- **Ship working > ship perfect.** If a feature is gnarly, stub it and move on. Don't block the build.
- **If a data source fails** (FWC endpoint down, NWS rate-limited), log clearly, stub with empty data, continue
- **Optimize for "thumb on phone in sun with one hand."** That is the user.
- **Ask before installing any unfamiliar package**
- **Commit after every numbered step** with a meaningful message

## Verified Data Inventory (research-validated, use these in seeding/testing)

### Alabama Perdido Bay AMRD Reefs (all 4 verified via Alabama ArcGIS service + watermeat.com)

| Reef | GPS | Acres | Depth | Material | Built |
|---|---|---|---|---|---|
| **Rockpile Reef** | 30.333517, -87.498533 | 14.1 | 9 ft | Long line of limestone rock along N boundary | 2011 |
| **Ross Point Reef** | 30.323933, -87.511133 | 4.4 | 13 ft | Concrete bridge rubble, pilings, bridge spans | 2005 |
| **Ono Island Reef** | 30.302783, -87.490067 | 9.3 | 11 ft | Rock rubble, red-clay bricks, concrete pilings | 2005 |
| **Bayou St John Reef** | 30.292683, -87.532667 | 5.3 | 11 ft | Rock rubble and concrete pilings | 2005 |

Source: Alabama Marine Resources Division side-scan sonar imagery (`https://conservationgis.alabama.gov/adcnrweb/rest/services/Perdido_Inshore_Reef_Sonar_Images/MapServer`)

### Florida Pensacola Bay System restoration anchors

- **Project GreenShores Site II:** 30.4132, -87.2007 — 4 acres oyster reef + 9 acres salt marsh (urban Pensacola, NOAA Project ID 26)
- **Garcon Point peninsula (FDEP):** 866 intertidal reefs between Garcon and White Points. Anchor: 30.5833, -87.0580. Mostly private property access.
- **Escribano Point WMA:** 30.5103, -86.9933 — anchor for TNC 33-reef corridor along 6.5 miles of east shore of East and Blackwater Bays. Reefs 200-500 ft offshore in ~4 ft water. Individual reef coordinates NOT publicly available.
- **Navy Point Park reef structures:** 30.3817, -87.2834 — 87 structures (struggling/eroding per recent news)
- **White Island living shoreline:** 30.3765, -87.2687 (Bayou Grande mouth)
- **Naval Live Oaks Fishing Trail:** ~30.37, -87.13 — Santa Rosa Sound kayak access

### Verified launch points

- **Big Lagoon State Park:** 30.3098, -87.4029 (boat ramp + kayak launch)
- **Johnson Beach Boat Launch (NPS):** 30.3027, -87.4148
- **Galvez Landing (24hr):** 30.3138, -87.4420
- **Bayou Grande Marina (military only):** 30.368, -87.270
- **Sherman Cove Marina (military only):** 30.335, -87.325
- **Escribano Point WMA:** 30.5103, -86.9933

### Habitat coverage stats (PPBEP 2022 mapping)

- Santa Rosa Sound: 2,582 acres of seagrass (richest grass-flat fishery in region)
- Perdido Bay + Big Lagoon: 947 acres of seagrass
- Pensacola Bay oyster habitat: **mostly gone or severely degraded** — only the cultch-restored areas still produce (FL Trustee Implementation Group 2022 NRDA report)
- 2024 discovery: New oyster farms at Garcon Point with flashing yellow buoy markers (Pensacola Fishing Forum, Oct 2024)

## User context (Matt)

- Owner of JABRO Construction LLC, Reliable Renovations, Altered Earth (Alabama)
- Pastor at LifePoint Church
- Has Claude Max plan now (was Pro $20)
- Not a developer — relies on AI assistance for all technical work
- Working pattern: Claude provides complete file code → Matt pastes into GitHub → Vercel auto-deploys
- Has prior apps deployed via Vite+React+Supabase+Vercel: SermonPrep Pro, Practice:Pace, Bedrock
- Claude Code integrated into workflow, always launched from project folder
- Mac-based development environment
- Going on a 12-day kayak fishing trip June 1-12, 2026 to Perdido Key, FL (staying on Garcon Rd at the end of a canal — 30.317, -87.436)
- Trip drove the original BitePlan vision

## Deliverable already made for the trip

`biteplan-garcon-v2.kml` — a static KML file with the 4 verified AMRD reefs (with polygons sized to actual acreage), Pensacola Bay system anchors, launch points, and trip-critical notes. This file was the interim solution while the app build was deferred. The on-water lessons from using this KML during the trip should feed back into BitePlan refinements.

## Phase 2/3 candidates (deferred)

- Native iOS wrapper (planned for future; needed for AirPlay second-screen mode using UIKit's UIScreen API — not achievable in web)
- Derived feature pipeline for cleaner edges
- Weather radar overlay
- Community-shared waypoints
- Sync across devices
- "Logbook" tab — past trips with weather/tide/conditions playback
- Backfill Mobile Bay wetlands — tiles 1 and 5 of the Step 3 fetch failed with HTTP 500 (USFWS server overload). Affects Alabama portion of coverage (Dauphin Island, north Mobile Bay estuary). Resolution: targeted backfill script with smaller sub-tiles over the AL column, dedup by OBJECTID. Not blocking the Perdido Key trip use case.
- Labeled basemap toggle — overlay roads, state/county lines, and place names on the satellite view. Should be a toggle in the layer controls (off by default per current spec, but easily accessible). Useful for orientation when not yet using GPS.
- Dev-only labeled basemap option for testing — quick toggle during development to see where the map is centered without having to rely on GPS or habitat layers.
