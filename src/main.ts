import "./style.css";
import {
  calculateSky,
  tonight,
  validLocation,
  wrap,
  type Location,
  type Sky,
} from "./sky.ts";
import {
  magneticDeclination,
  trueHeading,
  type NorthReference,
} from "./compass.ts";
import { GlassesDisplay } from "./glasses.ts";
import { HeadControls } from "./head-controls.ts";
import { element, input, pressed, text } from "./dom.ts";
import { renderView, type TimeMode } from "./view.ts";
import { version } from "../package.json";

const canvas = element<HTMLCanvasElement>("sky");
const sampleLocation: Location = {
  latitude: 35.6812,
  longitude: 139.7671,
  height: 0,
};
const observing = {
  location: null as Location | null,
  locationGeneration: 0,
  timeMode: "now" as TimeMode,
  time: new Date(),
  heading: 180,
};
const skyCache = {
  value: null as Sky | null,
  key: "",
  physicalDay: "",
  declination: null as number | null,
};
const renderState = {
  requested: false,
  timer: undefined as number | undefined,
  animation: undefined as number | undefined,
  lastRender: -Infinity,
  disposed: false,
};
const delivery = {
  force: false,
  lastSent: 0,
  key: "",
  timer: undefined as number | undefined,
};
const glasses = new GlassesDisplay(
  (status) => text("bridge-status", status),
  (gesture) => {
    if (gesture === "tap" && head.enabled && !head.active) head.captureNext();
    else if (gesture === "tap")
      setTimeMode(observing.timeMode === "now" ? "tonight" : "now");
    else {
      setHeading(observing.heading + (gesture === "left" ? -15 : 15));
    }
  },
  {
    onConnected: () => {
      delivery.key = "";
      delivery.lastSent = -Infinity;
      requestRender();
    },
    onForeground: () => {
      delivery.force = true;
      requestRender();
    },
    onMotion: (sample, receivedAt) => head.receive(sample, receivedAt),
    onMotionStopped: () => head.disconnected(),
    onFrameSent: (duration) => head.frameSent(duration),
  },
);
const head = new HeadControls(
  glasses,
  () => ({
    heading: observing.heading,
    pitch: Number(input("pitch").value),
    northReference: input("north-reference").value as NorthReference,
  }),
  requestRender,
  () => {
    // Preserve the last elevation when stopping or aligning another direction.
    if (head.pose) {
      input("pitch").value = String(head.pose.pitch);
    }
  },
);

