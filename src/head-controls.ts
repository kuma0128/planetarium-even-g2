import { element, input, text } from "./dom.ts";
import {
  HeadTracker,
  MOTION_TIMEOUT_MS,
  readMotionSample,
  type Axis,
  type MotionConfig,
  type TimedMotionSample,
} from "./head-tracking.ts";
import type { GlassesDisplay } from "./glasses.ts";

/** The live sensor session and calibration UI. No simulated input enters this path. */
export class HeadControls {
  readonly tracker = new HeadTracker();
  enabled = false;
  private generation = 0;
  private busy = false;
  private startedAt = 0;
  private samples: TimedMotionSample[] = [];
  private captures: {
    time: number;
    step: string;
    heading: number;
    pitch: number;
  }[] = [];
  private lastRefresh = -Infinity;
  private transferMs: number | null = null;
  private captureFailed = false;
  private receivedCount = 0;
  private rejectedCount = 0;
  private status =
    "Start the G2 sensor, then calibrate while wearing your glasses.";
  constructor(
    private glasses: GlassesDisplay,
    private reference: () => { heading: number; pitch: number },
    private changed: () => void,
    private beforeReset: () => void,
    private angleMode: () => void,
  ) {
    element("head-start").onclick = () => void this.start();
    element("head-stop").onclick = () => void this.stop();
    element("head-forward").onclick = () =>
      this.capture("forward", () => {
        this.beforeReset();
        this.tracker.captureForward(this.reference(), performance.now());
      });
    element("head-up").onclick = () =>
      this.capture("up", () => this.tracker.captureUp(performance.now()));
    element("head-right").onclick = () =>
      this.capture("right", () => this.tracker.captureRight(performance.now()));
    for (const id of [
      "head-format",
      "head-pitch-axis",
      "head-yaw-axis",
      "head-pitch-sign",
      "head-yaw-sign",
    ])
      element(id).onchange = () => this.recalibrate();
    element("head-download").onclick = () => this.download();
    this.refresh(performance.now(), true);
  }
  get pose() {
    return this.enabled ? this.tracker.pose : null;
  }
  get active() {
    return this.enabled && this.tracker.phase === "tracking";
  }
  get controlsYaw() {
    return this.enabled && this.tracker.config.format !== "gravity";
  }
  get glassesHint(): string | undefined {
    if (!this.enabled || this.active) return;
    if (performance.now() - this.tracker.lastSampleAt > MOTION_TIMEOUT_MS)
      return "Waiting for G2 sensor readings\nCheck the sensor status on your phone.\nCalibration needs live readings.";
    if (this.captureFailed)
      return "Pose not captured\nHold still and try the tap again.\nCheck the phone for calibration details.";
    if (this.tracker.phase === "up")
      return "Head setup: look up 20–40°\nKeep your head level sideways.\nHold still; tap to capture.";
    if (this.tracker.phase === "right")
      return "Head setup: turn right 20–40°\nUse your starting elevation.\nHold still; tap to capture.";
    return "Head setup: forward pose\nMatch the set heading and elevation.\nHold still; tap to capture.";
  }

  captureNext(): void {
    if (!this.enabled || this.busy || this.active) return;
    const id =
      this.tracker.phase === "up"
        ? "head-up"
        : this.tracker.phase === "right"
          ? "head-right"
          : "head-forward";
    element<HTMLButtonElement>(id).click();
  }

  receive(value: unknown, now: number): void {
    if (!this.enabled) return;
    this.receivedCount++;
    const sample = readMotionSample(value);
    if (!sample) {
      this.rejectedCount++;
      this.changed();
      return;
    }
    const phase = this.tracker.phase;
    const recovering = now - this.tracker.lastSampleAt > MOTION_TIMEOUT_MS;
    if (!this.tracker.receive(sample, now)) return;
    this.samples.push({ ...sample, time: now });
    if (this.samples.length > 600) this.samples.shift();
    if (phase !== this.tracker.phase || (recovering && !this.captureFailed))
      this.status = this.tracker.message;
    this.changed();
  }

  frameSent(duration: number): void {
    this.transferMs = duration;
  }

