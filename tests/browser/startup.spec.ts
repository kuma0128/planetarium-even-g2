import { test, expect } from "@playwright/test";
import { host, expectDeliveredFrame } from "./helpers/g2-host.ts";

for (const result of [0, 1, "throw"] as const) {
  test(`Startup times out, drains a late ${result} response, and permits a fresh connection`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await host(page, { blockStartup: true, startupResult: result });
    await page.goto("/");
    await page.locator("#location-form button").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.startupInFlight)).toBe(1);
    // A sensor start sharing the pending connection must recover its UI too.
    await page.locator("#head-start").click();
    await expect(page.locator("#bridge-status")).toContainText("did not finish creating", { timeout: 8000 });
    await expect(page.locator("#head-status")).toContainText("did not finish creating");
    await expect(page.locator("#connect")).toBeEnabled();
    await expect(page.locator("#head-start")).toBeEnabled();
    await expect(page.locator("#head-state")).toHaveText("Off");

    // Timeout releases the UI, but cannot cancel native page creation.
    await page.locator("#connect").click();
    await expect(page.locator("#bridge-status")).toContainText("previous G2 session", { timeout: 6000 });
    await expect(page.locator("#connect")).toBeEnabled();
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
    await page.evaluate(() => {
      window.__g2Test.blockStartup = false;
      window.__g2Test.startupResult = 0;
      window.__g2Test.releaseStartup();
    });
    await expect.poll(() => page.evaluate(() => window.__g2Test.startupInFlight)).toBe(0);
    await expect(page.locator("#bridge-status")).toContainText("previous G2 session");
    await expect(page.locator("#preview-status")).toContainText("Connect G2");
    expect(await page.evaluate(() => window.__g2Test.calls.some(call => call.method === "updateImageRawData" || call.method === "imuControl"))).toBe(false);

    await page.locator("#connect").click();
    await expectDeliveredFrame(page);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(2);
    expect(await page.evaluate(() => window.__g2Test.maxStartupInFlight)).toBe(1);
    expect(errors).toEqual([]);
  });
}

for (const event of ["disconnect", "exit", "abnormal-exit"] as const) {
  test(`A ${event} during startup survives the late success response`, async ({ page }) => {
    await host(page, { blockStartup: true });
    await page.goto("/");
    await page.locator("#location-form button").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.startupInFlight)).toBe(1);
    await page.locator("#head-start").click();
    await page.evaluate(event => {
      window.dispatchEvent(event === "disconnect"
        ? new CustomEvent("deviceStatusChanged", { detail: { sn: "test-g2", connectType: "disconnected" } })
        : new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType: event === "exit" ? 6 : 7 } } }));
    }, event);
    const status = event === "disconnect" ? "disconnected" : "closed";
    await expect(page.locator("#bridge-status")).toContainText(status);
    await expect(page.locator("#head-state")).toHaveText("Off");
    await page.evaluate(() => {
      window.__g2Test.blockStartup = false;
      window.__g2Test.releaseStartup();
    });
    await expect(page.locator("#connect")).toBeEnabled();
    await expect(page.locator("#bridge-status")).toContainText(status);
    await expect(page.locator("#preview-status")).toContainText("Connect G2");
    expect(await page.evaluate(() => window.__g2Test.calls.some(call => call.method === "updateImageRawData" || call.method === "imuControl"))).toBe(false);
    await page.locator("#connect").click();
    await expectDeliveredFrame(page);
  });
}

test("Foreground exit during startup keeps delivery and motion paused until re-entry", async ({ page }) => {
  await host(page, { blockStartup: true });
  await page.goto("/");
  await page.locator("#location-form button").click();
  await expect.poll(() => page.evaluate(() => window.__g2Test.startupInFlight)).toBe(1);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType: 5 } } }));
    window.__g2Test.blockStartup = false;
    window.__g2Test.releaseStartup();
  });
  await expect(page.locator("#connect")).toBeEnabled();
  await expect(page.locator("#preview-status")).toContainText("background");
  await page.locator("#head-start").click();
  await expect(page.locator("#head-status")).toContainText("Return to the G2 foreground");
  expect(await page.evaluate(() => window.__g2Test.calls.some(call => call.method === "updateImageRawData" || (call.method === "imuControl" && call.data?.iMUReportEn === 1)))).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType: 4 } } })));
  await expectDeliveredFrame(page);
  expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
});

test("Foreground re-entry before startup completes is retained, but early gestures are ignored", async ({ page }) => {
  await host(page, { blockStartup: true });
  await page.goto("/");
  await page.locator("#location-form button").click();
  await expect.poll(() => page.evaluate(() => window.__g2Test.startupInFlight)).toBe(1);
  await page.evaluate(() => {
    for (const eventType of [5, 4, 0, 1, 2, 3])
      window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType } } }));
    window.__g2Test.blockStartup = false;
    window.__g2Test.releaseStartup();
  });
  await expectDeliveredFrame(page);
  await expect(page.locator("#now")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#heading")).toHaveValue("180");
  expect(await page.evaluate(() => window.__g2Test.calls.some(call => call.method === "shutDownPageContainer"))).toBe(false);
});

test("A rejected startup removes lifecycle listeners before retrying", async ({ page }) => {
  await host(page, { startupResult: 1 });
  await page.goto("/");
  await expect(page.locator("#bridge-status")).toContainText("Could not create the G2 display");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType: 6 } } }));
    window.dispatchEvent(new CustomEvent("deviceStatusChanged", { detail: { sn: "test-g2", connectType: "disconnected" } }));
    window.__g2Test.startupResult = 0;
  });
  await expect(page.locator("#bridge-status")).toContainText("Could not create the G2 display");
  await page.locator("#location-form button").click();
  await page.locator("#connect").click();
  await expectDeliveredFrame(page);
});
