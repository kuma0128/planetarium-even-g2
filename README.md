# G2 Planetarium

[![Build and tests](https://github.com/kuma0128/planetarium-even-g2/actions/workflows/planetarium.yml/badge.svg)](https://github.com/kuma0128/planetarium-even-g2/actions/workflows/planetarium.yml)

An open-source Even Hub app that puts a sky map on Even Realities G2. Choose your observing location and time, then align the view with a manual compass reading or your phone's compass.

The view follows a manually entered heading or your phone's compass, with manual elevation control.

![G2 Planetarium browser UI showing a night sky map, compass, time, location, and visible objects](docs/images/planetarium-ui.jpg)

*Web interface preview: Tonight in Tokyo, facing west.*

## Features

- **Now, Tonight, or Custom:** follow the current sky or explore a selected date. Tonight chooses 30 minutes after astronomical dusk, or the current time if it is already dark, and explains polar-day fallbacks.
- **Your observing location:** use location permission or enter latitude and longitude. Date input and display use your **device's time zone**, including when you choose coordinates in another country.
- **An offline sky catalog:** 2,865 stars, constellation lines, the Moon, Sun, Mercury, Venus, Mars, Jupiter, and Saturn. Objects below the horizon are hidden.
- **Compass alignment:** enter a heading manually or use a supported phone's absolute orientation sensor. Choose magnetic or true north, with magnetic declination calculated for your location and today's date.
- **Adjustable view:** change elevation, field of view, the star magnitude limit, and constellation lines. See the brightest named objects with their azimuth and altitude.
- **G2 controls:** tap to switch Now / Tonight, swipe to turn the manual heading by 15 degrees, and double-tap for the exit dialog.

## Run the browser preview

Requires Node.js 22.18 or later and npm for the TypeScript app and Even Hub SDK. Python catalog maintenance uses [uv](https://docs.astral.sh/uv/); see [Data and licenses](#data-and-licenses).

```bash
git clone https://github.com/kuma0128/planetarium-even-g2.git
cd planetarium-even-g2
npm ci
npm run dev
```

Open <http://localhost:5173/>. The initial view is a clearly labeled **Tokyo demo**. Sending sky frames to G2 starts only after you choose an observing location.

1. Select **Use current location**, or enter coordinates and select **Use these coordinates**.
2. Choose **Now**, **Tonight**, or **Custom**.
3. Match **Compass heading** to an external compass, or select **Phone compass**.
4. Under **North reference & calibration**, select **True north** if your compass already applies magnetic correction. Otherwise keep **Magnetic north**.
5. Set **Elevation angle**: 0 degrees is the horizon; 90 degrees is straight up.

For phone compass mode, hold the phone flat and point its physical top edge toward the direction you want to view. Elevation remains manual. Relative orientation alone is rejected because it cannot identify north. Missing, inaccurate, or stale sensor readings are reported in the interface.

Phone browsers need a secure context, normally HTTPS, for compass and location access. A plain HTTP development URL on your local network supports manual controls, but sensors may be blocked. Availability inside the Even app's WebView also depends on the host exposing these sensors.

## Load on G2

Requires G2, the **Even app 2.2.10 or later**, and Even Hub developer access. The SDK is pinned to `0.0.15`.

```bash
npm run pack
```

This creates `g2-planetarium.ehpk`, an Even Hub app package. Successful [GitHub Actions runs](https://github.com/kuma0128/planetarium-even-g2/actions/workflows/planetarium.yml) also provide it in the `g2-planetarium` artifact.

- **Local development:** follow the [official local-testing instructions](https://hub.evenrealities.com/docs/test/local-testing). Generate a development QR code with `npx evenhub qr --url http://YOUR_COMPUTER_IP:5173` and open it through the Even app's developer tools.
- **Package testing:** upload the `.ehpk` for Private Testing in the Even Hub developer portal, then launch it from the Even app. See the [official packaging guide](https://hub.evenrealities.com/docs/ship/packaging).

The app connects automatically when it detects the Even Hub bridge. Use **Connect G2** to retry. A regular browser runs the preview. This repository does not include custom firmware, and the app has not been published to the public Even Hub store.

## Development

```bash
npm test
npm run pack
```

The automated tests cover Polaris altitude and azimuth, seasonal visibility of Sirius, southern skies, the equinox Sun, Tonight selection and polar conditions, projection orientation, magnetic correction, sensor validation, heading interpolation across north, and sequential frame delivery and recovery.

The browser preview supports desktop and mobile layouts.

## How it works

- `src/main.ts`: observing state, input events, sky updates, and G2 connection coordination.
- `src/view.ts`: browser display, visible-object cards, and shared captions for the preview and G2.
- `src/sky.ts`: Astronomy Engine calculations, HYG J2000 proper motion, precession and nutation, horizontal coordinates, and perspective projection.
- `src/compass.ts`: phone headings, magnetic declination, accuracy checks, and stale-reading detection.
- `src/render.ts`: a 576 × 144 pixel sky map. Symbol sizes help identify objects; they do not reproduce apparent diameters or the shape of the Moon's phase.
- `src/glasses.ts`: two 288 × 144 PNG tiles and two text containers on the G2's 576 × 288 display, sent sequentially through the official SDK.
- `src/frame-queue.ts`: keeps only the latest pending frame while a send is in progress. A host acknowledgment is treated as acceptance of the update, not proof of optical rendering.

The map is an enlarged view of the sky, not an optically calibrated AR overlay. Buildings, terrain, weather, and light pollution are not modeled. The public SDK does not document how to interpret its IMU `x/y/z` values as an absolute compass heading, so this app does not use them for head tracking.

Magnetic declination uses the **current physical date**, independent of the simulated sky date. If the magnetic model cannot provide a valid correction, sending pauses until you select a usable north reference. Use a true-north compass and select **True north** in that case.

## Data and licenses

Application code is licensed under [GPL-3.0-only](LICENSE). The bundled star catalog is derived from David Nash's HYG Database v4.1 and remains under **CC BY-SA 4.0**. Constellation lines and standard constellation names come from Olaf Frohn's D3-Celestial under **BSD 3-Clause**. Library licenses and attribution are included in the [credits page](public/credits.html) and `public/licenses/`.

Catalog source revisions are pinned, and regular builds do not download astronomical data. [Install uv](https://docs.astral.sh/uv/getting-started/installation/) to regenerate the bundled catalogs:

```bash
uv run --locked scripts/update-catalog.py
```

uv selects Python from `.python-version` and manages the local environment using `pyproject.toml` and `uv.lock`. The generator uses only the Python standard library. CI runs the same command and checks that the bundled catalogs and source licenses are reproduced without changes.

Catalog regeneration requires network access. Sky calculations and rendering run locally without API keys, and the app does not upload your observing location.
