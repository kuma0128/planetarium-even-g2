# Even Hub store listing

- App name: G2 Planetarium
- Tagline: Explore stars, constellations and planets on G2.
- Category: Education
- Tags: Astronomy, Stargazing, Constellations, Planets, Sky map
- About: [about.txt](about.txt)
- Icon: [icon.png](icon.png), 24 × 24 pixels, black and white
- Cover: winter-stars screenshot with the portal's Exterior / Nature background
- Screenshots: `01`–`03`, full sky, labeled sky, and compact sky with information
- Startup evidence: [00-startup.png](00-startup.png)

All four PNGs are original, unmodified 576 × 288 RGBA exports from the official
Even Hub simulator 0.9.5 (latest npm release checked on 2026-09-10). Preserve their
transparent backgrounds and green pixels when uploading; the portal supplies the
background. Use a black background for local visual inspection.

The development-only [capture fixture](capture.html) uses the production
`calculateSky`, `renderView`, `GlassesDisplay` and real SDK bridge. It supplies the
illustrative Tokyo coordinates and dates from [scenes.json](scenes.json), without
mocking the native host or rendering screenshots with an alternative canvas
library. The fixture is not part of the production build. Each scene waits for all
four tiles to reach the simulator before exporting its framebuffer.

Reproduce the screenshots from the repository root (three terminals):

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 5175 --strictPort
```

```sh
npx evenhub-simulator http://127.0.0.1:5175/docs/store-listing/capture.html --automation-port 9899
```

```sh
node docs/store-listing/capture.mjs
```

Use a newly started simulator for each capture run. Restart it after a Vite reload;
its startup page cannot be created twice in the same simulator session. The capture
script records the installed version, timestamp and PNG hashes in
[capture-metadata.json](capture-metadata.json). For a future submission, check
`npm view @evenrealities/evenhub-simulator version` and update the pinned dependency
if a newer release exists before recapturing.

The old `render-assets.ts` produces only development previews and an icon under
ignored `artifacts/rendered-previews/`; it cannot overwrite submission screenshots.

The application starts with an OS text container saying “G2 Planetarium started.”
and asks the user to continue on the phone. This remains until an observing location
is set, and is displayed for at least 1.5 seconds before the first sky page rebuild.

The listing describes head tracking as experimental and awaiting physical hardware
validation. Update that wording only after recording actual G2 results.
