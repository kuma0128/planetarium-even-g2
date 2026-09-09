import { test, expect } from "@playwright/test";
import { host, range, expectDeliveredFrame } from "./helpers/g2-host.ts";

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

test("New preview frames cannot overwrite a snapshot whose tiles are still being sent", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await range(page, "#pitch", "-90");
  await page.locator("#location-form button").click();
  await expectDeliveredFrame(page);
  const original = await page.locator("#sky").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  await page.evaluate(() => {
    window.__g2Test.captureFrames = true;
    window.__g2Test.blockImages = true;
  });
  await page.locator("#refresh-display").click();
  await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(1);
  await page.locator("#sky-info").check();
  await expect(page.locator("#lens-header")).toContainText("Now");
  await page.selectOption("#fov", "60");
  await page.evaluate(() => {
    window.__g2Test.blockImages = false;
    window.__g2Test.releaseImage();
  });
  await expectDeliveredFrame(page);
  // Every tile of the first forced frame must match the view before the edits.
  expect(await page.evaluate(async (original) => {
    const frame = window.__g2Test.capturedFrames[0];
    if (!frame || Object.keys(frame).length !== 4) return false;
    const canvas = document.createElement("canvas");
    canvas.width = 576;
    canvas.height = 288;
    const ctx = canvas.getContext("2d")!;
    const reference = new Image();
    reference.src = original;
    await reference.decode();
    ctx.drawImage(reference, 0, 0);
    const expected = ctx.getImageData(0, 0, 576, 288).data;
    for (let i = 0; i < 4; i++) {
      const bytes = frame[2 + i];
      const data = typeof bytes === "string"
        ? Uint8Array.from(atob(bytes), char => char.charCodeAt(0))
        : new Uint8Array(bytes);
      const image = await createImageBitmap(new Blob([data], { type: "image/png" }));
      ctx.drawImage(image, (i % 2) * 288, Math.floor(i / 2) * 144);
      image.close();
    }
    const actual = ctx.getImageData(0, 0, 576, 288).data;
    return expected.every((byte, i) => byte === actual[i]);
  }, original)).toBe(true);
  expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
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

test("Mobile browser preview keeps manual controls and reports that no native host is present", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#heading-source")).toHaveText("Manual");
  await page.locator("#head-diagnostics summary").click();
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
