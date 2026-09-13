import { element, text } from "./dom.ts";
import { errorMessage, message, t, type Message } from "./i18n.ts";
import {
  HeadTracker,
  MOTION_TIMEOUT_MS,
  readMotionSample,
  usableReading,
  type CaptureDetail,
  type TimedMotionSample,
} from "./head-tracking.ts";
import type { GlassesDisplay } from "./glasses.ts";
import type { NorthReference } from "./compass.ts";
import { dependencies, version } from "../package.json";

type HeadReference = { heading: number; pitch: number; northReference: NorthReference };
/** A received reading. Dropout frames stay in the log but are marked unusable. */
type LoggedSample = TimedMotionSample & { unusable?: true };
type ExportedSample = { elapsedMs: number; x: number; y: number; z: number; unusable?: true };
type SessionEvent = { time: number; event: string } & Record<string, unknown>;
type Capture = { time: number; step: string; recent: ExportedSample[] } &
  HeadReference &
  CaptureDetail;
/** About five minutes at the observed ten readings per second. */
const SAMPLE_LIMIT = 3000;
const CAPTURE_LIMIT = 100;
const EVENT_LIMIT = 200;

/** The live sensor session and calibration UI. No simulated input enters this path. */
export class HeadControls {
  readonly tracker = new HeadTracker();
  enabled = false;
  private generation = 0;
  private busy = false;
  private startedAt = 0;
  private samples: LoggedSample[] = [];
  private captures: Capture[] = [];
  private events: SessionEvent[] = [];
  private lastRefresh = -Infinity;
  private transferMs: number | null = null;
  private captureFailed = false;
  private exporting = false;
  private receivedCount = 0;
  private rejectedCount = 0;
  private ignoredCount = 0;
  private referencePose: HeadReference | null = null;
  private status: Message =
    "Start the G2 sensor, then calibrate while wearing your glasses.";
  constructor(
    private glasses: GlassesDisplay,
    private reference: () => HeadReference,
    private changed: () => void,
    private beforeReset: () => void,
  ) {
    element("head-start").onclick = () => void this.start();
    element("head-stop").onclick = () => void this.stop();
    element("align-direction").onclick = () =>
      this.capture("forward", (now) => {
        this.beforeReset();
        const reference = this.reference();
        const detail = this.tracker.captureForward(reference.pitch, now);
        this.referencePose = reference;
        return detail;
      });
    element("head-up").onclick = () =>
      this.capture("up", (now) => this.tracker.captureUp(now));
    element("head-realign").onclick = () => this.recalibrate();
    element("head-download").onclick = () => void this.download();
    element("head-copy").onclick = () => void this.copyLog();
    this.refresh(performance.now(), true);
  }
  get pose() {
    return this.enabled ? this.tracker.pose : null;
  }
  get active() {
    return this.enabled && this.tracker.phase === "tracking";
  }
  get glassesHint(): string | undefined {
    if (!this.enabled || this.active) return;
    if (performance.now() - this.tracker.lastSampleAt > MOTION_TIMEOUT_MS)
      return t("Waiting for G2 sensor readings\nCheck the sensor status on your phone.\nCalibration needs live readings.");
    if (this.captureFailed)
      return t("Pose not captured\nHold still and try the tap again.\nCheck the phone for calibration details.");
    if (this.tracker.phase === "up")
      return t("Head setup: look up 20–40°\nKeep your head level sideways.\nHold still; tap to capture.");
    return t("Set your direction reference\nFace the selected heading and elevation.\nHold still; tap to set the reference.");
  }

