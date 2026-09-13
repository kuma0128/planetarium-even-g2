import { expect, type Page } from "@playwright/test";

type Sample = { x: number; y: number; z: number };
type Host = {
  calls: { at: number; method: string; data?: Record<string, unknown> }[];
  imageDelay: number;
  imageInFlight: number;
  maxImageInFlight: number;
  failImages: boolean;
  nextImageFailure: "result" | "throw" | null;
  failMotion: boolean;
  failMotionStop: boolean;
  blockImages: boolean;
  blockMotionStop: boolean;
  blockMotionStart: boolean;
  releaseMotionStart: () => void;
  motionInFlight: number;
  maxMotionInFlight: number;
  blockStartup: boolean;
  startupResult: 0 | 1 | "throw";
  startupInFlight: number;
  maxStartupInFlight: number;
  releaseStartup: () => void;
  blockRebuild: boolean;
  rebuildInFlight: number;
  maxRebuildInFlight: number;
  releaseRebuild: () => void;
  deviceInfo: { model: string; sn: string } | null;
  failDeviceInfo: boolean;
  blockDeviceInfo: boolean;
  releaseDeviceInfo: () => void;
  locationResult: "success" | "null" | "failure" | "pending";
  releaseImage: () => void;
  releaseMotionStop: () => void;
  motion: boolean;
  omitZeroAxes: boolean;
  images: Record<number, number[] | string>;
  captureFrames: boolean;
  capturedFrames: Record<number, number[] | string>[];
  drawnText: string[];
  renderTimes: number[];
  sharedLog?: string;
  copiedLog?: string;
  downloadAttempts: number;
  emit: (sample: Sample) => void;
};
declare global {
  interface Window {
    __g2Test: Host;
  }
}

export async function host(
  page: Page,
  options: Partial<Pick<Host, "deviceInfo" | "failDeviceInfo" | "blockDeviceInfo" | "locationResult" | "blockStartup" | "startupResult">> = {},
): Promise<void> {
  await page.addInitScript((options) => {
    const state: Host = (window.__g2Test = {
      calls: [],
      imageDelay: 80,
      imageInFlight: 0,
      maxImageInFlight: 0,
      failImages: false,
      nextImageFailure: null,
      failMotion: false,
      failMotionStop: false,
      blockImages: false,
      blockMotionStop: false,
      blockMotionStart: false,
      releaseMotionStart: () => {},
      motionInFlight: 0,
      maxMotionInFlight: 0,
      blockStartup: false,
      startupResult: 0,
      startupInFlight: 0,
      maxStartupInFlight: 0,
      releaseStartup: () => {},
      blockRebuild: false,
      rebuildInFlight: 0,
      maxRebuildInFlight: 0,
      releaseRebuild: () => {},
      deviceInfo: { model: "g2", sn: "test-g2" },
      failDeviceInfo: false,
      blockDeviceInfo: false,
      releaseDeviceInfo: () => {},
      locationResult: "null",
      releaseImage: () => {},
      releaseMotionStop: () => {},
      motion: false,
      omitZeroAxes: false,
      images: {},
      captureFrames: false,
      capturedFrames: [],
      drawnText: [],
      renderTimes: [],
      downloadAttempts: 0,
      emit: (sample) =>
        window.dispatchEvent(
          new CustomEvent("evenHubEvent", {
            detail: { sysEvent: { eventType: 8, imuData: state.omitZeroAxes
              ? Object.fromEntries(Object.entries(sample).filter(([, value]) => value !== 0))
              : sample } },
          }),
        ),
      ...options,
    });
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      state.drawnText.push(args[0]);
      if (state.drawnText.length > 600) state.drawnText.shift();
      return fillText.apply(this, args);
    };
    const fillRect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.id === "sky" && args[0] === 0 && args[1] === 0 &&
          args[2] === 576 && args[3] === 288)
        state.renderTimes.push(performance.now());
      return fillRect.apply(this, args);
    };
    // Exercise the real SDK's native-call serialization and public event subscription.
    Object.assign(window, {
      flutter_inappwebview: {
        callHandler: async (_name: string, raw: string) => {
          const { method, data } = JSON.parse(raw);
          state.calls.push({
            at: performance.now(),
            method,
            data:
              method === "updateImageRawData"
                ? { containerID: data.containerID }
                : data,
          });
          if (method === "createStartUpPageContainer") {
            const result = state.startupResult;
            state.startupInFlight++;
            state.maxStartupInFlight = Math.max(state.maxStartupInFlight, state.startupInFlight);
            try {
              if (state.blockStartup)
                await new Promise<void>(resolve => { state.releaseStartup = resolve; });
              if (result === "throw") throw new Error("Startup rejected by host");
              return result;
            } finally {
              state.startupInFlight--;
            }
          }
          if (method === "rebuildPageContainer") {
            state.rebuildInFlight++;
            state.maxRebuildInFlight = Math.max(state.maxRebuildInFlight, state.rebuildInFlight);
            try {
              if (state.blockRebuild)
                await new Promise<void>(resolve => { state.releaseRebuild = resolve; });
              return true;
            } finally {
              state.rebuildInFlight--;
            }
          }
          if (method === "getGlassesInfo") {
            if (state.failDeviceInfo) throw new Error("Device info unavailable");
            const info = state.deviceInfo;
            if (state.blockDeviceInfo)
              await new Promise<void>(resolve => { state.releaseDeviceInfo = resolve; });
            return info;
          }
          if (method === "getAppLocation") {
            if (state.locationResult === "failure") throw new Error("Host location unavailable");
            if (state.locationResult === "pending") return new Promise(() => {});
            return state.locationResult === "success"
              ? { latitude: 51.5, longitude: -0.12, altitude: 35 }
              : null;
          }
          if (method === "imuControl") {
            const enabled = data.iMUReportEn === 1;
            const failed = enabled ? state.failMotion : state.failMotionStop;
            state.motionInFlight++;
            state.maxMotionInFlight = Math.max(state.maxMotionInFlight, state.motionInFlight);
            try {
              if (state.blockMotionStart && enabled)
                await new Promise<void>(resolve => { state.releaseMotionStart = resolve; });
              if (state.blockMotionStop && !enabled)
                await new Promise<void>(resolve => { state.releaseMotionStop = resolve; });
              if (failed) return false;
              state.motion = enabled;
              return true;
            } finally {
              state.motionInFlight--;
            }
          }
          if (method === "updateImageRawData") {
            const failure = state.nextImageFailure;
            state.nextImageFailure = null;
            state.imageInFlight++;
            state.maxImageInFlight = Math.max(
              state.maxImageInFlight,
              state.imageInFlight,
            );
            if (state.blockImages)
              await new Promise<void>(resolve => { state.releaseImage = resolve; });
            await new Promise((resolve) =>
              setTimeout(resolve, state.imageDelay),
            );
            state.imageInFlight--;
            if (failure === "throw") throw new Error("Image update rejected by host");
            const failed = state.failImages || failure === "result";
            if (!failed) state.images[data.containerID] = data.imageData;
            if (!failed && state.captureFrames && data.containerID === 5)
              state.capturedFrames.push({ ...state.images });
            return failed ? 1 : 0;
          }
          return true;
        },
      },
    });
  }, options);
}

