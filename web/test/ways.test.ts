import { describe, expect, test } from "bun:test";
import { expression } from "@maplibre/maplibre-gl-style-spec";
import type { LayerSpecification } from "maplibre-gl";
import { CARTO } from "../src/map/carto";
import {
  enumCodes,
  KEY_ROWS,
  KEY_ZOOM,
  keyStrokes,
  LOOK,
  type LookId,
  looks,
  TIER,
  WAY_BAND,
  WAY_CASING,
  WAY_DOTS,
  WAY_FERRY,
  WAY_HALO,
  WAY_LONG,
  WAY_PICK_LAYERS,
  WAY_SHORT,
  WAY_SOLID,
  wayClasses,
  wayLayers,
  widthAt,
  ZOOMS,
} from "../src/map/ways";
import { code, pipelineManifest } from "./pipeline-manifest";

const attributes = pipelineManifest().overlay.attributes;
const classes = wayClasses(attributes);

function evaluate(expr: unknown, properties: Record<string, unknown>, zoom = 14, kind = "filter") {
  const spec = kind === "filter" ? { type: "boolean" } : undefined;
  const compiled = expression.createExpression(expr, "test", spec as never);
  if (compiled.result !== "success") throw new Error(JSON.stringify(compiled.value));
  return compiled.value.evaluate({ zoom }, { type: 2, properties } as never);
}
const value = (expr: unknown, properties: Record<string, unknown>, zoom = 14) =>
  evaluate(expr, properties, zoom, "value");
/** An edge by labels: `edge({ highway: "track", surface_class: "gravel" })`. */
function edge(labels: Record<string, string>, extra: Record<string, number> = {}) {
  const properties: Record<string, number> = { surface_class: 0, tracktype: 0, bike_access: 0, ...extra };
  for (const [key, label] of Object.entries(labels)) properties[key] = code(key, label);
  return properties;
}
const lookOf = (labels: Record<string, string>, extra: Record<string, number> = {}) => {
  const n = value(classes.look, edge(labels, extra));
  return (Object.keys(LOOK) as LookId[]).find((id) => LOOK[id] === n);
};

const layers = wayLayers(attributes, {
  source: "overlay",
  sourceLayer: "edges",
  colors: CARTO.light,
  routes: true,
});
const all = [...layers.under, ...layers.over];
const byId = new Map(all.map((l) => [l.id, l as LayerSpecification & { filter?: unknown }]));
const DRAWING = [WAY_SOLID, WAY_LONG, WAY_SHORT, WAY_DOTS, WAY_BAND, WAY_FERRY];
const drawnBy = (properties: Record<string, number>, ids: readonly string[], zoom = 14) =>
  ids.filter((id) => evaluate(byId.get(id)?.filter ?? true, properties, zoom) === true);

describe("enumCodes", () => {
  test("codes by label, whatever the spelling; unknown labels and keys give nothing", () => {
    const codes = enumCodes(attributes);
    expect(codes("highway", "track", "path")).toEqual([14, 15]);
    expect(codes("surface_class", "Paved smooth", "nope")).toEqual([1]);
    expect(codes("not_there", "x")).toEqual([]);
    expect(codes("forest_share", "x")).toEqual([]);
  });
});

