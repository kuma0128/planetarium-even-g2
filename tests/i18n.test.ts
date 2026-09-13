import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage, formatSkyTime, getLanguage, languages, message, MessageError, setLanguage, t, translate } from "../src/i18n.ts";
import { translations } from "../src/locales.ts";
import { wrapCaption } from "../src/render.ts";

test("English is the default and unsupported languages fall back to English", () => {
  assert.equal(getLanguage(), "en");
  setLanguage("unsupported");
  assert.equal(t("Connect G2"), "Connect G2");
});

test("All translations preserve placeholders, with nested statuses resolved at display time", () => {
  for (const [key, values] of Object.entries(translations)) {
    const placeholders = (value: string) => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    for (const value of values) {
      assert.ok(value.trim(), key);
      assert.deepEqual(placeholders(value), placeholders(key), key);
    }
  }
  const source = message("{0} The selected sky time stays fixed.", "30 minutes after astronomical twilight ends.");
  const error = new MessageError(message("Could not send the sky map ({0}).", "7"));
  for (const language of languages) {
    setLanguage(language);
    assert.ok(!translate(source).includes("{0}"));
    assert.ok(translate(errorMessage(error)).includes("7"));
    assert.equal(t("Sirius"), "Sirius");
    assert.ok(formatSkyTime(new Date("2026-01-15T21:00:00Z")).includes("2026"));
  }
  assert.equal(error.message, "Could not send the sky map (7).");
  setLanguage("en");
});

test("Canvas captions wrap unspaced Japanese and Chinese without losing characters", () => {
  for (const content of ["選択した方位角と仰角を向いてください", "请在手机上查看传感器状态", "머리를 옆으로 기울이지 마세요"]) {
    const lines = wrapCaption(content, 5, value => Array.from(value).length);
    assert.ok(lines.every(line => Array.from(line).length <= 5));
    assert.equal(lines.join("").replaceAll(" ", ""), content.replaceAll(" ", ""));
  }
  assert.deepEqual(wrapCaption("Hold still; tap\nto capture.", 12, value => value.length), ["Hold still;", "tap", "to capture."]);
});
