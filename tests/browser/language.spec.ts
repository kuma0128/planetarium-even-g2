import { test, expect } from "@playwright/test";
import { host, range, reference, calibrateTilt, hold, gravity, expectDeliveredFrame } from "./helpers/g2-host.ts";

const locales = [
  { language: "ja", title: "見る方向", connect: "G2 に接続", custom: "日時指定", moon: "月の照明率", location: "選択した観測場所を使用しています。" },
  { language: "ko", title: "바라보는 방향", connect: "G2 연결", custom: "직접 설정", moon: "달의 밝은 면", location: "선택한 관측 위치를 사용 중입니다." },
  { language: "zh-CN", title: "观测方向", connect: "连接 G2", custom: "自定义", moon: "月面照明比例", location: "正在使用所选观测地点。" },
];

test("English remains the default regardless of the browser locale", async ({ browser }) => {
  const context = await browser.newContext({ locale: "ja-JP" });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#language")).toHaveValue("en");
  await expect(page.locator("#direction-title")).toHaveText("Viewing direction");
  await context.close();
});

for (const locale of locales) {
  test(`${locale.language}: translates live controls, captions and statuses, persists, and fits mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.locator("#date").fill("2026-01-15T21:00");
    await page.locator("#date").press("Tab");
    await page.locator("#location-form button").click();
    await range(page, "#heading", "90");
    await page.locator("#sky-info").check();
    await page.locator("#language").selectOption(locale.language);
    await expect(page.locator("html")).toHaveAttribute("lang", locale.language);
    await expect(page.locator("#direction-title")).toHaveText(locale.title);
    await expect(page.locator("#connect")).toContainText(locale.connect);
    await expect(page.locator("#location-status")).toHaveText(locale.location);
    await expect(page.locator("#lens-header")).toContainText(locale.custom);
    await expect(page.locator("#lens-footer")).toContainText(locale.moon);
    await expect(page.locator("#date")).toHaveValue("2026-01-15T21:00");
    await expect(page.locator("#heading")).toHaveValue("90");
    await expect(page.locator("#custom")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#sky-info")).toBeChecked();
    await expect(page.locator("#latitude")).toHaveValue("35.6812");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/language-${locale.language}-mobile.png`, fullPage: true });
    await page.reload();
    await expect(page.locator("#language")).toHaveValue(locale.language);
    await expect(page.locator("#direction-title")).toHaveText(locale.title);
    await page.locator("#language").selectOption("en");
    await expect(page.locator("#direction-title")).toHaveText("Viewing direction");
    await page.reload();
    await expect(page.locator("#language")).toHaveValue("en");
  });
}

test("Denied storage and invalid saved preferences do not prevent language selection", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("planetarium.language", "invalid"));
  await page.goto("/");
  await expect(page.locator("#language")).toHaveValue("en");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Denied", "SecurityError"); } });
  });
  await page.reload();
  await expect(page.locator("#language")).toHaveValue("en");
  await page.locator("#language").selectOption("ko");
  await expect(page.locator("#direction-title")).toHaveText("바라보는 방향");
});

test("Switching languages preserves calibration and resends the localized frame to G2", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await reference(page);
  await calibrateTilt(page);
  await page.evaluate(sample => {
    const timer = setInterval(() => window.__g2Test.emit(sample), 100);
    window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  }, gravity(60));
  const before = await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "imuControl").length);
  for (const [language, state] of [["ja", "追跡中"], ["ko", "추적 중"], ["zh-CN", "追踪中"], ["en", "Tracking"]]) {
    await page.locator("#language").selectOption(language!);
    await expect(page.locator("#head-state")).toHaveText(state!);
    await expectDeliveredFrame(page);
  }
  expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "imuControl").length)).toBe(before);
  expect(await page.evaluate(() => window.__g2Test.calls.filter(call => call.method === "createStartUpPageContainer").length)).toBe(1);
});

test("Calibration guidance and an existing sensor error change language without a restart", async ({ page }) => {
  await host(page);
  await page.goto("/");
  await page.locator("#head-start").click();
  await hold(page, gravity(30));
  await page.locator("#language").selectOption("ja");
  await expect(page.locator("#lens-footer")).toContainText("方向の基準を設定");
  await page.locator("#head-stop").click();
  await page.evaluate(() => { window.__g2Test.failMotion = true; });
  await page.locator("#head-start").click();
  await expect(page.locator("#head-status")).toContainText("開始できませんでした");
  await page.locator("#language").selectOption("ko");
  await expect(page.locator("#head-status")).toContainText("시작할 수 없습니다");
});
