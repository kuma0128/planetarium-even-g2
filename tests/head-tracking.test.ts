import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HeadTracker,
  MOTION_TIMEOUT_MS,
  readMotionSample,
  usableReading,
  type MotionSample,
} from "../src/head-tracking.ts";

const gravity = (pitch: number, roll = 0, magnitude = 1): MotionSample => {
  const p = (pitch * Math.PI) / 180,
    r = (roll * Math.PI) / 180;
  return {
    x: Math.sin(p) * magnitude,
    y: Math.cos(p) * Math.sin(r) * magnitude,
    z: Math.cos(p) * Math.cos(r) * magnitude,
  };
};
function hold(
  tracker: HeadTracker,
  sample: MotionSample,
  start: number,
): number {
  for (let i = 0; i < 5; i++) tracker.receive(sample, start + i * 100);
  return start + 400;
}
function calibratedGravity(transform = (v: MotionSample) => v): HeadTracker {
  const tracker = new HeadTracker();
  tracker.captureForward(
    20,
    hold(tracker, transform(gravity(20)), 100),
  );
  tracker.captureUp(hold(tracker, transform(gravity(50)), 600));
  return tracker;
}

test("Gravity calibration recovers elevation across sensor axes, scale and mounting angle", () => {
  for (const transform of [
    (v: MotionSample) => v,
    (v: MotionSample) => ({ x: -v.z * 9.81, y: v.x * 9.81, z: -v.y * 9.81 }),
    (v: MotionSample) => ({
      x: (v.x + v.z) / Math.SQRT2,
      y: v.y,
      z: (v.z - v.x) / Math.SQRT2,
    }),
  ]) {
    const tracker = calibratedGravity(transform);
    assert.equal(tracker.phase, "tracking");
    for (const pitch of [0, 30, 80, -20]) {
      const start = tracker.lastSampleAt + 100;
      hold(tracker, transform(gravity(pitch)), start);
      assert.ok(Math.abs(tracker.pose!.pitch - pitch) < 0.3);
      assert.equal(
        "heading" in tracker.pose!,
        false,
        "Gravity must never manufacture a compass heading",
      );
    }
  }
});

test("Sideways roll does not masquerade as elevation, including at nonzero elevation", () => {
  const tracker = calibratedGravity();
  hold(tracker, gravity(35, 60), 1100);
  assert.ok(Math.abs(tracker.pose!.pitch - 35) < 0.1);
  hold(tracker, gravity(35, -70), 1600);
  assert.ok(Math.abs(tracker.pose!.pitch - 35) < 0.1);
});

test("Calibration rejects missing, moving, zero and non-gravity readings", () => {
  const tracker = new HeadTracker();
  assert.throws(
    () => tracker.captureForward(0, 10),
    /four fresh/,
  );
  hold(tracker, { x: 0, y: 0, z: 0 }, 100);
  assert.throws(
    () => tracker.captureForward(0, 500),
    /gravity/,
  );
  tracker.reset();
  for (let i = 0; i < 5; i++) tracker.receive(gravity(i * 5), 100 + i * 100);
  assert.throws(
    () => tracker.captureForward(0, 500),
    /moving/,
  );
  tracker.reset();
  tracker.captureForward(
    0,
    hold(tracker, gravity(0), 100),
  );
  assert.throws(
    () => tracker.captureUp(hold(tracker, gravity(0), 600)),
    /20–40/,
  );
  assert.throws(
    () => tracker.captureUp(hold(tracker, gravity(30, 0, 1.8), 2000)),
    /stable gravity/,
  );
});

test("Acceleration bursts freeze the last view and sustained unusable data requires recalibration", () => {
  const tracker = calibratedGravity();
  const previous = tracker.pose!.pitch;
  tracker.receive(gravity(0, 0, 2), 1100);
  assert.equal(tracker.pose!.pitch, previous);
  for (let t = 1200; t <= 2700; t += 100) tracker.receive(gravity(0, 0, 2), t);
  assert.equal(tracker.phase, "neutral");
  assert.equal(tracker.pose!.pitch, previous);
  assert.match(tracker.message, /paused/);
});

test("A stale stream cannot silently resume using an obsolete calibration", () => {
  const tracker = calibratedGravity();
  const previous = tracker.pose;
  tracker.expire(tracker.lastSampleAt + MOTION_TIMEOUT_MS + 1);
  assert.equal(tracker.phase, "neutral");
  tracker.receive(gravity(80), 3000);
  assert.deepEqual(tracker.pose, previous);
  assert.equal(tracker.phase, "neutral");
});

test("Malformed frames, backwards timestamps and very old calibration samples are rejected", () => {
  for (const value of [
    null,
    {},
    { x: null, y: 1, z: 0 },
    { x: "1", y: 2, z: 3 },
    { x: NaN, y: 1, z: 2 },
    { x: Infinity, y: 0, z: 0 },
  ])
    assert.equal(readMotionSample(value), null);
  const tracker = new HeadTracker();
  assert.equal(tracker.receive(gravity(0), 1), true);
  assert.equal(tracker.receive(gravity(10), 0), false);
  hold(tracker, gravity(0), 100);
  assert.throws(
    () => tracker.captureForward(0, 1100),
    /fresh/,
  );
});