describe("the classes: tier, grade, look", () => {
  test("the grade: the track grade where mapped, else the surface, else unknown or paved by kind", () => {
    const g = (labels: Record<string, string>) => value(classes.grade, edge(labels));
    expect(g({ highway: "track", tracktype: "grade2", surface_class: "gravel" })).toBe(2);
    expect(g({ highway: "track", tracktype: "grade3" })).toBe(3);
    expect(g({ highway: "track", tracktype: "grade5" })).toBe(5);
    // a paved surface always makes it 1; a grade 1 with a loose surface is not paved
    expect(g({ highway: "track", tracktype: "grade4", surface_class: "paved_smooth" })).toBe(1);
    expect(g({ highway: "track", tracktype: "grade1", surface_class: "gravel" })).toBe(2);
    expect(g({ highway: "track", surface_class: "compacted" })).toBe(2);
    expect(g({ highway: "path", surface_class: "soft" })).toBe(4);
    // nothing mapped: tracks and paths are unknown, roads, cycle paths and footways paved
    expect(g({ highway: "track" })).toBe(0);
    expect(g({ highway: "path" })).toBe(0);
    expect(g({ highway: "residential" })).toBe(1);
    expect(g({ highway: "footway" })).toBe(1);
  });

  test("the tier: the road class; a path signed as a separate cycle path is one; aisles are thin", () => {
    const t = (labels: Record<string, string>, extra: Record<string, number> = {}) =>
      value(classes.width, edge(labels, extra));
    expect(t({ highway: "trunk" })).toBe(TIER.major);
    expect(t({ highway: "secondary_link" })).toBe(TIER.secondary);
    expect(t({ highway: "living_street" })).toBe(TIER.street);
    expect(t({ highway: "track" })).toBe(TIER.track);
    expect(t({ highway: "path", cycleway_kind: "separate_path" })).toBe(TIER.cycle);
    expect(t({ highway: "bridleway" })).toBe(TIER.path);
    expect(t({ highway: "service" })).toBe(TIER.service);
    expect(t({ highway: "service" }, { service_kind: 1 })).toBe(TIER.aisle);
    expect(t({ highway: "service" }, { service_kind: 2 })).toBe(TIER.aisle);
  });

  test("the look: roads keep their tier, the rest is its grade", () => {
    expect(lookOf({ highway: "primary", surface_class: "gravel" })).toBe("major");
    expect(lookOf({ highway: "secondary" })).toBe("secondary");
    expect(lookOf({ highway: "tertiary" })).toBe("tertiary");
    expect(lookOf({ highway: "residential" })).toBe("road");
    // an unpaved road is the band of its grade at the road's width
    expect(lookOf({ highway: "unclassified", surface_class: "gravel" })).toBe("gravel");
    expect(lookOf({ highway: "residential", surface_class: "compacted" })).toBe("compacted");
    expect(lookOf({ highway: "unclassified", tracktype: "grade5" })).toBe("soft");
    expect(lookOf({ highway: "track", tracktype: "grade1" })).toBe("lane");
    expect(lookOf({ highway: "track", tracktype: "grade2" })).toBe("compacted");
    expect(lookOf({ highway: "track", surface_class: "gravel" })).toBe("gravel");
    expect(lookOf({ highway: "track", tracktype: "grade4" })).toBe("rough");
    expect(lookOf({ highway: "track" })).toBe("unknown");
    expect(lookOf({ highway: "cycleway", surface_class: "gravel" })).toBe("cycle");
    expect(lookOf({ highway: "footway" })).toBe("pathPaved");
    expect(lookOf({ highway: "path", surface_class: "compacted" })).toBe("path");
    expect(lookOf({ highway: "path", tracktype: "grade5" })).toBe("pathSoft");
    expect(lookOf({ highway: "bridleway" })).toBe("pathUnknown");
    expect(lookOf({ highway: "ferry" })).toBe("ferry");
  });

  test("bands are road-like (light to ochre), soft ground and paths are lines, the ferry its own", () => {
    const table = looks(CARTO.light);
    const bands = (Object.keys(table) as LookId[]).filter((id) => table[id].shape === "band");
    expect(bands).toEqual([
      "major",
      "secondary",
      "tertiary",
      "road",
      "lane",
      "compacted",
      "gravel",
      "unknown",
    ]);
    expect(table.rough.pattern).toBe("short");
    expect(table.soft.pattern).toBe("dots");
    expect(table.ferry.shape).toBe("ferry");
    // the ramp of the gravel bands darkens with roughness (lightness, so it survives grey scale)
    const light = (hex: string) =>
      [1, 3, 5].reduce((sum, o) => sum + Number.parseInt(hex.slice(o, o + 2), 16), 0) / 3;
    expect(light(table.lane.fill)).toBeGreaterThan(light(table.compacted.fill));
    expect(light(table.compacted.fill)).toBeGreaterThan(light(table.gravel.fill));
    expect(light(table.gravel.fill)).toBeGreaterThan(light(table.rough.fill));
  });
});

