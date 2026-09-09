import geomagnetism from "geomagnetism";
import { validLocation, wrap, type Location } from "./sky.ts";

export type NorthReference = "magnetic" | "true";
export type HeadingSample = { heading: number; reference: NorthReference };
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
