import { describe, expect, test } from "bun:test";
import { CARTO, cartoFor, GROUNDS } from "../src/map/carto";
import { DEFAULT_LOOK, parseLook, sameLook } from "../src/map/look";

describe("the map style options", () => {
  test("parseLook: JSON text or an object; anything missing or unknown is the default", () => {
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
    expect(parseLook("not json")).toEqual(DEFAULT_LOOK);
    expect(parseLook('{"tracks":"simple","weight":"huge","contours":false}')).toEqual({
      ...DEFAULT_LOOK,
      tracks: "simple",
      contours: false,
    });
    expect(parseLook({ ground: "pale", relief: "strong" })).toEqual({
      ...DEFAULT_LOOK,
      ground: "pale",
      relief: "strong",
    });
    expect(sameLook(parseLook({}), DEFAULT_LOOK)).toBe(true);
  });

  test("the default is the base table: graded tracks on the straw ground", () => {
    expect(cartoFor("light", DEFAULT_LOOK)).toEqual(CARTO.light);
    expect(cartoFor("dark", DEFAULT_LOOK)).toEqual(CARTO.dark);
  });

  test("simple: every track is the paved one's band; ground and relief change only the light ground", () => {
    const simple = cartoFor("light", { ...DEFAULT_LOOK, tracks: "simple" });
    for (const fill of [simple.compacted, simple.gravel, simple.soft, simple.unknown])
      expect(fill).toBe(simple.lane);
    expect(cartoFor("light", { ...DEFAULT_LOOK, ground: "pale" }).land).toBe(GROUNDS.pale.land);
    expect(cartoFor("dark", { ...DEFAULT_LOOK, ground: "pale" }).land).toBe(CARTO.dark.land);
    const strong = cartoFor("light", { ...DEFAULT_LOOK, relief: "strong" });
    expect(strong.hillshadeStrength).toBeGreaterThan(CARTO.light.hillshadeStrength);
  });

  test("the bands are lighter than the open land they cross (straw and meadow)", () => {
    const light = (hex: string) =>
      [1, 3, 5].reduce((sum, o) => sum + Number.parseInt(hex.slice(o, o + 2), 16), 0) / 3;
    for (const ground of ["straw", "meadow"] as const) {
      const c = cartoFor("light", { ...DEFAULT_LOOK, ground });
      for (const fill of [c.lane, c.compacted, c.soft, c.unknown, c.road])
        for (const land of [c.land, c.farmland, c.meadow])
          expect([ground, fill, light(fill) > light(land)]).toEqual([ground, fill, true]);
    }
  });
});
