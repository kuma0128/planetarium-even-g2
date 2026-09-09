import { test, expect } from "@playwright/test";
import { host, hold, gravity, reference, calibrateTilt } from "./helpers/g2-host.ts";

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
  expect(report.version).toBe(3);
  expect(report.enabled).toBe(true);
  expect(report.exportedAtMs).toBeGreaterThan(0);
  expect(report.samples.length).toBeGreaterThan(10);
  expect(report.ignoredAsAcceleration).toBe(0);
  expect(report.captures.map((c: { step: string }) => c.step)).toEqual([
    "forward",
    "up",
  ]);
  // Each marker keeps what the capture measured and the readings it saw.
  const [forward, up] = report.captures;
  expect(forward.used).toBeGreaterThanOrEqual(4);
  expect(forward.dropped).toBe(0);
  expect(forward.gravity.x).toBeCloseTo(Math.sin(Math.PI / 6), 3);
  expect(forward.recent.length).toBeGreaterThanOrEqual(4);
  expect(up.tiltDeg).toBeCloseTo(30, 3);
  expect(up.forward).toEqual(expect.objectContaining({ x: expect.any(Number) }));
  const events = report.events.map((e: { event: string }) => e.event);
  expect(events[0]).toBe("sensor-started");
  expect(events).not.toContain("capture-failed");
  expect(report.config).toEqual({ format: "gravity" });
  expect(report.reference).toEqual({ heading: 180, pitch: 30, northReference: "true" });
  expect(report.lastPose).not.toHaveProperty("heading");
  expect(report).not.toHaveProperty("location");
  expect(JSON.stringify(report)).not.toContain("latitude");
});

test("Sensor log records failed captures, unusable readings and why the session ended", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await page.locator("#head-start").click();
  await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
  // One reading cannot calibrate; the attempt and the readings it saw are logged.
  await page.evaluate(async (sample) => {
    window.__g2Test.emit(sample);
    const button = document.getElementById("align-direction") as HTMLButtonElement;
    while (button.disabled) await new Promise((resolve) => setTimeout(resolve, 10));
    button.click();
  }, gravity(30));
  await expect(page.locator("#head-status")).toContainText("Wait for at least four fresh readings");
  // A near-zero frame is a dropout: counted as unusable and kept out of calibration.
  await page.evaluate(() => window.__g2Test.emit({ x: 0.0001, y: -0.0002, z: -0.0001 }));
  await expect(page.locator("#head-received")).toContainText("2 sensor messages · 1 unusable");
  await hold(page, gravity(30));
  await page.locator("#align-direction").click();
  await expect(page.locator("#head-up")).toBeEnabled();
  await page.locator("#head-stop").click();
  await expect(page.locator("#head-state")).toHaveText("Off");
  await page.locator("#head-diagnostics summary").click();
  await page.locator("#head-download").click();
  const report = JSON.parse(await page.locator("#head-log").inputValue());
  expect(report.enabled).toBe(false);
  expect(report.phase).toBe("neutral");
  expect(report.rejectedMessages).toBe(1);
  expect(report.samples.filter((s: { unusable?: boolean }) => s.unusable)).toHaveLength(1);
  expect(report.captures).toHaveLength(1);
  expect(report.captures[0]).toMatchObject({ step: "forward", dropped: 0 });
  expect(report.events.map((e: { event: string }) => e.event)).toEqual([
    "sensor-started",
    "capture-failed",
    "ended",
  ]);
  expect(report.events[1]).toMatchObject({
    step: "forward",
    message: expect.stringContaining("four fresh readings"),
  });
  expect(report.events[1].recent).toHaveLength(1);
  expect(report.events[2]).toMatchObject({ cause: "Stop selected", phase: "up" });
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
        state.sharedLog = await files![0]!.text();
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
