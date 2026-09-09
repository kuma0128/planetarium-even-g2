import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MotionStream } from "../src/motion-stream.ts";

test("Stop wins over an in-flight native start and no commands overlap", async () => {
  const calls: boolean[] = [];
  let release!: (ok: boolean) => void;
  const stream = new MotionStream(async (enabled) => {
    calls.push(enabled);
    if (enabled)
      return new Promise((resolve) => {
        release = resolve;
      });
    return true;
  });
  const start = stream.setEnabled(true);
  await setImmediate();
  assert.equal(stream.accepting, true);
  const stop = stream.setEnabled(false);
  assert.equal(stream.accepting, false);
  assert.deepEqual(calls, [true]);
  release(true);
  await Promise.all([start, stop]);
  assert.deepEqual(calls, [true, false]);
});

test("A queued start is cancelled by closing the sensor session", async () => {
  const calls: boolean[] = [];
  const stream = new MotionStream(async (enabled) => {
    calls.push(enabled);
    return true;
  });
  const start = stream.setEnabled(true);
  await stream.close();
  await start;
  assert.deepEqual(calls, [false]);
  await assert.rejects(stream.setEnabled(true), /Reconnect/);
  assert.equal(stream.accepting, false);
});

test("Sensor errors are reported, stop remains possible and a later retry can succeed", async () => {
  let attempts = 0;
  const stream = new MotionStream(
    async (enabled) => !enabled || ++attempts > 1,
  );
  await assert.rejects(stream.setEnabled(true), /could not start/);
  assert.equal(stream.accepting, false);
  await stream.setEnabled(false);
  await stream.setEnabled(true);
  assert.equal(stream.accepting, true);
});
