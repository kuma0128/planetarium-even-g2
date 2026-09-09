import { test, expect } from "@playwright/test";

test("An invalid date keeps the selected sky time and explains itself", async ({ page }) => {
  await page.goto("/");
  await page.locator("#date").fill("2026-01-15T21:00");
  await page.locator("#date").press("Tab");
  await expect(page.locator("#custom")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#date").fill("");
  await page.locator("#date").press("Tab");
  await expect(page.locator("#time-note")).toHaveText("Choose a valid date and time.");
  await expect(page.locator("#custom")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#sky-period")).toHaveText("Custom");
});
