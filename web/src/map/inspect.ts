// Edge inspect: which edge did the user tap? A small box around the point is queried (a finger is not
// a pixel), and the nearest edge in screen space wins.
import type { MapGeoJSONFeature, Map as MapLibreMap, PointLike } from "maplibre-gl";

/** Half the side of the query box, in CSS pixels: about a fingertip. */
export const HIT_RADIUS = 14;

export type PickedEdge = {
  id: number;
  properties: Record<string, unknown>;
};

/** Distance from point p to the segment a–b (all in px). */
export function distanceToSegment(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from p to a polyline (px). */
export function distanceToLine(p: readonly [number, number], line: readonly (readonly [number, number])[]) {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, distanceToSegment(p, line[i - 1] as [number, number], line[i] as [number, number]));
  }
  return line.length === 1 ? Math.hypot(p[0] - (line[0]?.[0] ?? 0), p[1] - (line[0]?.[1] ?? 0)) : best;
}

function lines(feature: MapGeoJSONFeature): [number, number][][] {
  const g = feature.geometry;
  if (g.type === "LineString") return [g.coordinates as [number, number][]];
  if (g.type === "MultiLineString") return g.coordinates as [number, number][][];
  return [];
}

/**
 * The overlay edge nearest to a screen point, within the hit radius; `null` when there is none. `layers`:
 * the layers that draw edges (those the style lacks are skipped).
 */
export function pickEdge(
  map: MapLibreMap,
  point: { x: number; y: number },
  layers: readonly string[],
): PickedEdge | null {
  const box: [PointLike, PointLike] = [
    [point.x - HIT_RADIUS, point.y - HIT_RADIUS],
    [point.x + HIT_RADIUS, point.y + HIT_RADIUS],
  ];
  const present = layers.filter((id) => map.getLayer(id));
  if (present.length === 0) return null;
  let best: { feature: MapGeoJSONFeature; distance: number } | null = null;
  for (const feature of map.queryRenderedFeatures(box, { layers: present })) {
    if (typeof feature.id !== "number") continue;
    for (const line of lines(feature)) {
      const projected = line.map((c) => {
        const p = map.project(c);
        return [p.x, p.y] as [number, number];
      });
      const distance = distanceToLine([point.x, point.y], projected);
      if (!best || distance < best.distance) best = { feature, distance };
    }
  }
  if (!best || best.distance > HIT_RADIUS) return null;
  return { id: best.feature.id as number, properties: { ...best.feature.properties } };
}