  async start(): Promise<void> {
    if (this.enabled || this.busy) return;
    const generation = ++this.generation;
    this.busy = true;
    this.status = "Connecting to the G2 motion sensor…";
    this.refresh(performance.now(), true);
    try {
      await this.glasses.connect();
      if (generation !== this.generation) return;
      this.tracker.reset(this.config());
      if (this.controlsYaw || this.tracker.config.format !== "gravity")
        this.angleMode();
      this.samples = [];
      this.receivedCount = this.rejectedCount = 0;
      this.captures = [];
      this.captureFailed = false;
      this.startedAt = performance.now();
      // Some hosts send their first sample before the start acknowledgement.
      this.enabled = true;
      await this.glasses.setMotionEnabled(true);
      if (generation !== this.generation) return;
      this.status = this.samples.length ? this.tracker.message
        : "Sensor requested. Waiting for G2 readings; then hold still and capture the forward pose. Tracking starts after both poses are captured.";
    } catch (error) {
      if (generation !== this.generation) return;
      this.enabled = false;
      this.status = error instanceof Error ? error.message : String(error);
      await this.glasses.setMotionEnabled(false).catch(() => {});
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.refresh(performance.now(), true);
        this.changed();
      }
    }
  }

  async stop(): Promise<void> {
    this.disconnected(
      "Head tracking stopped. Using the last viewing direction.",
    );
    try {
      await this.glasses.setMotionEnabled(false);
    } catch (error) {
      this.status = `Tracking stopped locally. ${String(error)}`;
      this.refresh(performance.now(), true);
    }
  }

  disconnected(
    message = "Motion session ended. Start the sensor and calibrate again.",
  ): void {
    this.beforeReset();
    this.generation++;
    this.enabled = this.busy = false;
    this.captureFailed = false;
    this.tracker.reset(this.config());
    this.status = message;
    this.refresh(performance.now(), true);
    this.changed();
  }

  recalibrate(): void {
    this.beforeReset();
    this.tracker.reset(this.config());
    this.captureFailed = false;
    if (this.controlsYaw) this.angleMode();
    this.status = this.tracker.message;
    this.refresh(performance.now(), true);
    this.changed();
  }

  refresh(now: number, force = false): void {
    this.tracker.expire(now);
    if (!force && now - this.lastRefresh < 100) return;
    this.lastRefresh = now;
    if (
      this.enabled &&
      now - Math.max(this.tracker.lastSampleAt, this.startedAt) >
        MOTION_TIMEOUT_MS
    )
      this.status = !this.receivedCount
        ? "No G2 sensor readings received. Stop and retry, check the G2 connection and Even app version (2.2.10 or later). Location permission does not control this sensor."
        : this.rejectedCount === this.receivedCount
          ? "G2 sensor messages arrived without usable x/y/z readings. Stop and retry the sensor; check the Even app version."
          : "No fresh G2 motion data. Hold still, check the connection, then calibrate again.";
    else if (
      this.enabled &&
      this.tracker.pose &&
      this.tracker.phase === "neutral"
    )
      this.status = this.tracker.message;
    text("head-status", this.status);
    const fresh = now - this.tracker.lastSampleAt <= MOTION_TIMEOUT_MS;
    text("head-state", this.active ? "Tracking" : !this.enabled ? "Off"
      : !fresh ? "Waiting for sensor" : "Calibrating / paused");
    text("head-scope", this.tracker.config.format === "gravity"
      ? "Up / down only. Turning your head left or right does not change direction; use Manual or Phone compass, or swipe to turn 15°."
      : "Experimental up / down + left / right. Requires verified rotation-angle readings and all three calibration poses.");
    element<HTMLButtonElement>("head-start").disabled =
      this.enabled || this.busy;
    element<HTMLButtonElement>("head-stop").disabled =
      !this.enabled && !this.busy;
    element<HTMLButtonElement>("head-forward").disabled =
      !this.enabled || this.busy || !fresh;
    element<HTMLButtonElement>("head-up").disabled =
      !this.enabled || this.busy || !fresh || this.tracker.phase !== "up";
    element<HTMLButtonElement>("head-right").disabled =
      !this.enabled || this.busy || !fresh || this.tracker.phase !== "right";
    element("head-right").hidden = this.tracker.config.format === "gravity";
    element("head-angle-settings").hidden =
      input("head-format").value === "gravity";
    const last = this.samples.at(-1);
    const recent = this.samples.filter((s) => now - s.time <= 2000);
    const hz =
      recent.length > 1
        ? ((recent.length - 1) * 1000) / (recent.at(-1)!.time - recent[0]!.time)
        : 0;
    text("head-sample-rate", `${hz.toFixed(1)} samples/s`);
    text(
      "head-sample-age",
      last
        ? `${Math.round(now - last.time)} ms since reading`
        : "Waiting for readings",
    );
    text(
      "head-transfer",
      this.transferMs == null
        ? "No frame sent yet"
        : `${Math.round(this.transferMs)} ms host transfer`,
    );
    text("head-received", `${this.receivedCount} sensor messages · ${this.rejectedCount} unusable`);
    text(
      "head-raw",
      last
        ? `x ${last.x.toFixed(4)}   y ${last.y.toFixed(4)}   z ${last.z.toFixed(4)}`
        : "x —   y —   z —",
    );
    element<HTMLButtonElement>("head-download").disabled = !this.samples.length;
  }

  private capture(step: string, action: () => void): void {
    if (!this.enabled) return;
    try {
      action();
      this.captureFailed = false;
      this.status = this.tracker.message;
      this.captures.push({
        time: performance.now(),
        step,
        ...this.reference(),
      });
      if (this.captures.length > 100) this.captures.shift();
    } catch (error) {
      this.captureFailed = true;
      this.status = error instanceof Error ? error.message : String(error);
    }
    this.refresh(performance.now(), true);
    this.changed();
  }

  private config(): MotionConfig {
    return {
      format: input("head-format").value as MotionConfig["format"],
      pitchAxis: input("head-pitch-axis").value as Axis,
      yawAxis: input("head-yaw-axis").value as Axis,
      pitchSign: Number(input("head-pitch-sign").value),
      yawSign: Number(input("head-yaw-sign").value),
    };
  }

  private download(): void {
    const first = this.startedAt;
    const report = {
      version: 1,
      sdk: "0.0.15",
      config: this.tracker.config,
      phase: this.tracker.phase,
      lastPose: this.tracker.pose,
      lastHostTransferMs: this.transferMs,
      receivedMessages: this.receivedCount,
      rejectedMessages: this.rejectedCount,
      captures: this.captures.map(({ time, ...capture }) => ({
        elapsedMs: time - first,
        ...capture,
      })),
      note: "Raw, unverified G2 IMU axes. elapsedMs uses the browser's monotonic clock. Host transfer time is not optical latency. No location included.",
      samples: this.samples.map(({ time, ...sample }) => ({
        elapsedMs: time - first,
        ...sample,
      })),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `g2-motion-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
