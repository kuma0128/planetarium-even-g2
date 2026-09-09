/** Serialize sensor commands so an in-flight start cannot undo a later stop. */
export class MotionStream {
  private operation: Promise<void> = Promise.resolve();
  private wanted = false;
  private closed = false;
  private revision = 0;
  private control: (enabled: boolean) => Promise<boolean>;
  constructor(control: (enabled: boolean) => Promise<boolean>) {
    this.control = control;
  }

  get accepting(): boolean {
    return this.wanted && !this.closed;
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (this.closed && enabled)
      return Promise.reject(
        new Error("Reconnect G2 before starting motion tracking."),
      );
    this.wanted = enabled;
    const revision = ++this.revision;
    const operation = this.operation
      .catch(() => {})
      .then(async () => {
        if (enabled && (revision !== this.revision || !this.accepting)) return;
        try {
          if (!(await this.control(enabled)))
            throw new Error(
              `G2 could not ${enabled ? "start" : "stop"} its motion sensor.`,
            );
        } catch (error) {
          if (revision === this.revision) this.wanted = false;
          throw error;
        }
      });
    this.operation = operation;
    return operation;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.setEnabled(false);
  }
}
