import {
  Body,
  Equator,
  Horizon,
  HorizonFromVector,
  Illumination,
  MakeTime,
  Observer,
  RotateVector,
  Rotation_EQJ_HOR,
  SearchAltitude,
  SearchRiseSet,
  Vector,
} from "astronomy-engine";
import starData from "./data/stars.json" with { type: "json" };
import constellationData from "./data/constellations.json" with { type: "json" };

export const DEG = Math.PI / 180;
export const wrap = (degrees: number) => ((degrees % 360) + 360) % 360;
export const angleDifference = (a: number, b: number) =>
  wrap(a - b + 180) - 180;
export type Location = { latitude: number; longitude: number; height: number };
export type Horizontal = { azimuth: number; altitude: number };
export type SkyObject = Horizontal & {
  id: string;
  name: string;
  magnitude: number;
  kind: "star" | "planet" | "moon" | "sun";
};
export type SkyLine = { name: string; points: Horizontal[] };
export type Sky = {
  time: Date;
  objects: SkyObject[];
  lines: SkyLine[];
  sunAltitude: number;
  moonFraction: number;
};
type Star = [number, string, number, number, number, number, number];
type Constellation = [string, string, [number, number][][]];

const bodies = [
  [Body.Sun, "Sun", "sun"],
  [Body.Moon, "Moon", "moon"],
  [Body.Mercury, "Mercury", "planet"],
  [Body.Venus, "Venus", "planet"],
  [Body.Mars, "Mars", "planet"],
  [Body.Jupiter, "Jupiter", "planet"],
  [Body.Saturn, "Saturn", "planet"],
] as const;

export function validLocation(location: Location): boolean {
  return (
    Number.isFinite(location.latitude) &&
    Math.abs(location.latitude) <= 90 &&
    Number.isFinite(location.longitude) &&
    Math.abs(location.longitude) <= 180 &&
    Number.isFinite(location.height) &&
    location.height >= -500 &&
    location.height <= 10000
  );
}

export function calculateSky(date: Date, location: Location): Sky {
  if (!Number.isFinite(date.getTime()) || !validLocation(location))
    throw new Error("Check the date, time, and observing location.");
  const time = MakeTime(date);
  const observer = new Observer(
    location.latitude,
    location.longitude,
    location.height,
  );
  const rotation = Rotation_EQJ_HOR(time, observer);
  const years =
    (date.getTime() - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400000);
  const horizontal = (
    ra: number,
    dec: number,
    pmra = 0,
    pmdec = 0,
  ): Horizontal => {
    const a = ra * DEG,
      d = dec * DEG;
    const ma = ((pmra * DEG) / 3600000) * years,
      md = ((pmdec * DEG) / 3600000) * years;
    // Tangent-space proper motion avoids dividing by cos(dec) at the poles.
    const vector = new Vector(
      Math.cos(d) * Math.cos(a) -
        ma * Math.sin(a) -
        md * Math.sin(d) * Math.cos(a),
      Math.cos(d) * Math.sin(a) +
        ma * Math.cos(a) -
        md * Math.sin(d) * Math.sin(a),
      Math.sin(d) + md * Math.cos(d),
      time,
    );
    const horizon = HorizonFromVector(RotateVector(rotation, vector), "normal");
    return { azimuth: horizon.lon, altitude: horizon.lat };
  };
  const objects: SkyObject[] = (starData as Star[]).map(
    ([hip, name, ra, dec, magnitude, pmra, pmdec], i) => ({
      id: `star-${hip || `hyg-${i}`}`,
      name,
      magnitude,
      kind: "star",
      ...horizontal(ra * 15, dec, pmra, pmdec),
    }),
  );
  for (const [body, name, kind] of bodies) {
    const eq = Equator(body, date, observer, true, true);
    objects.push({
      id: body,
      name,
      kind,
      magnitude: Illumination(body, date).mag,
      ...Horizon(date, observer, eq.ra, eq.dec, "normal"),
    });
  }
  const lines: SkyLine[] = [];
  for (const [, name, paths] of constellationData as Constellation[]) {
    for (const path of paths)
      lines.push({
        name,
        points: path.map(([ra, dec]) => horizontal(ra, dec)),
      });
  }
  return {
    time: date,
    objects,
    lines,
    sunAltitude: objects.find((o) => o.kind === "sun")!.altitude,
    moonFraction: Illumination(Body.Moon, date).phase_fraction,
  };
}

/** Next dark part of the current observing night; already-dark nights stay at now. */
export function tonight(
  now: Date,
  location: Location,
): { time: Date; note: string } {
  const observer = new Observer(
    location.latitude,
    location.longitude,
    location.height,
  );
  const eq = Equator(Body.Sun, now, observer, true, true);
  const altitude = Horizon(now, observer, eq.ra, eq.dec).altitude;
  if (altitude <= -18)
    return { time: new Date(now), note: "The sky is already dark after astronomical twilight." };
  const dark = SearchAltitude(Body.Sun, observer, -1, now, 1, -18);
  if (dark)
    return {
      time: new Date(dark.date.getTime() + 30 * 60000),
      note: "30 minutes after astronomical twilight ends.",
    };
  const sunset = SearchRiseSet(Body.Sun, observer, -1, now, 1);
  if (sunset)
    return {
      time: new Date(sunset.date.getTime() + 60 * 60000),
      note: "No fully dark night within 24 hours; showing one hour after sunset.",
    };
  return {
    time: new Date(now),
    note: "No end of astronomical twilight or sunset within 24 hours (polar conditions).",
  };
}

export function skyBrightness(sunAltitude: number): string {
  if (sunAltitude >= 0) return "Daylight: simulated stars";
  if (sunAltitude > -6) return "Dawn or dusk";
  if (sunAltitude > -18) return "Twilight";
  return "Night sky";
}

export type View = {
  heading: number;
  pitch: number;
  fov: number;
  width: number;
  height: number;
};
export function project(
  point: Horizontal,
  view: View,
): { x: number; y: number } | null {
  const az = angleDifference(point.azimuth, view.heading) * DEG;
  const alt = point.altitude * DEG,
    pitch = view.pitch * DEG;
  const depth =
    Math.cos(alt) * Math.cos(az) * Math.cos(pitch) +
    Math.sin(alt) * Math.sin(pitch);
  if (depth <= 0.02) return null;
  const scale = view.width / (2 * Math.tan((view.fov * DEG) / 2));
  return {
    x: view.width / 2 + (scale * Math.cos(alt) * Math.sin(az)) / depth,
    y:
      view.height / 2 -
      (scale *
        (Math.sin(alt) * Math.cos(pitch) -
          Math.cos(alt) * Math.cos(az) * Math.sin(pitch))) /
        depth,
  };
}

export function direction(degrees: number): string {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][
    Math.round(wrap(degrees) / 45) % 8
  ]!;
}
