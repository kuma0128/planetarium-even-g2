# Even Hub store listing

- App name: G2 Planetarium
- Tagline: Explore stars, constellations and planets on G2.
- Category: Education
- Tags: Astronomy, Stargazing, Constellations, Planets, Sky map
- About: [about.txt](about.txt)
- Icon: [icon.png](icon.png), 24 × 24 pixels, black and white
- Cover: winter-stars preview with the portal's Exterior / Nature background
- Screenshots: the three numbered PNGs, each 576 × 288 pixels: full sky without text, full sky with labels, compact sky with information

The previews call the application's `calculateSky` and `renderView` functions.
They use illustrative Tokyo coordinates and selected dates, recorded in
[scenes.json](scenes.json). All pixels, including optional captions, come directly
from the production renderer. These are rendered previews, not physical G2
screenshots; optical appearance and font rendering may differ.

Generate the assets from the repository root:

```sh
npm install --prefix artifacts/store-tools --no-save --package-lock=false @napi-rs/canvas@1.0.5
TZ=Asia/Tokyo node --experimental-strip-types docs/store-listing/render-assets.ts
```

The temporary rendering dependency stays under the ignored `artifacts/` directory
and does not change the app package or its runtime dependencies. The icon is also
reproducible in Even Hub's 24 × 24 pixel editor.

The current listing describes head tracking as experimental and awaiting physical
hardware validation. Update that wording only after recording actual G2 results.
