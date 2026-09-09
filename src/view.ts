import { element, text } from "./dom.ts";
import { renderSky, type RenderOptions } from "./render.ts";
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
  const visible = renderSky(canvas, sky, options);
  const targets = visible
    .filter((object) => object.name && object.kind !== "sun")
    .sort((a, b) => a.magnitude - b.magnitude)
    .slice(0, 8);
  const modeLabel = timeLabels[timeMode];
  const brightness = skyBrightness(sky.sunAltitude);
  const headingLabel =
    heading == null
      ? "Check north reference"
      : `${direction(heading)} ${Math.round(heading) % 360}°`;
  const timeLabel = time.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const header = `${modeLabel} ${timeLabel}\n${location ? "" : "Tokyo demo / "}${headingLabel}  Alt ${options.pitch}°  ${headingSource}`;
  const footer = `${brightness}\n${
    targets
      .slice(0, 2)
      .map((object) => `${object.name} ${Math.round(object.altitude)}°`)
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
  text("heading-source", headingSource);
  text("heading-value", `${Math.round(rawHeading) % 360}°`);
  text("pitch-value", `${options.pitch}°`);
  // No CSS transition across 359°→0°: the diagram follows the actual shortest path.
  const needle = element("compass-needle");
  needle.style.transition = "none";
  needle.style.transform = `rotate(${options.heading}deg)`;
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
  text("light-label", brightness);
  text("object-count", `${visible.length} objects · Brightest named objects below`);
  renderObjects(targets);
  return { header, footer };
}

function renderObjects(targets: SkyObject[]): void {
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
}
