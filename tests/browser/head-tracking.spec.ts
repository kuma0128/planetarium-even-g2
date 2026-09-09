import { test, expect, type Page } from "@playwright/test";

type Sample = { x: number; y: number; z: number };
type Host = {
  calls: { method: string; data?: Record<string, unknown> }[];
  imageDelay: number;
  imageInFlight: number;
  maxImageInFlight: number;
  failImages: boolean;
  failMotion: boolean;
  blockImages: boolean;
  blockMotionStop: boolean;
  releaseImage: () => void;
  releaseMotionStop: () => void;
  motion: boolean;
  omitZeroAxes: boolean;
  images: Record<number, number[] | string>;
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

async function host(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: Host = (window.__g2Test = {
      calls: [],
      imageDelay: 80,
      imageInFlight: 0,
      maxImageInFlight: 0,
      failImages: false,
      failMotion: false,
      blockImages: false,
      blockMotionStop: false,
      releaseImage: () => {},
      releaseMotionStop: () => {},
      motion: false,
      omitZeroAxes: false,
      images: {},
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
            method,
            data:
              method === "updateImageRawData"
                ? { containerID: data.containerID }
                : data,
          });
          if (method === "createStartUpPageContainer") return 0;
          if (method === "getGlassesInfo")
            return { model: "g2", sn: "test-g2" };
          if (method === "imuControl") {
            if (state.failMotion && data.iMUReportEn === 1) return false;
            if (state.blockMotionStop && data.iMUReportEn === 0)
              await new Promise<void>(resolve => { state.releaseMotionStop = resolve; });
            state.motion = data.iMUReportEn === 1;
            return true;
          }
          if (method === "updateImageRawData") {
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
            if (!state.failImages) state.images[data.containerID] = data.imageData;
            return state.failImages ? 1 : 0;
          }
          return true;
        },
      },
    });
  });
}

async function hold(page: Page, sample: Sample): Promise<void> {
  await page.evaluate(async (value) => {
    for (let i = 0; i < 11; i++) {
      window.__g2Test.emit(value);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, sample);
}
const gravity = (pitch: number, roll = 0): Sample => {
  const p = (pitch * Math.PI) / 180,
    r = (roll * Math.PI) / 180;
  return {
    x: Math.sin(p),
    y: Math.cos(p) * Math.sin(r),
    z: Math.cos(p) * Math.cos(r),
  };
};
async function range(
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
async function reference(page: Page, pitch = "30"): Promise<void> {
  await page.locator("#sky-info").check();
  await page
    .getByText("North reference & calibration", { exact: true })
    .click();
  await page.selectOption("#north-reference", "true");
  await range(page, "#pitch", pitch);
  await page.locator("#location-form button").click();
}

/** Compare all four accepted PNGs with the current preview, including cleared text. */
async function expectDeliveredFrame(page: Page): Promise<void> {
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

test("Full-display mode starts without text and delivers the entire 576 x 288 frame", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await expect(page.locator("#full-sky")).toBeChecked();
  await expect(page.locator("#sky-info")).not.toBeChecked();
  await expect(page.locator("#sky-labels")).not.toBeChecked();
  await page.locator("#location-form button").click();
  await expectDeliveredFrame(page);
  expect(await page.evaluate(() => window.__g2Test.drawnText)).toEqual([]);
  const layout = await page.evaluate(() => window.__g2Test.calls.find(call => call.method === "createStartUpPageContainer")!.data);
  expect(layout?.containerTotalNum).toBe(5);
  expect(layout?.textObject).toEqual([
    expect.objectContaining({ containerID: 1, content: "", isEventCapture: 1, zOrderIndex: 0 }),
  ]);
  expect(layout?.imageObject).toEqual([
    expect.objectContaining({ containerID: 2, xPosition: 0, yPosition: 0, width: 288, height: 144, zOrderIndex: 1 }),
    expect.objectContaining({ containerID: 3, xPosition: 288, yPosition: 0, width: 288, height: 144, zOrderIndex: 2 }),
    expect.objectContaining({ containerID: 4, xPosition: 0, yPosition: 144, width: 288, height: 144, zOrderIndex: 3 }),
    expect.objectContaining({ containerID: 5, xPosition: 288, yPosition: 144, width: 288, height: 144, zOrderIndex: 4 }),
  ]);
  // Blank captions must not remove the physical gesture target.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("evenHubEvent", {
    detail: { textEvent: { eventType: 0, containerID: 1, containerName: "sky-events" } },
  })));
  await expect(page.locator("#tonight")).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("evenHubEvent", {
    detail: { sysEvent: { eventType: 1 } },
  })));
  await expect(page.locator("#heading")).toHaveValue("165");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("evenHubEvent", {
    detail: { sysEvent: { eventType: 3 } },
  })));
  await expect.poll(() => page.evaluate(() => window.__g2Test.calls.some(call => call.method === "shutDownPageContainer"))).toBe(true);
  await page.screenshot({ path: "artifacts/full-planetarium-desktop.png", fullPage: true });
});