describe("the layers", () => {
  test("every edge is drawn by exactly one layer, and can be picked", () => {
    const cases: [Record<string, number>, string][] = [
      [edge({ highway: "secondary" }), WAY_BAND],
      [edge({ highway: "track", tracktype: "grade1" }), WAY_BAND],
      [edge({ highway: "track", tracktype: "grade3" }), WAY_BAND],
      [edge({ highway: "track" }), WAY_BAND],
      [edge({ highway: "track", tracktype: "grade4" }), WAY_SHORT],
      [edge({ highway: "track", tracktype: "grade5" }), WAY_DOTS],
      [edge({ highway: "cycleway", surface_class: "paved_smooth" }), WAY_SOLID],
      [edge({ highway: "path", surface_class: "gravel" }), WAY_LONG],
      [edge({ highway: "path", surface_class: "soft" }), WAY_SHORT],
      [edge({ highway: "path" }), WAY_LONG],
      [edge({ highway: "ferry" }), WAY_FERRY],
    ];
    for (const [properties, layer] of cases) {
      expect(drawnBy(properties, DRAWING)).toEqual([layer]);
      expect(drawnBy(properties, WAY_PICK_LAYERS)).toHaveLength(1);
    }
    // a band is cased, a line has a halo; the ferry has neither (and is never a band)
    expect(drawnBy(edge({ highway: "track", tracktype: "grade2" }), [WAY_CASING, WAY_HALO])).toEqual([
      WAY_CASING,
    ]);
    expect(drawnBy(edge({ highway: "path" }), [WAY_CASING, WAY_HALO])).toEqual([WAY_HALO]);
    expect(drawnBy(edge({ highway: "ferry" }), [WAY_CASING, WAY_HALO, WAY_BAND])).toEqual([]);
  });

  test("pavements show from z15, driveways from z14, car-park aisles from z15", () => {
    const pavement = edge({ highway: "footway", surface_class: "paved_smooth" }, { road_near_share: 100 });
    expect(drawnBy(pavement, DRAWING, 14)).toEqual([]);
    expect(drawnBy(pavement, DRAWING, 15)).toEqual([WAY_SOLID]);
    const driveway = edge({ highway: "service" }, { service_kind: 2 });
    expect(drawnBy(driveway, DRAWING, 13)).toEqual([]);
    expect(drawnBy(driveway, DRAWING, 14)).toEqual([WAY_BAND]);
    const aisle = edge({ highway: "service" }, { service_kind: 1 });
    expect(drawnBy(aisle, DRAWING, 14)).toEqual([]);
    expect(drawnBy(aisle, DRAWING, 15)).toEqual([WAY_BAND]);
    expect(drawnBy(edge({ highway: "service" }), DRAWING, 12)).toEqual([WAY_BAND]);
  });

  test("crossings: bridges above, tunnels below and faint; tiles without the properties are level", () => {
    const sort = (extra: Record<string, number>) => value(classes.sort, edge({ highway: "track" }, extra));
    const road = value(classes.sort, edge({ highway: "residential" }));
    expect(sort({})).toBeLessThan(road);
    expect(sort({ bridge: 1 })).toBeGreaterThan(value(classes.sort, edge({ highway: "primary" })));
    expect(sort({ tunnel: 1 })).toBeLessThan(sort({}));
    expect(sort({ layer: 2, bridge: 1 })).toBeGreaterThan(sort({ bridge: 1 }));
    const band = byId.get(WAY_BAND) as { paint: Record<string, unknown> };
    const opacity = (extra: Record<string, number>) =>
      value(band.paint["line-opacity"], edge({ highway: "residential" }, extra));
    expect(opacity({})).toBe(1);
    expect(opacity({ tunnel: 1 })).toBeLessThan(0.5);
    expect(drawnBy(edge({ highway: "residential" }, { bridge: 1 }), ["way-bridge"])).toEqual(["way-bridge"]);
    expect(drawnBy(edge({ highway: "residential" }), ["way-bridge"])).toEqual([]);
  });

  test("tracks and paths fade in over the overview zooms; restricted ways are faint", () => {
    const band = byId.get(WAY_BAND) as { paint: Record<string, unknown> };
    const opacity = (labels: Record<string, string>, zoom: number) =>
      value(band.paint["line-opacity"], edge(labels), zoom);
    expect(opacity({ highway: "track", tracktype: "grade3" }, 11)).toBeLessThan(0.6);
    expect(opacity({ highway: "track", tracktype: "grade3" }, 13)).toBe(1);
    expect(opacity({ highway: "tertiary" }, 11)).toBe(1);
    expect(opacity({ highway: "track", tracktype: "grade3", bike_access: "private" }, 14)).toBeLessThan(0.5);
  });

  test("a manifest without the attributes or drawing properties still gives a valid style", () => {
    const bare = wayLayers([], {
      source: "overlay",
      sourceLayer: "edges",
      colors: CARTO.dark,
      routes: false,
    });
    const ids = [...bare.under, ...bare.over].map((l) => l.id);
    expect(ids).toContain(WAY_BAND);
    const k = wayClasses([]);
    // with nothing to tell them apart every edge is a paved path, drawn once
    expect(value(k.look, {})).toBe(LOOK.pathPaved);
    const filters = new Map(
      [...bare.under, ...bare.over].map((l) => [l.id, (l as { filter?: unknown }).filter]),
    );
    const drawn = DRAWING.filter((id) => evaluate(filters.get(id) ?? true, {}) === true);
    expect(drawn).toEqual([WAY_SOLID]);
  });
});

