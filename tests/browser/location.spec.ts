import { test, expect } from "@playwright/test";
import { host } from "./helpers/g2-host.ts";

for (const locationResult of ["success", "null", "failure", "pending"] as const) {
  test(`Location lookup uses a browser fallback when the host result is ${locationResult}`, async ({ page }) => {
    await host(page, { locationResult });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        getCurrentPosition: (success: PositionCallback) => success({
          coords: { latitude: 48.85, longitude: 2.35, altitude: null },
        } as GeolocationPosition),
      } });
    });
    await page.goto("/");
    await expect(page.locator("#bridge-status")).toHaveText("Connected to G2.");
    await page.locator("#locate").click();
    if (locationResult === "pending") await expect(page.locator("#locate")).toBeDisabled();
    await expect(page.locator("#location-status")).toContainText("Using your current location", { timeout: 11000 });
    await expect(page.locator("#locate")).toBeEnabled();
    await expect(page.locator("#latitude")).toHaveValue(locationResult === "success" ? "51.5" : "48.85");
    await expect(page.locator("#longitude")).toHaveValue(locationResult === "success" ? "-0.12" : "2.35");
    expect(await page.evaluate(() => window.__g2Test.calls.find(call => call.method === "getAppLocation")?.data)).toMatchObject({
      accuracy: "high", timeoutMs: 8000,
    });
  });
}

test("Location errors leave the button usable and manual coordinates can recover", async ({ page }) => {
  await host(page, { locationResult: "failure" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) =>
        failure({ code: 1, message: "Permission denied" } as GeolocationPositionError),
    } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#bridge-status")).toHaveText("Connected to G2.");
  await page.locator("#locate").click();
  await expect(page.locator("#location-status")).toContainText("Unable to get your location");
  await expect(page.locator("#locate")).toBeEnabled();
  // Bypass browser constraint validation to exercise the submit handler's guard.
  await page.locator("#latitude").fill("91");
  await page.locator("#location-form").evaluate(form => form.dispatchEvent(new Event("submit", { cancelable: true })));
  await expect(page.locator("#location-status")).toContainText("Check the latitude");
  await page.locator("#latitude").fill("35");
  await page.locator("#location-form button").click();
  await expect(page.locator("#location-status")).toContainText("Using your selected observing location");
  expect(errors).toEqual([]);
});
