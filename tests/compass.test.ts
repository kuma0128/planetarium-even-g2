import { test } from "node:test";
import assert from "node:assert/strict";
import {
  magneticDeclination,
  readHeading,
  smoothHeading,
  trueHeading,
} from "../src/compass.ts";

const base = { alpha: 90, beta: 0, gamma: 0, absolute: true };
test("A relative orientation cannot masquerade as a north-referenced compass", () => {
  assert.equal(readHeading({ ...base, absolute: false }), null);
  assert.equal(readHeading({ ...base, alpha: null }), null);
});
test("iOS heading takes precedence, is magnetic, and poor accuracy is rejected", () => {
  assert.deepEqual(
    readHeading({ ...base, webkitCompassHeading: 0, webkitCompassAccuracy: 5 }),
    { heading: 0, reference: "magnetic" },
  );
  for (const accuracy of [-1, 50, NaN])
    assert.equal(
      readHeading({
        ...base,
        webkitCompassHeading: 100,
        webkitCompassAccuracy: accuracy,
      }),
      null,
    );
});
test("A flat phone with absolute alpha 90 points west; vertical and malformed inputs are rejected", () => {
  assert.equal(readHeading(base)!.heading, 270);
  assert.equal(readHeading({ ...base, beta: 90 }), null);
  assert.equal(readHeading({ ...base, gamma: 80 }), null);
  assert.equal(readHeading({ ...base, beta: NaN }), null);
});
test("Magnetic declination is added once, true-north inputs are not corrected", () => {
  assert.equal(trueHeading({ heading: 5, reference: "magnetic" }, -8), 357);
  assert.equal(trueHeading({ heading: 5, reference: "true" }, -8), 5);
  assert.equal(trueHeading({ heading: 5, reference: "true" }, null, 2), 7);
  assert.equal(trueHeading({ heading: 5, reference: "magnetic" }, null), null);
  assert.equal(trueHeading({ heading: NaN, reference: "true" }, null), null);
});
test("World Magnetic Model gives a westerly declination in Tokyo and fails closed outside its epoch", () => {
  const tokyo = { latitude: 35.68, longitude: 139.76, height: 0 };
  const declination = magneticDeclination(
    tokyo,
    new Date("2026-09-09T00:00:00Z"),
  )!;
  assert.ok(declination < -6 && declination > -10);
  assert.equal(
    magneticDeclination(tokyo, new Date("2100-01-01T00:00:00Z")),
    null,
  );
});
test("Smoothing follows the short arc across north in both directions", () => {
  assert.equal(smoothHeading(359, 1, 0.5), 0);
  assert.equal(smoothHeading(1, 359, 0.5), 0);
});
