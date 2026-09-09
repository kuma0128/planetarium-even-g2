import { test } from "node:test";
import assert from "node:assert/strict";
import {
  angleDifference,
  calculateSky,
  project,
  tonight,
  validLocation,
} from "../src/sky.ts";

const tokyo = { latitude: 35.6812, longitude: 139.7671, height: 0 };
test("Polaris stays near true north, at the observer latitude, across seasons", () => {
  for (const date of [
    "2026-01-15T12:00:00Z",
    "2026-04-15T12:00:00Z",
    "2026-09-09T12:00:00Z",
  ]) {
    const polaris = calculateSky(new Date(date), tokyo).objects.find(
      (o) => o.id === "star-11767",
    )!;
    assert.ok(Math.abs(angleDifference(polaris.azimuth, 0)) < 1);
    assert.ok(Math.abs(polaris.altitude - tokyo.latitude) < 0.9);
  }
});
test("Sirius is above the southeast horizon on a Tokyo winter evening, below it in September", () => {
  const winter = calculateSky(
    new Date("2026-01-15T12:00:00Z"),
    tokyo,
  ).objects.find((o) => o.name === "Sirius")!;
  const summer = calculateSky(
    new Date("2026-09-09T12:00:00Z"),
    tokyo,
  ).objects.find((o) => o.name === "Sirius")!;
  assert.ok(winter.azimuth > 145 && winter.azimuth < 155);
  assert.ok(winter.altitude > 30 && winter.altitude < 34);
  assert.ok(summer.altitude < -50);
});
test("Sun is close to the zenith at the equator at Greenwich noon on the equinox", () => {
  const sky = calculateSky(new Date("2026-03-20T12:00:00Z"), {
    latitude: 0,
    longitude: 0,
    height: 0,
  });
  assert.ok(sky.sunAltitude > 87);
});
test("Moving to the southern hemisphere puts Polaris below the horizon", () => {
  const sky = calculateSky(new Date("2026-09-09T12:00:00Z"), {
    latitude: -33.87,
    longitude: 151.21,
    height: 0,
  });
  assert.ok(sky.objects.find((o) => o.name === "Polaris")!.altitude < -32);
});
test("Actual Moon and planets have finite independent topocentric positions", () => {
  const sky = calculateSky(new Date("2026-09-09T12:00:00Z"), tokyo);
  assert.equal(sky.objects.filter((o) => o.kind === "planet").length, 5);
  assert.ok(sky.objects.length > 2800);
  assert.ok(sky.moonFraction > 0 && sky.moonFraction < 1);
  assert.ok(
    sky.objects.every(
      (o) =>
        Number.isFinite(o.azimuth) &&
        o.azimuth >= 0 &&
        o.azimuth < 360 &&
        Number.isFinite(o.altitude) &&
        Math.abs(o.altitude) <= 90,
    ),
  );
});
test("Tonight is dark after sunset, and does not skip an already dark night", () => {
  const noon = new Date("2026-09-09T03:00:00Z");
  const night = tonight(noon, tokyo);
  assert.ok(
    night.time > noon && night.time.getTime() - noon.getTime() < 86400000,
  );
  assert.ok(calculateSky(night.time, tokyo).sunAltitude < -18);
  const alreadyDark = new Date("2026-09-09T15:00:00Z");
  assert.equal(
    tonight(alreadyDark, tokyo).time.getTime(),
    alreadyDark.getTime(),
  );
});
test("Polar day never invents a sunset or a dark-night time", () => {
  const now = new Date("2026-06-21T12:00:00Z");
  const result = tonight(now, { latitude: 78.22, longitude: 15.63, height: 0 });
  assert.equal(result.time.getTime(), now.getTime());
  assert.match(result.note, /No /);
});
test("Projection is centered, north-wrap continuous, east to the right, and hides the back", () => {
  const view = { width: 576, height: 144, heading: 359, pitch: 30, fov: 100 };
  const center = project({ azimuth: 359, altitude: 30 }, view)!;
  assert.ok(Math.abs(center.x - 288) < 1e-9 && Math.abs(center.y - 72) < 1e-9);
  assert.ok(project({ azimuth: 1, altitude: 30 }, view)!.x > center.x);
  assert.ok(project({ azimuth: 357, altitude: 30 }, view)!.x < center.x);
  assert.ok(project({ azimuth: 359, altitude: 40 }, view)!.y < center.y);
  assert.equal(project({ azimuth: 179, altitude: 0 }, view), null);
});
test("Zenith and polar coordinates do not cause NaN, invalid input is rejected", () => {
  assert.ok(
    project(
      { azimuth: 0, altitude: 90 },
      { width: 576, height: 144, heading: 0, pitch: 90, fov: 100 },
    ),
  );
  assert.equal(validLocation({ ...tokyo, latitude: NaN }), false);
  assert.equal(validLocation({ ...tokyo, longitude: 181 }), false);
  assert.throws(() => calculateSky(new Date("invalid"), tokyo));
  assert.throws(() => calculateSky(new Date(), { ...tokyo, latitude: 91 }));
});
