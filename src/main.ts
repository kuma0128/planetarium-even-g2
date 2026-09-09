import "./style.css";
import {
  calculateSky,
  direction,
  skyBrightness,
  tonight,
  validLocation,
  wrap,
  type Location,
  type Sky,
} from "./sky.ts";
import {
  magneticDeclination,
  PhoneCompass,
  smoothHeading,
  trueHeading,
  type NorthReference,
} from "./compass.ts";
import { GlassesDisplay } from "./glasses.ts";
import { renderSky } from "./render.ts";

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id)! as T;
const input = (id: string) => element<HTMLInputElement>(id);
const text = (id: string, value: string) => {
  element(id).textContent = value;
};
const pressed = (id: string, value: boolean) =>
  element(id).setAttribute("aria-pressed", String(value));
const canvas = element<HTMLCanvasElement>("sky");
const sampleLocation: Location = {
  latitude: 35.6812,
  longitude: 139.7671,
  height: 0,
};
let location: Location | null = null;
let timeMode: "now" | "tonight" | "custom" = "now";
let selectedTime = new Date();
let rawHeading = 180;
let phoneMode = false;
let phoneReceivedAt = 0;
let compassGeneration = 0;
let sky: Sky | null = null;
let skyKey = "";
let renderRequested = false;
let lastGlassesSend = 0;
let lastGlassesKey = "";
let locationGeneration = 0;
let disposed = false;
let physicalDay = "";
let declination: number | null = null;
const phone = new PhoneCompass();
const glasses = new GlassesDisplay(
  (status) => text("bridge-status", status),
  (gesture) => {
    if (gesture === "tap") setTimeMode(timeMode === "now" ? "tonight" : "now");
    else {
      manualMode();
      setHeading(rawHeading + (gesture === "left" ? -15 : 15));
    }
  },
);

function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function setTimeMode(mode: typeof timeMode): void {
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
    text("time-note", "Showing the selected time, which may differ from the current sky.");
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
  requestAnimationFrame(() => {
    renderRequested = false;
    render();
  });
}
function render(): void {
  const now = new Date();
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
      heading: rawHeading,
      reference: input("north-reference").value as NorthReference,
    },
    declination,
    Number(input("offset").value),
  );
  const pitch = Number(input("pitch").value);
  const options = {
    heading: heading ?? rawHeading,
    pitch,
    fov: Number(input("fov").value),
    magnitude: Number(input("magnitude").value),
    lines: input("lines").checked,
  };
  const visible = renderSky(canvas, sky, options);
  const targets = visible
    .filter((o) => o.name && o.kind !== "sun")
    .sort((a, b) => a.magnitude - b.magnitude)
    .slice(0, 8);
  const modeLabel =
    timeMode === "now"
      ? "Now"
      : timeMode === "tonight"
        ? "Tonight"
        : "Custom";
  const source = phoneMode
    ? Date.now() - phoneReceivedAt <= 4000
      ? "Phone"
      : "Phone: waiting"
    : "Manual";
  const headingLabel =
    heading == null
      ? "Check north reference"
      : `${direction(heading)} ${Math.round(heading) % 360}°`;
  const timeLabel = selectedTime.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const header = `${modeLabel} ${timeLabel}\n${location ? "" : "Tokyo demo / "}${headingLabel}  Alt ${pitch}°  ${source}`;
  const footer = `${skyBrightness(sky.sunAltitude)}\n${
    targets
      .slice(0, 2)
      .map((o) => `${o.name} ${Math.round(o.altitude)}°`)
      .join(" / ") || "Try a different heading or elevation"
  }\nMoon illuminated: ${Math.round(sky.moonFraction * 100)}%`;
  text("lens-header", header);
  text("lens-footer", footer);
  text("sky-period", modeLabel);
  text("direction-name", heading == null ? "Set north" : direction(heading));
  text(
    "heading-readout",
    heading == null ? "—" : String(Math.round(heading) % 360),
  );
  text("heading-source", source);
  text("heading-value", `${Math.round(rawHeading) % 360}°`);
  text("pitch-value", `${pitch}°`);
  // No CSS transition across 359°→0°: the diagram follows the actual shortest path.
  element("compass-needle").style.transition = "none";
  element("compass-needle").style.transform =
    `rotate(${heading ?? rawHeading}deg)`;
  text(
    "declination-label",
    declination == null
      ? "Magnetic correction is unavailable here at the current date. Use a true-north compass and select True north."
      : `Current declination: ${declination.toFixed(1)}°. Added to magnetic headings to align with true north. Select True north if your compass already applies this correction.`,
  );
  text(
    "location-label",
    location
      ? `${location.latitude.toFixed(4)}°, ${location.longitude.toFixed(4)}°`
      : "Tokyo demo · Location not set",
  );
  text("light-label", skyBrightness(sky.sunAltitude));
  text("object-count", `${visible.length} objects · Brightest named objects below`);
  const list = element("objects");
  list.replaceChildren();
  for (const object of targets) {
    const card = document.createElement("div");
    card.className = "object";
    const dot = document.createElement("span");
    dot.className = "object-dot";
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = object.name;
    const detail = document.createElement("p");
    detail.textContent = `${direction(object.azimuth)} ${object.azimuth.toFixed(0)}° · Alt ${object.altitude.toFixed(0)}° · ${object.kind === "star" ? `mag ${object.magnitude.toFixed(1)}` : object.kind === "moon" ? "Moon" : "Planet"}`;
    description.append(title, detail);
    card.append(dot, description);
    list.append(card);
  }
  if (!targets.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      "No bright named objects in this view. Change the heading or elevation to explore.";
    list.append(empty);
  }
  const frameKey = JSON.stringify([
    skyKey,
    Math.round(options.heading),
    options.pitch,
    options.fov,
    options.magnitude,
    options.lines,
    header,
    footer,
  ]);
  if (
    glasses.connected &&
    location &&
    heading != null &&
    frameKey !== lastGlassesKey &&
    now.getTime() - lastGlassesSend > 1200
  ) {
    lastGlassesSend = now.getTime();
    lastGlassesKey = frameKey;
    glasses.submit({ image: canvas, header, footer });
  }
}

element("manual-mode").onclick = manualMode;
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
        setHeading(next);
      },
      (status) => {
        if (generation === compassGeneration) {
          text("compass-status", status);
          requestRender();
        }
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
for (const id of ["pitch", "fov", "magnitude", "lines", "north-reference"])
  element(id).addEventListener("input", requestRender);
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
  setLocation(
    {
      latitude: Number(input("latitude").value),
      longitude: Number(input("longitude").value),
      height: 0,
    },
    "Using your selected observing location.",
  );
};
element("locate").onclick = async () => {
  const generation = ++locationGeneration;
  const button = element<HTMLButtonElement>("locate");
  button.disabled = true;
  text("location-status", "Finding your location…");
  try {
    let fix = await glasses.location();
    if (!fix) {
      if (!navigator.geolocation)
        throw new Error("Location is unavailable. Enter latitude and longitude instead.");
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
      setLocation(fix, "Using your current location. Update it again after moving.");
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
setTimeMode("now");
const timer = window.setInterval(requestRender, 1000);
window.addEventListener("pagehide", () => {
  disposed = true;
  clearInterval(timer);
  phone.stop();
  glasses.stop();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
