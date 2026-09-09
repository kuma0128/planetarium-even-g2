# G2 Planetarium

[![Build and tests](https://github.com/kuma0128/planetarium-even-g2/actions/workflows/planetarium.yml/badge.svg)](https://github.com/kuma0128/planetarium-even-g2/actions/workflows/planetarium.yml)

An open-source Even Hub app that puts a sky map on Even Realities G2. Choose your observing location and time, then align the view with a manual compass reading or your phone's compass.

The view follows a manually entered heading or your phone's compass. Experimental G2 head tracking can follow elevation after calibration, with an optional yaw experiment for verified angle data.

![G2 Planetarium browser UI showing a night sky map, compass, time, location, and visible objects](docs/images/planetarium-ui.jpg)

*Web interface preview: Tonight in Tokyo, facing west.*

## Features

- **Now, Tonight, or Custom:** follow the current sky or explore a selected date. Tonight chooses 30 minutes after astronomical dusk, or the current time if it is already dark, and explains polar-day fallbacks.
- **Your observing location:** use location permission or enter latitude and longitude. Date input and display use your **device's time zone**, including when you choose coordinates in another country.
- **An offline sky catalog:** 2,865 stars, constellation lines, the Moon, Sun, Mercury, Venus, Mars, Jupiter, and Saturn. Objects below the horizon are hidden.
- **Compass alignment:** enter a heading manually or use a supported phone's absolute orientation sensor. Choose magnetic or true north, with magnetic declination calculated for your location and today's date.
- **Adjustable view:** change elevation, field of view, the star magnitude limit, and constellation lines. See the brightest named objects with their azimuth and altitude.
- **Full-display planetarium:** the sky fills the entire 576 × 288 display by default. Date, direction/elevation numbers, Moon readouts, and star/direction labels start hidden. Enable the information and label options independently, or turn off full-display mode for the compact sky map. Temporary head-calibration instructions still appear during setup.
- **Experimental head tracking:** calibrate two poses to follow head elevation from gravity-like G2 IMU data. An explicitly selected rotation-angle mode adds a right-turn check before enabling yaw. Sensor readings, sample rate, transfer timing, and a downloadable log help with real-device verification.
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

For phone compass mode, hold the phone flat and point its physical top edge toward the direction you want to view. Elevation can be set manually or use experimental G2 head tracking. Relative phone orientation alone is rejected because it cannot identify north. Missing, inaccurate, or stale sensor readings are reported in the interface.

Phone browsers need a secure context, normally HTTPS, for compass and location access. A plain HTTP development URL on your local network supports manual controls, but sensors may be blocked. Availability inside the Even app's WebView also depends on the host exposing these sensors.

**If the Even app only offers Location permission:** that permission supplies the observing position; it does not enable the browser's phone orientation sensor. The pinned SDK has no separate phone-compass API. If no usable compass reading arrives within about five seconds, the app explains the limitation and returns to **Manual**. Read a bearing in your phone's Compass app, enter it here, and match **Magnetic north / True north** to that app. Valid phone readings select their magnetic reference automatically. A phone compass follows the phone, not the glasses.

**If Lens Preview options seem unchanged:** the note under the preview explains whether a location, G2 connection, or north reference is missing. Options apply to both the preview and G2 once these are ready. **Refresh G2 display** resends every tile, including unchanged pixels, without resetting head calibration. Rendering has a timer fallback for hosts that suspend browser animation frames. The version at the bottom of the page identifies the installed build.

## Load on G2

Requires G2, the **Even app 2.2.10 or later**, and Even Hub developer access. The SDK version is pinned in `package.json`.

```bash
npm run pack
```

This creates `g2-planetarium.ehpk`, an Even Hub app package. Successful [GitHub Actions runs](https://github.com/kuma0128/planetarium-even-g2/actions/workflows/planetarium.yml) also provide it in the `g2-planetarium` artifact.

`npm run pack` adds `min_sdk_version` to a temporary copy of `app.json` from the pinned SDK dependency and passes that version to the CLI. Sensor logs use the same dependency version.

- **Local development:** follow the [official local-testing instructions](https://hub.evenrealities.com/docs/test/local-testing). Generate a development QR code with `npx evenhub qr --url http://YOUR_COMPUTER_IP:5173` and open it through the Even app's developer tools.
- **Package testing:** upload the `.ehpk` for Private Testing in the Even Hub developer portal, then launch it from the Even app. See the [official packaging guide](https://hub.evenrealities.com/docs/ship/packaging).

The app connects automatically when it detects the Even Hub bridge. Use **Connect G2** to retry. If a previous image transfer or sensor stop is still waiting for the host, reconnect reports this after four seconds and restores the button. Retry after the connection recovers, or reopen the app if the host remains unresponsive. A regular browser runs the preview. This repository does not include custom firmware, and the app has not been published to the public Even Hub store.

Image updates pause between G2 foreground exit and re-entry. Returning to the foreground resends the complete current view without reconnecting; head tracking requires calibration again. Transfers already waiting for the host at exit cannot be cancelled, but their late results do not close the resumed session.

Device-status events identify devices only by serial number. Once the G2 serial is known, other devices' disconnects are ignored. Until then, including when device lookup fails or returns another model, any disconnect ends the session to avoid missing a lost G2 link. A ring disconnect can therefore require **Connect G2** in this fallback state.

## Try head tracking on G2

This is an experimental implementation, **not yet verified on physical G2 hardware**. The [official IMU API](https://hub.evenrealities.com/docs/build/device-apis#imu) exposes `x/y/z` without specifying their units or coordinate convention. The default is a gravity-vector hypothesis, checked for stable magnitude during calibration; it is not automatic sensor-type detection.

1. Open the app through Even Hub, set your observing location, and wear the glasses.
2. Set **Compass heading**, its north reference, and **Elevation angle** to match your forward view. Start near the horizon so there is room to look up. The initial reference elevation must be between −60° and 60°.
3. Under **Head tracking**, select **Start G2 sensor**. Hold your head still for about one second and select **1. Capture forward pose**, or tap the glasses/ring. Calibration instructions also appear on G2.
4. Look 20–40° higher without turning or tilting sideways. Hold still for about one second and select **2. Capture upward tilt**, or tap again. During calibration, taps capture the next pose; during tracking they resume switching Now / Tonight.
5. Move your head up and down. **Elevation angle** and the map should follow. Yaw continues to use the manual or phone compass; gravity alone cannot determine yaw. Sideways roll is compensated when estimating elevation, but the map itself is not rotated with your head.
6. **Stop** returns to manual elevation at the last displayed angle. To change the reference elevation, stop, adjust it, and repeat calibration.

The two poses recover the viewing axis in sensor coordinates, accommodating axis signs, scale, and the glasses' mounting angle. Samples with a large magnitude change are ignored as possible acceleration. This cannot eliminate every movement artifact. Missing or unusable readings for 1.5 seconds freeze the last orientation and invalidate calibration; new readings alone never silently reactivate it. Disconnecting, leaving the **G2 foreground**, closing the page, or stopping also ends the sensor session. Hiding just the phone view no longer stops tracking; continued updates still depend on the Even host keeping JavaScript and the sensor stream alive.

**Turning left or right does not change the map in the default mode.** Gravity supplies tilt, not a compass bearing. Use manual heading / 15° swipes for direction, or the explicitly selected angle experiment below only with verified sensor data. A successful sensor-start response alone does not prove that readings are arriving: **Waiting for sensor** keeps calibration disabled until a sample arrives, and the diagnostics show received and unusable message counts. Omitted zero-valued protobuf axes are decoded as zero; empty or invalid messages are rejected.

For yaw, open **Sensor details & experimental yaw** and select **Rotation angles — degrees/radians** only after confirming what the real sensor reports. Choose the pitch/yaw axes and signs. Capture the forward and upward poses, then return to the starting elevation and turn 20–40° right for **3. Capture right turn**. A distinct right-turn signal is required. The initial compass heading anchors these relative changes; this is not an independently north-referenced G2 compass. If a check fails, inspect the log or return to **Gravity vector — tilt only**. Pure angular-rate data is not supported. These checks help reject a bad mapping but do not prove that an undocumented sensor stream is an orientation estimate.

**Save or share sensor log** exports the last 600 raw samples with monotonic arrival times from session start, calibration markers, selected format, and the latest host-transfer duration as JSON. It opens file sharing when supported, otherwise requests a download. The same JSON remains visible with a **Copy sensor log** button; if clipboard access is unavailable, select and copy the text using your device's Copy command. Coordinates are not included, and the app does not automatically upload the log. `P100` is the selected SDK pacing code; it is not a claim of 100 Hz. The UI reports the observed arrival rate. Tracking renders and requests display updates at most every 100 ms, keeps only the latest waiting frame, and skips unchanged tiles/captions. Real optical refresh rate and latency still need measurement on G2; host acceptance does not establish either.

## Development

```bash
npm test
npx playwright install chromium
npm run test:browser
npm run pack
```

The automated tests cover astronomy and projection, magnetic correction, phone sensors, gravity calibration across axes and mounting angles, roll compensation, independent yaw checks, north-wrap interpolation, stale/invalid readings, and serialized sensor/frame delivery. Browser tests use the real SDK with a mock native host to exercise calibration, stop/reconnect, slow frame transfers, log export, and mobile layout. They do not simulate the optical hardware or prove real IMU semantics. CI runs both test suites and packaging.

The browser preview supports desktop and mobile layouts.

The display tests decode all four accepted PNG tiles and compare the complete
frame with the browser canvas. They cover text removal, full/compact switching
during slow transfers, and tap/swipe/exit gestures with an empty event container.

## How it works

- `src/main.ts`: observing state, input events, sky updates, and G2 connection coordination.
- `src/view.ts`: browser display, visible-object cards, and shared captions for the preview and G2.
- `src/sky.ts`: Astronomy Engine calculations, HYG J2000 proper motion, precession and nutation, horizontal coordinates, and perspective projection.
- `src/compass.ts`: phone headings, magnetic declination, accuracy checks, and stale-reading detection.
- `src/head-tracking.ts`: stable pose capture, gravity-based elevation, explicit angle profiles, filtering, and stale-data invalidation.
- `src/head-controls.ts`: live sensor controls, guided calibration, diagnostics, and local log export.
- `src/motion-stream.ts`: serializes sensor start/stop calls, including rapid stop and reconnect.
- `src/render.ts`: a 576 × 288 pixel display frame, with a full-height or compact 144-pixel sky viewport and optional captions/labels. Symbol sizes help identify objects; they do not reproduce apparent diameters or the shape of the Moon's phase.
- `src/glasses.ts`: four 288 × 144 PNG tiles cover the G2 display. A blank text container behind the images captures gestures without reserving a visible text area. Every tile is sent sequentially through the official SDK; unchanged tiles are skipped. Switching display options does not rebuild the page or interrupt head tracking.
- `src/frame-queue.ts`: keeps only the latest pending frame while a send is in progress. A host acknowledgment is treated as acceptance of the update, not proof of optical rendering.

The map is an enlarged view of the sky, not an optically calibrated AR overlay. Buildings, terrain, weather, and light pollution are not modeled. Head tracking changes the map's viewing direction; matching the optical display's field of view, gaze offset, and real stars would require additional calibration and hardware validation.

Magnetic declination uses the **current physical date**, independent of the simulated sky date. If the magnetic model cannot provide a valid correction, sending pauses until you select a usable north reference. Use a true-north compass and select **True north** in that case.

## Data and licenses

Application code is licensed under [GPL-3.0-only](LICENSE). The bundled star catalog is derived from David Nash's HYG Database v4.1 and remains under **CC BY-SA 4.0**. Constellation lines and standard constellation names come from Olaf Frohn's D3-Celestial under **BSD 3-Clause**. Library licenses and attribution are included in the [credits page](public/credits.html) and `public/licenses/`.

Catalog source revisions are pinned, and regular builds do not download astronomical data. [Install uv](https://docs.astral.sh/uv/getting-started/installation/) to regenerate the bundled catalogs:

```bash
uv run --locked scripts/update-catalog.py
```

uv selects Python from `.python-version` and manages the local environment using `pyproject.toml` and `uv.lock`. The generator uses only the Python standard library. CI runs the same command and checks that the bundled catalogs and source licenses are reproduced without changes.

Catalog regeneration requires network access. Sky calculations and rendering run locally without API keys, and the app does not upload your observing location.
