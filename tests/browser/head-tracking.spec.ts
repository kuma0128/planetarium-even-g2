import { test, expect } from "@playwright/test";
import { host, hold, gravity, range, reference, expectDeliveredFrame, calibrateTilt } from "./helpers/g2-host.ts";

test("A sensor acknowledgement without readings cannot enable calibration and can be retried", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await page.locator("#head-start").click();
  await expect(page.locator("#head-state")).toHaveText("Waiting for sensor");
  await expect(page.locator("#align-direction")).toBeDisabled();
  await expect(page.locator("#head-status")).toContainText("No G2 sensor readings received");
  await expect(page.locator("#head-scope")).toContainText("Up / down only");
  await page.locator("#head-stop").click();
  await page.locator("#head-start").click();
  await hold(page, gravity(30));
  await expect(page.locator("#align-direction")).toBeEnabled();
  await expect(page.locator("#head-status")).not.toContainText("No G2 sensor readings");
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
  await page.locator("#align-direction").click();
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
  await page.locator("#align-direction").click();
  await expect(page.locator("#head-status")).toContainText("Wait for at least four fresh readings");
  await hold(page, gravity(30));
  await expect(page.locator("#head-status")).toContainText("Wait for at least four fresh readings");
  await expect(page.locator("#lens-footer")).toContainText("Pose not captured");
  await page.locator("#align-direction").click();
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
  await page.locator("#align-direction").click();
  await expect(page.locator("#head-status")).toContainText("Align another direction or Stop");
  await expect(page.locator("#head-status")).toContainText("between −60° and 60°");
  await page.locator("#head-stop").click();
  await range(page, "#pitch", "30");
  await calibrateTilt(page);
});

test("The direction-reference button starts tilt from the chosen elevation and can realign without reconnecting", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await reference(page, "0");
  await range(page, "#heading", "90");
  await expect(page.locator("#align-direction")).toBeDisabled();
  await page.locator("#head-start").click();
  await hold(page, gravity(20));
  await page.getByRole("button", { name: "1. Use this direction as reference" }).click();
  await expect(page.locator("#head-reference")).toContainText("90° true north · elevation 0°");
  await expect(page.locator("#head-state")).not.toHaveText("Tracking");
  await expect(page.locator("#pitch-value")).toHaveText("0°");
  await hold(page, gravity(50));
  await page.locator("#head-up").click();
  await expect(page.locator("#head-state")).toHaveText("Tracking");
  await expect(page.locator("#pitch-value")).toHaveText("30°");
  await hold(page, gravity(10));
  await expect(page.locator("#pitch-value")).toHaveText("-10°");
  await expect(page.locator("#heading-readout")).toHaveText("90");

  await page.getByRole("button", { name: "Align another direction" }).click();
  await expect(page.locator("#head-reference")).toContainText("No reference set");
  await expect(page.locator("#pitch-value")).toHaveText("-10°");
  await range(page, "#heading", "270");
  await range(page, "#pitch", "10");
  await hold(page, gravity(25));
  await page.locator("#align-direction").click();
  await expect(page.locator("#head-reference")).toContainText("270° true north · elevation 10°");
  await hold(page, gravity(55));
  await page.locator("#head-up").click();
  await expect(page.locator("#pitch-value")).toHaveText("40°");
  await hold(page, gravity(15));
  await expect(page.locator("#pitch-value")).toHaveText("0°");
  await expect(page.locator("#heading-readout")).toHaveText("270");
  await expectDeliveredFrame(page);
  expect(await page.evaluate(() => window.__g2Test.calls.filter(
    call => call.method === "imuControl" && call.data?.iMUReportEn === 1,
  ).length)).toBe(1);
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
  await expect(page.locator("#align-direction")).toBeEnabled();
});

test("A calibration error remains readable while further sensor samples arrive", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await page.locator("#head-start").click();
  await hold(page, gravity(30));
  await page.locator("#align-direction").click();
  await hold(page, gravity(30));
  await page.locator("#head-up").click();
  await expect(page.locator("#head-status")).toContainText("try again");
  await hold(page, gravity(30));
  await expect(page.locator("#head-status")).toContainText("try again");
  await expect(page.locator("#lens-footer")).toContainText("Pose not captured");
});
