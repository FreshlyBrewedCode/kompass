import { describe, expect, test } from "bun:test";
import { expression } from "@maplibre/maplibre-gl-style-spec";
import {
  formatAttribute,
  infoLayerFromName,
  infoLayerName,
  infoSpec,
  isUnknownLabel,
  RULES,
} from "../src/map/info";
import type { OverlayAttribute } from "../src/map/manifest";
import { CATEGORICAL, sequential, UNKNOWN } from "../src/map/palette";
import { code, pipelineManifest } from "./pipeline-manifest";

const attributes = pipelineManifest().overlay.attributes;
const attribute = (key: string) => attributes.find((a) => a.key === key) as OverlayAttribute;

/** Evaluates a style expression for one edge's properties. */
function evaluate(expr: unknown, properties: Record<string, unknown>) {
  const compiled = expression.createExpression(expr, "test");
  if (compiled.result !== "success") throw new Error(JSON.stringify(compiled.value));
  return compiled.value.evaluate({ zoom: 14 }, { type: 2, properties } as never);
}
const shows = (key: string, properties: Record<string, unknown>) =>
  evaluate(infoSpec(attribute(key), "light").filter, properties);

describe("infoSpec: what an attribute's layer shows by default", () => {
  test("surface: everything but smooth asphalt, the unknown in the neutral grey", () => {
    const spec = infoSpec(attribute("surface_class"), "light");
    expect(shows("surface_class", { surface_class: code("surface_class", "paved_smooth") })).toBe(false);
    expect(shows("surface_class", { surface_class: code("surface_class", "gravel") })).toBe(true);
    expect(shows("surface_class", { surface_class: code("surface_class", "unknown") })).toBe(true);
    expect(shows("surface_class", {})).toBe(false);
    if (spec.legend.kind !== "categories") throw new Error("expected categories");
    expect(spec.legend.entries.map((e) => e.label)).toEqual([
      "paved rough",
      "compacted",
      "gravel",
      "soft",
      "other",
      "Unknown",
    ]);
    expect(spec.legend.entries.at(-1)).toMatchObject({ color: UNKNOWN.light, neutral: true });
    expect(spec.legend.note).toBe("Not highlighted: paved smooth");
    // the colours are the rule's own, in both themes
    expect(spec.legend.entries[2]?.color).toBe(RULES.surface_class?.colors?.gravel as string);
    expect(JSON.stringify(spec.color)).toContain(RULES.surface_class?.colors?.soft as string);
  });

  test("an ordered enum without its unknown: a ramp over the known grades", () => {
    const spec = infoSpec(attribute("tracktype"), "dark");
    expect(shows("tracktype", { tracktype: code("tracktype", "unknown") })).toBe(false);
    expect(shows("tracktype", { tracktype: code("tracktype", "grade3") })).toBe(true);
    if (spec.legend.kind !== "categories") throw new Error("expected categories");
    const ramp = sequential("dark");
    expect(spec.legend.entries.map((e) => e.color)).toEqual([
      ramp[0],
      ramp[2],
      ramp[4],
      ramp[5],
      ramp[7],
    ] as string[]);
    expect(spec.legend.entries.some((e) => e.neutral)).toBe(false);
  });

  test("an enum without a rule shows every value in categorical colours", () => {
    const spec = infoSpec(attribute("highway"), "light");
    expect(shows("highway", { highway: code("highway", "other") })).toBe(true);
    if (spec.legend.kind !== "categories") throw new Error("expected categories");
    expect(spec.legend.entries).toHaveLength(22);
    expect(spec.legend.entries[0]?.color).toBe(CATEGORICAL[0]);
    expect(spec.legend.note).toBe("");
  });

  test("a share draws from its threshold on, as a ramp starting there", () => {
    const spec = infoSpec(attribute("forest_edge_share"), "light");
    expect(shows("forest_edge_share", { forest_edge_share: 29 })).toBe(false);
    expect(shows("forest_edge_share", { forest_edge_share: 30 })).toBe(true);
    expect(shows("forest_edge_share", {})).toBe(false);
    expect(spec.legend).toMatchObject({ kind: "ramp", min: "30%", max: "100%", note: "Only from 30% on" });
    const color = spec.color as unknown[];
    expect(color.slice(0, 2)).toEqual(["interpolate", ["linear"]]);
    expect(color[3]).toBe(30);
    expect(color.at(-2)).toBe(100);
  });

  test("traffic alongside: from a quarter on (a tertiary road at country speed), a ramp", () => {
    const spec = infoSpec(attribute("road_near_traffic"), "light");
    expect(shows("road_near_traffic", { road_near_traffic: 7 })).toBe(false);
    expect(shows("road_near_traffic", { road_near_traffic: 25 })).toBe(true);
    expect(shows("road_near_traffic", {})).toBe(false);
    expect(spec.minzoom).toBe(12);
    expect(spec.legend).toMatchObject({ kind: "ramp", min: "25%", max: "100%" });
  });

  test("a number: the steep ones only; a share without a rule: where it is not zero", () => {
    expect(shows("grade_max", { grade_max: 5.9 })).toBe(false);
    expect(shows("grade_max", { grade_max: 6 })).toBe(true);
    expect(infoSpec(attribute("grade_max"), "light").legend).toMatchObject({ min: "6%", max: "25%" });
    const plain: OverlayAttribute = { key: "something", label: "Something", kind: "share", max: 1 };
    const spec = infoSpec(plain, "light");
    expect(evaluate(spec.filter, { something: 0 })).toBe(false);
    expect(evaluate(spec.filter, { something: 0.01 })).toBe(true);
    expect(spec.legend).toMatchObject({ min: "> 0%", note: "" });
  });

  test("every rule names an attribute key of the pipeline and labels of its enum", () => {
    for (const key of ["surface_class", "tracktype", "bike_access", "cycleway_kind", "route_level"]) {
      const a = attribute(key);
      if (a.kind !== "enum") throw new Error(key);
      const known = new Set(a.values.map((v) => v.label));
      for (const label of RULES[key]?.hide ?? []) expect(known.has(label)).toBe(true);
    }
  });
});

describe("formatAttribute", () => {
  test("enum codes by label, shares as a percentage, numbers with their unit", () => {
    expect(formatAttribute(attribute("surface_class"), 2)).toBe("paved rough");
    expect(formatAttribute(attribute("surface_class"), 99)).toBe("code 99");
    expect(formatAttribute(attribute("forest_share"), 70)).toBe("70%");
    expect(formatAttribute(attribute("grade_max"), 7.25)).toBe("7.3%");
    expect(formatAttribute(attribute("grade_max"), undefined)).toBe("no value");
    expect(isUnknownLabel(" Unknown ")).toBe(true);
  });
});

describe("the layer's name in the URL", () => {
  test("round trip; anything else is the plain map", () => {
    expect(infoLayerFromName(null, attributes)).toEqual({ kind: "none" });
    expect(infoLayerFromName("nope", attributes)).toEqual({ kind: "none" });
    expect(infoLayerName(infoLayerFromName("explored", attributes))).toBe("explored");
    expect(infoLayerName(infoLayerFromName("surface_class", attributes))).toBe("surface_class");
  });
});
