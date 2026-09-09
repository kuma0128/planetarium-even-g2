import { test, expect } from "@playwright/test";
import { host, hold, gravity, reference, expectDeliveredFrame, calibrateTilt } from "./helpers/g2-host.ts";

for (const busy of [false, true]) {
  test(`Background updates pause and resume without reconnecting with a transfer ${busy ? "in flight" : "idle"}`, async ({ page }) => {
    await host(page);
    await page.goto("/");
    await page.locator("#date").fill("2026-01-15T21:00");
    await page.locator("#date").press("Tab");
    await page.locator("#location-form button").click();
    await expectDeliveredFrame(page);
    const before = await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length);
    if (busy) {
      await page.evaluate(() => { window.__g2Test.blockImages = true; });
      await page.locator("#refresh-display").click();
      await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(1);
      await page.locator("#sky-info").check();
      await expect(page.locator("#lens-header")).toContainText("Custom");
      // Queue a changed snapshot behind the blocked transfer before exiting.
      await page.waitForTimeout(350);
    }
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("evenHubEvent", {
        detail: { sysEvent: { eventType: 5 } },
      }));
      window.__g2Test.failImages = true;
      window.__g2Test.blockImages = false;
      window.__g2Test.releaseImage();
    });
    await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(0);
    await page.locator("#date").fill("2026-01-15T22:00");
    await page.locator("#date").press("Tab");
    await page.selectOption("#fov", "60");
    await page.locator("#refresh-display").click();
    await expect(page.locator("#preview-status")).toContainText("background");
    await page.locator("#head-start").click();
    await expect(page.locator("#head-status")).toContainText("Return to the G2 foreground");
    await expect(page.locator("#head-state")).toHaveText("Off");
    // Include the periodic render, as well as user-requested updates.
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length)).toBe(before + (busy ? 1 : 0));
    expect(await page.evaluate(() => window.__g2Test.calls.some(call => call.method === "imuControl" && call.data?.iMUReportEn === 1))).toBe(false);
    await page.evaluate(() => {
      window.__g2Test.failImages = false;
      window.__g2Test.images = {};
      window.dispatchEvent(new CustomEvent("evenHubEvent", {
        detail: { sysEvent: { eventType: 4 } },
      }));
    });
    await expectDeliveredFrame(page);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length)).toBe(before + (busy ? 1 : 0) + 4);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
    expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
  });
}

for (const failure of ["result", "throw"] as const) {
  test(`A pre-exit image ${failure} failure arriving after re-entry cannot stop the resumed display`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await host(page);
    await page.goto("/");
    await page.locator("#date").fill("2026-01-15T21:00");
    await page.locator("#date").press("Tab");
    await page.locator("#location-form button").click();
    await expectDeliveredFrame(page);
    const before = await page.evaluate(failure => {
      window.__g2Test.blockImages = true;
      window.__g2Test.nextImageFailure = failure;
      return window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length;
    }, failure);
    await page.locator("#refresh-display").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("evenHubEvent", {
      detail: { sysEvent: { eventType: 5 } },
    })));
    await page.selectOption("#fov", "60");
    await expect(page.locator("#preview-status")).toContainText("background");
    await page.evaluate(() => {
      window.__g2Test.images = {};
      window.dispatchEvent(new CustomEvent("evenHubEvent", {
        detail: { sysEvent: { eventType: 4 } },
      }));
      window.__g2Test.blockImages = false;
      window.__g2Test.releaseImage();
    });
    await expectDeliveredFrame(page);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length)).toBe(before + 5);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
    expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
    expect(errors).toEqual([]);
  });
}

for (const failure of ["result", "throw"] as const) {
  test(`A single rejected tile (${failure}) is retried without ending the session or head tracking`, async ({ page }) => {
    await host(page);
    await page.goto("/");
    await reference(page);
    await calibrateTilt(page);
    await expectDeliveredFrame(page);
    const sensorTimer = await page.evaluate(sample =>
      window.setInterval(() => window.__g2Test.emit(sample), 100), gravity(60));
    try {
      const before = await page.evaluate(failure => {
        window.__g2Test.images = {};
        window.__g2Test.nextImageFailure = failure;
        return window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length;
      }, failure);
      await page.locator("#refresh-display").click();
      await expectDeliveredFrame(page);
      // Four forced tiles plus the retry of the rejected one.
      expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length)).toBeGreaterThanOrEqual(before + 5);
      await expect(page.locator("#bridge-status")).toHaveText("Sky map sent to G2.");
      await expect(page.locator("#head-state")).toHaveText("Tracking");
      expect(await page.evaluate(() => window.__g2Test.motion)).toBe(true);
      expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
      expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
    } finally {
      await page.evaluate(timer => window.clearInterval(timer), sensorTimer);
    }
  });
}