test("Information and labels can be enabled independently, then clear completely even during slow transfers", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await page.locator("#date").fill("2026-01-15T21:00");
  await page.locator("#date").press("Tab");
  await expect(page.locator("#custom")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#location-form button").click();
  await expectDeliveredFrame(page);
  const original = await page.locator("#sky").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  await page.evaluate(() => { window.__g2Test.imageDelay = 180; });
  await page.locator("#sky-info").check();
  await expect(page.locator("#lens-header")).toContainText("Custom");
  await expect(page.locator("#lens-footer")).toContainText("Moon illuminated");
  await expectDeliveredFrame(page);
  await page.locator("#sky-info").uncheck();
  await expect(page.locator("#lens-header")).toHaveText("");
  await expect(page.locator("#lens-footer")).toHaveText("");
  await expectDeliveredFrame(page);
  expect(await page.locator("#sky").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).toBe(original);
  await page.evaluate(() => { window.__g2Test.drawnText = []; });
  await page.locator("#sky-labels").check();
  await expect.poll(() => page.evaluate(() => window.__g2Test.drawnText.length)).toBeGreaterThan(0);
  await expect(page.locator("#lens-header")).toHaveText("");
  await page.locator("#sky-labels").uncheck();
  await expectDeliveredFrame(page);
  expect(await page.locator("#sky").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).toBe(original);
  expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
});

test("Compact and full-display views replace all pixels without rebuilding the G2 page", async ({ page }) => {
  await host(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#location-form button").click();
  await expectDeliveredFrame(page);
  await page.locator("#full-sky").uncheck();
  await expectDeliveredFrame(page);
  expect(await page.locator("#sky").evaluate(canvas => {
    const ctx = (canvas as HTMLCanvasElement).getContext("2d")!;
    return [[0, 54], [198, 90]].every(([top, height]) => {
      const { data } = ctx.getImageData(0, top!, 576, height!);
      return data.every((byte, index) => index % 4 === 3 ? byte === 255 : byte === 0);
    });
  })).toBe(true);
  await page.locator("#full-sky").check();
  await expectDeliveredFrame(page);
  expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
  expect(await page.evaluate(() => window.__g2Test.calls.some(call => call.method === "rebuildPageContainer"))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/full-planetarium-mobile.png", fullPage: true });
});

test("Preview options and G2 updates still work when the host suspends animation frames", async ({ page }) => {
  await host(page);
  await page.addInitScript(() => { window.requestAnimationFrame = () => 1; });
  await page.goto("/");
  await page.locator("#location-form button").click();
  await expectDeliveredFrame(page);
  const original = await page.locator("#sky").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  await page.locator("#sky-info").check();
  await expect(page.locator("#lens-header")).toContainText("Now");
  await expectDeliveredFrame(page);
  expect(await page.locator("#sky").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).not.toBe(original);
  await page.locator("#sky-info").uncheck();
  await expect(page.locator("#lens-header")).toHaveText("");
  await expectDeliveredFrame(page);
  await page.locator("#full-sky").uncheck();
  await expect.poll(() => page.locator("#sky").evaluate((canvas, initial) =>
    (canvas as HTMLCanvasElement).toDataURL() === initial, original)).toBe(false);
  await expectDeliveredFrame(page);
});

test("Refresh G2 display resends all unchanged tiles and preview-only states explain the missing location", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await expect(page.locator("#preview-status")).toContainText("Choose your observing location");
  await expect(page.locator("#refresh-display")).toBeDisabled();
  await page.locator("#location-form button").click();
  await expectDeliveredFrame(page);
  const before = await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length);
  await page.locator("#refresh-display").click();
  await expect.poll(() => page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length)).toBeGreaterThanOrEqual(before + 4);
  await expectDeliveredFrame(page);
  expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
});

