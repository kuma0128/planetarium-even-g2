import {
  AppLocationAccuracy,
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { LatestFrameQueue } from "./frame-queue.ts";
import { MAP_HEIGHT, MAP_WIDTH, pngBytes } from "./render.ts";
import { validLocation, type Location } from "./sky.ts";

const TILE_WIDTH = MAP_WIDTH / 2;

export type GlassesFrame = {
  header: string;
  footer: string;
  image: HTMLCanvasElement;
};
export class GlassesDisplay {
  private bridge: EvenAppBridge | null = null;
  private queue: LatestFrameQueue<GlassesFrame> | null = null;
  private unsubscribe: (() => void) | null = null;
  private connecting: Promise<void> | null = null;
  private active = false;
  private generation = 0;
  constructor(
    private onStatus: (status: string) => void,
    private onGesture: (gesture: "tap" | "left" | "right") => void,
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A stopped queue may still have an in-flight native image call. Drain it
      // before rebuilding the page so a reconnect never overlaps image sends.
      this.queue?.stop();
      await this.queue?.idle();
      if (generation !== this.generation) return;
      const bridge = await Promise.race([
        waitForEvenAppBridge(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Open this app through Even Hub in the Even app. A regular browser provides a preview.",
                ),
              ),
            6000,
          );
        }),
      ]);
      if (generation !== this.generation) return;
      this.bridge = bridge;
      const result = await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: 4,
          textObject: [
            new TextContainerProperty({
              containerID: 1,
              containerName: "sky-header",
              xPosition: 0,
              yPosition: 0,
              width: MAP_WIDTH,
              height: 48,
              content: "G2 Planetarium",
              isEventCapture: 1,
            }),
            new TextContainerProperty({
              containerID: 2,
              containerName: "sky-footer",
              xPosition: 0,
              yPosition: 202,
              width: MAP_WIDTH,
              height: 86,
              content: "Set your location and heading",
              isEventCapture: 0,
            }),
          ],
          imageObject: [
            new ImageContainerProperty({
              containerID: 3,
              containerName: "sky-left",
              xPosition: 0,
              yPosition: 54,
              width: TILE_WIDTH,
              height: MAP_HEIGHT,
            }),
            new ImageContainerProperty({
              containerID: 4,
              containerName: "sky-right",
              xPosition: TILE_WIDTH,
              yPosition: 54,
              width: TILE_WIDTH,
              height: MAP_HEIGHT,
            }),
          ],
        }),
      );
      if (generation !== this.generation) return;
      if (result !== StartUpPageCreateResult.success)
        throw new Error(
          `Could not create the G2 display (${result}). Open this app through Even Hub and check the glasses connection.`,
        );
      this.unsubscribe?.();
      this.unsubscribe = bridge.onEvenHubEvent((event) => {
        if (generation !== this.generation) return;
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
      this.active = true;
      this.queue?.stop();
      this.queue = new LatestFrameQueue(
        (frame) => this.send(frame, generation),
        (error) => {
          if (generation !== this.generation) return;
          this.active = false;
          this.unsubscribe?.();
          this.unsubscribe = null;
          this.onStatus(
            `G2 updates stopped. Please reconnect. ${error instanceof Error ? error.message : ""}`,
          );
        },
      );
      this.onStatus("Connected to G2.");
    } catch (error) {
      if (generation !== this.generation) return;
      this.active = false;
      this.onStatus(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
    // Snapshot before queueing; the preview canvas is reused by the next compass update.
    const image = document.createElement("canvas");
    image.width = MAP_WIDTH;
    image.height = MAP_HEIGHT;
    image.getContext("2d")!.drawImage(frame.image, 0, 0);
    this.queue?.submit({ ...frame, image });
  }
  private async send(frame: GlassesFrame, generation: number): Promise<void> {
    const bridge = this.bridge!;
    for (const [containerID, containerName, content] of [
      [1, "sky-header", frame.header],
      [2, "sky-footer", frame.footer],
    ] as const) {
      if (!this.active || generation !== this.generation) return;
      const ok = await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID, containerName, content }),
      );
      if (!ok) throw new Error("Could not send the display captions.");
    }
    const tile = document.createElement("canvas");
    tile.width = TILE_WIDTH;
    tile.height = MAP_HEIGHT;
    for (let i = 0; i < 2; i++) {
      if (!this.active || generation !== this.generation) return;
      tile
        .getContext("2d")!
        .drawImage(
          frame.image,
          i * TILE_WIDTH,
          0,
          TILE_WIDTH,
          MAP_HEIGHT,
          0,
          0,
          TILE_WIDTH,
          MAP_HEIGHT,
        );
      const result = await bridge.updateImageRawData(
        new ImageRawDataUpdate({
          containerID: 3 + i,
          containerName: i ? "sky-right" : "sky-left",
          imageData: await pngBytes(tile),
        }),
      );
      if (result !== ImageRawDataUpdateResult.success)
        throw new Error(`Could not send the sky map (${result}).`);
    }
    // This acknowledgement confirms acceptance by the host, not optical delivery.
    if (this.active && generation === this.generation)
      this.onStatus("Sky map sent to G2.");
  }
  stop(): void {
    this.generation++;
    this.active = false;
    this.queue?.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
