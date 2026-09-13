import { errorMessage, message, MessageError, type Message } from "./i18n.ts";
import {
  AppLocationAccuracy,
  CreateStartUpPageContainer,
  DeviceConnectType,
  DeviceModel,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ImuReportPace,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { LatestFrameQueue } from "./frame-queue.ts";
import { MotionStream } from "./motion-stream.ts";
import { DISPLAY_HEIGHT, MAP_WIDTH, pngBytes } from "./render.ts";
import { usableHeight, validLocation, type Location } from "./sky.ts";

const TILE_WIDTH = MAP_WIDTH / 2;
const TILE_HEIGHT = DISPLAY_HEIGHT / 2;

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function withTimeout<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function samePixels(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  // ImageData buffers hold whole RGBA pixels: compare 32-bit words, not bytes.
  const wa = new Uint32Array(a.buffer, a.byteOffset, a.length >>> 2);
  const wb = new Uint32Array(b.buffer, b.byteOffset, b.length >>> 2);
  for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) return false;
  for (let i = wa.length << 2; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export type GlassesFrame = {
  image: HTMLCanvasElement;
  force?: boolean;
};
type QueuedFrame = {
  image: HTMLCanvasElement;
  foregroundRevision: number;
};
export type GlassesHooks = {
  onConnected?: () => void;
  onForeground?: () => void;
  onMotion?: (sample: unknown, receivedAt: number) => void;
  onMotionStopped?: (cause: string) => void;
  onFrameSent?: (durationMs: number) => void;
};
export class GlassesDisplay {
  private bridge: EvenAppBridge | null = null;
  private queue: LatestFrameQueue<QueuedFrame> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDevice: (() => void) | null = null;
  private motion: MotionStream | null = null;
  private closingMotion: Promise<void> = Promise.resolve();
  private pixels: (Uint8ClampedArray | undefined)[] = [];
  private snapshots: HTMLCanvasElement[] = [];
  private sendingImage: HTMLCanvasElement | null = null;
  private tile: HTMLCanvasElement | null = null;
  private refreshRequested = 0;
  private refreshSent = 0;
  private connecting: Promise<void> | null = null;
  private creatingPage: Promise<void> = Promise.resolve();
  private bridgeRequest: Promise<EvenAppBridge> | null = null;
  private active = false;
  private inForeground = false;
  private foregroundRevision = 0;
  private generation = 0;
  constructor(
    private onStatus: (status: Message) => void,
    private onGesture: (gesture: "tap" | "left" | "right") => void,
    private hooks: GlassesHooks = {},
    private acquireBridge: () => Promise<EvenAppBridge> = waitForEvenAppBridge,
  ) {}
  get connected(): boolean {
    return this.active;
  }
  get foreground(): boolean {
    return this.active && this.inForeground;
  }
  connect(): Promise<void> {
    if (this.active) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.active = false;
    this.onStatus("Connecting to the Even app…");
    try {
      // Native image, sensor and page-creation calls cannot be cancelled.
      // Drain them before a retry can rebuild the page underneath an old call.
      this.queue?.stop();
      this.closeMotion();
      await withTimeout(
        Promise.all([this.queue?.idle(), this.closingMotion, this.creatingPage]),
        4000,
        "The previous G2 session is still waiting for the Even app. Check the connection, then retry Connect G2 or reopen the app.",
      );
      if (generation !== this.generation) return;
      const bridge = await withTimeout(
        this.awaitBridge(),
        6000,
        "Open this app through Even Hub in the Even app. A regular browser provides a preview.",
      );
      if (generation !== this.generation) return;
      this.bridge = bridge;
      this.pixels = [];
      // Subscribe before asking the host to create the page. An exit or a
      // disconnect can arrive while its acknowledgement is still pending.
      // Assume foreground only until an event supplies the actual state.
      this.inForeground = true;
      this.unsubscribe?.();
      this.unsubscribe = bridge.onEvenHubEvent((event) => {
        if (generation !== this.generation) return;
        if (event.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
          if (this.motion?.accepting)
            this.hooks.onMotion?.(event.sysEvent.imuData, performance.now());
          return;
        }
        if (
          event.sysEvent?.eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT
        ) {
          this.inForeground = true;
          this.pixels = [];
          // A transfer already in flight must not acknowledge this refresh.
          this.refreshRequested++;
          this.hooks.onForeground?.();
          return;
        }
        if (
          event.sysEvent?.eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT
        ) {
          this.inForeground = false;
          // Invalidate both the in-flight transfer and any waiting snapshot.
          // Their late results must not stop or acknowledge the resumed session.
          this.foregroundRevision++;
          void this.setMotionEnabled(false).catch((error) =>
            this.onStatus(errorMessage(error)),
          );
          this.hooks.onMotionStopped?.("G2 left the foreground");
          return;
        }
        // CLICK_EVENT is 0: do not discard it with a truthiness check.
        const type =
          event.sysEvent?.eventType ??
          event.textEvent?.eventType ??
          event.listEvent?.eventType;
        if (
          type === OsEventTypeList.SYSTEM_EXIT_EVENT ||
          type === OsEventTypeList.ABNORMAL_EXIT_EVENT
        ) {
          const abnormal = type === OsEventTypeList.ABNORMAL_EXIT_EVENT;
          this.stop(abnormal ? "G2 display closed unexpectedly" : "G2 display closed");
          this.onStatus(abnormal
            ? "G2 display closed unexpectedly. Reconnect to resume."
            : "G2 display closed.");
          return;
        }
        // Lifecycle events matter during startup; gestures require a ready page.
        if (!this.foreground) return;
        if (type === OsEventTypeList.CLICK_EVENT) this.onGesture("tap");
        else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
          void bridge
            .shutDownPageContainer(1)
            .catch((error) =>
              this.onStatus(message("Could not open the exit dialog. {0}", errorMessage(error))),
            );
        } else if (type === OsEventTypeList.SCROLL_TOP_EVENT)
          this.onGesture("left");
        else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT)
          this.onGesture("right");
      });
      this.unsubscribeDevice?.();
      let glassesSn: string | undefined;
      this.unsubscribeDevice = bridge.onDeviceStatusChanged((status) => {
        // Status events have no model. Until the G2 SN is known, accept
        // disconnects conservatively instead of missing a lost glasses link.
        if (
          generation !== this.generation ||
          (glassesSn && status.sn !== glassesSn)
        )
          return;
        if (
          status.connectType === DeviceConnectType.Disconnected ||
          status.connectType === DeviceConnectType.ConnectionFailed
        ) {
          this.stop("G2 disconnected");
          this.onStatus("G2 disconnected. Reconnect to resume.");
        }
      });
      const creation = bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: 5,
          textObject: [
            new TextContainerProperty({
              containerID: 1,
              containerName: "sky-events",
              xPosition: 0,
              yPosition: 0,
              width: MAP_WIDTH,
              height: DISPLAY_HEIGHT,
              content: "",
              borderWidth: 0,
              paddingLength: 0,
              isEventCapture: 1,
              zOrderIndex: 0,
            }),
          ],
          // The four front tiles cover the blank event container completely.
          // Gestures still use its single isEventCapture target.
          imageObject: Array.from({ length: 4 }, (_, i) =>
            new ImageContainerProperty({
              containerID: 2 + i,
              containerName: `sky-tile-${i}`,
              xPosition: (i % 2) * TILE_WIDTH,
              yPosition: Math.floor(i / 2) * TILE_HEIGHT,
              width: TILE_WIDTH,
              height: TILE_HEIGHT,
              zOrderIndex: i + 1,
            }),
          ),
        }),
      );
      // Retain the native operation after a timeout so retries cannot overlap it.
      this.creatingPage = creation.then(() => {}, () => {});
      const result = await withTimeout(
        creation,
        6000,
        "The Even app did not finish creating the G2 display in time. Check the connection, then retry Connect G2 or reopen the app.",
      );
      if (generation !== this.generation) return;
      if (result !== StartUpPageCreateResult.success)
        throw new MessageError(
          message("Could not create the G2 display ({0}). Open this app through Even Hub and check the glasses connection.", String(result)),
        );
      this.motion = new MotionStream((enabled) =>
        bridge.imuControl(enabled, ImuReportPace.P100),
      );
      void bridge
        .getDeviceInfo()
        .then((info) => {
          if (generation !== this.generation) return;
          if (info?.model === DeviceModel.G2) glassesSn = info.sn;
        })
        .catch(() => {});
      if (generation !== this.generation) return;
      this.active = true;
      this.queue?.stop();
      this.queue = new LatestFrameQueue(
        (frame) => {
          this.sendingImage = frame.image;
          return this.send(frame, generation)
            .catch((error) => {
              if (this.canSend(generation, frame.foregroundRevision)) throw error;
            })
            .finally(() => {
              this.sendingImage = null;
            });
        },
        (error) => {
          if (generation !== this.generation) return;
          this.stop("G2 updates stopped");
          this.onStatus(
            message("G2 updates stopped. Please reconnect. {0}", errorMessage(error)),
          );
        },
      );
      this.onStatus("Connected to G2.");
      this.hooks.onConnected?.();
    } catch (error) {
      if (generation !== this.generation) return;
      // Failed startup must not retain subscriptions or accept late events.
      this.generation++;
      this.active = false;
      this.inForeground = false;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.unsubscribeDevice?.();
      this.unsubscribeDevice = null;
      this.onStatus(errorMessage(error));
      throw error;
    }
  }
  /**
   * The SDK's bridge wait registers a listener it never removes. Share one
   * pending request so repeated Connect attempts in a plain browser do not
   * accumulate listeners; a settled request is dropped so a later connect
   * still sees the host's current bridge.
   */
  private awaitBridge(): Promise<EvenAppBridge> {
    this.bridgeRequest ??= this.acquireBridge().finally(() => {
      this.bridgeRequest = null;
    });
    return this.bridgeRequest;
  }
  async setMotionEnabled(enabled: boolean): Promise<void> {
    if (!this.active || !this.motion) {
      if (enabled)
        throw new Error("Connect G2 before starting its motion sensor.");
      return;
    }
    if (enabled && !this.inForeground)
      throw new Error("Return to the G2 foreground before starting its motion sensor.");
    await this.motion.setEnabled(enabled);
  }
  async location(): Promise<Location | null> {
    if (!this.bridge) return null;
    const fix = await withTimeout(
      this.bridge.getAppLocation({
        accuracy: AppLocationAccuracy.High,
        timeoutMs: 8000,
      }),
      8000,
      "The Even app did not return a location in time.",
    );
    if (!fix) return null;
    const location = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      height: usableHeight(fix.altitude),
    };
    return validLocation(location) ? location : null;
  }
  submit(frame: GlassesFrame): void {
    if (!this.foreground || !this.queue) return;
    // Preserve a refresh request even if a newer sensor frame replaces the
    // waiting frame while the native transfer is busy.
    if (frame.force) this.refreshRequested++;
    // Keep the sending snapshot immutable and reuse the other buffer for the
    // latest waiting frame. The preview can change during a native transfer.
    let image = this.snapshots.find((canvas) => canvas !== this.sendingImage);
    if (!image) {
      image = createCanvas(MAP_WIDTH, DISPLAY_HEIGHT);
      this.snapshots.push(image);
    }
    const context = image.getContext("2d")!;
    context.clearRect(0, 0, MAP_WIDTH, DISPLAY_HEIGHT);
    context.drawImage(frame.image, 0, 0);
    this.queue.submit({ image, foregroundRevision: this.foregroundRevision });
  }
  private canSend(generation: number, foregroundRevision: number): boolean {
    return this.foreground && generation === this.generation &&
      foregroundRevision === this.foregroundRevision;
  }
  private async send(frame: QueuedFrame, generation: number): Promise<void> {
    const bridge = this.bridge!;
    const refresh = this.refreshRequested;
    const force = refresh !== this.refreshSent;
    const cachedPixels = this.pixels;
    const startedAt = performance.now();
    const tile = this.tile ??= createCanvas(TILE_WIDTH, TILE_HEIGHT);
    const context = tile.getContext("2d")!;
    for (let i = 0; i < 4; i++) {
      if (!this.canSend(generation, frame.foregroundRevision)) return;
      context.clearRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
      context.drawImage(
        frame.image,
        (i % 2) * TILE_WIDTH,
        Math.floor(i / 2) * TILE_HEIGHT,
        TILE_WIDTH,
        TILE_HEIGHT,
        0,
        0,
        TILE_WIDTH,
        TILE_HEIGHT,
      );
      const pixels = context.getImageData(0, 0, TILE_WIDTH, TILE_HEIGHT).data;
      const previous = cachedPixels[i];
      if (
        !force && previous &&
        samePixels(pixels, previous)
      )
        continue;
      const imageData = await pngBytes(tile);
      if (!this.canSend(generation, frame.foregroundRevision)) return;
      let failure = await this.sendTile(bridge, i, imageData);
      if (!this.canSend(generation, frame.foregroundRevision)) return;
      if (failure) {
        // One rejected tile must not end the session and head tracking. A
        // second failure in a row still does, so a dead link is not hidden.
        this.onStatus(message("Retrying a sky-map tile. {0}", failure));
        failure = await this.sendTile(bridge, i, imageData);
        if (!this.canSend(generation, frame.foregroundRevision)) return;
      }
      if (failure) throw new MessageError(failure);
      cachedPixels[i] = pixels;
    }
    // This acknowledgement confirms acceptance by the host, not optical delivery.
    if (this.canSend(generation, frame.foregroundRevision)) {
      this.refreshSent = refresh;
      this.hooks.onFrameSent?.(performance.now() - startedAt);
      this.onStatus("Sky map sent to G2.");
    }
  }
  /** Send one tile; resolve with null on success or with the failure text. */
  private async sendTile(
    bridge: EvenAppBridge,
    index: number,
    imageData: Uint8Array,
  ): Promise<Message | null> {
    try {
      const result = await bridge.updateImageRawData(
        new ImageRawDataUpdate({
          containerID: 2 + index,
          containerName: `sky-tile-${index}`,
          imageData,
        }),
      );
      return result === ImageRawDataUpdateResult.success
        ? null
        : message("Could not send the sky map ({0}).", String(result));
    } catch (error) {
      return errorMessage(error);
    }
  }
  stop(cause = "G2 session stopped"): void {
    this.generation++;
    this.active = false;
    this.inForeground = false;
    this.queue?.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeDevice?.();
    this.unsubscribeDevice = null;
    this.closeMotion();
    this.hooks.onMotionStopped?.(cause);
  }
  private closeMotion(): void {
    if (this.motion) {
      this.closingMotion = this.motion.close().catch(() => {
        // The link may already be gone. Reconnection creates a fresh sensor session.
      });
      this.motion = null;
    }
  }
}