test("A sensor acknowledgement without readings cannot enable calibration and can be retried", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await page.locator("#head-start").click();
  await expect(page.locator("#head-state")).toHaveText("Waiting for sensor");
  await expect(page.locator("#head-forward")).toBeDisabled();
  await expect(page.locator("#head-status")).toContainText("No G2 sensor readings received");
  await expect(page.locator("#head-scope")).toContainText("Up / down only");
  await page.locator("#head-stop").click();
  await page.locator("#head-start").click();
  await hold(page, gravity(30));
  await expect(page.locator("#head-forward")).toBeEnabled();
  await expect(page.locator("#head-status")).not.toContainText("No G2 sensor readings");
});

test("A refresh queued during a slow transfer survives replacement by a newer unchanged frame", async ({ page }) => {
  await host(page);
  await page.goto("/");
  // Below the horizon every frame is black, even when field of view changes.
  await range(page, "#pitch", "-90");
  await page.locator("#location-form button").click();
  await expectDeliveredFrame(page);
  const before = await page.evaluate(() => {
    window.__g2Test.imageDelay = 250;
    return window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length;
  });
  await page.locator("#refresh-display").click();
  await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(1);
  await page.locator("#refresh-display").click();
  // Let the second refresh queue behind the first transfer before replacing it.
  await expect.poll(() => page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length)).toBeGreaterThanOrEqual(before + 2);
  await page.selectOption("#fov", "60");
  await expect.poll(() => page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length), { timeout: 6000 }).toBeGreaterThanOrEqual(before + 8);
  await expectDeliveredFrame(page);
  expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
});

test("G2 tilt accepts omitted zero axes and keeps tracking when only the phone view is hidden", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await page.evaluate(() => { window.__g2Test.omitZeroAxes = true; });
  await calibrateTilt(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.requestAnimationFrame = () => 1;
  });
  await hold(page, gravity(10));
  await expect(page.locator("#head-state")).toHaveText("Tracking");
  await expect(page.locator("#pitch-value")).toHaveText("10°");
  await expectDeliveredFrame(page);
  expect(await page.evaluate(() => window.__g2Test.motion)).toBe(true);
});
async function calibrateTilt(page: Page): Promise<void> {
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

test("Real SDK bridge: gravity calibration, roll rejection, serial frames, stop and late samples", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await expect(page.locator("#pitch-value")).toHaveText("60°");
  await expect(page.locator("#heading-readout")).toHaveText("180");
  await hold(page, gravity(10, 60));
  await expect(page.locator("#pitch-value")).toHaveText("10°");
  await expect(page.locator("#lens-header")).toContainText("head tilt");
  await page.screenshot({
    path: "artifacts/head-tracking-desktop.png",
    fullPage: true,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__g2Test.calls.filter((c) => c.method === "updateImageRawData")
            .length,
      ),
    )
    .toBeGreaterThan(2);
  expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
  expect(
    await page.evaluate(
      () => window.__g2Test.calls.find((c) => c.method === "imuControl")!.data,
    ),
  ).toEqual({ iMUReportEn: 1, reportFrq: 100 });
  await page.locator("#head-stop").click();
  await expect(page.locator("#pitch")).toBeEnabled();
  await hold(page, gravity(80));
  await expect(page.locator("#pitch-value")).toHaveText("10°");
  await expect
    .poll(() => page.evaluate(() => window.__g2Test.motion))
    .toBe(false);
  expect(errors).toEqual([]);
});

test("The final stationary frame is delivered even when movements arrive during a slow transfer", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await page.evaluate(() => {
    window.__g2Test.imageDelay = 250;
  });
  await hold(page, gravity(5));
  await expect(page.locator("#pitch-value")).toHaveText("5°");
  await expectDeliveredFrame(page);
  expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
});