test("Showing the page again after pagehide restarts it even without a cache restore", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await expect(page.locator("#bridge-status")).toHaveText("Connected to G2.");
  await page.locator("#head-start").click();
  await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
  await page.evaluate(() => {
    (window as Window & { __sameDocument?: boolean }).__sameDocument = true;
    window.dispatchEvent(new Event("pagehide"));
  });
  await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(false);
  const reloaded = page.waitForEvent("load");
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })),
  ).catch(() => {});
  await reloaded;
  expect(await page.evaluate(() => (window as Window & { __sameDocument?: boolean }).__sameDocument)).toBeUndefined();
  await expect(page.locator("#bridge-status")).toHaveText("Connected to G2.");
});

test("A rejected sensor close does not poison subsequent reconnects", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await page.locator("#location-form button").click();
  await expectDeliveredFrame(page);
  await page.evaluate(() => { window.__g2Test.failMotionStop = true; });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator("#head-start").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("deviceStatusChanged", {
      detail: { sn: "test-g2", connectType: "disconnected" },
    })));
    await expect(page.locator("#bridge-status")).toContainText("disconnected");
    await page.locator("#connect").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(attempt + 2);
    await expectDeliveredFrame(page);
  }
});

for (const busy of [false, true]) {
  test(`Returning to the G2 foreground restores unchanged tiles with a transfer ${busy ? "in flight" : "idle"}`, async ({ page }) => {
    await host(page);
    await page.goto("/");
    await page.locator("#date").fill("2026-01-15T21:00");
    await page.locator("#date").press("Tab");
    await page.locator("#location-form button").click();
    await expectDeliveredFrame(page);
    const before = await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length);
    if (busy) {
      await page.evaluate(() => { window.__g2Test.blockImages = true; });
      await page.locator("#refresh-display").click();
      await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(1);
    }
    await page.evaluate(() => {
      window.__g2Test.images = {};
      window.dispatchEvent(new CustomEvent("evenHubEvent", {
        detail: { sysEvent: { eventType: 4 } },
      }));
      window.__g2Test.blockImages = false;
      window.__g2Test.releaseImage();
    });
    await expect.poll(() => page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "updateImageRawData").length)).toBe(before + (busy ? 8 : 4));
    await expectDeliveredFrame(page);
    expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
    await expect(page.locator("#head-state")).toHaveText("Off");
  });
}

test("Disconnect stops tracking and reconnect requires a new calibration", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("deviceStatusChanged", {
        detail: { sn: "test-g2", connectType: "disconnected" },
      }),
    ),
  );
  await expect(page.locator("#head-state")).toHaveText("Off");
  await expect(page.locator("#bridge-status")).toContainText("disconnected");
  await page.locator("#head-start").click();
  await hold(page, gravity(30));
  await expect(page.locator("#align-direction")).toBeEnabled();
  await expect(page.locator("#head-up")).toBeDisabled();
});

for (const eventType of [6, 7]) {
  test(`G2 exit event ${eventType} immediately stops the display and sensor`, async ({ page }) => {
    await host(page);
    await page.goto("/");
    await expect(page.locator("#bridge-status")).toHaveText("Connected to G2.");
    await page.locator("#head-start").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
    await page.evaluate(eventType => window.dispatchEvent(new CustomEvent("evenHubEvent", {
      detail: { sysEvent: { eventType } },
    })), eventType);
    await expect(page.locator("#bridge-status")).toContainText("closed");
    await expect(page.locator("#head-state")).toHaveText("Off");
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(false);
    await page.locator("#location-form button").click();
    await expect(page.locator("#preview-status")).toContainText("Connect G2");
    // Refresh only resends tiles; reconnecting stays with Connect G2.
    await expect(page.locator("#refresh-display")).toBeDisabled();
    expect(await page.evaluate(() => window.__g2Test.calls.some(call => call.method === "updateImageRawData"))).toBe(false);
    await page.locator("#connect").click();
    await expectDeliveredFrame(page);
    await expect(page.locator("#refresh-display")).toBeEnabled();
  });
}

for (const info of ["pending", "null", "failure", "other-model"] as const) {
  test(`Disconnect is detected when G2 device information is ${info}`, async ({ page }) => {
    await host(page, {
      blockDeviceInfo: info === "pending",
      failDeviceInfo: info === "failure",
      deviceInfo: info === "null" ? null : {
        model: info === "other-model" ? "ring1" : "g2", sn: "test-g2",
      },
    });
    await page.goto("/");
    await expect(page.locator("#bridge-status")).toHaveText("Connected to G2.");
    await page.locator("#head-start").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("deviceStatusChanged", {
      detail: { sn: "test-g2", connectType: "disconnected" },
    })));
    await expect(page.locator("#bridge-status")).toContainText("disconnected");
    await expect(page.locator("#head-state")).toHaveText("Off");
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(false);
    // A device-info response arriving after the disconnect must not revive it.
    await page.evaluate(() => window.__g2Test.releaseDeviceInfo());
    await page.locator("#location-form button").click();
    await expect(page.locator("#preview-status")).toContainText("Connect G2");
  });
}

