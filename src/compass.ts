import geomagnetism from "geomagnetism";
import { angleDifference, validLocation, wrap, type Location } from "./sky.ts";

export type NorthReference = "magnetic" | "true";
export type HeadingSample = { heading: number; reference: NorthReference };
export const HEADING_TIMEOUT_MS = 4000;
type Orientation = Pick<
  DeviceOrientationEvent,
  "alpha" | "beta" | "gamma" | "absolute"
> & {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
};

export function readHeading(event: Orientation): HeadingSample | null {
  // This UI follows the physical top of a phone held flat, not its camera or the glasses.
  if (
    event.beta != null &&
    (!Number.isFinite(event.beta) || Math.abs(event.beta) > 45)
  )
    return null;
  if (
    event.gamma != null &&
    (!Number.isFinite(event.gamma) || Math.abs(event.gamma) > 45)
  )
    return null;
  if (Number.isFinite(event.webkitCompassHeading)) {
    if (
      event.webkitCompassAccuracy != null &&
      (!Number.isFinite(event.webkitCompassAccuracy) ||
        event.webkitCompassAccuracy < 0 ||
        event.webkitCompassAccuracy > 25)
    )
      return null;
    return {
      heading: wrap(event.webkitCompassHeading!),
      reference: "magnetic",
    };
  }
  // Relative alpha has no north reference and cannot be used as a compass.
  if (
    event.absolute &&
    event.alpha != null &&
    Number.isFinite(event.alpha) &&
    event.beta != null &&
    Number.isFinite(event.beta) &&
    event.gamma != null &&
    Number.isFinite(event.gamma)
  ) {
    return { heading: wrap(360 - event.alpha), reference: "magnetic" };
  }
  return null;
}

export function magneticDeclination(
  location: Location,
  physicalTime: Date,
): number | null {
  if (!validLocation(location) || !Number.isFinite(physicalTime.getTime()))
    return null;
  try {
    const field = geomagnetism
      .model(physicalTime)
      .point([location.latitude, location.longitude, location.height / 1000]);
    return Number.isFinite(field.decl) && field.h >= 2000 ? field.decl : null;
  } catch {
    return null;
  }
}

export function trueHeading(
  sample: HeadingSample,
  declination: number | null,
  offset = 0,
): number | null {
  if (!Number.isFinite(sample.heading) || !Number.isFinite(offset)) return null;
  if (
    sample.reference === "magnetic" &&
    (declination == null || !Number.isFinite(declination))
  )
    return null;
  return wrap(
    sample.heading +
      (sample.reference === "magnetic" ? declination! : 0) +
      offset,
  );
}

export function smoothHeading(
  previous: number,
  next: number,
  weight = 0.3,
): number {
  return wrap(previous + angleDifference(next, previous) * weight);
}

export class PhoneCompass {
  private cleanup: (() => void) | null = null;
  private generation = 0;
  async start(
    onSample: (sample: HeadingSample) => void,
    onStatus: (status: string) => void,
    onUnavailable?: (status: string) => void,
  ): Promise<void> {
    this.stop();
    const generation = this.generation;
    if (!window.isSecureContext)
      throw new Error(
        compassUnavailable("Phone compass requires HTTPS."),
      );
    if (!window.DeviceOrientationEvent)
      throw new Error(
        compassUnavailable("This view does not provide a phone orientation sensor."),
      );
    const ctor = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: (absolute?: boolean) => Promise<string>;
    };
    try {
      if (ctor.requestPermission && (await ctor.requestPermission(true)) !== "granted")
        throw new Error("Permission denied");
    } catch {
      throw new Error(compassUnavailable("Phone orientation access was not granted."));
    }
    if (generation !== this.generation) return;
    let receivedAt = 0;
    let lastIssue = "No compass readings arrived.";
    const startedAt = Date.now();
    const listener = (event: DeviceOrientationEvent) => {
      const sample = readHeading(event);
      if (!sample) {
        // Android emits relative events alongside absolute compass readings.
        // They must not replace a live heading's status or its last issue.
        const relative = !event.absolute &&
          !Number.isFinite((event as Orientation).webkitCompassHeading);
        if (relative && receivedAt) return;
        lastIssue = headingIssue(event);
        onStatus(lastIssue);
        return;
      }
      receivedAt = Date.now();
      onSample(sample);
      onStatus("Following the phone compass.");
    };
    window.addEventListener("deviceorientationabsolute", listener);
    window.addEventListener("deviceorientation", listener);
    const watchdog = window.setInterval(() => {
      if (!receivedAt && Date.now() - startedAt > HEADING_TIMEOUT_MS) {
        const message = compassUnavailable(lastIssue);
        this.stop();
        onStatus(message);
        onUnavailable?.(message);
      } else if (receivedAt && Date.now() - receivedAt > HEADING_TIMEOUT_MS)
        onStatus(
          "No recent heading. Keeping the last direction. Hold the phone flat or switch to Manual.",
        );
    }, 1000);
    this.cleanup = () => {
      clearInterval(watchdog);
      window.removeEventListener("deviceorientationabsolute", listener);
      window.removeEventListener("deviceorientation", listener);
    };
    onStatus(
      "Waiting for a heading. Hold the phone flat with its top edge pointing toward your view.",
    );
  }
  stop(): void {
    this.generation++;
    this.cleanup?.();
    this.cleanup = null;
  }
}

function compassUnavailable(reason: string): string {
  const inEven = Boolean((window as Window & { flutter_inappwebview?: unknown }).flutter_inappwebview);
  return inEven
    ? `${reason} This Even app view may not expose the phone compass. Location permission only supplies your position. Use your phone's Compass app, then enter its heading in Manual mode.`
    : `${reason} Use a supported phone browser over HTTPS, or read your phone's Compass app and enter its heading in Manual mode.`;
}

function headingIssue(event: Orientation): string {
  if ((event.beta != null && Math.abs(event.beta) > 45) ||
      (event.gamma != null && Math.abs(event.gamma) > 45))
    return "Hold the phone flat, with its top edge pointing toward your view.";
  if (Number.isFinite(event.webkitCompassHeading))
    return "Compass accuracy is too low. Move away from magnets and metal, then try again.";
  return "No north-referenced compass reading. Relative phone motion cannot locate north.";
}