test("Tracking coalesces frequent sensor updates into at most ten renders per second", async ({ page }) => {
  await host(page);
  await page.goto("/");
  // Keep periodic sky recalculation outside the sensor-render timing check.
  await page.locator("#date").fill("2026-01-15T21:00");
  await page.locator("#date").press("Tab");
  await reference(page);
  await calibrateTilt(page);
  const renders = await page.evaluate(async () => {
    const state = window.__g2Test;
    state.renderTimes = [];
    for (let i = 0; i < 60; i++) {
      const pitch = (20 + i / 2) * Math.PI / 180;
      state.emit({ x: Math.sin(pitch), y: 0, z: Math.cos(pitch) });
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    return state.renderTimes;
  });
  expect(renders.length).toBeGreaterThan(3);
  for (let i = 1; i < renders.length; i++)
    expect(renders[i] - renders[i - 1]).toBeGreaterThanOrEqual(95);
  await expectDeliveredFrame(page);
});

test("Stale sensor readings freeze the map and require calibration before resuming", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await expect(page.locator("#heading-source")).toHaveText("Head paused", {
    timeout: 4000,
  });
  await hold(page, gravity(0));
  await expect(page.locator("#pitch-value")).toHaveText("60°");
  await expect(page.locator("#head-state")).not.toHaveText("Tracking");
  await page.locator("#head-forward").click();
  await expect(page.locator("#head-up")).toBeEnabled();
  await expect(page.locator("#pitch-value")).toHaveText("60°");
});

test("A failed forward capture after a pause stays readable until calibration is retried", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await expect(page.locator("#heading-source")).toHaveText("Head paused", { timeout: 4000 });
  await page.evaluate(sample => window.__g2Test.emit(sample), gravity(30));
  await page.locator("#head-forward").click();
  await expect(page.locator("#head-status")).toContainText("Wait for at least four fresh readings");
  await hold(page, gravity(30));
  await expect(page.locator("#head-status")).toContainText("Wait for at least four fresh readings");
  await expect(page.locator("#lens-footer")).toContainText("Pose not captured");
  await page.locator("#head-forward").click();
  await expect(page.locator("#head-up")).toBeEnabled();
  await expect(page.locator("#head-status")).toContainText("Look 20–40° higher");
});

test("A paused elevation outside the calibration range explains how to recover with Stop", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await hold(page, gravity(75));
  await expect(page.locator("#pitch-value")).toHaveText("75°");
  await expect(page.locator("#heading-source")).toHaveText("Head paused", { timeout: 4000 });
  await hold(page, gravity(30));
  await page.locator("#head-forward").click();
  await expect(page.locator("#head-status")).toContainText("Select Stop");
  await expect(page.locator("#head-status")).toContainText("between −60° and 60°");
  await page.locator("#head-stop").click();
  await range(page, "#pitch", "30");
  await calibrateTilt(page);
});

test("Experimental yaw remains disabled until the right-turn check, then manual mode releases it", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page, "0");
  await page.locator("#head-diagnostics summary").click();
  await page.selectOption("#head-format", "degrees");
  await range(page, "#heading", "90");
  await page.locator("#head-start").click();
  await hold(page, { x: 10, y: 0, z: 350 });
  await page.locator("#head-forward").click();
  await hold(page, { x: 40, y: 0, z: 350 });
  await page.locator("#head-up").click();
  await expect(page.locator("#head-right")).toBeEnabled();
  await expect(page.locator("#heading-readout")).toHaveText("90");
  await hold(page, { x: 10, y: 0, z: 20 });
  await page.locator("#head-right").click();
  await expect(page.locator("#heading-readout")).toHaveText("120");
  await expect(page.locator("#phone-mode")).toBeDisabled();
  await page.locator("#manual-mode").click();
  await expect(page.locator("#head-state")).toHaveText("Off");
  await expect(page.locator("#heading")).toBeEnabled();
  await expect(page.locator("#heading-readout")).toHaveText("120");
});

test("A rejected sensor start is visible and retry works", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await page.evaluate(() => {
    window.__g2Test.failMotion = true;
  });
  await page.locator("#head-start").click();
  await expect(page.locator("#head-status")).toContainText("could not start");
  await expect(page.locator("#head-start")).toBeEnabled();
  await page.evaluate(() => {
    window.__g2Test.failMotion = false;
  });
  await page.locator("#head-start").click();
  await hold(page, gravity(30));
  await expect(page.locator("#head-forward")).toBeEnabled();
});