function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function setTimeMode(mode: TimeMode): void {
  observing.timeMode = mode;
  if (mode === "now") {
    observing.time = new Date();
    text("time-note", "The sky updates automatically to the current time.");
  }
  if (mode === "tonight") {
    const night = tonight(new Date(), observing.location || sampleLocation);
    observing.time = night.time;
    text("time-note", `${night.note} The selected sky time stays fixed.`);
  }
  if (mode === "custom")
    text(
      "time-note",
      "Showing the selected time, which may differ from the current sky.",
    );
  for (const id of ["now", "tonight", "custom"]) pressed(id, mode === id);
  input("date").value = localInput(observing.time);
  requestRender();
}
function setHeading(degrees: number): void {
  observing.heading = wrap(degrees);
  input("heading").value = String(Math.round(observing.heading) % 360);
  requestRender();
}
function setLocation(value: Location, label: string): void {
  if (!validLocation(value))
    throw new Error("Check the latitude, longitude, and elevation.");
  observing.location = value;
  skyCache.physicalDay = "";
  input("latitude").value = String(value.latitude);
  input("longitude").value = String(value.longitude);
  text("location-status", label);
  if (observing.timeMode === "tonight") setTimeMode("tonight");
  requestRender();
}
function requestRender(): void {
  if (renderState.requested || renderState.disposed) return;
  renderState.requested = true;
  const flush = () => {
    if (!renderState.requested || renderState.disposed) return;
    clearTimeout(renderState.timer);
    if (renderState.animation !== undefined) cancelAnimationFrame(renderState.animation);
    renderState.timer = renderState.animation = undefined;
    const now = performance.now();
    const wait = head.active ? 100 - (now - renderState.lastRender) : 0;
    if (wait > 0) {
      renderState.timer = window.setTimeout(flush, wait);
      return;
    }
    renderState.requested = false;
    renderState.lastRender = now;
    render();
  };
  // Even's WebView can suspend animation frames while G2 is still in use.
  // SDK-backed timers let display updates continue when the host keeps JS alive.
  renderState.timer = window.setTimeout(flush, 50);
  renderState.animation = requestAnimationFrame(flush);
}
function currentSky(now: Date): Sky {
  if (observing.timeMode === "now") observing.time = now;
  const place = observing.location || sampleLocation;
  const key = `${Math.floor(observing.time.getTime() / 15000)}:${place.latitude}:${place.longitude}:${place.height}`;
  if (!skyCache.value || key !== skyCache.key) {
    skyCache.value = calculateSky(observing.time, place);
    skyCache.key = key;
  }
  // A simulated future sky does not change today's physical magnetic field.
  if (skyCache.physicalDay !== now.toDateString()) {
    skyCache.physicalDay = now.toDateString();
    skyCache.declination = magneticDeclination(place, now);
  }
  return skyCache.value;
}
function updateControls(): void {
  if (observing.timeMode === "now" && document.activeElement !== input("date"))
    input("date").value = localInput(observing.time);
  const calibrating = head.enabled && head.tracker.phase !== "neutral";
  input("pitch").disabled = head.pose != null || calibrating;
}
function render(): void {
  const monotonicNow = performance.now();
  head.refresh(monotonicNow);
  const sky = currentSky(new Date());
  updateControls();
  const heading = trueHeading(
    {
      heading: observing.heading,
      reference: input("north-reference").value as NorthReference,
    },
    skyCache.declination,
    Number(input("offset").value),
  );
  // Draw at the same 0.2° precision used to coalesce deliveries. Otherwise a
  // settling sensor can change preview pixels without changing the frame key,
  // leaving G2 on an earlier frame until another input or a forced refresh.
  const options = {
    heading: wrap(Math.round((heading ?? observing.heading) * 5) / 5),
    pitch: Math.round((head.pose?.pitch ?? Number(input("pitch").value)) * 5) / 5,
    fov: Number(input("fov").value),
    magnitude: Number(input("magnitude").value),
    lines: input("lines").checked,
    labels: input("sky-labels").checked,
  };
  const display = {
    fullSky: input("full-sky").checked,
    showInfo: input("sky-info").checked,
  };
  const source = head.pose
    ? !head.active
      ? "Head paused"
      : "Manual + head tilt"
    : "Manual";
  const { header, footer } = renderView(canvas, sky, options, {
    time: observing.time,
    timeMode: observing.timeMode,
    location: observing.location,
    rawHeading: observing.heading,
    heading,
    headingSource: source,
    declination: skyCache.declination,
    footerOverride: head.glassesHint,
  }, display);
  const frameKey = JSON.stringify([
    skyCache.key,
    options.heading,
    options.pitch,
    options.fov,
    options.magnitude,
    options.lines,
    options.labels,
    display.fullSky,
    display.showInfo,
    header,
    footer,
  ]);
  updateGlasses(frameKey, heading, monotonicNow);
}
function updateGlasses(frameKey: string, heading: number | null, now: number): void {
  text(
    "preview-status",
    !observing.location
      ? "Preview only. Choose your observing location below to apply these options to G2."
      : !glasses.connected
        ? "Preview only. Connect G2 to apply these options to your glasses."
        : heading == null
          ? "G2 updates paused. Check the north reference below."
          : !glasses.foreground
            ? "G2 updates paused while the app is in the background. Return to the G2 foreground to resume."
            : "Options apply to this preview and G2. Allow a few seconds for the glasses to update.",
  );
  element<HTMLButtonElement>("refresh-display").disabled =
    !observing.location || heading == null;
  if (
    glasses.foreground &&
    observing.location &&
    heading != null &&
    (delivery.force || frameKey !== delivery.key)
  ) {
    const wait = (head.active ? 100 : 300) - (now - delivery.lastSent);
    if (wait <= 0) {
      clearTimeout(delivery.timer);
      delivery.timer = undefined;
      delivery.lastSent = now;
      delivery.key = frameKey;
      glasses.submit({ image: canvas, force: delivery.force });
      delivery.force = false;
    } else if (delivery.timer === undefined) {
      delivery.timer = window.setTimeout(() => {
        delivery.timer = undefined;
        requestRender();
      }, wait);
    }
  }
}

