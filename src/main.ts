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
  HEADING_TIMEOUT_MS,
  magneticDeclination,
  PhoneCompass,
  smoothHeading,
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
let location: Location | null = null;
let timeMode: TimeMode = "now";
let selectedTime = new Date();
let rawHeading = 180;
let phoneMode = false;
let phoneReceivedAt = 0;
let compassGeneration = 0;
let sky: Sky | null = null;
let skyKey = "";
let renderRequested = false;
let renderTimer: number | undefined;
let renderAnimation: number | undefined;
let lastRender = -Infinity;
let forceGlassesSend = false;
let lastGlassesSend = 0;
let lastGlassesKey = "";
let sendTimer: number | undefined;
let locationGeneration = 0;
let disposed = false;
let physicalDay = "";
let declination: number | null = null;
const phone = new PhoneCompass();
const glasses = new GlassesDisplay(
  (status) => text("bridge-status", status),
  (gesture) => {
    if (gesture === "tap" && head.enabled && !head.active) head.captureNext();
    else if (gesture === "tap")
      setTimeMode(timeMode === "now" ? "tonight" : "now");
    else {
      if (head.controlsYaw) void head.stop();
      manualMode();
      setHeading(rawHeading + (gesture === "left" ? -15 : 15));
    }
  },
  {
    onConnected: () => {
      lastGlassesKey = "";
      lastGlassesSend = -Infinity;
      requestRender();
    },
    onForeground: () => {
      forceGlassesSend = true;
      requestRender();
    },
    onMotion: (sample, receivedAt) => head.receive(sample, receivedAt),
    onMotionStopped: () => head.disconnected(),
    onFrameSent: (duration) => head.frameSent(duration),
  },
);
const head = new HeadControls(
  glasses,
  () => ({ heading: rawHeading, pitch: Number(input("pitch").value) }),
  requestRender,
  () => {
    // Preserve the last view when stopping, changing format, or recalibrating.
    if (head.pose) {
      if (head.pose.heading != null) setHeading(head.pose.heading);
      input("pitch").value = String(head.pose.pitch);
    }
  },
  manualMode,
);

function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function setTimeMode(mode: TimeMode): void {
  timeMode = mode;
  if (mode === "now") {
    selectedTime = new Date();
    text("time-note", "The sky updates automatically to the current time.");
  }
  if (mode === "tonight") {
    const night = tonight(new Date(), location || sampleLocation);
    selectedTime = night.time;
    text("time-note", `${night.note} The selected sky time stays fixed.`);
  }
  if (mode === "custom")
    text(
      "time-note",
      "Showing the selected time, which may differ from the current sky.",
    );
  for (const id of ["now", "tonight", "custom"]) pressed(id, mode === id);
  input("date").value = localInput(selectedTime);
  requestRender();
}
function setHeading(degrees: number): void {
  rawHeading = wrap(degrees);
  input("heading").value = String(Math.round(rawHeading) % 360);
  requestRender();
}
function manualMode(): void {
  compassGeneration++;
  phone.stop();
  phoneMode = false;
  phoneReceivedAt = 0;
  pressed("manual-mode", true);
  pressed("phone-mode", false);
  input("heading").disabled = false;
  text("compass-status", "Match the heading shown on your compass.");
  requestRender();
}
function setLocation(value: Location, label: string): void {
  if (!validLocation(value))
    throw new Error("Check the latitude, longitude, and elevation.");
  location = value;
  physicalDay = "";
  input("latitude").value = String(value.latitude);
  input("longitude").value = String(value.longitude);
  text("location-status", label);
  if (timeMode === "tonight") setTimeMode("tonight");
  requestRender();
}
function requestRender(): void {
  if (renderRequested || disposed) return;
  renderRequested = true;
  const flush = () => {
    if (!renderRequested || disposed) return;
    clearTimeout(renderTimer);
    if (renderAnimation !== undefined) cancelAnimationFrame(renderAnimation);
    renderTimer = renderAnimation = undefined;
    const now = performance.now();
    const wait = head.active ? 100 - (now - lastRender) : 0;
    if (wait > 0) {
      renderTimer = window.setTimeout(flush, wait);
      return;
    }
    renderRequested = false;
    lastRender = now;
    render();
  };
  // Even's WebView can suspend animation frames while G2 is still in use.
  // SDK-backed timers let display updates continue when the host keeps JS alive.
  renderTimer = window.setTimeout(flush, 50);
  renderAnimation = requestAnimationFrame(flush);
}
function render(): void {
  const now = new Date();
  const monotonicNow = performance.now();
  head.refresh(monotonicNow);
  if (timeMode === "now") {
    selectedTime = now;
    if (document.activeElement !== input("date"))
      input("date").value = localInput(selectedTime);
  }
  const place = location || sampleLocation;
  const key = `${Math.floor(selectedTime.getTime() / 15000)}:${place.latitude}:${place.longitude}:${place.height}`;
  if (!sky || key !== skyKey) {
    sky = calculateSky(selectedTime, place);
    skyKey = key;
  }
  // A simulated future sky does not change today's physical magnetic field.
  if (physicalDay !== now.toDateString()) {
    physicalDay = now.toDateString();
    declination = magneticDeclination(place, now);
  }
  const heading = trueHeading(
    {
      heading: head.pose?.heading ?? rawHeading,
      reference: input("north-reference").value as NorthReference,
    },
    declination,
    Number(input("offset").value),
  );
  const pitch = head.pose?.pitch ?? Number(input("pitch").value);
  const calibrating = head.enabled && head.tracker.phase !== "neutral";
  input("pitch").disabled = head.pose != null || calibrating;
  input("heading").disabled =
    phoneMode || (head.controlsYaw && (calibrating || head.pose != null));
  element<HTMLButtonElement>("phone-mode").disabled = head.controlsYaw;
  input("north-reference").disabled = phoneMode;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-heading]",
  ))
    button.disabled = head.controlsYaw && (calibrating || head.pose != null);
  const options = {
    heading: heading ?? rawHeading,
    pitch,
    fov: Number(input("fov").value),
    magnitude: Number(input("magnitude").value),
    lines: input("lines").checked,
    labels: input("sky-labels").checked,
  };
  const display = {
    fullSky: input("full-sky").checked,
    showInfo: input("sky-info").checked,
  };
  const headingSource = phoneMode
    ? Date.now() - phoneReceivedAt <= HEADING_TIMEOUT_MS
      ? "Phone"
      : "Phone: waiting"
    : "Manual";
  const source = head.pose
    ? !head.active
      ? "Head paused"
      : head.controlsYaw
        ? "G2 angles"
        : `${headingSource} + head tilt`
    : headingSource;
  const { header, footer } = renderView(canvas, sky, options, {
    time: selectedTime,
    timeMode,
    location,
    rawHeading: head.pose?.heading ?? rawHeading,
    heading,
    headingSource: source,
    declination,
    footerOverride: head.glassesHint,
  }, display);
  const frameKey = JSON.stringify([
    skyKey,
    Math.round(options.heading * 5) / 5,
    Math.round(options.pitch * 5) / 5,
    options.fov,
    options.magnitude,
    options.lines,
    options.labels,
    display.fullSky,
    display.showInfo,
    header,
    footer,
  ]);
  text(
    "preview-status",
    !location
      ? "Preview only. Choose your observing location below to apply these options to G2."
      : !glasses.connected
        ? "Preview only. Connect G2 to apply these options to your glasses."
        : heading == null
          ? "G2 updates paused. Check the north reference below."
          : "Options apply to this preview and G2. Allow a few seconds for the glasses to update.",
  );
  element<HTMLButtonElement>("refresh-display").disabled =
    !location || heading == null;
  if (
    glasses.connected &&
    location &&
    heading != null &&
    (forceGlassesSend || frameKey !== lastGlassesKey)
  ) {
    const wait = (head.active ? 100 : 300) - (monotonicNow - lastGlassesSend);
    if (wait <= 0) {
      clearTimeout(sendTimer);
      sendTimer = undefined;
      lastGlassesSend = monotonicNow;
      lastGlassesKey = frameKey;
      glasses.submit({ image: canvas, force: forceGlassesSend });
      forceGlassesSend = false;
    } else if (sendTimer === undefined) {
      sendTimer = window.setTimeout(() => {
        sendTimer = undefined;
        requestRender();
      }, wait);
    }
  }
}