test("Disconnect stops tracking and reconnect requires a new calibration", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("deviceStatusChanged", {
        detail: { sn: "test-g2", connectType: "disconnected" },
      }),
    ),
  );
  await expect(page.locator("#head-state")).toHaveText("Off");
  await expect(page.locator("#bridge-status")).toContainText("disconnected");
  await page.locator("#head-start").click();
  await hold(page, gravity(30));
  await expect(page.locator("#head-forward")).toBeEnabled();
  await expect(page.locator("#head-up")).toBeDisabled();
});

for (const blocked of ["image", "motion"] as const) {
  test(`Reconnect times out a stalled ${blocked} call and can be retried after it settles`, async ({ page }) => {
    await host(page);
    await page.goto("/");
    await reference(page);
    await expectDeliveredFrame(page);
    await page.locator("#head-start").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
    await page.evaluate(blocked => {
      window.__g2Test.blockImages = blocked === "image";
      window.__g2Test.blockMotionStop = blocked === "motion";
    }, blocked);
    if (blocked === "image") {
      await page.locator("#refresh-display").click();
      await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(1);
    }
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("deviceStatusChanged", {
      detail: { sn: "test-g2", connectType: "disconnected" },
    })));
    await expect(page.locator("#bridge-status")).toContainText("disconnected");
    await page.locator("#connect").click();
    await expect(page.locator("#connect")).toBeDisabled();
    await expect(page.locator("#bridge-status")).toContainText("previous G2 session", { timeout: 6000 });
    await expect(page.locator("#connect")).toBeEnabled();
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
    await page.evaluate(() => {
      const state = window.__g2Test;
      state.blockImages = state.blockMotionStop = false;
      state.releaseImage();
      state.releaseMotionStop();
    });
    await page.locator("#connect").click();
    await expectDeliveredFrame(page);
    await expect.poll(() => page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(2);
    expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
    await expect(page.locator("#head-state")).toHaveText("Off");
  });
}

test("Disconnecting an unused sensor leaves its setup message intact", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await expectDeliveredFrame(page);
  const initial = await page.locator("#head-status").textContent();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("deviceStatusChanged", {
    detail: { sn: "test-g2", connectType: "disconnected" },
  })));
  await expect(page.locator("#bridge-status")).toContainText("disconnected");
  await expect(page.locator("#head-status")).toHaveText(initial!);
  await expect(page.locator("#head-state")).toHaveText("Off");
});

test("A frame failure stops the sensor; reconnect redraws an unchanged sky", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await page.evaluate(() => {
    window.__g2Test.failImages = true;
  });
  await hold(page, gravity(10));
  await expect(page.locator("#bridge-status")).toContainText("updates stopped");
  await expect(page.locator("#head-state")).toHaveText("Off");
  await expect
    .poll(() => page.evaluate(() => window.__g2Test.motion))
    .toBe(false);
  const previous = await page.evaluate(
    () =>
      window.__g2Test.calls.filter((c) => c.method === "updateImageRawData")
        .length,
  );
  await page.evaluate(() => {
    window.__g2Test.failImages = false;
  });
  await page.locator("#head-start").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__g2Test.calls.filter((c) => c.method === "updateImageRawData")
            .length,
      ),
    )
    .toBeGreaterThan(previous + 1);
  expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
});

test("A calibration error remains readable while further sensor samples arrive", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await page.locator("#head-start").click();
  await hold(page, gravity(30));
  await page.locator("#head-forward").click();
  await hold(page, gravity(30));
  await page.locator("#head-up").click();
  await expect(page.locator("#head-status")).toContainText("try again");
  await hold(page, gravity(30));
  await expect(page.locator("#head-status")).toContainText("try again");
  await expect(page.locator("#lens-footer")).toContainText("Pose not captured");
});

