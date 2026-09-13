// Development-only fixture: real renderer, SDK and G2 delivery; no bridge mocks.
// Not included in the app's Vite production entrypoint.
import { GlassesDisplay } from "../../src/glasses.ts";
import { translate } from "../../src/i18n.ts";
import { calculateSky } from "../../src/sky.ts";
import { renderView } from "../../src/view.ts";
import scenes from "./scenes.json";

for (const id of ["lens-header", "lens-footer", "sky-period", "direction-name",
  "heading-readout", "heading-source", "heading-value", "pitch-value",
  "compass-needle", "declination-label", "location-label", "light-label",
  "object-count", "objects"]) {
  const element = document.createElement("div");
  element.id = id;
  document.querySelector("#details")!.append(element);
}
const canvas = document.querySelector<HTMLCanvasElement>("#sky")!;
let index = -1;
const display = new GlassesDisplay(status => {
  const value = translate(status);
  document.querySelector("#status")!.textContent = value;
  console.log(`capture: ${value}`);
}, gesture => {
  if (gesture !== "right" || index >= scenes.length - 1) return;
  const scene = scenes[++index]!;
  const time = new Date(scene.time);
  renderView(canvas, calculateSky(time, scene.location), {
    heading: scene.heading, pitch: scene.pitch, fov: scene.fov,
    magnitude: 5.5, lines: true, labels: scene.labels,
  }, {
    time, timeMode: "custom", location: scene.location,
    rawHeading: scene.heading, heading: scene.heading,
    headingSource: "Manual", declination: 0,
  }, { fullSky: scene.fullSky, showInfo: scene.showInfo });
  display.submit({ image: canvas, force: true });
  console.log(`capture scene: ${scene.file}`);
});
await display.connect();
