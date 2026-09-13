import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const base = process.env.SIMULATOR_URL ?? "http://127.0.0.1:9899";
const scenes = JSON.parse(await readFile(new URL("scenes.json", import.meta.url)));
async function request(path, options) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response;
}
async function waitForMessage(message, after = -1) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { entries } = await (await request(after < 0 ? "/api/console" : `/api/console?since_id=${after}`)).json();
    const failure = entries.find(entry => entry.level === "error" || entry.message.includes("Could not"));
    if (failure) throw new Error(failure.message);
    const found = entries.find(entry => entry.id > after && entry.message === message);
    if (found) return found.id;
    await setTimeout(100);
  }
  throw new Error(`Timed out waiting for ${message}. Restart the simulator with capture.html.`);
}
const { entries } = await (await request("/api/console")).json();
if (entries.some(entry => entry.message.startsWith("capture scene:")))
  throw new Error("Restart the simulator with capture.html before capturing a new set.");
await waitForMessage("capture: Connected to G2.");
// Native OS rendering occurs after the SDK acknowledgement.
await setTimeout(1600);
const files = [];
async function screenshot(file) {
  const bytes = Buffer.from(await (await request("/api/screenshot/glasses")).arrayBuffer());
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== 576 || bytes.readUInt32BE(20) !== 288)
    throw new Error("Expected the simulator's 576 x 288 PNG framebuffer.");
  await writeFile(new URL(file, import.meta.url), bytes);
  files.push({ file, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await screenshot("00-startup.png");
for (const scene of scenes) {
  await request("/api/input", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "down" }),
  });
  const id = await waitForMessage(`capture scene: ${scene.file}`);
  await waitForMessage("capture: Sky map sent to G2.", id);
  await setTimeout(250);
  await screenshot(scene.file);
}
const pkg = JSON.parse(await readFile(new URL("../../node_modules/@evenrealities/evenhub-simulator/package.json", import.meta.url)));
await writeFile(new URL("capture-metadata.json", import.meta.url), JSON.stringify({
  simulatorVersion: pkg.version, capturedAt: new Date().toISOString(),
  source: "Official simulator /api/screenshot/glasses; original RGBA PNG, unmodified",
  fixture: "capture.html + production calculateSky, renderView and GlassesDisplay",
  files,
}, null, 2) + "\n");
console.log(`Captured ${files.length} simulator screenshots.`);