test("Leaving the G2 foreground stops its motion session", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await page.locator("#head-start").click();
  await expect
    .poll(() => page.evaluate(() => window.__g2Test.motion))
    .toBe(true);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("evenHubEvent", {
        detail: { sysEvent: { eventType: 5 } },
      }),
    ),
  );
  await expect(page.locator("#head-state")).toHaveText("Off");
  await expect
    .poll(() => page.evaluate(() => window.__g2Test.motion))
    .toBe(false);
});

test("Sensor log contains real-session samples and capture markers, with no location", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await page.locator("#head-diagnostics summary").click();
  const downloading = page.waitForEvent("download");
  await page.locator("#head-download").click();
  const download = await downloading;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const report = JSON.parse(Buffer.concat(chunks).toString());
  expect(JSON.parse(await page.locator("#head-log").inputValue())).toEqual(report);
  await expect(page.locator("#head-log")).toBeVisible();
  expect(report.samples.length).toBeGreaterThan(10);
  expect(report.captures.map((c: { step: string }) => c.step)).toEqual([
    "forward",
    "up",
  ]);
  expect(report.config.format).toBe("gravity");
  expect(report).not.toHaveProperty("location");
  expect(JSON.stringify(report)).not.toContain("latitude");
});

for (const outcome of ["success", "cancel", "failure", "unsupported"] as const) {
  test(`Sensor log export remains accessible when file sharing reports ${outcome}`, async ({ page }) => {
    await host(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.locator("#head-start").click();
    await hold(page, gravity(30));
    await page.locator("#head-diagnostics summary").click();
    await page.evaluate(outcome => {
      const state = window.__g2Test;
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => outcome !== "unsupported" });
      Object.defineProperty(navigator, "share", { configurable: true, value: async ({ files }: ShareData) => {
        if (outcome === "cancel") throw new DOMException("Cancelled", "AbortError");
        if (outcome === "failure") throw new DOMException("Unavailable", "NotAllowedError");
        state.sharedLog = await files![0].text();
      } });
      // Model a WebView that ignores downloads and may deny clipboard access.
      HTMLAnchorElement.prototype.click = () => { state.downloadAttempts++; };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (text: string) => {
          if (outcome !== "success") throw new DOMException("Unavailable", "NotAllowedError");
          state.copiedLog = text;
        },
      } });
    }, outcome);
    await page.locator("#head-download").click();
    await expect(page.locator("#head-download")).toBeEnabled();
    await expect(page.locator("#head-log")).toBeVisible();
    const json = await page.locator("#head-log").inputValue();
    expect(JSON.parse(json).samples.length).toBeGreaterThan(10);
    expect(json).not.toContain("latitude");
    if (outcome === "success") {
      await expect(page.locator("#head-log-status")).toContainText("shared");
      expect(await page.evaluate(() => window.__g2Test.sharedLog)).toBe(json);
    } else if (outcome === "cancel") {
      await expect(page.locator("#head-log-status")).toContainText("Sharing cancelled");
    } else {
      await expect(page.locator("#head-log-status")).toContainText("Download requested");
    }
    expect(await page.evaluate(() => window.__g2Test.downloadAttempts))
      .toBe(outcome === "success" || outcome === "cancel" ? 0 : 1);
    await page.locator("#head-copy").click();
    if (outcome === "success") {
      await expect(page.locator("#head-log-status")).toContainText("copied");
      expect(await page.evaluate(() => window.__g2Test.copiedLog)).toBe(json);
    } else {
      await expect(page.locator("#head-log-status")).toContainText("your device's Copy command");
      expect(await page.locator("#head-log").evaluate(log => {
        const area = log as HTMLTextAreaElement;
        return area.selectionEnd - area.selectionStart;
      })).toBe(json.length);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (outcome === "unsupported")
      await page.screenshot({ path: "artifacts/sensor-log-mobile.png", fullPage: true });
  });
}

test("Mobile browser preview keeps manual controls and reports that no native host is present", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#heading-source")).toHaveText("Manual");
  await page.locator("#head-diagnostics summary").click();
  await page.selectOption("#head-format", "degrees");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/head-tracking-mobile.png",
    fullPage: true,
  });
  await page.locator("#head-start").click();
  await expect(page.locator("#head-state")).toHaveText("Off");
  await expect(page.locator("#head-start")).toBeEnabled();
  expect(errors).toEqual([]);
});