input("heading").oninput = () => setHeading(Number(input("heading").value));
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-heading]",
))
  button.onclick = () => {
    setHeading(Number(button.dataset.heading));
  };
for (const id of ["pitch", "fov", "magnitude", "lines", "north-reference", "full-sky", "sky-info", "sky-labels"]) {
  element(id).addEventListener("input", requestRender);
  element(id).addEventListener("change", requestRender);
}
input("offset").onchange = () => {
  if (!input("offset").value || !input("offset").checkValidity())
    input("offset").value = "0";
  requestRender();
};
for (const mode of ["now", "tonight", "custom"] as const)
  element(mode).onclick = () => setTimeMode(mode);
input("date").onchange = () => {
  const date = new Date(input("date").value);
  if (!Number.isFinite(date.getTime())) {
    text("time-note", "Choose a valid date and time.");
    return;
  }
  observing.time = date;
  setTimeMode("custom");
};
for (const [id, step] of [
  ["earlier", -1],
  ["later", 1],
] as const)
  element(id).onclick = () => {
    observing.time = new Date(observing.time.getTime() + step * 3600000);
    setTimeMode("custom");
  };
element<HTMLFormElement>("location-form").onsubmit = (event) => {
  event.preventDefault();
  observing.locationGeneration++;
  try {
    setLocation(
      {
        latitude: Number(input("latitude").value),
        longitude: Number(input("longitude").value),
        height: 0,
      },
      "Using your selected observing location.",
    );
  } catch (error) {
    text("location-status", error instanceof Error ? error.message : String(error));
  }
};
element("locate").onclick = async () => {
  const generation = ++observing.locationGeneration;
  const button = element<HTMLButtonElement>("locate");
  button.disabled = true;
  text("location-status", "Finding your location…");
  try {
    let fix = await glasses.location().catch(() => null);
    if (!fix) {
      if (!navigator.geolocation)
        throw new Error(
          "Location is unavailable. Enter latitude and longitude instead.",
        );
      const position = await new Promise<GeolocationPosition>(
        (resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 60000,
          }),
      );
      fix = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        height: position.coords.altitude ?? 0,
      };
    }
    if (generation === observing.locationGeneration)
      setLocation(
        fix,
        "Using your current location. Update it again after moving.",
      );
  } catch {
    if (generation === observing.locationGeneration)
      text(
        "location-status",
        "Unable to get your location. Check location permission or enter latitude and longitude.",
      );
  } finally {
    button.disabled = false;
  }
};
async function connect(): Promise<void> {
  const button = element<HTMLButtonElement>("connect");
  button.disabled = true;
  try {
    await glasses.connect();
    delivery.force = true;
    delivery.key = "";
    delivery.lastSent = 0;
    if (!observing.location)
      text(
        "location-status",
        "Set your observing location to start displaying the sky on G2.",
      );
    requestRender();
  } catch {
    /* The display provides a useful status message. */
  } finally {
    button.disabled = false;
  }
}
element("connect").onclick = connect;
element("refresh-display").onclick = connect;
const autoConnect = () => {
  if (
    (window as Window & { flutter_inappwebview?: unknown })
      .flutter_inappwebview &&
    !glasses.connected
  )
    void connect();
};
window.addEventListener("flutterInAppWebViewPlatformReady", autoConnect);
window.addEventListener("evenAppBridgeReady", autoConnect);
window.setTimeout(autoConnect, 600);
text("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
text("app-version", `v${version}`);
setTimeMode("now");
const timer = window.setInterval(requestRender, 1000);
window.addEventListener("pagehide", () => {
  renderState.disposed = true;
  clearInterval(timer);
  clearTimeout(delivery.timer);
  clearTimeout(renderState.timer);
  if (renderState.animation !== undefined) cancelAnimationFrame(renderState.animation);
  glasses.stop();
});
// Phone visibility is independent of G2's foreground. The SDK's foreground-exit,
// disconnect and system-exit events still stop the sensor session.
document.addEventListener("visibilitychange", requestRender);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
