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
  ): Promise<void> {
    this.stop();
    const generation = this.generation;
    if (!window.isSecureContext)
      throw new Error(
        "Phone compass requires HTTPS. You can still set the heading manually.",
      );
    if (!window.DeviceOrientationEvent)
      throw new Error(
        "Phone compass is unavailable in this environment. Set the heading manually.",
      );
    const ctor = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: (absolute?: boolean) => Promise<string>;
    };
    if (
      ctor.requestPermission &&
      (await ctor.requestPermission(true)) !== "granted"
    )
      throw new Error("Compass permission was not granted.");
    if (generation !== this.generation) return;
    let receivedAt = 0;
    const startedAt = Date.now();
    const listener = (event: DeviceOrientationEvent) => {
      const sample = readHeading(event);
      if (!sample) return;
      receivedAt = Date.now();
      onSample(sample);
      onStatus("Following the phone compass.");
    };
    window.addEventListener("deviceorientationabsolute", listener);
    window.addEventListener("deviceorientation", listener);
    const watchdog = window.setInterval(() => {
      if (Date.now() - (receivedAt || startedAt) > HEADING_TIMEOUT_MS)
        onStatus(
          "No recent heading. Hold the phone flat or switch to manual mode.",
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
