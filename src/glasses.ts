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
import { DISPLAY_HEIGHT, MAP_HEIGHT, MAP_WIDTH, pngBytes } from "./render.ts";
import { validLocation, type Location } from "./sky.ts";

const TILE_WIDTH = MAP_WIDTH / 2;

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
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) return false;
  return true;
}

export type GlassesFrame = {
  image: HTMLCanvasElement;
  force?: boolean;
};
export type GlassesHooks = {
  onConnected?: () => void;
  onMotion?: (sample: unknown, receivedAt: number) => void;
  onMotionStopped?: () => void;
  onFrameSent?: (durationMs: number) => void;
};
export class GlassesDisplay {
  private bridge: EvenAppBridge | null = null;
  private queue: LatestFrameQueue<GlassesFrame> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDevice: (() => void) | null = null;
  private motion: MotionStream | null = null;
  private closingMotion: Promise<void> = Promise.resolve();
  private pixels: (Uint8ClampedArray | undefined)[] = [];
  private refreshRequested = 0;
  private refreshSent = 0;
  private connecting: Promise<void> | null = null;
  private active = false;
  private generation = 0;
  constructor(
    private onStatus: (status: string) => void,
    private onGesture: (gesture: "tap" | "left" | "right") => void,
    private hooks: GlassesHooks = {},
    private acquireBridge: () => Promise<EvenAppBridge> = waitForEvenAppBridge,
  ) {}
  get connected(): boolean {
    return this.active;
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
      // A stopped queue may still have an in-flight native image call. Drain it
      // before rebuilding the page so a reconnect never overlaps image sends.
      this.queue?.stop();
      if (this.motion) {
        this.closingMotion = this.motion.close();
        this.motion = null;
      }
      await withTimeout(
        Promise.all([this.queue?.idle(), this.closingMotion]),
        4000,
        "The previous G2 session is still waiting for the Even app. Check the connection, then retry Connect G2 or reopen the app.",
      );
      if (generation !== this.generation) return;
      const bridge = await withTimeout(
        this.acquireBridge(),
        6000,
        "Open this app through Even Hub in the Even app. A regular browser provides a preview.",
      );
      if (generation !== this.generation) return;
      this.bridge = bridge;
      this.pixels = [];
      const result = await bridge.createStartUpPageContainer(
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
              yPosition: Math.floor(i / 2) * MAP_HEIGHT,
              width: TILE_WIDTH,
              height: MAP_HEIGHT,
              zOrderIndex: i + 1,
            }),
          ),
        }),
      );
      if (generation !== this.generation) return;
      if (result !== StartUpPageCreateResult.success)
        throw new Error(
          `Could not create the G2 display (${result}). Open this app through Even Hub and check the glasses connection.`,
        );
      this.unsubscribe?.();
      this.motion = new MotionStream((enabled) =>
        bridge.imuControl(enabled, ImuReportPace.P100),
      );
      this.unsubscribe = bridge.onEvenHubEvent((event) => {
        if (generation !== this.generation) return;
        if (event.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
          if (this.motion?.accepting)
            this.hooks.onMotion?.(event.sysEvent.imuData, performance.now());
          return;
        }
        if (
          event.sysEvent?.eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT
        ) {
          void this.setMotionEnabled(false).catch((error) =>
            this.onStatus(String(error)),
          );
          this.hooks.onMotionStopped?.();
          return;
        }
        // CLICK_EVENT is 0: do not discard it with a truthiness check.
        const type =
          event.sysEvent?.eventType ??
          event.textEvent?.eventType ??
          event.listEvent?.eventType;
        if (type === OsEventTypeList.CLICK_EVENT) this.onGesture("tap");
        else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
          void bridge
            .shutDownPageContainer(1)
            .catch((error) =>
              this.onStatus(`Could not open the exit dialog. ${String(error)}`),
            );
        } else if (type === OsEventTypeList.SYSTEM_EXIT_EVENT) {
          this.stop();
          this.onStatus("G2 display closed.");
        } else if (type === OsEventTypeList.SCROLL_TOP_EVENT)
          this.onGesture("left");
        else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT)
          this.onGesture("right");
      });
      this.unsubscribeDevice?.();
      let glassesSn: string | undefined;
      void bridge
        .getDeviceInfo()
        .then((info) => {
          if (info?.model === DeviceModel.G2) glassesSn = info.sn;
        })
        .catch(() => {});
      this.unsubscribeDevice = bridge.onDeviceStatusChanged((status) => {
        if (
          generation !== this.generation ||
          !glassesSn ||
          status.sn !== glassesSn
        )
          return;
        if (
          status.connectType === DeviceConnectType.Disconnected ||
          status.connectType === DeviceConnectType.ConnectionFailed
        ) {
          this.stop();
          this.onStatus("G2 disconnected. Reconnect to resume.");
        }
      });
      this.active = true;
      this.queue?.stop();
      this.queue = new LatestFrameQueue(
        (frame) => this.send(frame, generation),
        (error) => {
          if (generation !== this.generation) return;
          this.stop();
          this.onStatus(
            `G2 updates stopped. Please reconnect. ${error instanceof Error ? error.message : ""}`,
          );
        },
      );
      this.onStatus("Connected to G2.");
      this.hooks.onConnected?.();
    } catch (error) {
      if (generation !== this.generation) return;
      this.active = false;
      this.onStatus(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  async setMotionEnabled(enabled: boolean): Promise<void> {
    if (!this.active || !this.motion) {
      if (enabled)
        throw new Error("Connect G2 before starting its motion sensor.");
      return;
    }
    await this.motion.setEnabled(enabled);
  }
  async location(): Promise<Location | null> {
    if (!this.bridge) return null;
    const fix = await this.bridge.getAppLocation({
      accuracy: AppLocationAccuracy.High,
      timeoutMs: 8000,
    });
    if (!fix) return null;
    const location = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      height: fix.altitude ?? 0,
    };
    return validLocation(location) ? location : null;
  }
  submit(frame: GlassesFrame): void {
    if (!this.active) return;
    // Preserve a refresh request even if a newer sensor frame replaces the
    // waiting frame while the native transfer is busy.
    if (frame.force) this.refreshRequested++;
    // Snapshot before queueing; the preview canvas is reused by the next compass update.
    const image = document.createElement("canvas");
    image.width = MAP_WIDTH;
    image.height = DISPLAY_HEIGHT;
    image.getContext("2d")!.drawImage(frame.image, 0, 0);
    this.queue?.submit({ ...frame, image });
  }
  private async send(frame: GlassesFrame, generation: number): Promise<void> {
    const bridge = this.bridge!;
    const refresh = this.refreshRequested;
    const force = refresh !== this.refreshSent;
    const startedAt = performance.now();
    const tile = document.createElement("canvas");
    tile.width = TILE_WIDTH;
    tile.height = MAP_HEIGHT;
    for (let i = 0; i < 4; i++) {
      if (!this.active || generation !== this.generation) return;
      tile
        .getContext("2d")!
        .drawImage(
          frame.image,
          (i % 2) * TILE_WIDTH,
          Math.floor(i / 2) * MAP_HEIGHT,
          TILE_WIDTH,
          MAP_HEIGHT,
          0,
          0,
          TILE_WIDTH,
          MAP_HEIGHT,
        );
      const pixels = tile
        .getContext("2d")!
        .getImageData(0, 0, TILE_WIDTH, MAP_HEIGHT).data;
      const previous = this.pixels[i];
      if (
        !force && previous &&
        samePixels(pixels, previous)
      )
        continue;
      const result = await bridge.updateImageRawData(
        new ImageRawDataUpdate({
          containerID: 2 + i,
          containerName: `sky-tile-${i}`,
          imageData: await pngBytes(tile),
        }),
      );
      if (result !== ImageRawDataUpdateResult.success)
        throw new Error(`Could not send the sky map (${result}).`);
      this.pixels[i] = pixels;
    }
    // This acknowledgement confirms acceptance by the host, not optical delivery.
    if (this.active && generation === this.generation) {
      this.refreshSent = refresh;
      this.hooks.onFrameSent?.(performance.now() - startedAt);
      this.onStatus("Sky map sent to G2.");
    }
  }
  stop(): void {
    this.generation++;
    this.active = false;
    this.queue?.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeDevice?.();
    this.unsubscribeDevice = null;
    if (this.motion) {
      this.closingMotion = this.motion.close().catch(() => {
        // The link may already be gone. Reconnection creates a fresh sensor session.
      });
      this.motion = null;
    }
    this.hooks.onMotionStopped?.();
  }
}
