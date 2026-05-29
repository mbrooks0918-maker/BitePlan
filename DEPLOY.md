# Deploying BitePlan

This guide takes you from a clean repo to a live PWA at
`https://biteplan.vercel.app`, then through installing it to your iPhone home
screen.

> BitePlan has **no environment variables** and **no server**. All data is
> public (NOAA / NWS / state habitat datasets); all user state lives in
> `localStorage`. Deploy is just a static-site push.

---

## 1. First-time setup

### 1a. Push the repo to GitHub

From the project root:

```bash
git remote add origin git@github.com:<your-user>/biteplan.git
git push -u origin main
```

If the repo already exists on GitHub, just `git push`.

### 1b. Import the repo into Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and pick the GitHub repo.
2. **Project name:** `bite-plan`
   *(This is what makes the production URL `biteplan.vercel.app` — see step 1c.)*
3. **Framework preset:** Vercel auto-detects **Vite**. Leave it.
4. **Build & Output Settings:** leave on defaults — `vercel.json` in the repo
   already pins `buildCommand: npm run build` and `outputDirectory: dist`.
5. **Environment Variables:** leave empty. BitePlan needs none.
6. Click **Deploy**.

First build takes ~2–3 minutes (mostly `npm install` and the SW precache
manifest generation). When it finishes you get a URL like
`bite-plan-abc123.vercel.app`.

### 1c. Lock the production domain

Production domain on Vercel is `<project-slug>.vercel.app`. With the project
named `bite-plan` you get `bite-plan.vercel.app` for free. To get the prettier
`biteplan.vercel.app`:

1. In the project, go to **Settings → Domains**.
2. Add `biteplan.vercel.app`. Vercel will check availability — if it's free,
   it assigns to your project immediately.
3. Set it as the **Production Domain** (the toggle next to it).

If `biteplan.vercel.app` is taken, fall back to `bite-plan.vercel.app` or any
other free `*.vercel.app` slug and update `README.md` accordingly.

---

## 2. Future deploys

Every push to `main` triggers a Vercel production deploy automatically:

```bash
git push
```

That's it. Vercel runs `npm run build`, replaces the SW (`sw.js` is served
with `max-age=0, must-revalidate` per `vercel.json`), and atomically swaps the
edge cache. Live users see the **Update available** banner on their next
visit and can tap to refresh.

For preview deploys, push to any non-main branch — Vercel builds a unique
URL you can share before merging.

---

## 3. Build settings reference

These are the values Vercel reads from `vercel.json`. You shouldn't have to
touch them in the Vercel UI:

| Setting | Value |
| --- | --- |
| Framework preset | Vite |
| Build command | `npm run build` |
| Install command | `npm install` |
| Output directory | `dist` |
| Dev command | `npm run dev` |
| Node version | 20.x (Vercel default) |

`vercel.json` also defines:

- `Cache-Control: max-age=0, must-revalidate` for `sw.js`, `workbox-*.js`,
  `registerSW.js`, `manifest.webmanifest` (so updates ship instantly)
- `Cache-Control: max-age=86400, stale-while-revalidate=604800` for `/data/*`
  (habitat / depth / convergence JSON revalidates daily, never blocks)
- `Cache-Control: max-age=31536000, immutable` for `/assets/*` and `/icons/*`
  (Vite hashes filenames, so this is safe forever)
- SPA rewrites: anything that isn't an asset / data file / SW asset → `/index.html`

---

## 4. Verifying a fresh deploy

After the deploy URL goes green:

1. Open the URL in a private window.
2. Map should load with the Esri imagery basemap and the BitePlan dot pulse
   over Pensacola → Perdido by default.
3. Drag a finger across the time strip — score banner under the tide pill
   should update without freezing.
4. Tap a `FIRE` or `HOT` zone → ZonePopup slides up with factor stack.
5. Tap **Save Waypoint** → toast appears, pin renders on the map, the saved
   waypoint shows in the bottom sheet's Full snap.
6. Toggle airplane mode on your phone → map tiles, tide pill, and saved
   waypoints all keep working. Score recomputes when conditions are cached.
7. Tap the **Update available** banner if it appears (only on subsequent
   deploys) and confirm the new SW takes over.

---

## 5. Installing BitePlan on iOS

iOS doesn't show an install button — the user has to use the Safari share
sheet. BitePlan shows an in-app card explaining this 30 seconds after first
visit on iOS Safari (dismissible for 30 days).

**Manual walkthrough:**

1. Open `biteplan.vercel.app` in **Safari** on the iPhone. (Chrome on iOS
   uses the WebKit shell but does **not** support adding PWAs to the home
   screen — it has to be Safari.)
2. Wait for the map to render once so the SW can install.
3. Tap the **Share** icon (square with up arrow) at the bottom of the screen.
4. Scroll the share sheet down and tap **Add to Home Screen**.
5. Confirm the name (`BitePlan`) and tap **Add**.
6. The icon (orange-on-navy fish over a heat disc) appears on the home
   screen. Launching from there opens BitePlan **fullscreen**, no browser
   chrome, exactly like a native app.

**Once installed:**

- The app gets its own slot in iOS Settings → BitePlan, where you can grant
  **Location** permission. The in-app **Locate Me** button respects the
  setting.
- The service worker keeps habitat data, tide curves, and basemap tiles
  cached. You can launch BitePlan from the home screen with no signal and
  still see your saved waypoints, the score for cached units, and the map.
- iOS Safari purges PWA storage if you don't open the app for ~7 weeks.
  Don't go more than a month without launching it once before a trip if you
  rely on the offline cache.

## 6. Installing on Android (Chrome)

Chrome on Android catches `beforeinstallprompt` automatically. BitePlan shows
an **Install app** button in the bottom-sheet Settings panel when Chrome
fires the event. Tap it, then confirm the OS dialog. The PWA installs to the
launcher.

## 7. Rolling back

If a deploy breaks something on the water:

1. In Vercel project → **Deployments**, find the last known-good deploy.
2. Click the **⋯** menu → **Promote to Production**.
3. The edge swaps within seconds. Users see the update banner on next
   launch and can pull in the rollback the same way they pull updates.

You can also roll back from the command line with `vercel rollback <url>` if
you've installed the Vercel CLI, but the UI is faster.

---

## 8. Troubleshooting

**Build fails on Vercel but passes locally.** Vercel uses Node 20.x by
default. Check `node -v` locally; if you're on a newer major, `nvm use 20`
and rerun `npm run build` to reproduce.

**Service worker doesn't update.** Hard-reload (Cmd+Shift+R / long-press the
Safari reload icon → **Request Website**). The SW is cached `max-age=0,
must-revalidate` so this should rarely happen — but iOS Safari caches
aggressively even against `must-revalidate` if storage is low.

**`/data/*` requests 404.** Re-run `npm run fetch-data` locally; the script
populates `public/data/`. Vercel only ships what's in the repo, so missing
files mean they weren't committed.

**Map tiles don't load offline.** Tiles only enter the cache after they've
been viewed online once. Pan the area you plan to fish while on Wi-Fi at
least once before the trip.

---

That's the whole deploy story. Push, refresh, fish.
