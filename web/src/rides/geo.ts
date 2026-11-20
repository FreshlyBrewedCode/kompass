// Geometry for tracks: distance, bounds, garbage filtering and Douglas–Peucker simplification.
import type { Bounds, RawTrack, RidePoints } from "./types";

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in metres (haversine). */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function pathLength(lat: ArrayLike<number>, lon: ArrayLike<number>): number {
  let total = 0;
  for (let i = 1; i < lat.length; i++) {
    total += haversine(lat[i - 1] as number, lon[i - 1] as number, lat[i] as number, lon[i] as number);
  }
  return total;
}

export function boundsOf(lat: ArrayLike<number>, lon: ArrayLike<number>): Bounds {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    const la = lat[i] as number;
    const lo = lon[i] as number;
    if (lo < w) w = lo;
    if (lo > e) e = lo;
    if (la < s) s = la;
    if (la > n) n = la;
  }
  return [w, s, e, n];
}

/** A jump this long between two consecutive points is garbage, whatever the time says. */
export const MAX_JUMP_M = 50_000;
/** Faster than this (m/s, 250 km/h) between two timed points is garbage. */
export const MAX_SPEED_MPS = 70;
/** After this many consecutive "jumps" the track really moved there (a gap, a train): accept them. */
const REANCHOR_AFTER = 3;

export type CleanReport = {
  /** (0, 0), out of range or not a number */
  invalid: number;
  /** points that jump away and back */
  jumps: number;
};

/**
 * Drops garbage points: no-fix zeros (exactly 0, 0), coordinates out of range or NaN, and isolated
 * jumps (further than 50 km from the last good point, or faster than 250 km/h when timed). A track
 * that stays at the new place for three points is taken as having really moved. Returns the kept
 * points as `RidePoints` (time / elevation `null` when not every point has them; elevation gaps are
 * filled from the previous point) and what was dropped.
 */
export function cleanTrack(raw: RawTrack): { points: RidePoints; report: CleanReport } {
  const report: CleanReport = { invalid: 0, jumps: 0 };
  const total = raw.lat.length;
  const keep: number[] = [];
  let pending: number[] = [];
  let last = -1;

  const jumpFrom = (anchor: number, i: number): boolean => {
    const d = haversine(
      raw.lat[anchor] as number,
      raw.lon[anchor] as number,
      raw.lat[i] as number,
      raw.lon[i] as number,
    );
    if (d > MAX_JUMP_M) return true;
    const dt = ((raw.time[i] as number) - (raw.time[anchor] as number)) / 1000;
    return dt > 0 && d > 200 && d / dt > MAX_SPEED_MPS;
  };

  for (let i = 0; i < total; i++) {
    const la = raw.lat[i] as number;
    const lo = raw.lon[i] as number;
    if (
      !Number.isFinite(la) ||
      !Number.isFinite(lo) ||
      Math.abs(la) > 90 ||
      Math.abs(lo) > 180 ||
      (la === 0 && lo === 0)
    ) {
      report.invalid++;
      continue;
    }
    if (last < 0 || !jumpFrom(last, i)) {
      keep.push(i);
      last = i;
      pending = [];
      continue;
    }
    // far from the last good point: wait and see whether the track stays there
    const before = pending[pending.length - 1];
    if (before !== undefined && jumpFrom(before, i)) pending = [];
    pending.push(i);
    if (pending.length >= REANCHOR_AFTER) {
      for (const p of pending) keep.push(p);
      last = i;
      pending = [];
    }
  }
  report.jumps = total - report.invalid - keep.length;

  const count = keep.length;
  const lat = new Float64Array(count);
  const lon = new Float64Array(count);
  const timed = count > 0 && keep.every((i) => Number.isFinite(raw.time[i]));
  const time = timed ? new Float64Array(count) : null;
  const eleKnown = keep.filter((i) => Number.isFinite(raw.ele[i])).length;
  const ele = eleKnown > 0 ? new Float64Array(count) : null;
  let lastEle = Number.NaN;
  if (ele) {
    // leading gaps take the first known value, later gaps the previous one
    for (const i of keep) {
      if (Number.isFinite(raw.ele[i])) {
        lastEle = raw.ele[i] as number;
        break;
      }
    }
  }
  keep.forEach((src, k) => {
    lat[k] = raw.lat[src] as number;
    lon[k] = raw.lon[src] as number;
    if (time) time[k] = raw.time[src] as number;
    if (ele) {
      const e = raw.ele[src] as number;
      if (Number.isFinite(e)) lastEle = e;
      ele[k] = lastEle;
    }
  });
  return { points: { count, lat, lon, time, ele }, report };
}

/** Douglas–Peucker tolerance for the map line, metres. */
export const LINE_TOLERANCE_M = 10;

/**
 * Indices of the points Douglas–Peucker keeps for `toleranceM` (first and last always). Iterative, so
 * a 100k-point track cannot overflow the stack; distances are measured on a local flat projection.
 */
export function simplifyIndices(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
  toleranceM: number = LINE_TOLERANCE_M,
): number[] {
  const n = lat.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const lat0 = (lat[0] as number) * RAD;
  const kx = EARTH_RADIUS_M * Math.cos(lat0) * RAD;
  const ky = EARTH_RADIUS_M * RAD;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (lon[i] as number) * kx;
    y[i] = (lat[i] as number) * ky;
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  const tol2 = toleranceM * toleranceM;
  while (stack.length > 0) {
    const b = stack.pop() as number;
    const a = stack.pop() as number;
    if (b <= a + 1) continue;
    const ax = x[a] as number;
    const ay = y[a] as number;
    const dx = (x[b] as number) - ax;
    const dy = (y[b] as number) - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = (x[i] as number) - ax;
      const py = (y[i] as number) - ay;
      let d2: number;
      if (len2 === 0) {
        d2 = px * px + py * py;
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx;
        const ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** The map line of a ride: its points simplified to `toleranceM`, positions only. */
export function simplifyLine(points: RidePoints, toleranceM: number = LINE_TOLERANCE_M): RidePoints {
  const idx = simplifyIndices(points.lat, points.lon, toleranceM);
  const lat = new Float64Array(idx.length);
  const lon = new Float64Array(idx.length);
  idx.forEach((src, k) => {
    lat[k] = points.lat[src] as number;
    lon[k] = points.lon[src] as number;
  });
  return { count: idx.length, lat, lon, time: null, ele: null };
}
