import { expect, test } from "@playwright/test";
import { range } from "./helpers/g2-host.ts";

test("Manual direction works without phone sensor permission and ignores orientation events", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(DeviceOrientationEvent, { requestPermission: () => {
      throw new Error("Phone sensor permission must not be requested");
    } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByText("North reference & calibration", { exact: true }).click();
  await page.selectOption("#north-reference", "true");
  await page.locator('[data-heading="90"]').click();
  await expect(page.locator("#heading-readout")).toHaveText("90");
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event("deviceorientation"), {
    alpha: 180, beta: 0, gamma: 0, absolute: true, webkitCompassHeading: 180,
  })));
  await expect(page.locator("#heading-source")).toHaveText("Manual");
  await expect(page.locator("#heading")).toHaveValue("90");
  await expect(page.getByRole("button", { name: "Phone compass" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Manual north reference and offset apply once and wrap across north", async ({ page }) => {
  await page.goto("/");
  await page.getByText("North reference & calibration", { exact: true }).click();
  await page.selectOption("#north-reference", "true");
  await range(page, "#heading", "359");
  await page.locator("#offset").fill("2");
  await page.locator("#offset").press("Tab");
  await expect(page.locator("#heading-readout")).toHaveText("1");
  await expect(page.locator("#heading-value")).toHaveText("359°");
  await page.selectOption("#north-reference", "magnetic");
  await expect(page.locator("#heading-readout")).not.toHaveText("1");
  await page.selectOption("#north-reference", "true");
  await expect(page.locator("#heading-readout")).toHaveText("1");
});
