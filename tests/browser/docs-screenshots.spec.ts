import { test } from "@playwright/test";
import { host, hold, gravity, range, reference, calibrateTilt } from "./helpers/g2-host.ts";

// Regenerates the README images. Opt in so the regular suite does not rewrite docs:
//   DOCS_SCREENSHOTS=1 npx playwright test tests/browser/docs-screenshots.spec.ts
test.skip(!process.env.DOCS_SCREENSHOTS, "Set DOCS_SCREENSHOTS=1 to regenerate README images");

test("README: browser preview, Tonight in Tokyo facing west", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto("/");
  await page.locator("#tonight").click();
  await page.locator("#location-form button").click();
  await range(page, "#heading", "270");
  await range(page, "#pitch", "30");
  await page.locator("#sky-info").check();
  await page.locator("#sky-labels").check();
  await page.waitForTimeout(800);
  await page.screenshot({
    path: "docs/images/planetarium-ui.jpg",
    type: "jpeg",
    quality: 85,
    fullPage: true,
  });
});

test("README: G2 head tilt panel while tracking, with sensor details and the log", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await hold(page, gravity(42));
  // Keep readings flowing so the panel stays in the Tracking state.
  await page.evaluate((sample) => {
    window.setInterval(() => window.__g2Test.emit(sample), 100);
  }, gravity(42));
  await page.locator("#head-diagnostics summary").click();
  await page.locator("#head-download").click();
  await page.waitForTimeout(600);
  await page
    .locator("section.head-tracking")
    .screenshot({ path: "docs/images/head-tilt-diagnostics.png" });
});
