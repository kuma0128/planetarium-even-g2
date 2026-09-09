import {
  DEG,
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
};
export const MAP_WIDTH = 576;
export const MAP_HEIGHT = 144;

export function renderSky(
  canvas: HTMLCanvasElement,
  sky: Sky,
  options: RenderOptions,
): SkyObject[] {
  const ctx = canvas.getContext("2d")!;
  const view: View = { ...options, width: canvas.width, height: canvas.height };
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 1;
  const within = (p: { x: number; y: number } | null, margin = 0) =>
    p != null &&
    p.x >= margin &&
    p.x < canvas.width - margin &&
    p.y >= margin &&
    p.y < canvas.height - margin;
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
  // Great-circle interpolation clips constellation lines at the horizon/camera plane.
  const arc = (a: Horizontal, b: Horizontal): Horizontal[] => {
    const vector = (p: Horizontal) => [
      Math.cos(p.altitude * DEG) * Math.sin(p.azimuth * DEG),
      Math.cos(p.altitude * DEG) * Math.cos(p.azimuth * DEG),
      Math.sin(p.altitude * DEG),
    ];
    const v = vector(a),
      w = vector(b);
    return Array.from({ length: 17 }, (_, i) => {
      const t = i / 16,
        x = v[0]! * (1 - t) + w[0]! * t,
        y = v[1]! * (1 - t) + w[1]! * t,
        z = v[2]! * (1 - t) + w[2]! * t;
      return {
        azimuth: Math.atan2(x, y) / DEG,
        altitude: Math.atan2(z, Math.hypot(x, y)) / DEG,
      };
    });
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
    if (within(p, 12)) {
      ctx.fillStyle = "#aaa";
      ctx.font = "12px sans-serif";
      ctx.fillText(direction(azimuth), p!.x + 3, p!.y - 3);
    }
  }
  if (options.lines)
    for (const line of sky.lines)
      for (let i = 1; i < line.points.length; i++) {
        drawPath(arc(line.points[i - 1]!, line.points[i]!), "#555", true);
      }
  const visible = sky.objects.filter(
    (o) =>
      o.altitude >= 0 &&
      (o.kind !== "star" || o.magnitude <= options.magnitude) &&
      within(project(o, view), 3),
  );
  const occupied: { x: number; y: number; width: number }[] = [];
  for (const object of [...visible].sort((a, b) => a.magnitude - b.magnitude)) {
    const p = project(object, view)!;
    const radius =
      object.kind === "moon"
        ? 4
        : object.kind === "sun"
          ? 4
          : Math.max(0.7, Math.min(2.5, (5.7 - object.magnitude) * 0.45));
    ctx.fillStyle =
      object.kind === "star"
        ? `rgb(${Math.round(Math.max(95, 245 - object.magnitude * 23))} ${Math.round(Math.max(95, 245 - object.magnitude * 23))} ${Math.round(Math.max(95, 245 - object.magnitude * 23))})`
        : "#fff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
    ctx.fill();
    if (object.kind === "planet") {
      ctx.strokeStyle = "#aaa";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
      ctx.stroke();
    }
    if (!object.name || (object.kind === "star" && object.magnitude > 2.6))
      continue;
    ctx.font = "12px sans-serif";
    const width = ctx.measureText(object.name).width;
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
    ctx.fillText(object.name, x, y);
  }
  ctx.strokeStyle = "#888";
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2 - 5, canvas.height / 2);
  ctx.lineTo(canvas.width / 2 + 5, canvas.height / 2);
  ctx.moveTo(canvas.width / 2, canvas.height / 2 - 5);
  ctx.lineTo(canvas.width / 2, canvas.height / 2 + 5);
  ctx.stroke();
  return visible;
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
