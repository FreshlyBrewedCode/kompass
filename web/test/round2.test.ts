import { describe, expect, test } from "bun:test";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { VARIANTS, variantFromSearch } from "../src/map/round2/variants";
import { buildStyle, DEFAULT_LAYERS, EXPLORED_LINE, INFO_LINE } from "../src/map/style";
import { WAY_CASING, WAY_HALO, WAY_ROUTE, WAY_SELECTED } from "../src/map/ways";
import { pipelineManifest } from "./pipeline-manifest";

// the design round's prototype variants (`?mapstyle=`): each must be a valid style in both themes and
// keep the layers the controller switches and queries
describe("map style round 2 variants", () => {
  const manifest = pipelineManifest();
  const base = { dataUrl: "https://example.org/data/", assetsUrl: "https://example.org/map/" };

  test("the query switch", () => {
    expect(variantFromSearch("?mapstyle=B")).toBe("b");
    expect(variantFromSearch("?mapstyle=x")).toBeNull();
    expect(variantFromSearch("")).toBeNull();
  });

  for (const variant of VARIANTS) {
    for (const theme of ["light", "dark"] as const) {
      test(`${variant} ${theme} is a valid style`, () => {
        const style = buildStyle({ manifest, ...base, theme, layers: DEFAULT_LAYERS, variant });
        expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
        const ids = style.layers.map((l) => l.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of [WAY_ROUTE, WAY_CASING, WAY_HALO, WAY_SELECTED, INFO_LINE, EXPLORED_LINE]) {
          expect(ids).toContain(id);
        }
        // the bands lie between the ways' rims and their lines
        expect(ids.indexOf("r2-band-casing")).toBeLessThan(ids.indexOf(INFO_LINE));
        expect(ids.indexOf(EXPLORED_LINE)).toBeLessThan(ids.indexOf("r2-band"));
      });
    }
  }
});
