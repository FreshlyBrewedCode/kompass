import { describe, expect, test } from "bun:test";
import { expression } from "@maplibre/maplibre-gl-style-spec";
import { CARTO } from "../src/map/carto";
import { enumCodes, WAY_PICK_LAYERS, wayClasses, wayLayers } from "../src/map/ways";
import { code, pipelineManifest } from "./pipeline-manifest";

const attributes = pipelineManifest().overlay.attributes;
const classes = wayClasses(attributes);

function evaluate(expr: unknown, properties: Record<string, unknown>, zoom = 14) {
  const compiled = expression.createExpression(expr, "test");
  if (compiled.result !== "success") throw new Error(JSON.stringify(compiled.value));
  return compiled.value.evaluate({ zoom }, { type: 2, properties } as never);
}
/** An edge by labels: `edge({ highway: "track", surface_class: "gravel" })`. */
function edge(labels: Record<string, string>, extra: Record<string, number> = {}) {
  const properties: Record<string, number> = { surface_class: 0, tracktype: 0, bike_access: 0, ...extra };
  for (const [key, label] of Object.entries(labels)) properties[key] = code(key, label);
  return properties;
}

describe("enumCodes", () => {
  test("codes by label, whatever the spelling; unknown labels and keys give nothing", () => {
    const codes = enumCodes(attributes);
    expect(codes("highway", "track", "path")).toEqual([14, 15]);
    expect(codes("surface_class", "Paved smooth", "nope")).toEqual([1]);
    expect(codes("not_there", "x")).toEqual([]);
    expect(codes("forest_share", "x")).toEqual([]);
  });
});

describe("the line vocabulary", () => {
  test("firmness: the surface, else the track grade, else the kind of way", () => {
    const f = (labels: Record<string, string>) => evaluate(classes.firmness, edge(labels));
    expect(f({ highway: "track", surface_class: "paved_smooth" })).toBe(0);
    expect(f({ highway: "track", surface_class: "compacted" })).toBe(1);
    expect(f({ highway: "track", surface_class: "gravel", tracktype: "grade1" })).toBe(2);
    expect(f({ highway: "path", surface_class: "soft" })).toBe(3);
    expect(f({ highway: "track", tracktype: "grade2" })).toBe(1);
    expect(f({ highway: "track", tracktype: "grade5" })).toBe(3);
    // nothing mapped: a track is taken for gravel, a path for soft ground, a road or footway for paved
    expect(f({ highway: "track" })).toBe(2);
    expect(f({ highway: "path" })).toBe(3);
    expect(f({ highway: "residential" })).toBe(0);
    expect(f({ highway: "footway" })).toBe(0);
  });

  test("a cased road: the big roads always, small ones and tracks only when paved", () => {
    const road = (labels: Record<string, string>) => evaluate(classes.road, edge(labels));
    expect(road({ highway: "primary", surface_class: "gravel" })).toBe(true);
    expect(road({ highway: "residential" })).toBe(true);
    expect(road({ highway: "residential", surface_class: "gravel" })).toBe(false);
    expect(road({ highway: "track", tracktype: "grade1" })).toBe(true);
    expect(road({ highway: "track" })).toBe(false);
    expect(road({ highway: "cycleway", surface_class: "paved_smooth" })).toBe(false);
  });

  test("guessed, cycling, restricted and roadside paths are told apart", () => {
    expect(evaluate(classes.guessed, edge({ highway: "track" }))).toBe(true);
    expect(evaluate(classes.guessed, edge({ highway: "track", tracktype: "grade3" }))).toBe(false);
    expect(evaluate(classes.guessed, edge({ highway: "residential" }))).toBe(false);
    expect(evaluate(classes.cycle, edge({ highway: "cycleway" }))).toBe(true);
    expect(evaluate(classes.cycle, edge({ highway: "path", cycleway_kind: "separate_path" }))).toBe(true);
    expect(evaluate(classes.cycle, edge({ highway: "path" }))).toBe(false);
    expect(evaluate(classes.restricted, edge({ highway: "track", bike_access: "private" }))).toBe(true);
    expect(evaluate(classes.restricted, edge({ highway: "track", bike_access: "foot_only" }))).toBe(false);
    const paved = { highway: "cycleway", surface_class: "paved_smooth" };
    expect(evaluate(classes.sidepath, edge(paved, { road_near_share: 90 }))).toBe(true);
    expect(evaluate(classes.sidepath, edge(paved, { road_near_share: 10 }))).toBe(false);
    expect(evaluate(classes.sidepath, edge({ highway: "path" }, { road_near_share: 90 }))).toBe(false);
  });

  test("every edge is drawn by exactly one line layer, and can be picked", () => {
    const layers = wayLayers(attributes, {
      source: "overlay",
      sourceLayer: "edges",
      colors: CARTO.light,
      routes: true,
    });
    const drawing = ["way-road", "way-solid", "way-firm", "way-loose", "way-soft"];
    const filters = new Map(layers.map((l) => [l.id, (l as { filter?: unknown }).filter]));
    const drawnBy = (properties: Record<string, number>, ids: readonly string[], zoom = 14) =>
      ids.filter((id) => evaluate(filters.get(id), properties, zoom) === true);
    const cases: [Record<string, number>, string][] = [
      [edge({ highway: "secondary" }), "way-road"],
      [edge({ highway: "track", tracktype: "grade1" }), "way-road"],
      [edge({ highway: "cycleway", surface_class: "paved_smooth" }), "way-solid"],
      [edge({ highway: "track", surface_class: "compacted" }), "way-firm"],
      [edge({ highway: "residential", surface_class: "gravel" }), "way-loose"],
      [edge({ highway: "path" }), "way-soft"],
    ];
    for (const [properties, layer] of cases) {
      expect(drawnBy(properties, drawing)).toEqual([layer]);
      expect(drawnBy(properties, WAY_PICK_LAYERS)).toHaveLength(1);
    }
    // a pavement along a road: no line of its own at planning zooms, one from z15 on
    const pavement = edge({ highway: "footway", surface_class: "paved_smooth" }, { road_near_share: 100 });
    expect(drawnBy(pavement, drawing, 14)).toEqual([]);
    expect(drawnBy(pavement, drawing, 15)).toEqual(["way-solid"]);
  });

  test("a manifest without the attributes still gives a valid (single-class) style", () => {
    const layers = wayLayers([], {
      source: "overlay",
      sourceLayer: "edges",
      colors: CARTO.dark,
      routes: false,
    });
    expect(layers.map((l) => l.id)).toContain("way-soft");
    expect(evaluate((layers.find((l) => l.id === "way-solid") as { filter?: unknown }).filter, {})).toBe(
      true,
    );
  });
});