  captureNext(): void {
    if (!this.enabled || this.busy || this.active) return;
    const id =
      this.tracker.phase === "up"
        ? "head-up"
        : "align-direction";
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
    if (!usableReading(sample)) {
      // A dropout frame: keep it in the log, out of calibration and tracking.
      this.rejectedCount++;
      this.record({ ...sample, time: now, unusable: true });
      this.changed();
      return;
    }
    const phase = this.tracker.phase;
    const recovering = now - this.tracker.lastSampleAt > MOTION_TIMEOUT_MS;
    const ignored = this.tracker.ignored;
    if (!this.tracker.accept(sample, now)) {
      // Only a clock running backwards is refused; keep received = kept + unusable.
      this.rejectedCount++;
      this.changed();
      return;
    }
    if (this.tracker.ignored !== ignored) this.ignoredCount++;
    this.record({ ...sample, time: now });
    if (!this.settle(phase, now) && recovering && !this.captureFailed)
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
      this.tracker.reset();
      this.referencePose = null;
      this.samples = [];
      this.captures = [];
      this.events = [];
      this.receivedCount = this.rejectedCount = this.ignoredCount = 0;
      this.captureFailed = false;
      this.startedAt = performance.now();
      // Some hosts send their first sample before the start acknowledgement.
      this.enabled = true;
      await this.glasses.setMotionEnabled(true);
      if (generation !== this.generation) return;
      this.note(performance.now(), "sensor-started");
      this.status = this.samples.length ? this.tracker.message
        : "Waiting for G2 readings. Face the selected heading and elevation, then select Use this direction as reference. Tracking starts after the upward tilt is also captured.";
    } catch (error) {
      if (generation !== this.generation) return;
      this.enabled = false;
      this.status = errorMessage(error);
      this.note(performance.now(), "sensor-start-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
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
    const generation = this.generation;
    try {
      await this.glasses.setMotionEnabled(false);
    } catch (error) {
      if (generation !== this.generation) return;
      this.status = message("Tracking stopped locally. {0}", errorMessage(error));
      this.refresh(performance.now(), true);
    }
  }

  disconnected(
    message: Message = "Motion session ended. Start the sensor and calibrate again.",
    cause = "Stop selected",
  ): void {
    if (!this.enabled && !this.busy) return;
    this.note(performance.now(), "ended", { cause, phase: this.tracker.phase });
    this.beforeReset();
    this.generation++;
    this.enabled = this.busy = false;
    this.captureFailed = false;
    this.tracker.reset();
    this.referencePose = null;
    this.status = message;
    this.refresh(performance.now(), true);
    this.changed();
  }

  recalibrate(): void {
    if (!this.enabled || this.busy) return;
    this.note(performance.now(), "realign", { phase: this.tracker.phase });
    this.beforeReset();
    this.tracker.reset();
    this.referencePose = null;
    this.captureFailed = false;
    this.status = "Face your new direction. Set the heading and elevation above, then use this direction as reference.";
    this.refresh(performance.now(), true);
    this.changed();
  }

  refresh(now: number, force = false): void {
    const phase = this.tracker.phase;
    this.tracker.expire(now);
    this.settle(phase, now);
    if (!force && now - this.lastRefresh < 100) return;
    this.lastRefresh = now;
    if (
      this.enabled &&
      !this.captureFailed &&
      now - Math.max(this.tracker.lastSampleAt, this.startedAt) >
        MOTION_TIMEOUT_MS
    )
      this.status = !this.receivedCount
        ? "No G2 sensor readings received. Stop and retry, check the G2 connection and Even app version (2.2.10 or later). Location permission does not control this sensor."
        : this.rejectedCount === this.receivedCount
          ? "G2 sensor messages arrived without usable x/y/z readings. Stop and retry the sensor; check the Even app version."
          : "No fresh G2 motion data. Hold still, check the connection, then calibrate again.";
    text("head-status", this.status);
    const fresh = now - this.tracker.lastSampleAt <= MOTION_TIMEOUT_MS;
    text("head-state", this.active ? "Tracking" : !this.enabled ? "Off"
      : !fresh ? "Waiting for sensor" : "Calibrating / paused");
    text("head-reference", this.referencePose
      ? message("{0}: {1}° {2} north · elevation {3}°",
        this.tracker.phase === "neutral" ? "Previous reference (paused)" : "Calibration reference",
        Math.round(this.referencePose.heading), this.referencePose.northReference,
        Math.round(this.referencePose.pitch))
      : "No reference set. Face the selected heading and elevation.");
    element<HTMLButtonElement>("head-start").disabled =
      this.enabled || this.busy;
    element<HTMLButtonElement>("head-stop").disabled =
      !this.enabled && !this.busy;
    element<HTMLButtonElement>("align-direction").disabled =
      !this.enabled || this.busy || !fresh;
    element<HTMLButtonElement>("head-up").disabled =
      !this.enabled || this.busy || !fresh || this.tracker.phase !== "up";
    element<HTMLButtonElement>("head-realign").disabled =
      !this.enabled || this.busy || (!this.referencePose && !this.pose);
    const last = this.samples.at(-1);
    const recent = this.samples.filter((s) => now - s.time <= 2000);
    const span = recent.length > 1 ? recent.at(-1)!.time - recent[0]!.time : 0;
    const hz = span > 0 ? ((recent.length - 1) * 1000) / span : 0;
    text("head-sample-rate", message("{0} samples/s", hz.toFixed(1)));
    text(
      "head-sample-age",
      last
        ? message("{0} ms since reading", Math.round(now - last.time))
        : "Waiting for readings",
    );
    text(
      "head-transfer",
      this.transferMs == null
        ? "No frame sent yet"
        : message("{0} ms host transfer", Math.round(this.transferMs)),
    );
    text(
      "head-received",
      message("{0} sensor messages · {1} unusable · {2} ignored as acceleration", this.receivedCount, this.rejectedCount, this.ignoredCount),
    );
    text(
      "head-raw",
      last
        ? `x ${last.x.toFixed(4)}   y ${last.y.toFixed(4)}   z ${last.z.toFixed(4)}`
        : "x —   y —   z —",
    );
    element<HTMLButtonElement>("head-download").disabled =
      !this.samples.length || this.exporting;
  }

  /** Adopt the tracker's message after a phase change; log a pause nobody requested. */
  private settle(before: HeadTracker["phase"], now: number): boolean {
    if (before === this.tracker.phase) return false;
    this.captureFailed = false;
    this.status = this.tracker.message;
    if (this.tracker.phase === "neutral")
      this.note(now, "paused", { from: before, message: this.tracker.message });
    return true;
  }

  private record(sample: LoggedSample): void {
    this.samples.push(sample);
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
  }

  private note(time: number, event: string, detail: Record<string, unknown> = {}): void {
    this.events.push({ time, event, ...detail });
    if (this.events.length > EVENT_LIMIT) this.events.shift();
  }

  private elapsed(time: number): number {
    // Whole microseconds: performance.now() differences carry float noise.
    return Math.round((time - this.startedAt) * 1000) / 1000;
  }

  private serialize({ time, ...sample }: LoggedSample): ExportedSample {
    return { elapsedMs: this.elapsed(time), ...sample };
  }

  /** The second of readings before a tap, as the log shows them. */
  private recent(now: number): ExportedSample[] {
    return this.samples
      .filter((s) => now - s.time <= 1000)
      .map((s) => this.serialize(s));
  }

  private capture(step: string, action: (now: number) => CaptureDetail): void {
    if (!this.enabled) return;
    const now = performance.now();
    const recent = this.recent(now);
    try {
      const detail = action(now);
      this.captureFailed = false;
      this.status = this.tracker.message;
      this.captures.push({ time: now, step, ...this.reference(), ...detail, recent });
      if (this.captures.length > CAPTURE_LIMIT) this.captures.shift();
    } catch (error) {
      this.captureFailed = true;
      this.status = errorMessage(error);
      this.note(now, "capture-failed", { step, message: this.status, recent });
    }
    this.refresh(now, true);
    this.changed();
  }

  private async download(): Promise<void> {
    if (!this.samples.length || this.exporting) return;
    const report = {
      version: 3,
      appVersion: version,
      sdk: dependencies["@evenrealities/even_hub_sdk"],
      config: { format: "gravity" },
      enabled: this.enabled,
      exportedAtMs: this.elapsed(performance.now()),
      reference: this.referencePose,
      phase: this.tracker.phase,
      lastPose: this.tracker.pose,
      lastHostTransferMs: this.transferMs,
      receivedMessages: this.receivedCount,
      rejectedMessages: this.rejectedCount,
      ignoredAsAcceleration: this.ignoredCount,
      captures: this.captures.map(({ time, ...capture }) => ({
        elapsedMs: this.elapsed(time),
        ...capture,
      })),
      events: this.events.map(({ time, ...event }) => ({
        elapsedMs: this.elapsed(time),
        ...event,
      })),
      note: "Raw, unverified G2 IMU axes. elapsedMs uses the browser's monotonic clock from sensor start. Readings marked unusable were logged but kept out of calibration and tracking. Host transfer time is not optical latency. No location included.",
      samples: this.samples.map((sample) => this.serialize(sample)),
    };
    const json = JSON.stringify(report, null, 2);
    const filename = `g2-motion-${new Date().toISOString().replaceAll(":", "-")}.json`;
    // Some embedded views silently ignore downloads. Keep a selectable snapshot
    // even when sharing or the clipboard is unavailable in the host.
    element<HTMLTextAreaElement>("head-log").value = json;
    element("head-log-panel").hidden = false;
    this.exporting = true;
    this.refresh(performance.now(), true);
    text("head-log-status", "Preparing sensor log…");
    try {
      const file = new File([json], filename, { type: "application/json" });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: t("G2 sensor log") });
          text("head-log-status", "Sensor log shared. A copy is also available below.");
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            text("head-log-status", "Sharing cancelled. You can still copy the log below.");
            return;
          }
        }
      }
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      try {
        link.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      text("head-log-status", "Download requested. If no file appears, copy the log below.");
    } catch {
      text("head-log-status", "Could not save a file in this view. Copy the log below.");
    } finally {
      this.exporting = false;
      this.refresh(performance.now(), true);
    }
  }

  private async copyLog(): Promise<void> {
    const log = element<HTMLTextAreaElement>("head-log");
    log.focus();
    log.select();
    try {
      await navigator.clipboard.writeText(log.value);
      text("head-log-status", "Sensor log copied.");
    } catch {
      text("head-log-status", "Select and copy the text below using your device's Copy command.");
    }
  }
}
