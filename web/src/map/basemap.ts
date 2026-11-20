// The base map layers of the outdoor style, on the Protomaps tiles (schema v4): land cover and land
// use, water, buildings, the roads *below* the zoom where the overlay takes over, motorways and
// railways (never in the overlay) and the labels. Pure builders.
//
// From `@protomaps/basemaps` come only the label layers and a few fills (earth, water), recoloured
// through a flavour; land cover and roads are our own layers, because an outdoor map needs meadow,
// farmland and built-up areas told apart and a road hierarchy that continues into the overlay's.
import { type Flavor, namedFlavor, layers as protomapsLayers } from "@protomaps/basemaps";
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type { Carto } from "./carto";
import type { Theme } from "./palette";
import { WAYS_MINZOOM } from "./ways";

type Expr = ExpressionSpecification;

/** The Protomaps flavour behind the layers we keep from the package (labels, earth, water, buildings). */
export function flavor(theme: Theme, c: Carto): Flavor {
  const base = namedFlavor(theme);
  return {
    ...base,
    background: c.background,
    earth: c.land,
    water: c.water,
    buildings: c.buildings,
    pedestrian: c.builtup,
    boundaries: c.boundary,
    city_label: c.label,
    city_label_halo: c.labelHalo,
    subplace_label: c.labelMinor,
    subplace_label_halo: c.labelHalo,
    state_label: c.labelMinor,
    state_label_halo: c.labelHalo,
    country_label: c.labelMinor,
    roads_label_major: c.labelMinor,
    roads_label_major_halo: c.labelHalo,
    roads_label_minor: c.labelMinor,
    roads_label_minor_halo: c.labelHalo,
    address_label: c.labelMinor,
    address_label_halo: c.labelHalo,
    ocean_label: c.waterLabel,
    landcover: {
      barren: c.rock,
      farmland: c.farmland,
      forest: c.forest,
      glacier: c.glacier,
      grassland: c.meadow,
      scrub: c.scrub,
      urban_area: c.builtup,
    },
  };
}

/** Land use `kind` → colour. What is not listed keeps the land colour. */
function landFills(source: string, c: Carto): LayerSpecification[] {
  const fill = (id: string, kinds: Record<string, string>, opacity: Expr | number): LayerSpecification => ({
    id,
    type: "fill",
    source,
    "source-layer": "landuse",
    filter: ["in", ["get", "kind"], ["literal", Object.keys(kinds)]],
    paint: {
      "fill-color": ["match", ["get", "kind"], ...Object.entries(kinds).flat(), c.land] as unknown as Expr,
      "fill-opacity": opacity,
      "fill-antialias": false,
    },
  });
  return [
    // built-up first: parks and woods inside a town stay green
    fill(
      "land-use",
      {
        residential: c.builtup,
        commercial: c.industrial,
        retail: c.industrial,
        industrial: c.industrial,
        railway: c.industrial,
        farmyard: c.builtup,
        hospital: c.builtup,
        school: c.builtup,
        university: c.builtup,
        college: c.builtup,
        kindergarten: c.builtup,
        pedestrian: c.builtup,
        aerodrome: c.industrial,
      },
      1,
    ),
    fill(
      "land-cover",
      {
        forest: c.forest,
        wood: c.forest,
        scrub: c.scrub,
        heath: c.scrub,
        meadow: c.meadow,
        grassland: c.meadow,
        grass: c.meadow,
        farmland: c.farmland,
        orchard: c.orchard,
        vineyard: c.orchard,
        allotments: c.orchard,
        wetland: c.wetland,
        bare_rock: c.rock,
        scree: c.rock,
        sand: c.sand,
        beach: c.sand,
        glacier: c.glacier,
        park: c.park,
        cemetery: c.park,
        village_green: c.park,
        recreation_ground: c.park,
        golf_course: c.park,
        playground: c.park,
        pitch: c.pitch,
      },
      // the Protomaps low-zoom land cover fades out as this fades in
      ["interpolate", ["linear"], ["zoom"], 6, 0, 8, 1],
    ),
  ];
}