test("Readings that share an arrival timestamp are kept and can calibrate", () => {
  const tracker = new HeadTracker();
  // Buffered host delivery: several readings land in the same tick.
  for (const time of [100, 100, 100, 400, 400])
    assert.equal(tracker.receive(gravity(20), time), true);
  tracker.captureForward(20, 400);
  assert.equal(tracker.phase, "up");
  for (const time of [600, 600, 900, 900, 900]) tracker.receive(gravity(50), time);
  tracker.captureUp(900);
  assert.equal(tracker.phase, "tracking");
  const pitch = tracker.pose!.pitch;
  assert.ok(Math.abs(pitch - 50) < 0.01);
  // No elapsed time: the duplicate neither moves the filter nor corrupts it.
  assert.equal(tracker.receive(gravity(0), 900), true);
  assert.equal(tracker.pose!.pitch, pitch);
  hold(tracker, gravity(0), 1000);
  assert.ok(Math.abs(tracker.pose!.pitch) < 0.3);
});

test("Omitted protobuf zero axes can calibrate a level forward pose", () => {
  assert.deepEqual(readMotionSample({ z: 1 }), { x: 0, y: 0, z: 1 });
  assert.deepEqual(readMotionSample({ x: undefined, y: 1 }), { x: 0, y: 1, z: 0 });
  const tracker = new HeadTracker();
  for (let time = 100; time <= 500; time += 100) tracker.receive({ z: 1 }, time);
  tracker.captureForward(0, 500);
  for (let time = 600; time <= 1000; time += 100)
    tracker.receive({ x: 0.5, z: Math.sqrt(3) / 2 }, time);
  tracker.captureUp(1000);
  assert.equal(tracker.phase, "tracking");
  assert.ok(Math.abs(tracker.pose!.pitch - 30) < 0.01);
  assert.equal("heading" in tracker.pose!, false);
});

test("A new reference changes the elevation origin and requires both fresh poses", () => {
  const tracker = calibratedGravity();
  tracker.reset();
  assert.equal(tracker.pose, null);
  tracker.captureForward(0, hold(tracker, gravity(20), 1100));
  assert.equal(tracker.phase, "up");
  assert.equal(tracker.pose, null);
  tracker.captureUp(hold(tracker, gravity(50), 1600));
  assert.ok(Math.abs(tracker.pose!.pitch - 30) < 0.01);
  hold(tracker, gravity(10), 2100);
  assert.ok(Math.abs(tracker.pose!.pitch + 10) < 0.1);
});

test("Calibration tolerates isolated dropout and shock readings but not two among five", () => {
  const tracker = new HeadTracker();
  const glitches: Record<number, MotionSample> = {
    300: { x: 0.0001, y: -0.0002, z: -0.0001 },
    600: gravity(20, 0, 1.5),
  };
  for (let time = 100; time <= 900; time += 100)
    tracker.receive(glitches[time] ?? gravity(20), time);
  const forward = tracker.captureForward(20, 900);
  assert.equal(tracker.phase, "up");
  assert.deepEqual([forward.used, forward.dropped], [7, 2]);
  assert.ok(Math.abs(forward.gravity.x - gravity(20).x) < 1e-9);
  const up = tracker.captureUp(hold(tracker, gravity(50), 1000));
  assert.equal(tracker.phase, "tracking");
  assert.ok(Math.abs(up.tiltDeg! - 30) < 1e-6);
  assert.deepEqual([up.used, up.dropped], [5, 0]);
  // Tracking starts from the averaged upward pose, not the last single reading.
  assert.ok(Math.abs(tracker.pose!.pitch - 50) < 1e-6);
  hold(tracker, gravity(30), 1500);
  assert.ok(Math.abs(tracker.pose!.pitch - 30) < 0.1);

  tracker.reset();
  const window: [number, MotionSample][] = [
    [100, gravity(20)],
    [200, { x: 0, y: 0, z: 0 }],
    [300, gravity(20)],
    [400, gravity(20, 0, 1.5)],
    [500, gravity(20)],
  ];
  for (const [time, sample] of window) tracker.receive(sample, time);
  assert.throws(() => tracker.captureForward(20, 500), /moving/);
});

test("Dropout frames are recognised and ignored acceleration is counted while tracking", () => {
  assert.equal(usableReading({ x: 0.0001, y: -0.0002, z: -0.0001 }), false);
  assert.equal(usableReading({ x: 0, y: 0, z: 0 }), false);
  assert.equal(usableReading(gravity(0)), true);
  assert.equal(usableReading({ x: 0, y: 0, z: 9.81 }), true);
  const tracker = calibratedGravity();
  assert.equal(tracker.ignored, 0);
  tracker.receive(gravity(0, 0, 2), 1100);
  tracker.receive(gravity(20), 1200);
  assert.equal(tracker.ignored, 1);
  tracker.reset();
  assert.equal(tracker.ignored, 0);
});
