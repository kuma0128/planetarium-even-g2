import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { LatestFrameQueue } from "../src/frame-queue.ts";

test("BLE backpressure never overlaps sends and drops superseded waiting frames", async () => {
  const started: number[] = [];
  let release!: () => void;
  const queue = new LatestFrameQueue<number>(
    async (frame) => {
      started.push(frame);
      if (frame === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
    (error) => assert.fail(String(error)),
  );
  queue.submit(1);
  queue.submit(2);
  queue.submit(3);
  assert.deepEqual(started, [1]);
  release();
  await setImmediate();
  assert.deepEqual(started, [1, 3]);
});
test("A failed send reports the failure once and stops subsequent sends", async () => {
  const errors: unknown[] = [];
  const started: number[] = [];
  const queue = new LatestFrameQueue<number>(
    async (frame) => {
      started.push(frame);
      throw new Error("BLE lost");
    },
    (error) => errors.push(error),
  );
  queue.submit(1);
  queue.submit(2);
  await setImmediate();
  queue.submit(3);
  await setImmediate();
  assert.deepEqual(started, [1]);
  assert.equal(errors.length, 1);
});
test("Stopping a busy queue prevents the pending frame from being sent", async () => {
  const started: number[] = [];
  let release!: () => void;
  const queue = new LatestFrameQueue<number>(
    async (frame) => {
      started.push(frame);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    (error) => assert.fail(String(error)),
  );
  queue.submit(1);
  queue.submit(2);
  queue.stop();
  release();
  await setImmediate();
  assert.deepEqual(started, [1]);
});

test("Reconnection can await the last native send even after the queue is stopped", async () => {
  let release!: () => void;
  let drained = false;
  const queue = new LatestFrameQueue<number>(
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    (error) => assert.fail(String(error)),
  );
  queue.submit(1);
  queue.stop();
  const idle = queue.idle().then(() => {
    drained = true;
  });
  await setImmediate();
  assert.equal(drained, false);
  release();
  await idle;
  assert.equal(drained, true);
});