test("A known G2 serial ignores other device disconnects but accepts its own connection failure", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await expect(page.locator("#bridge-status")).toHaveText("Connected to G2.");
  await page.locator("#head-start").click();
  await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("deviceStatusChanged", {
    detail: { sn: "test-ring", connectType: "disconnected" },
  })));
  await expect(page.locator("#head-stop")).toBeEnabled();
  expect(await page.evaluate(() => window.__g2Test.motion)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("deviceStatusChanged", {
    detail: { sn: "test-g2", connectType: "connectionFailed" },
  })));
  await expect(page.locator("#bridge-status")).toContainText("disconnected");
  await expect(page.locator("#head-state")).toHaveText("Off");
});

for (const blocked of ["image", "motion"] as const) {
  test(`Reconnect times out a stalled ${blocked} call and can be retried after it settles`, async ({ page }) => {
    await host(page);
    await page.goto("/");
    await reference(page);
    await expectDeliveredFrame(page);
    await page.locator("#head-start").click();
    await expect.poll(() => page.evaluate(() => window.__g2Test.motion)).toBe(true);
    await page.evaluate(blocked => {
      window.__g2Test.blockImages = blocked === "image";
      window.__g2Test.blockMotionStop = blocked === "motion";
    }, blocked);
    if (blocked === "image") {
      await page.locator("#refresh-display").click();
      await expect.poll(() => page.evaluate(() => window.__g2Test.imageInFlight)).toBe(1);
    }
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("deviceStatusChanged", {
      detail: { sn: "test-g2", connectType: "disconnected" },
    })));
    await expect(page.locator("#bridge-status")).toContainText("disconnected");
    await page.locator("#connect").click();
    await expect(page.locator("#connect")).toBeDisabled();
    await expect(page.locator("#bridge-status")).toContainText("previous G2 session", { timeout: 6000 });
    await expect(page.locator("#connect")).toBeEnabled();
    expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
    await page.evaluate(() => {
      const state = window.__g2Test;
      state.blockImages = state.blockMotionStop = false;
      state.releaseImage();
      state.releaseMotionStop();
    });
    await page.locator("#connect").click();
    await expectDeliveredFrame(page);
    await expect.poll(() => page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(2);
    expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
    await expect(page.locator("#head-state")).toHaveText("Off");
  });
}

test("Disconnecting an unused sensor leaves its setup message intact", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await expectDeliveredFrame(page);
  const initial = await page.locator("#head-status").textContent();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("deviceStatusChanged", {
    detail: { sn: "test-g2", connectType: "disconnected" },
  })));
  await expect(page.locator("#bridge-status")).toContainText("disconnected");
  await expect(page.locator("#head-status")).toHaveText(initial!);
  await expect(page.locator("#head-state")).toHaveText("Off");
});

test("A frame failure stops the sensor; reconnect redraws an unchanged sky", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await page.evaluate(() => {
    window.__g2Test.failImages = true;
  });
  await hold(page, gravity(10));
  await expect(page.locator("#bridge-status")).toContainText("updates stopped");
  await expect(page.locator("#head-state")).toHaveText("Off");
  await expect
    .poll(() => page.evaluate(() => window.__g2Test.motion))
    .toBe(false);
  const previous = await page.evaluate(
    () =>
      window.__g2Test.calls.filter((c) => c.method === "updateImageRawData")
        .length,
  );
  await page.evaluate(() => {
    window.__g2Test.failImages = false;
  });
  await page.locator("#head-start").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__g2Test.calls.filter((c) => c.method === "updateImageRawData")
            .length,
      ),
    )
    .toBeGreaterThan(previous + 1);
  expect(await page.evaluate(() => window.__g2Test.maxImageInFlight)).toBe(1);
});

test("Leaving the G2 foreground stops its motion session", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await page.locator("#head-start").click();
  await expect
    .poll(() => page.evaluate(() => window.__g2Test.motion))
    .toBe(true);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("evenHubEvent", {
        detail: { sysEvent: { eventType: 5 } },
      }),
    ),
  );
  await expect(page.locator("#head-state")).toHaveText("Off");
  await expect
    .poll(() => page.evaluate(() => window.__g2Test.motion))
    .toBe(false);
});