const KIND = ["get", "kind"] as Expr;
const DETAIL = ["get", "kind_detail"] as Expr;
const byDetail = (major: unknown, secondary: unknown, other: unknown): Expr =>
  [
    "match",
    DETAIL,
    ["trunk", "trunk_link", "primary", "primary_link"],
    major,
    ["secondary", "secondary_link"],
    secondary,
    other,
  ] as Expr;

/**
 * The base tiles' roads below `WAYS_MINZOOM`, in the same colours and ending at the same widths as the
 * overlay's, which replaces them from there on. Tracks show one zoom early, as a hint of what comes.
 */
function lowZoomRoads(source: string, c: Carto): LayerSpecification[] {
  const base = { type: "line", source, "source-layer": "roads", maxzoom: WAYS_MINZOOM } as const;
  const round = { "line-cap": "round", "line-join": "round" } as const;
  const roads: Expr = ["in", KIND, ["literal", ["major_road", "minor_road"]]];
  const notService: Expr = ["!=", DETAIL, "service"];
  // px at z7, 10, 12, 13; the last column is what `ways.ts` starts with
  const width = (extra: number): Expr => [
    "interpolate",
    ["exponential", 1.4],
    ["zoom"],
    7,
    byDetail(0.7 + extra, 0, 0),
    10,
    byDetail(1.4 + extra, 0.9 + extra, ["match", KIND, "major_road", 0.5 + extra, 0]),
    12,
    byDetail(2.2 + extra, 1.8 + extra, ["match", KIND, "major_road", 1.5 + extra, 1 + extra]),
    13,
    byDetail(2.8 + extra, 2.4 + extra, ["match", KIND, "major_road", 2.1 + extra, 1.8 + extra]),
  ];
  return [
    {
      ...base,
      id: "base-track",
      minzoom: 12,
      filter: ["==", KIND, "path"],
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": c.track, "line-opacity": 0.7, "line-width": 0.8, "line-dasharray": [4, 1.6] },
    },
    {
      ...base,
      id: "base-road-casing",
      minzoom: 8,
      filter: ["all", roads, notService],
      layout: round,
      paint: {
        "line-color": byDetail(c.primaryCasing, c.secondaryCasing, c.roadCasing),
        "line-width": width(1.2),
      },
    },
    {
      ...base,
      id: "base-road",
      filter: ["all", roads, notService],
      layout: { ...round, "line-sort-key": byDetail(3, 2, ["match", KIND, "major_road", 1, 0]) },
      paint: {
        "line-color": byDetail(c.primary, c.secondary, c.road),
        "line-width": width(0),
      },
    },
  ];
}

/** Motorways and railways at every zoom: the overlay has neither (a bicycle cannot use them). */
function motorwaysAndRail(source: string, c: Carto): LayerSpecification[] {
  const base = { type: "line", source, "source-layer": "roads" } as const;
  const motorway: Expr = ["==", KIND, "highway"];
  const width = (extra: number): Expr => [
    "interpolate",
    ["exponential", 1.4],
    ["zoom"],
    6,
    0.8 + extra,
    10,
    2 + extra,
    13,
    3.4 + extra,
    15,
    6.5 + extra,
    17,
    13 + extra,
    19,
    28 + extra,
  ];
  const tunnel: Expr = ["case", ["has", "is_tunnel"], 0.45, 1];
  return [
    {
      ...base,
      id: "base-rail",
      // sidings and yards only close up: a station would be a grey smear otherwise
      filter: ["all", ["==", KIND, "rail"], ["any", [">=", ["zoom"], 15], ["!", ["has", "service"]]]],
      minzoom: 9,
      paint: {
        "line-color": c.rail,
        "line-opacity": ["case", ["has", "is_tunnel"], 0.3, 0.75],
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 13, 0.9, 17, 2],
      },
    },
    {
      ...base,
      id: "base-motorway-casing",
      filter: motorway,
      minzoom: 9,
      layout: { "line-join": "round" },
      paint: { "line-color": c.motorwayCasing, "line-opacity": tunnel, "line-width": width(1.4) },
    },
    {
      ...base,
      id: "base-motorway",
      filter: motorway,
      layout: { "line-join": "round" },
      paint: { "line-color": c.motorway, "line-opacity": tunnel, "line-width": width(0) },
    },
  ];
}

