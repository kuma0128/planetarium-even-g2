import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MOTION_CONFIG,
  HeadTracker,
  MOTION_TIMEOUT_MS,
  readMotionSample,
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
    { heading: 180, pitch: 20 },
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
        tracker.pose!.heading,
        null,
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
    () => tracker.captureForward({ heading: 0, pitch: 0 }, 10),
    /four fresh/,
  );
  hold(tracker, { x: 0, y: 0, z: 0 }, 100);
  assert.throws(
    () => tracker.captureForward({ heading: 0, pitch: 0 }, 500),
    /gravity/,
  );
  tracker.reset();
  for (let i = 0; i < 5; i++) tracker.receive(gravity(i * 5), 100 + i * 100);
  assert.throws(
    () => tracker.captureForward({ heading: 0, pitch: 0 }, 500),
    /moving/,
  );
  tracker.reset();
  tracker.captureForward(
    { heading: 0, pitch: 0 },
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

test("Malformed frames, repeated timestamps and very old calibration samples are rejected", () => {
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
  assert.equal(tracker.receive(gravity(10), 1), false);
  hold(tracker, gravity(0), 100);
  assert.throws(
    () => tracker.captureForward({ heading: 0, pitch: 0 }, 1100),
    /fresh/,
  );
});

test("Omitted protobuf zero axes can calibrate a level forward pose", () => {
  assert.deepEqual(readMotionSample({ z: 1 }), { x: 0, y: 0, z: 1 });
  assert.deepEqual(readMotionSample({ x: undefined, y: 1 }), { x: 0, y: 1, z: 0 });
  const tracker = new HeadTracker();
  for (let time = 100; time <= 500; time += 100) tracker.receive({ z: 1 }, time);
  tracker.captureForward({ heading: 180, pitch: 0 }, 500);
  for (let time = 600; time <= 1000; time += 100)
    tracker.receive({ x: 0.5, z: Math.sqrt(3) / 2 }, time);
  tracker.captureUp(1000);
  assert.equal(tracker.phase, "tracking");
  assert.ok(Math.abs(tracker.pose!.pitch - 30) < 0.01);
  assert.equal(tracker.pose!.heading, null);
});

test("Experimental angles require independent pitch and yaw checks, then cross north smoothly", () => {
  const tracker = new HeadTracker({
    ...DEFAULT_MOTION_CONFIG,
    format: "degrees",
  });
  tracker.captureForward(
    { heading: 359, pitch: 10 },
    hold(tracker, { x: 5, y: 0, z: 359 }, 100),
  );
  tracker.captureUp(hold(tracker, { x: 35, y: 0, z: 359 }, 600));
  assert.equal(tracker.phase, "right");
  assert.equal(tracker.pose, null);
  assert.throws(
    () => tracker.captureRight(hold(tracker, { x: 5, y: 0, z: 359 }, 1100)),
    /independent/,
  );
  tracker.captureRight(hold(tracker, { x: 5, y: 0, z: 29 }, 2100));
  hold(tracker, { x: 15, y: 0, z: 1 }, 3100);
  assert.ok(Math.abs(tracker.pose!.heading! - 1) < 0.1);
  assert.ok(Math.abs(tracker.pose!.pitch - 20) < 0.1);
});

test("Radian angle profiles support reversed axes and reject using one axis twice", () => {
  const config = {
    ...DEFAULT_MOTION_CONFIG,
    format: "radians" as const,
    pitchAxis: "y" as const,
    yawAxis: "x" as const,
    pitchSign: -1,
    yawSign: -1,
  };
  const tracker = new HeadTracker(config);
  tracker.captureForward(
    { heading: 90, pitch: 0 },
    hold(tracker, { x: 0, y: 0, z: 0 }, 100),
  );
  tracker.captureUp(hold(tracker, { x: 0, y: -Math.PI / 6, z: 0 }, 600));
  tracker.captureRight(hold(tracker, { x: -Math.PI / 6, y: 0, z: 0 }, 1100));
  assert.ok(Math.abs(tracker.pose!.heading! - 120) < 1e-8);
  tracker.reset({ ...config, pitchAxis: "x" });
  assert.throws(
    () => tracker.captureForward({ heading: 0, pitch: 0 }, 2000),
    /different axes/,
  );
});

test("Small accelerometer values do not pass the degrees-mode rotation checks", () => {
  const tracker = new HeadTracker({
    ...DEFAULT_MOTION_CONFIG,
    format: "degrees",
  });
  tracker.captureForward(
    { heading: 0, pitch: 0 },
    hold(tracker, gravity(0), 100),
  );
  assert.throws(
    () => tracker.captureUp(hold(tracker, gravity(30), 600)),
    /angle axes/,
  );
});
