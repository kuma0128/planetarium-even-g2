import { test } from "node:test";
import assert from "node:assert/strict";
import {
  magneticDeclination,
  trueHeading,
} from "../src/compass.ts";

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
