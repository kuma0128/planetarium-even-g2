import { t } from "./i18n.ts";
import {
  direction,
  project,
  type Horizontal,
  type Sky,
  type SkyObject,
  type View,
} from "./sky.ts";

export type RenderOptions = {
  heading: number;
  pitch: number;
  fov: number;
  magnitude: number;
  lines: boolean;
  labels?: boolean;
};
export const MAP_WIDTH = 576;
export const MAP_HEIGHT = 144;
export const DISPLAY_HEIGHT = 288;

export type DisplayOptions = {
  fullSky: boolean;
  showInfo: boolean;
};

export function renderSky(
  canvas: HTMLCanvasElement,
  sky: Sky,
  options: RenderOptions,
  viewport = { top: 0, height: canvas.height },
): SkyObject[] {
  const ctx = canvas.getContext("2d")!;
  const { width } = canvas;
  const { height } = viewport;
  const view: View = { ...options, width, height };
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, viewport.top, width, height);
  ctx.clip();
  ctx.translate(0, viewport.top);
  ctx.lineWidth = 1;
  const within = (p: { x: number; y: number } | null, margin = 0) =>
    p != null &&
    p.x >= margin &&
    p.x < width - margin &&
    p.y >= margin &&
    p.y < height - margin;
  const drawPath = (
    points: Horizontal[],
    color: string,
    hideGround = false,
  ) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    let previous: { x: number; y: number } | null = null;
    for (const point of points) {
      const p = hideGround && point.altitude < 0 ? null : project(point, view);
      if (
        p &&
        previous &&
        Math.hypot(p.x - previous.x, p.y - previous.y) < canvas.width
      ) {
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(p.x, p.y);
      }
      previous = p;
    }
    ctx.stroke();
  };
  for (const altitude of [0, 30, 60])
    drawPath(
      Array.from({ length: 181 }, (_, i) => ({ azimuth: i * 2, altitude })),
      altitude === 0 ? "#888" : "#222",
    );
  for (let azimuth = 0; azimuth < 360; azimuth += 45) {
    drawPath(
      Array.from({ length: 46 }, (_, i) => ({ azimuth, altitude: i * 2 })),
      "#222",
    );
    const p = project({ azimuth, altitude: 2 }, view);
    if (options.labels !== false && within(p, 12)) {
      ctx.fillStyle = "#aaa";
      ctx.font = "12px sans-serif";
      ctx.fillText(t(direction(azimuth)), p!.x + 3, p!.y - 3);
    }
  }
  // Constellation lines are densified along great circles in sky.ts, so they
  // only need connecting here and clip cleanly at the horizon/camera plane.
  if (options.lines)
    for (const line of sky.lines) drawPath(line.points, "#555", true);
  // Project each candidate once and reuse the position for symbols and labels.
  const placed: { object: SkyObject; x: number; y: number }[] = [];
  for (const object of sky.objects) {
    if (object.altitude < 0) continue;
    if (object.kind === "star" && object.magnitude > options.magnitude) continue;
    const p = project(object, view);
    if (within(p, 3)) placed.push({ object, x: p!.x, y: p!.y });
  }
  const occupied: { x: number; y: number; width: number }[] = [];
  for (const p of [...placed].sort(
    (a, b) => a.object.magnitude - b.object.magnitude,
  )) {
    const { object } = p;
    const radius =
      object.kind === "moon"
        ? 4
        : object.kind === "sun"
          ? 4
          : Math.max(0.7, Math.min(2.5, (5.7 - object.magnitude) * 0.45));
    // Fainter stars are drawn darker, down to a floor that stays visible.
    const shade = Math.round(Math.max(95, 245 - object.magnitude * 23));
    ctx.fillStyle = object.kind === "star" ? `rgb(${shade} ${shade} ${shade})` : "#fff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
    ctx.fill();
    if (object.kind === "planet") {
      ctx.strokeStyle = "#aaa";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
      ctx.stroke();
    }
    if (options.labels === false || !object.name || (object.kind === "star" && object.magnitude > 2.6))
      continue;
    ctx.font = "12px sans-serif";
    const label = t(object.name);
    const width = ctx.measureText(label).width;
    const x = Math.min(canvas.width - width - 3, p.x + 7),
      y = Math.max(14, p.y - 5);
    if (
      occupied.some(
        (box) =>
          x < box.x + box.width + 4 &&
          x + width + 4 > box.x &&
          Math.abs(y - box.y) < 15,
      )
    )
      continue;
    occupied.push({ x, y, width });
    ctx.fillStyle = "#ddd";
    ctx.fillText(label, x, y);
  }
  ctx.strokeStyle = "#888";
  ctx.beginPath();
  ctx.moveTo(width / 2 - 5, height / 2);
  ctx.lineTo(width / 2 + 5, height / 2);
  ctx.moveTo(width / 2, height / 2 - 5);
  ctx.lineTo(width / 2, height / 2 + 5);
  ctx.stroke();
  ctx.restore();
  return placed.map((p) => p.object);
}

/** Captions are part of the frame, so hiding them clears their pixels on G2. */
export function renderCaptions(
  canvas: HTMLCanvasElement,
  header: string,
  footer: string,
): void {
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.font = "21px sans-serif";
  ctx.textBaseline = "top";
  for (const [content, top, height, lineHeight] of [
    [header, 0, 48, 24],
    [footer, 202, 86, 27],
  ] as const) {
    if (!content) continue;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, top, canvas.width, height);
    const measure = (value: string) => ctx.measureText(value).width;
    const availableWidth = canvas.width - 4;
    const lines = wrapCaption(content, availableWidth, measure);
    const maxLines = Math.floor(height / lineHeight);
    const visible = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
      const last = Array.from(visible[maxLines - 1]!);
      while (last.length && measure(`${last.join("")}…`) > availableWidth) last.pop();
      visible[maxLines - 1] = `${last.join("")}…`;
    }
    ctx.fillStyle = "#fff";
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, canvas.width, height);
    ctx.clip();
    visible.forEach((line, index) => ctx.fillText(line, 0, top + index * lineHeight));
    ctx.restore();
  }
  ctx.restore();
}

/** Wrap words normally, but split long unspaced CJK text to the display width. */
export function wrapCaption(content: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of content.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const character of Array.from(word)) {
        if (line && measure(line + character) > width) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not create the sky-map image."));
        return;
      }
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/png"),
  );
}
