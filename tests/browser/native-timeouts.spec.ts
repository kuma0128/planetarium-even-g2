import { test, expect } from "@playwright/test";
import { host, expectDeliveredFrame, gravity } from "./helpers/g2-host.ts";

for (const lateResult of ["success", "throw"] as const) {
  test(`A stalled image transfer ends the session and drains its late ${lateResult} before reconnecting`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await host(page);
    await page.goto("/");
    await page.locator("#date").fill("2026-01-15T21:00");
    await page.locator("#date").press("Tab");
    await page.locator("#location-form button").click();
    await expectDeliveredFrame(page);
    await page.locator("#head-start").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
    await page.evaluate(lateResult => {
      window.__g2Test.blockImages = true;
      window.__g2Test.nextImageFailure = lateResult === "throw" ? "throw" : null;
    }, lateResult);
    await page.locator("#refresh-display").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(1);
    await page.locator("#sky-info").check();
    if (lateResult === "throw") {
      // Returning to the foreground cannot bypass a still-blocked transfer.
      await page.evaluate(() => {
        for (const eventType of [5, 4])
          window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType } } }));
      });
    }
    await expect(page.locator("#bridge-status")).toContainText("image transfer did not finish", { timeout: 8000 });
    await expect(page.locator("#head-state")).toHaveText("Off");
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(false);
    await expect(page.locator("#refresh-display")).toBeDisabled();
    await expect(page.locator("#preview-status")).toContainText("Connect G2");
    await page.locator("#connect").click();
    await expect(page.locator("#bridge-status")).toContainText("previous G2 session", { timeout: 6000 });
    await expect(page.locator("#connect")).toBeEnabled();
    expect(await page.evaluate(() => window.__g2Test.calls.filter(c => c.method === "createStartUpPageContainer").length)).toBe(1);
    await page.evaluate(() => {
      window.__g2Test.blockImages = false;
      window.__g2Test.releaseImage();
    });
    await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(0);
    await expect(page.locator("#bridge-status")).toContainText("previous G2 session");
    await page.locator("#connect").click();
    await expectDeliveredFrame(page);
    expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(c => c.method === "createStartUpPageContainer").length)).toBe(2);
    expect(errors).toEqual([]);
  });
}

for (const command of ["start", "start-rejected", "stop", "failed-start-cleanup"] as const) {
  test(`A stalled sensor ${command} releases the controls and preserves native serialization`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await host(page);
    await page.goto("/");
    await page.locator("#location-form button").click();
    await expectDeliveredFrame(page);
    await page.evaluate(command => {
      const state = window.__g2Test;
      state.blockMotionStart = command === "start" || command === "start-rejected";
      state.blockMotionStop = !state.blockMotionStart;
      state.failMotion = command === "failed-start-cleanup" || command === "start-rejected";
      // Readings can arrive before the native start acknowledgement.
      if (state.blockMotionStart) setInterval(() => state.emit({ x: 0.5, y: 0, z: Math.sqrt(0.75) }), 100);
    }, command);
    await page.locator("#head-start").click();
    if (command === "stop") {
      await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
      await page.locator("#head-stop").click();
      // A second start queues behind the stop; its late result must not win.
      await page.locator("#head-start").click();
    }
    await expect(page.locator("#bridge-status")).toContainText("motion sensor did not respond", { timeout: 8000 });
    await expect(page.locator("#head-state")).toHaveText("Off");
    await expect(page.locator("#head-start")).toBeEnabled();
    await expect(page.locator("#head-status")).toContainText("motion sensor did not respond");
    await expect(page.locator("#align-direction")).toBeDisabled();
    await page.locator("#language").selectOption("ja");
    await expect(page.locator("#head-status")).toContainText("タイムアウト");
    await expect(page.locator("#bridge-status")).toContainText("タイムアウト");
    await page.locator("#language").selectOption("en");
    await expect(page.locator("#refresh-display")).toBeDisabled();
    await page.locator("#connect").click();
    await expect(page.locator("#bridge-status")).toContainText("previous G2 session", { timeout: 6000 });
    await expect(page.locator("#connect")).toBeEnabled();
    expect(await page.evaluate(() => window.__g2Test.maxMotionInFlight)).toBe(1);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(c => c.method === "createStartUpPageContainer").length)).toBe(1);
    await page.evaluate(() => {
      const state = window.__g2Test;
      state.blockMotionStart = state.blockMotionStop = state.failMotion = false;
      state.releaseMotionStart();
      state.releaseMotionStop();
    });
    await expect.poll(() => page.evaluate(() => window.__g2Test.motionInFlight)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(false);
    await expect(page.locator("#bridge-status")).toContainText("previous G2 session");
    await expect(page.locator("#head-status")).toContainText("motion sensor did not respond");
    await page.locator("#head-start").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
    await page.evaluate(sample => {
      setInterval(() => window.__g2Test.emit(sample), 100);
    }, gravity(30));
    await expect(page.locator("#align-direction")).toBeEnabled();
    await expectDeliveredFrame(page);
    expect(await page.evaluate(() => window.__g2Test.maxMotionInFlight)).toBe(1);
    expect(errors).toEqual([]);
  });
}