/** Summits with name and height, from the planning zooms on: the anchors of a hilly map. */
function peaks(source: string, c: Carto): LayerSpecification[] {
  return [
    {
      id: "peaks",
      type: "symbol",
      source,
      "source-layer": "pois",
      minzoom: 12,
      filter: ["all", ["==", KIND, "peak"], ["has", "name"]],
      layout: {
        "icon-image": "peak",
        "icon-size": 0.8,
        "symbol-sort-key": ["-", 0, ["to-number", ["get", "elevation"], 0]],
        "text-field": [
          "case",
          ["has", "elevation"],
          ["concat", ["get", "name"], "\n", ["to-string", ["round", ["to-number", ["get", "elevation"]]]]],
          ["get", "name"],
        ],
        "text-font": ["Noto Sans Italic"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 12.5],
        "text-anchor": "top",
        "text-offset": [0, 0.6],
        "text-line-height": 1.1,
        "text-optional": true,
        "text-padding": 4,
      },
      paint: { "text-color": c.contourLabel, "text-halo-color": c.labelHalo, "text-halo-width": 1.4 },
    },
  ];
}

/** The package's POI layer minus the summits (`peaks` draws them). */
function withoutPeaks(layer: LayerSpecification): LayerSpecification {
  if (layer.id !== "pois" || layer.type !== "symbol" || !layer.filter) return layer;
  return { ...layer, filter: ["all", ["!=", KIND, "peak"], layer.filter] as never };
}

export type BaseLayers = {
  /** background, land, water areas: everything the relief is drawn on */
  ground: LayerSpecification[];
  /** rivers and streams, buildings: above the relief */
  features: LayerSpecification[];
  /** the roads below the zoom where the overlay draws them */
  roads: LayerSpecification[];
  /** motorways and railways: above the overlay's ways */
  top: LayerSpecification[];
  labels: LayerSpecification[];
};

/** Ids of the Protomaps layers kept as they are (recoloured by the flavour). */
const KEEP_GROUND = ["background", "earth", "landcover"];
const KEEP_WATER = ["water"];
const KEEP_FEATURES = ["water_stream", "water_river", "buildings"];

export function baseLayers(source: string, theme: Theme, c: Carto, lang: string): BaseLayers {
  const f = flavor(theme, c);
  const all = protomapsLayers(source, f, { lang });
  const labelIds = new Set(protomapsLayers(source, f, { lang, labelsOnly: true }).map((l) => l.id));
  const byId = new Map(all.map((l) => [l.id, l]));
  const keep = (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? []);

  const features = keep(KEEP_FEATURES).map((layer): LayerSpecification => {
    if (layer.type !== "line") return layer;
    // rivers and streams: our blue (the package draws them in the water fill's colour)
    return { ...layer, paint: { ...layer.paint, "line-color": c.waterway } };
  });
  const boundaries: LayerSpecification[] = [
    {
      id: "boundaries",
      type: "line",
      source,
      "source-layer": "boundaries",
      // countries and states only: municipal borders are noise on an outdoor map
      filter: ["<=", ["get", "kind_detail"], 4],
      paint: { "line-color": c.boundary, "line-width": 1, "line-dasharray": [4, 2], "line-opacity": 0.7 },
    },
  ];
  return {
    ground: [...keep(KEEP_GROUND), ...landFills(source, c), ...keep(KEEP_WATER)],
    features,
    roads: lowZoomRoads(source, c),
    top: [...motorwaysAndRail(source, c), ...boundaries],
    labels: [...peaks(source, c), ...all.filter((l) => labelIds.has(l.id)).map(withoutPeaks)],
  };
}