element("manual-mode").onclick = () => {
  if (head.controlsYaw) void head.stop();
  manualMode();
};
element("phone-mode").onclick = async () => {
  const generation = ++compassGeneration;
  phoneReceivedAt = 0;
  try {
    await phone.start(
      (sample) => {
        if (generation !== compassGeneration) return;
        const next = phoneReceivedAt
          ? smoothHeading(rawHeading, sample.heading)
          : sample.heading;
        phoneReceivedAt = Date.now();
        input("north-reference").value = sample.reference;
        setHeading(next);
      },
      (status) => {
        if (generation === compassGeneration) {
          text("compass-status", status);
          requestRender();
        }
      },
      (status) => {
        if (generation !== compassGeneration) return;
        manualMode();
        text("compass-status", status);
      },
    );
    if (generation !== compassGeneration) return;
    phoneMode = true;
    pressed("manual-mode", false);
    pressed("phone-mode", true);
    input("heading").disabled = true;
  } catch (error) {
    if (generation !== compassGeneration) return;
    manualMode();
    text(
      "compass-status",
      error instanceof Error ? error.message : String(error),
    );
  }
  requestRender();
};
input("heading").oninput = () => setHeading(Number(input("heading").value));
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-heading]",
))
  button.onclick = () => {
    manualMode();
    setHeading(Number(button.dataset.heading));
  };
for (const id of ["pitch", "fov", "magnitude", "lines", "north-reference", "full-sky", "sky-info", "sky-labels"]) {
  element(id).addEventListener("input", requestRender);
  element(id).addEventListener("change", requestRender);
}
element("north-reference").addEventListener("input", () => {
  if (head.controlsYaw) head.recalibrate();
});
input("offset").onchange = () => {
  if (!input("offset").value || !input("offset").checkValidity())
    input("offset").value = "0";
  if (head.controlsYaw) head.recalibrate();
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
  selectedTime = date;
  setTimeMode("custom");
};
for (const [id, step] of [
  ["earlier", -1],
  ["later", 1],
] as const)
  element(id).onclick = () => {
    selectedTime = new Date(selectedTime.getTime() + step * 3600000);
    setTimeMode("custom");
  };
element<HTMLFormElement>("location-form").onsubmit = (event) => {
  event.preventDefault();
  locationGeneration++;
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
  const generation = ++locationGeneration;
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
    if (generation === locationGeneration)
      setLocation(
        fix,
        "Using your current location. Update it again after moving.",
      );
  } catch {
    if (generation === locationGeneration)
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
    forceGlassesSend = true;
    lastGlassesKey = "";
    lastGlassesSend = 0;
    if (!location)
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
  disposed = true;
  clearInterval(timer);
  clearTimeout(sendTimer);
  clearTimeout(renderTimer);
  if (renderAnimation !== undefined) cancelAnimationFrame(renderAnimation);
  phone.stop();
  glasses.stop();
});
// Phone visibility is independent of G2's foreground. The SDK's foreground-exit,
// disconnect and system-exit events still stop the sensor session.
document.addEventListener("visibilitychange", requestRender);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