describe("the key", () => {
  test("every row's sample edge is classified as the row says (the key cannot drift from the map)", () => {
    for (const row of KEY_ROWS) {
      const properties = edge(row.sample);
      expect([row.label, lookOf(row.sample)]).toEqual([row.label, row.look]);
      const tier = value(classes.width, properties);
      expect([row.label, tier]).toEqual([row.label, row.tier]);
      expect(drawnBy(properties, DRAWING)).toHaveLength(1);
      if (row.restricted) expect(value(classes.restricted, properties)).toBe(true);
    }
    // every look is in the key
    const shown = new Set(KEY_ROWS.map((r) => r.look));
    for (const id of Object.keys(LOOK) as LookId[]) expect([id, shown.has(id)]).toEqual([id, true]);
  });

  test("the strokes are the map's: casing then fill for a band, halo then dashed line for a soft track", () => {
    const c = CARTO.light;
    const at = (row: string) => KEY_ROWS.find((r) => r.label === row) as (typeof KEY_ROWS)[number];
    const gravel = keyStrokes(at("Gravel"), c);
    expect(gravel.map((s) => s.color)).toEqual([c.trackCasing, c.gravel]);
    const band = byId.get(WAY_BAND) as { paint: Record<string, unknown> };
    const mapWidth = value(band.paint["line-width"], edge(at("Gravel").sample), KEY_ZOOM);
    expect(gravel[1]?.width).toBeCloseTo(mapWidth as number, 1);
    const soft = keyStrokes(at("Mostly soft"), c);
    expect(soft.map((s) => s.color)).toEqual([c.wayHalo, c.soft]);
    expect(soft[1]?.dash).toBeDefined();
    expect(keyStrokes(at("No bike access"), c)[1]?.opacity).toBeLessThan(0.5);
    expect(keyStrokes(at("Cycle route"), c)[0]?.color).toBe(c.cycleRoute);
  });

  test("widthAt is the style's exponential interpolation", () => {
    expect(widthAt(ZOOMS[0] - 1, (i) => i)).toBe(0);
    expect(widthAt(13, (i) => [0, 0, 0, 5, 9, 0, 0, 0][i] as number)).toBe(5);
    const mid = widthAt(13.5, (i) => [0, 0, 0, 5, 9, 0, 0, 0][i] as number);
    expect(mid).toBeGreaterThan(5);
    expect(mid).toBeLessThan(7); // exponential: below the linear midpoint
  });
});
