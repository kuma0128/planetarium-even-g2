import { angleDifference, DEG, wrap } from "./sky.ts";

export type Axis = "x" | "y" | "z";
export type MotionSample = Record<Axis, number>;
export type TimedMotionSample = MotionSample & { time: number };
export type HeadPose = { heading: number | null; pitch: number };
export type MotionConfig = {
  format: "gravity" | "degrees" | "radians";
  pitchAxis: Axis;
  yawAxis: Axis;
  pitchSign: number;
  yawSign: number;
};
export const DEFAULT_MOTION_CONFIG: MotionConfig = {
  format: "gravity",
  pitchAxis: "x",
  yawAxis: "z",
  pitchSign: 1,
  yawSign: 1,
};
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
  // IMU_Report_Data contains protobuf doubles. The SDK leaves omitted zero
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

/** Gravity constrains elevation, never yaw. Angle decoding is an explicit experiment. */
export class HeadTracker {
  config: MotionConfig;
  phase: "neutral" | "up" | "right" | "tracking" = "neutral";
  pose: HeadPose | null = null;
  message = "Set the viewing direction, then capture your forward pose.";
  lastSampleAt = -Infinity;
  private samples: TimedMotionSample[] = [];
  private neutral: MotionSample | null = null;
  private reference: { heading: number; pitch: number } | null = null;
  private forward: MotionSample | null = null;
  private gravityLength = 0;
  private poseAt = -Infinity;

  constructor(config = DEFAULT_MOTION_CONFIG) {
    this.config = { ...config };
  }

  reset(config = this.config): void {
    this.config = { ...config };
    this.phase = "neutral";
    this.pose = null;
    this.neutral = this.reference = this.forward = null;
    this.samples = [];
    this.lastSampleAt = this.poseAt = -Infinity;
    this.message = "Set the viewing direction, then capture your forward pose.";
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
    let next: HeadPose;
    if (this.config.format === "gravity") {
      const magnitude = length(sample);
      // Reject linear acceleration / corrupt frames instead of treating them as tilt.
      if (Math.abs(magnitude / this.gravityLength - 1) > 0.15) return true;
      next = {
        heading: null,
        pitch: Math.asin(clamp(dot(unit(sample), this.forward!), -1, 1)) / DEG,
      };
    } else {
      const angles = this.angles(sample);
      if (!angles) return true;
      const pitch =
        this.reference!.pitch +
        this.config.pitchSign *
          angleDifference(
            angles[this.config.pitchAxis],
            this.neutral![this.config.pitchAxis],
          );
      if (Math.abs(pitch) > 90) return true;
      next = {
        pitch,
        heading: wrap(
          this.reference!.heading +
            this.config.yawSign *
              angleDifference(
                angles[this.config.yawAxis],
                this.neutral![this.config.yawAxis],
              ),
        ),
      };
    }
    const weight = 1 - Math.exp(-Math.min(500, now - this.poseAt) / 80);
    this.pose = this.pose
      ? {
          pitch: this.pose.pitch + (next.pitch - this.pose.pitch) * weight,
          heading:
            next.heading == null
              ? null
              : wrap(
                  (this.pose.heading ?? next.heading) +
                    angleDifference(
                      next.heading,
                      this.pose.heading ?? next.heading,
                    ) *
                      weight,
                ),
        }
      : next;
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
      this.neutral = this.reference = this.forward = null;
      this.message =
        "Motion paused: no usable reading. Hold still and calibrate again, or stop tracking.";
    }
  }

  captureForward(
    reference: { heading: number; pitch: number },
    now: number,
  ): void {
    if (
      !Number.isFinite(reference.heading) ||
      !Number.isFinite(reference.pitch) ||
      reference.pitch < -60 ||
      reference.pitch > 60
    )
      throw new Error(
        "Select Stop, set a reference elevation between −60° and 60°, then start the sensor and calibrate again.",
      );
    if (
      this.config.format !== "gravity" &&
      this.config.pitchAxis === this.config.yawAxis
    )
      throw new Error("Pitch and yaw must use different axes.");
    this.neutral = this.stable(now);
    this.reference = { ...reference };
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
    if (this.config.format === "gravity") {
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
      const p = this.reference!.pitch * DEG;
      // Recover the glasses' forward axis in sensor coordinates. asin(g·forward)
      // measures elevation independently of roll; no axis/unit assumptions needed.
      this.forward = {
        x: n.x * Math.sin(p) + tangent.x * Math.cos(p),
        y: n.y * Math.sin(p) + tangent.y * Math.cos(p),
        z: n.z * Math.sin(p) + tangent.z * Math.cos(p),
      };
      this.begin(now);
    } else {
      const delta =
        this.config.pitchSign *
        angleDifference(
          up[this.config.pitchAxis],
          this.neutral![this.config.pitchAxis],
        );
      const yaw = Math.abs(
        angleDifference(
          up[this.config.yawAxis],
          this.neutral![this.config.yawAxis],
        ),
      );
      if (delta < 10 || delta > 65 || yaw > 12)
        throw new Error(
          "The selected angle axes did not match an upward tilt. Check format, axes and signs.",
        );
      this.phase = "right";
      this.samples = [];
      this.message =
        "Return to your starting elevation, turn 20–40° right, and hold still. Then capture the right turn.";
    }
  }

  captureRight(now: number): void {
    if (this.phase !== "right")
      throw new Error("Capture the forward and upward poses first.");
    const right = this.stable(now);
    const yaw =
      this.config.yawSign *
      angleDifference(
        right[this.config.yawAxis],
        this.neutral![this.config.yawAxis],
      );
    const pitch = Math.abs(
      angleDifference(
        right[this.config.pitchAxis],
        this.neutral![this.config.pitchAxis],
      ),
    );
    if (yaw < 10 || yaw > 65 || pitch > 12)
      throw new Error(
        "No independent right-turn angle was found. Check the axes, or use tilt-only tracking.",
      );
    this.begin(now);
  }

  private begin(now: number): void {
    this.phase = "tracking";
    this.pose = null;
    this.poseAt = now;
    this.message =
      this.config.format === "gravity"
        ? "Following head elevation. Direction still uses your manual or phone heading."
        : "Following experimental yaw + pitch. Recalibrate if the direction drifts.";
    // Apply the captured pose immediately, including when the device stops sending at rest.
    const latest = this.samples.at(-1)!;
    this.lastSampleAt = -Infinity;
    this.receive(latest, now);
  }

  private angles(sample: MotionSample): MotionSample | null {
    const result = scale(
      sample,
      this.config.format === "radians" ? 1 / DEG : 1,
    );
    return axes.every((key) => Math.abs(result[key]) <= 720) ? result : null;
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
    if (this.config.format === "gravity") {
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
    const readings = samples.map((s) => this.angles(s));
    if (readings.some((s) => !s))
      throw new Error(
        "Values are outside the selected angle format. Check the sensor details.",
      );
    const average = { x: 0, y: 0, z: 0 };
    for (const key of axes) {
      const sin = readings.reduce((sum, s) => sum + Math.sin(s![key] * DEG), 0);
      const cos = readings.reduce((sum, s) => sum + Math.cos(s![key] * DEG), 0);
      average[key] = Math.atan2(sin, cos) / DEG;
      if (
        readings.some(
          (s) => Math.abs(angleDifference(s![key], average[key])) > 2.5,
        )
      )
        throw new Error("Hold your head still while capturing the pose.");
    }
    return average;
  }
}
