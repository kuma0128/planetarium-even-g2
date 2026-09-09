/** One send at a time. While BLE is busy, retain only the newest requested view. */
export class LatestFrameQueue<T> {
  private pending: T | undefined;
  private running = false;
  private stopped = false;
  private idleWaiters: (() => void)[] = [];
  private send: (frame: T) => Promise<void>;
  private onError: (error: unknown) => void;
  constructor(
    send: (frame: T) => Promise<void>,
    onError: (error: unknown) => void,
  ) {
    this.send = send;
    this.onError = onError;
  }
  submit(frame: T): void {
    if (this.stopped) return;
    this.pending = frame;
    void this.drain();
  }
  stop(): void {
    this.stopped = true;
    this.pending = undefined;
  }
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped && this.pending !== undefined) {
        const frame = this.pending;
        this.pending = undefined;
        await this.send(frame);
      }
    } catch (error) {
      this.stop();
      this.onError(error);
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
