import { describe, expect, test } from "bun:test";
import {
  attributeColor,
  formatAttribute,
  isUnknownLabel,
  legendFor,
  overlayPaint,
} from "../src/map/expressions";
import type { OverlayAttribute } from "../src/map/manifest";
import { CATEGORICAL, categoryColor, sequential, UNKNOWN } from "../src/map/palette";

const surface: OverlayAttribute = {
  key: "surface_class",
  label: "Surface",
  kind: "enum",
  values: [
    { value: 0, label: "unknown" },
    { value: 1, label: "paved" },
    { value: 2, label: "gravel" },
  ],
};
const forest: OverlayAttribute = { key: "forest", label: "In forest", kind: "share", max: 1 };
const grade: OverlayAttribute = {
  key: "grade",
  label: "Max grade",
  kind: "number",
  unit: "%",
  min: 0,
  max: 25,
};

describe("attributeColor", () => {
  test("enum: a match on the code, categorical colours, unknown and fallback are neutral", () => {
    const e = attributeColor(surface, "light") as unknown[];
    expect(e).toEqual([
      "match",
      ["get", "surface_class"],
      1,
      CATEGORICAL[0],
      2,
      CATEGORICAL[1],
      UNKNOWN.light,
    ]);
    // code 0 ("unknown") is not an arm: it falls through to the neutral colour, like a missing value
    expect(e).not.toContain(0);
  });

  test("share and number: a sequential ramp over the domain, neutral when there is no number", () => {
    const e = attributeColor(forest, "light") as unknown[];
    expect(e[0]).toBe("case");
    expect(e[1]).toEqual(["==", ["typeof", ["get", "forest"]], "number"]);
    expect(e[3]).toBe(UNKNOWN.light);
    const ramp = e[2] as unknown[];
    expect(ramp.slice(0, 3)).toEqual(["interpolate", ["linear"], ["get", "forest"]]);
    expect(ramp[3]).toBe(0);
    expect(ramp[ramp.length - 2]).toBe(1);
    const stops = ramp.slice(3).filter((_, i) => i % 2 === 0) as number[];
    expect([...stops].sort((a, b) => a - b)).toEqual(stops);
    expect(((attributeColor(grade, "dark") as unknown[])[2] as unknown[]).includes(25)).toBe(true);
  });

  test("the sequential ramp differs by theme and each theme drops its invisible end", () => {
    expect(sequential("light")).toHaveLength(8);
    expect(sequential("dark")).toHaveLength(8);
    expect(sequential("light")[0]).not.toBe(sequential("dark")[0]);
  });
});

describe("categoryColor", () => {
  test("uses at most 8 distinct hues; later rounds repeat them lighter then darker", () => {
    expect(new Set(Array.from({ length: 8 }, (_, i) => categoryColor(i))).size).toBe(8);
    expect(categoryColor(8)).not.toBe(categoryColor(0));
    expect(categoryColor(16)).not.toBe(categoryColor(8));
    expect(categoryColor(24)).toBe(categoryColor(8)); // rounds alternate, they never run out
  });
});

describe("legendFor", () => {
  test("enum: one entry per known value, then a neutral Unknown", () => {
    const legend = legendFor(surface, "light");
    expect(legend.kind).toBe("categories");
    if (legend.kind !== "categories") return;
    expect(legend.entries.map((e) => e.label)).toEqual(["paved", "gravel", "Unknown"]);
    expect(legend.entries.at(-1)?.neutral).toBe(true);
  });

  test("an enum without an unknown code still gets a neutral entry (edges can lack the value)", () => {
    const legend = legendFor({ ...surface, values: [{ value: 1, label: "paved" }] }, "dark");
    if (legend.kind !== "categories") throw new Error("categories expected");
    expect(legend.entries.at(-1)).toMatchObject({ label: "No value", neutral: true });
  });

  test("share / number: a ramp with ends and a no-value entry", () => {
    expect(legendFor(forest, "light")).toMatchObject({ kind: "ramp", min: "0%", max: "100%" });
    expect(legendFor(grade, "light")).toMatchObject({ kind: "ramp", min: "0%", max: "25%" });
    const km: OverlayAttribute = { key: "s", label: "Speed", kind: "number", unit: "km/h", min: 0, max: 130 };
    expect(legendFor(km, "light")).toMatchObject({ min: "0 km/h", max: "130 km/h" });
  });
});

describe("formatAttribute", () => {
  test("enum codes by label, shares as percent, numbers with their unit, gaps as no value", () => {
    expect(formatAttribute(surface, 2)).toBe("gravel");
    expect(formatAttribute(surface, 9)).toBe("code 9");
    expect(formatAttribute(forest, 0.456)).toBe("46%");
    expect(formatAttribute(grade, 12)).toBe("12%");
    expect(formatAttribute(grade, undefined)).toBe("no value");
  });

  test("unknown labels are recognised loosely", () => {
    expect(isUnknownLabel(" Unknown ")).toBe(true);
    expect(isUnknownLabel("other")).toBe(false);
  });
});

describe("overlayPaint", () => {
  test("plain hides the overlay", () => {
    expect(overlayPaint({ mode: "plain" }, "light").visible).toBe(false);
    // attribute mode without a chosen attribute has nothing to colour by
    expect(overlayPaint({ mode: "attribute" }, "light").visible).toBe(false);
  });

  test("attribute colours by the attribute; explored by feature-state", () => {
    const a = overlayPaint({ mode: "attribute", attribute: surface }, "light");
    expect(a.visible).toBe(true);
    expect(JSON.stringify(a.lineColor)).toContain("surface_class");
    const x = overlayPaint({ mode: "explored" }, "dark");
    expect(JSON.stringify(x.lineColor)).toContain('["feature-state","ridden"]');
    expect(JSON.stringify(x.lineWidth)).toContain("feature-state");
  });

  test("line widths grow with zoom from z8 to z18", () => {
    const width = overlayPaint({ mode: "attribute", attribute: forest }, "light").lineWidth as unknown[];
    expect(width.slice(0, 3)).toEqual(["interpolate", ["linear"], ["zoom"]]);
    const stops = width.slice(3);
    expect(stops[0]).toBe(8);
    expect(stops.at(-2)).toBe(18);
    const widths = stops.filter((_, i) => i % 2 === 1) as number[];
    expect([...widths].sort((a, b) => a - b)).toEqual(widths);
  });
});