export async function hold(page: Page, sample: Sample): Promise<void> {
  await page.evaluate(async (value) => {
    for (let i = 0; i < 11; i++) {
      window.__g2Test.emit(value);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, sample);
}
export const gravity = (pitch: number, roll = 0): Sample => {
  const p = (pitch * Math.PI) / 180,
    r = (roll * Math.PI) / 180;
  return {
    x: Math.sin(p),
    y: Math.cos(p) * Math.sin(r),
    z: Math.cos(p) * Math.cos(r),
  };
};
export async function range(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  await expect(page.locator(selector)).toBeEnabled();
  await page.locator(selector).evaluate((element, next) => {
    (element as HTMLInputElement).value = next;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}
export async function reference(page: Page, pitch = "30"): Promise<void> {
  await page.locator("#sky-info").check();
  await page
    .getByText("North reference & calibration", { exact: true })
    .click();
  await page.selectOption("#north-reference", "true");
  await range(page, "#pitch", pitch);
  await page.locator("#location-form button").click();
}

/** Compare all four accepted PNGs with the current preview, including cleared text. */
export async function expectDeliveredFrame(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const preview = document.querySelector<HTMLCanvasElement>("#sky")!;
    const delivered = document.createElement("canvas");
    delivered.width = 576;
    delivered.height = 288;
    const ctx = delivered.getContext("2d")!;
    for (let i = 0; i < 4; i++) {
      const bytes = window.__g2Test.images[2 + i];
      if (!bytes) return false;
      const data = typeof bytes === "string"
        ? Uint8Array.from(atob(bytes), char => char.charCodeAt(0))
        : new Uint8Array(bytes);
      const image = await createImageBitmap(new Blob([data], { type: "image/png" }));
      if (image.width !== 288 || image.height !== 144) return false;
      ctx.drawImage(image, (i % 2) * 288, Math.floor(i / 2) * 144);
      image.close();
    }
    const expected = preview.getContext("2d")!.getImageData(0, 0, 576, 288).data;
    const actual = ctx.getImageData(0, 0, 576, 288).data;
    return expected.every((byte, i) => byte === actual[i]);
  }), { timeout: 8000 }).toBe(true);
}

export async function calibrateTilt(page: Page): Promise<void> {
  await page.locator("#head-start").click();
  await expect
    .poll(() => page.evaluate(() => window.__g2Test.motion))
    .toBe(true);
  await hold(page, gravity(30));
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("evenHubEvent", {
        detail: { sysEvent: { eventType: 0 } },
      }),
    ),
  );
  await expect(page.locator("#head-up")).toBeEnabled();
  await expect(page.locator("#lens-footer")).toContainText("look up");
  await hold(page, gravity(60));
  await page.locator("#head-up").click();
  await expect(page.locator("#head-state")).toHaveText("Tracking");
}
