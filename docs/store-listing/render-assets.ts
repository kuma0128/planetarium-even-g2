// npm install --prefix artifacts/store-tools --no-save --package-lock=false @napi-rs/canvas@1.0.5
// TZ=Asia/Tokyo node --experimental-strip-types docs/store-listing/render-assets.ts
// Uses the app's complete frame renderer. These are rendered previews, not
// captures of the physical optical display.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { calculateSky } from "../../src/sky.ts";
import { renderView } from "../../src/view.ts";

const require = createRequire(new URL("../../artifacts/store-tools/package.json", import.meta.url));
const { createCanvas } = require("@napi-rs/canvas");
const out = new URL("./", import.meta.url);
const nodes = new Map();
const makeNode = () => ({ textContent: "", style: {}, replaceChildren() {}, append() {} });
// A small DOM sink lets renderView produce the same captions as the app.
globalThis.document = {
  getElementById(id: string) {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  },
  createElement: makeNode,
} as unknown as Document;

const location = { latitude: 35.6762, longitude: 139.6503, height: 0 };
const scenes = [
  { file: "01-winter-stars.png", time: "2026-01-15T12:00:00Z", target: "Betelgeuse", pitchOffset: -4, fov: 100, fullSky: true, showInfo: false, labels: false },
  { file: "02-summer-stars.png", time: "2026-08-15T12:00:00Z", target: "Altair", pitchOffset: 6, fov: 110, fullSky: true, showInfo: false, labels: true },
  { file: "03-moon-and-planets.png", time: "2026-09-25T12:00:00Z", target: "Moon", pitchOffset: 0, fov: 100, fullSky: false, showInfo: true, labels: true },
];
const manifest = [];
for (const scene of scenes) {
  const time = new Date(scene.time);
  const sky = calculateSky(time, location);
  const target = sky.objects.find((object) => object.name === scene.target);
  if (!target || target.altitude < 0) throw new Error(`Target is not visible: ${scene.target}`);
  const heading = Math.round(target.azimuth);
  const pitch = Math.round(target.altitude + scene.pitchOffset);
  const canvas = createCanvas(576, 288);
  const captions = renderView(canvas, sky, { heading, pitch, fov: scene.fov, magnitude: 5.5, lines: true, labels: scene.labels }, {
    time, timeMode: "custom", location, rawHeading: heading, heading,
    headingSource: "Manual", declination: 0,
  }, { fullSky: scene.fullSky, showInfo: scene.showInfo });
  writeFileSync(new URL(scene.file, out), canvas.toBuffer("image/png"));
  manifest.push({ ...scene, location, heading, pitch, ...captions });
}

// Pixel-aligned, two-colour 24 × 24 icon: a star above a curved horizon.
const icon = createCanvas(24, 24);
const iconCtx = icon.getContext("2d");
iconCtx.fillStyle = "black";
iconCtx.fillRect(0, 0, 24, 24);
iconCtx.fillStyle = "white";
for (const [x, y, width, height] of [
  [11, 2, 2, 12], [7, 6, 10, 2], [9, 4, 6, 6],
  [3, 3, 2, 2], [19, 10, 2, 2],
  [2, 20, 20, 2], [3, 18, 18, 2], [5, 16, 14, 2], [8, 14, 8, 2],
] as const) iconCtx.fillRect(x, y, width, height);
iconCtx.fillStyle = "black";
for (const [x, y, width, height] of [[4, 20, 16, 2], [5, 18, 14, 2], [8, 16, 8, 2]] as const) {
  iconCtx.fillRect(x, y, width, height);
}
writeFileSync(new URL("icon.png", out), icon.toBuffer("image/png"));
writeFileSync(new URL("scenes.json", out), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest.map(({ file, heading, pitch, footer }) => ({ file, heading, pitch, footer })), null, 2));
