import { test, expect } from "@playwright/test";
import { host, expectDeliveredFrame } from "./helpers/g2-host.ts";

for (const sky of [false, true]) {
  test(`Exit dialog can reopen after three No selections on the ${sky ? "sky" : "startup"} page`, async ({ page }) => {
    await host(page);
    await page.goto("/");
    await expect(page.locator("#bridge-status")).toHaveText("Connected to G2.");
    if (sky) {
      await page.locator("#location-form button").click();
      await expectDeliveredFrame(page);
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("evenHubEvent", {
        detail: { sysEvent: { eventType: 3 } },
      })));
      await expect.poll(() => page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "shutDownPageContainer").length)).toBe(attempt);
      // Native overlay opens (4), then No dismisses it (5). The command's
      // acknowledgement is not the user's answer. No reconnect occurs.
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType: 4 } } }));
        window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType: 5 } } }));
      });
    }
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("evenHubEvent", {
      detail: { textEvent: { eventType: 0, containerID: 1, containerName: "sky-events" } },
    })));
    await expect(page.locator("#tonight")).toHaveAttribute("aria-pressed", "true");
    if (sky) await expectDeliveredFrame(page);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
    // A later Yes still terminates the session via the real system exit event.
    await page.evaluate(() => {
      for (const eventType of [3, 4, 5, 7])
        window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType } } }));
    });
    await expect(page.locator("#bridge-status")).toHaveText("G2 display closed.");
  });
}

for (const result of [false, "throw"] as const) {
  test(`A rejected dialog request (${result}) allows the next double-tap`, async ({ page }) => {
    await host(page);
    await page.goto("/");
    await expect(page.locator("#bridge-status")).toHaveText("Connected to G2.");
    await page.evaluate(result => {
      window.__g2Test.shutdownResult = result;
      window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType: 3 } } }));
    }, result);
    await expect(page.locator("#bridge-status")).toContainText("Could not open the exit dialog");
    await page.evaluate(() => {
      window.__g2Test.shutdownResult = true;
      window.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { sysEvent: { eventType: 3 } } }));
    });
    await expect.poll(() => page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "shutDownPageContainer").length)).toBe(2);
  });
}
