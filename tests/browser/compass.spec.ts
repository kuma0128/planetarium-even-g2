import { expect, test } from "@playwright/test";

test("An Even view without compass readings returns to usable manual controls", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      flutter_inappwebview: { callHandler: async () => 1 },
    });
    Object.assign(DeviceOrientationEvent, { requestPermission: async () => "granted" });
  });
  await page.goto("/");
  await page.locator("#phone-mode").click();
  await expect(page.locator("#compass-status")).toContainText("Location permission", { timeout: 7000 });
  await expect(page.locator("#manual-mode")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#heading")).toBeEnabled();
  await page.locator('[data-heading="90"]').click();
  await expect(page.locator("#heading")).toHaveValue("90");
});

test("Denied orientation access explains the Even limitation without disabling manual input", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { flutter_inappwebview: { callHandler: async () => 1 } });
    Object.assign(DeviceOrientationEvent, { requestPermission: async () => "denied" });
  });
  await page.goto("/");
  await page.locator("#phone-mode").click();
  await expect(page.locator("#compass-status")).toContainText("Location permission");
  await expect(page.locator("#heading")).toBeEnabled();
});

test("Mixed absolute and relative orientation events keep the live compass status stable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(DeviceOrientationEvent, { requestPermission: async () => "granted" });
  });
  await page.goto("/");
  await page.locator("#phone-mode").click();
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event("deviceorientation"), {
    alpha: 0, beta: 0, gamma: 0, absolute: false,
  })));
  await expect(page.locator("#compass-status")).toContainText("No north-referenced");
  const statuses = await page.evaluate(async () => {
    const statuses: string[] = [];
    for (let i = 0; i < 12; i++) {
      window.dispatchEvent(Object.assign(new Event("deviceorientationabsolute"), {
        alpha: 90, beta: 0, gamma: 0, absolute: true,
      }));
      window.dispatchEvent(Object.assign(new Event("deviceorientation"), {
        alpha: i * 10, beta: 0, gamma: 0, absolute: false,
      }));
      statuses.push(document.querySelector("#compass-status")!.textContent!);
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    return statuses;
  });
  expect(statuses).toEqual(Array(12).fill("Following the phone compass."));
  await expect(page.locator("#heading")).toHaveValue("270");
  await expect(page.locator("#heading-source")).toHaveText("Phone");
});

test("A valid phone compass uses its magnetic reference and reports tilt and stale data", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(DeviceOrientationEvent, { requestPermission: async () => "granted" });
  });
  await page.goto("/");
  await page.getByText("North reference & calibration", { exact: true }).click();
  await page.selectOption("#north-reference", "true");
  await page.locator("#phone-mode").click();
  await page.evaluate(() => {
    // WebKit exposes the event type but does not allow constructing it.
    const event = Object.assign(new Event("deviceorientation"), {
      alpha: 0, beta: 0, gamma: 0, absolute: false,
      webkitCompassHeading: 90, webkitCompassAccuracy: 5,
    });
    window.dispatchEvent(event);
  });
  await expect(page.locator("#heading")).toHaveValue("90");
  await expect(page.locator("#north-reference")).toHaveValue("magnetic");
  await expect(page.locator("#north-reference")).toBeDisabled();
  await expect(page.locator("#heading-source")).toHaveText("Phone");
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event("deviceorientation"), {
    alpha: 120, beta: 90, gamma: 0, absolute: true,
  })));
  await expect(page.locator("#compass-status")).toContainText("flat");
  await expect(page.locator("#heading")).toHaveValue("90");
  await expect(page.locator("#heading-source")).toHaveText("Phone: waiting", { timeout: 6500 });
  await page.locator("#manual-mode").click();
  await expect(page.locator("#north-reference")).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event("deviceorientationabsolute"), {
    alpha: 180, beta: 0, gamma: 0, absolute: true,
  })));
  await expect(page.locator("#heading")).toHaveValue("90");
});
