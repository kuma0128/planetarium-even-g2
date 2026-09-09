import { test, expect } from "@playwright/test";
import { host, hold, gravity, range, reference, calibrateTilt, expectDeliveredFrame } from "./helpers/g2-host.ts";

test("Temple and ring scroll pan across north while head tilt keeps following elevation", async ({ page }) => {
  await host(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#date").fill("2026-01-15T21:00");
  await page.locator("#date").press("Tab");
  await reference(page);
  await range(page, "#heading", "350");
  await calibrateTilt(page);

  // Cover both temple sources and the ring, including container-routed events
  // with source metadata in sysEvent but the scroll type in text/listEvent.
  for (const route of [
    { envelope: "sysEvent", eventSource: 1 },
    { envelope: "textEvent", eventSource: 3 },
    { envelope: "listEvent", eventSource: 2 },
  ]) {
    for (const step of [
      { eventType: 2, heading: "5", pitch: 20 },
      { eventType: 1, heading: "350", pitch: 45 },
    ]) {
      await page.evaluate(({ route, eventType }) => {
        const detail = route.envelope === "sysEvent"
          ? { sysEvent: { eventType, eventSource: route.eventSource } }
          : {
            sysEvent: { eventSource: route.eventSource },
            [route.envelope]: { eventType, containerID: 1, containerName: "sky-events" },
          };
        window.dispatchEvent(new CustomEvent("evenHubEvent", { detail }));
      }, { route, eventType: step.eventType });
      await hold(page, gravity(step.pitch));
      await expect(page.locator("#heading-readout")).toHaveText(step.heading);
      await expect(page.locator("#pitch-value")).toHaveText(`${step.pitch}°`);
      await expect(page.locator("#head-state")).toHaveText("Tracking");
      await expect(page.locator("#head-reference")).toContainText("350° true north · elevation 30°");
    }
  }
  await expect(page.locator("#custom")).toHaveAttribute("aria-pressed", "true");
  await expectDeliveredFrame(page);
  expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "imuControl").map(call => call.data)))
    .toEqual([{ iMUReportEn: 1, reportFrq: 100 }]);
});

test("Rapid temple scrolling keeps the final heading during slow image transfers and live head tilt", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await page.locator("#date").fill("2026-01-15T21:00");
  await page.locator("#date").press("Tab");
  await reference(page);
  await range(page, "#heading", "350");
  await calibrateTilt(page);
  const sensorTimer = await page.evaluate(sample => {
    window.__g2Test.imageDelay = 250;
    return window.setInterval(() => window.__g2Test.emit(sample), 100);
  }, gravity(20));
  try {
    await page.evaluate(() => {
      for (let i = 0; i < 12; i++) {
        window.dispatchEvent(new CustomEvent("evenHubEvent", {
          detail: {
            sysEvent: { eventSource: 1 },
            textEvent: { eventType: i < 10 ? 2 : 1, containerID: 1, containerName: "sky-events" },
          },
        }));
      }
    });
    // Ten right steps and two left steps: 350 + 150 - 30 wraps to 110°.
    await expect(page.locator("#heading-readout")).toHaveText("110");
    await expect(page.locator("#pitch-value")).toHaveText("20°");
    await expectDeliveredFrame(page);
    await expect(page.locator("#head-state")).toHaveText("Tracking");
    expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "imuControl").map(call => call.data)))
      .toEqual([{ iMUReportEn: 1, reportFrq: 100 }]);
  } finally {
    await page.evaluate(timer => window.clearInterval(timer), sensorTimer);
  }
});
