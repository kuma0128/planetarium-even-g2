import { element, text } from "./dom.ts";
import { formatSkyTime, getLanguage, t } from "./i18n.ts";
import { MAP_HEIGHT, renderCaptions, renderSky, type DisplayOptions, type RenderOptions } from "./render.ts";
import {
  direction,
  skyBrightness,
  type Location,
  type Sky,
  type SkyObject,
} from "./sky.ts";

export type TimeMode = "now" | "tonight" | "custom";

type ViewState = {
  time: Date;
  timeMode: TimeMode;
  location: Location | null;
  rawHeading: number;
  heading: number | null;
  headingSource: string;
  declination: number | null;
  footerOverride?: string;
};

const timeLabels: Record<TimeMode, string> = {
  now: "Now",
  tonight: "Tonight",
  custom: "Custom",
};

export function renderView(
  canvas: HTMLCanvasElement,
  sky: Sky,
  options: RenderOptions,
  state: ViewState,
  display: DisplayOptions = { fullSky: true, showInfo: false },
): { header: string; footer: string } {
  const {
    time,
    timeMode,
    location,
    rawHeading,
    heading,
    headingSource,
    declination,
  } = state;
  const visible = renderSky(canvas, sky, options, display.fullSky
    ? { top: 0, height: canvas.height }
    : { top: 54, height: MAP_HEIGHT });
  const targets = visible
    .filter((object) => object.name && object.kind !== "sun")
    .sort((a, b) => a.magnitude - b.magnitude)
    .slice(0, 8);
  const modeLabel = t(timeLabels[timeMode]);
  const brightness = t(skyBrightness(sky.sunAltitude));
  const headingLabel =
    heading == null
      ? t("Check north reference")
      : `${t(direction(heading))} ${Math.round(heading) % 360}°`;
  const timeLabel = formatSkyTime(time);
  const header = display.showInfo
    ? t("{0} {1}\n{2}{3}  Alt {4}°  {5}", modeLabel, timeLabel,
      location ? "" : "Tokyo demo / ", headingLabel, Math.round(options.pitch), headingSource)
    : "";
  const footer =
    state.footerOverride ??
    (display.showInfo ? t("{0}\n{1}\nMoon illuminated: {2}%", brightness,
      targets
        .slice(0, 2)
        .map((object) => `${t(object.name)} ${Math.round(object.altitude)}°`)
        .join(" / ") || "Try a different heading or elevation",
      Math.round(sky.moonFraction * 100)) : "");
  renderCaptions(canvas, header, footer);
  text("lens-header", header);
  text("lens-footer", footer);
  text("sky-period", modeLabel);
  text("direction-name", heading == null ? "Set north" : direction(heading));
  text(
    "heading-readout",
    heading == null ? "—" : String(Math.round(heading) % 360),
  );
  text("heading-source", headingSource);
  text("heading-value", `${Math.round(rawHeading) % 360}°`);
  text("pitch-value", `${Math.round(options.pitch)}°`);
  // No CSS transition across 359°→0°: the diagram follows the actual shortest path.
  const needle = element("compass-needle");
  needle.style.transition = "none";
  needle.style.transform = `rotate(${options.heading}deg)`;
  text(
    "declination-label",
    declination == null
      ? "Magnetic correction is unavailable here at the current date. Use a true-north compass and select True north."
      : t("Current declination: {0}°. Added to magnetic headings to align with true north. Select True north if your compass already applies this correction.", declination.toFixed(1)),
  );
  text(
    "location-label",
    location
      ? `${location.latitude.toFixed(4)}°, ${location.longitude.toFixed(4)}°`
      : "Tokyo demo · Location not set",
  );
  text("light-label", brightness);
  text(
    "object-count",
    t("{0} objects · Brightest named objects below", visible.length),
  );
  renderObjects(targets);
  return { header, footer };
}

let renderedObjects = "";
function renderObjects(targets: SkyObject[]): void {
  const rows = targets.map((object): [string, string] => [
    t(object.name),
    t("{0} {1}° · Alt {2}° · {3}", direction(object.azimuth), object.azimuth.toFixed(0),
      object.altitude.toFixed(0), object.kind === "star" ? t("mag {0}", object.magnitude.toFixed(1))
        : object.kind === "moon" ? "Moon" : "Planet"),
  ]);
  // Renders run at up to 10 Hz during head tracking. Rebuild the cards only
  // when their visible text changes instead of on every frame.
  const key = JSON.stringify([getLanguage(), rows]);
  if (key === renderedObjects) return;
  renderedObjects = key;
  const list = element("objects");
  list.replaceChildren();
  for (const [name, summary] of rows) {
    const card = document.createElement("div");
    card.className = "object";
    const dot = document.createElement("span");
    dot.className = "object-dot";
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = name;
    const detail = document.createElement("p");
    detail.textContent = summary;
    description.append(title, detail);
    card.append(dot, description);
    list.append(card);
  }
  if (!targets.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      t("No bright named objects in this view. Change the heading or elevation to explore.");
    list.append(empty);
  }
}
