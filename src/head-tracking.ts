import { DEG } from "./sky.ts";

export type Axis = "x" | "y" | "z";
export type MotionSample = Record<Axis, number>;
export type TimedMotionSample = MotionSample & { time: number };
export type HeadPose = { pitch: number };
export const MOTION_TIMEOUT_MS = 1500;
const axes: Axis[] = ["x", "y", "z"];
const dot = (a: MotionSample, b: MotionSample) =>
  axes.reduce((s, k) => s + a[k] * b[k], 0);
const length = (v: MotionSample) => Math.hypot(v.x, v.y, v.z);
const scale = (v: MotionSample, n: number): MotionSample => ({
  x: v.x * n,
  y: v.y * n,
  z: v.z * n,
});
const unit = (v: MotionSample) => scale(v, 1 / length(v));
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

export function readMotionSample(value: unknown): MotionSample | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<MotionSample>;
  // IMU_Report_Data contains numeric axes. The SDK leaves omitted zero
  // components undefined; do not discard a level pose such as { z: 1 }.
  // An absent/empty payload is still not a reading.
  if (!axes.some((key) => raw[key] !== undefined)) return null;
  const sample = {
    x: raw.x === undefined ? 0 : raw.x,
    y: raw.y === undefined ? 0 : raw.y,
    z: raw.z === undefined ? 0 : raw.z,
  };
  if (
    !axes.every(
      (key) =>
        typeof sample[key] === "number" &&
        Number.isFinite(sample[key]) &&
        Math.abs(sample[key]) <= 1e9,
    )
  )
    return null;
  return { x: sample.x, y: sample.y, z: sample.z };
}

/** Two gravity poses establish the viewing axis; tracking only produces elevation. */
export class HeadTracker {
  phase: "neutral" | "up" | "tracking" = "neutral";
  pose: HeadPose | null = null;
  message = "Face the selected heading and elevation, then use this direction as reference.";
  lastSampleAt = -Infinity;
  private samples: TimedMotionSample[] = [];
  private neutral: MotionSample | null = null;
  private referencePitch = 0;
  private forward: MotionSample | null = null;
  private gravityLength = 0;
  private poseAt = -Infinity;

  reset(): void {
    this.phase = "neutral";
    this.pose = null;
    this.neutral = this.forward = null;
    this.samples = [];
    this.lastSampleAt = this.poseAt = -Infinity;
    this.message = "Face the selected heading and elevation, then use this direction as reference.";
  }

  receive(value: unknown, now: number): boolean {
    const sample = readMotionSample(value);
    if (!sample || !Number.isFinite(now) || now <= this.lastSampleAt)
      return false;
    this.expire(now);
    this.lastSampleAt = now;
    this.samples = this.samples.filter((s) => now - s.time <= 1000);
    this.samples.push({ ...sample, time: now });
    if (this.samples.length > 100) this.samples.shift();
    if (this.phase !== "tracking") return true;
    const magnitude = length(sample);
    // Reject linear acceleration / corrupt frames instead of treating them as tilt.
    if (Math.abs(magnitude / this.gravityLength - 1) > 0.15) return true;
    const next = Math.asin(clamp(dot(unit(sample), this.forward!), -1, 1)) / DEG;
    const weight = 1 - Math.exp(-Math.min(500, now - this.poseAt) / 80);
    this.pose = {
      pitch: this.pose ? this.pose.pitch + (next - this.pose.pitch) * weight : next,
    };
    this.poseAt = now;
    return true;
  }

  /** Freeze the last view, but require calibration again after a gap/reset. */
  expire(now: number): void {
    const referenceTime =
      this.phase === "tracking" ? this.poseAt : this.lastSampleAt;
    if (this.phase !== "neutral" && now - referenceTime > MOTION_TIMEOUT_MS) {
      this.phase = "neutral";
      this.samples = [];
      this.neutral = this.forward = null;
      this.message =
        "Motion paused: no usable reading. Hold still and calibrate again, or stop tracking.";
    }
  }

  captureForward(
    referencePitch: number,
    now: number,
  ): void {
    if (
      !Number.isFinite(referencePitch) ||
      referencePitch < -60 ||
      referencePitch > 60
    )
      throw new Error(
        "Select Align another direction or Stop, set a reference elevation between −60° and 60°, then set the reference again.",
      );
    this.neutral = this.stable(now);
    this.referencePitch = referencePitch;
    this.gravityLength = length(this.neutral);
    this.forward = null;
    this.pose = null;
    this.phase = "up";
    this.message =
      "Look 20–40° higher without tilting sideways. Hold still, then capture the upward pose.";
    this.samples = [];
  }

  captureUp(now: number): void {
    if (this.phase !== "up")
      throw new Error("Capture your forward pose first.");
    const up = this.stable(now);
    if (Math.abs(length(up) / this.gravityLength - 1) > 0.1)
      throw new Error(
        "The sensor does not look like a stable gravity vector. Check the sensor details.",
      );
    const n = unit(this.neutral!),
      u = unit(up);
    const cosine = clamp(dot(n, u), -1, 1);
    const angle = Math.acos(cosine) / DEG;
    if (angle < 10 || angle > 65)
      throw new Error("Look 20–40° higher, hold still, and try again.");
    const tangent = unit({
      x: u.x - cosine * n.x,
      y: u.y - cosine * n.y,
      z: u.z - cosine * n.z,
    });
    const p = this.referencePitch * DEG;
    // Recover the glasses' forward axis in sensor coordinates. asin(g·forward)
    // measures elevation independently of roll; no axis/unit assumptions needed.
    this.forward = {
      x: n.x * Math.sin(p) + tangent.x * Math.cos(p),
      y: n.y * Math.sin(p) + tangent.y * Math.cos(p),
      z: n.z * Math.sin(p) + tangent.z * Math.cos(p),
    };
    this.begin(now);
  }

  private begin(now: number): void {
    this.phase = "tracking";
    this.pose = null;
    this.poseAt = now;
    this.message = "Following head elevation. Scroll the temple touchpad to browse left/right by 15° per step.";
    // Apply the captured pose immediately, including when the device stops sending at rest.
    const latest = this.samples.at(-1)!;
    this.lastSampleAt = -Infinity;
    this.receive(latest, now);
  }

  private stable(now: number): MotionSample {
    const samples = this.samples.filter((s) => now - s.time <= 800);
    if (
      samples.length < 4 ||
      now - this.lastSampleAt > 400 ||
      samples.at(-1)!.time - samples[0]!.time < 250
    )
      throw new Error(
        "Wait for at least four fresh readings while holding your head still, then try again.",
      );
    const average = { x: 0, y: 0, z: 0 };
    for (const s of samples)
      for (const key of axes) average[key] += s[key] / samples.length;
    const magnitude = length(average);
    if (
      magnitude < 1e-6 ||
      samples.some(
        (s) =>
          Math.abs(length(s) / magnitude - 1) > 0.08 ||
          dot(unit(s), unit(average)) < Math.cos(2.5 * DEG),
      )
    )
      throw new Error(
        "Readings are moving or are not a gravity vector. Hold still and try again.",
      );
    return average;
  }
}
