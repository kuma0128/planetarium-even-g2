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
  expect(report.samples.length).toBeGreaterThan(10);
  expect(report.captures.map((c: { step: string }) => c.step)).toEqual([
    "forward",
    "up",
  ]);
  expect(report.config).toEqual({ format: "gravity" });
  expect(report.reference).toEqual({ heading: 180, pitch: 30, northReference: "true" });
  expect(report.lastPose).not.toHaveProperty("heading");
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
