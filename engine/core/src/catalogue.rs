//! The catalogue: every preference and limit a profile can name, with the text the UI shows and the
//! numbers that shape its cost (how strong +100 and −100 are). The picker, the JSON Schema and the
//! agent's tool all read it; nothing about the set of preferences is hard-coded elsewhere. What each
//! one matches on the graph is [`crate::cost`]; `docs/profile.md` explains both.

use serde::{Deserialize, Serialize};

#[cfg(feature = "schema")]
use ts_rs::TS;

use crate::graph::Graph;
use crate::profile::{Bounds, LimitId, PrefId};

/// The catalogue's version; bumped when ids change meaning or disappear.
pub const CATALOGUE_VERSION: u32 = 1;

/// A group of the picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum Group {
    Surface,
    Ways,
    Traffic,
    Landscape,
    Terrain,
    Signs,
    Trail,
    History,
}

/// What kind of control an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum Kind {
    /// A slider, −100 (avoid) … +100 (seek).
    Soft,
    /// A switch that excludes ways.
    LimitFlag,
    /// A number that excludes ways beyond it.
    LimitNumber,
}

/// A group's text.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct GroupInfo {
    pub id: Group,
    pub label: &'static str,
    pub blurb: &'static str,
}

/// Where a preference's data comes from, and how much of the region has it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Coverage {
    /// The attribute the preference rests on (an `edges.parquet` column, or `personal`).
    pub attribute: &'static str,
    /// Share of the region's length where it is mapped, 0..1 (only from a loaded region).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share: Option<f32>,
    /// What to know about the data.
    pub note: &'static str,
}

/// A soft preference.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Preference {
    pub id: PrefId,
    /// Always [`Kind::Soft`].
    pub kind: Kind,
    pub group: Group,
    pub label: &'static str,
    /// For chips.
    pub short: &'static str,
    /// One line: what it matches.
    pub hint: &'static str,
    /// Words for the slider's ends, when "avoid" / "seek" don't fit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low_label: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub high_label: Option<&'static str>,
    /// The weight it starts with when added.
    pub default: i8,
    /// The factor on a fully matching way at +100 (< 1: cheaper).
    pub max_bonus: f32,
    /// The factor on a fully matching way at −100 (> 1: dearer).
    pub max_penalty: f32,
    /// Its bonus only counts on ways the rest of the profile finds acceptable (see `docs/profile.md`).
    pub gated: bool,
    /// Reads the personal layer (no effect without one).
    pub personal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<Coverage>,
}

/// The number of a number limit.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct NumberRange {
    pub min: f64,
    pub max: f64,
    pub step: f64,
    /// When the limit is switched on.
    pub default: f64,
    pub unit: &'static str,
}

/// A hard limit.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Limit {
    pub id: LimitId,
    pub kind: Kind,
    pub group: Group,
    pub label: &'static str,
    pub hint: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<NumberRange>,
}

/// A bound's range.
#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct BoundRange {
    pub min: f32,
    pub max: f32,
    pub default: f32,
}

/// The ranges of [`Bounds`].
#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct BoundsInfo {
    pub min_factor: BoundRange,
    pub max_factor: BoundRange,
}

/// The whole catalogue (`kompass profile catalogue`).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Catalogue {
    pub version: u32,
    pub groups: Vec<GroupInfo>,
    pub preferences: Vec<Preference>,
    pub limits: Vec<Limit>,
    pub bounds: BoundsInfo,
    /// The range of `turn_m`, what a right-angle turn at a junction costs (metres-equivalent).
    pub turn_m: BoundRange,
    /// The structured controls (boards, tiers, the hills curve, detours; a prototype). Always
    /// present.
    #[cfg_attr(feature = "schema", ts(optional))]
    pub structured: Option<crate::structured::StructuredInfo>,
}

/// The static facts of a preference.
#[derive(Debug, Clone, Copy)]
pub struct PrefMeta {
    pub group: Group,
    pub label: &'static str,
    pub short: &'static str,
    pub hint: &'static str,
    pub low_label: Option<&'static str>,
    pub high_label: Option<&'static str>,
    pub default: i8,
    pub max_bonus: f32,
    pub max_penalty: f32,
    pub gated: bool,
    /// The attribute behind it and a note, when its coverage matters.
    pub coverage: Option<(&'static str, &'static str)>,
}

#[allow(clippy::too_many_arguments, reason = "a table row")]
const fn p(
    group: Group,
    label: &'static str,
    short: &'static str,
    hint: &'static str,
    default: i8,
    max_bonus: f32,
    max_penalty: f32,
) -> PrefMeta {
    PrefMeta {
        group,
        label,
        short,
        hint,
        low_label: None,
        high_label: None,
        default,
        max_bonus,
        max_penalty,
        gated: false,
        coverage: None,
    }
}

impl PrefMeta {
    const fn gated(mut self) -> Self {
        self.gated = true;
        self
    }
    const fn ends(mut self, low: &'static str, high: &'static str) -> Self {
        self.low_label = Some(low);
        self.high_label = Some(high);
        self
    }
    const fn data(mut self, attribute: &'static str, note: &'static str) -> Self {
        self.coverage = Some((attribute, note));
        self
    }
}

/// A "steeper than X %" preference: a grade threshold of the family (the ramp is
/// [`crate::cost::grade_ramp`]). Strong when avoided (4× at −100 on a full match, and they stack), a
/// mild bonus when sought.
const fn ramps_over(label: &'static str, short: &'static str, hint: &'static str) -> PrefMeta {
    p(Group::Terrain, label, short, hint, -60, 0.85, 4.0).data(
        "max_grade_fwd_pct",
        "From a surface model: forest grades are discounted, they are mostly canopy noise.",
    )
}

/// The facts of a preference. The bonus and penalty strengths are the tuning knobs of the cost
/// model (tuned on a real region, see the PR of #18 and `docs/profile.md`).
#[must_use]
#[allow(clippy::too_many_lines, reason = "the table")]
pub fn pref_meta(id: PrefId) -> PrefMeta {
    use Group::{History, Landscape, Signs, Surface, Terrain, Traffic, Trail, Ways};
    match id {
        PrefId::Unpaved => p(
            Surface,
            "Gravel & unpaved",
            "Gravel",
            "Anything not sealed: gravel, forest tracks, dirt.",
            50,
            0.6,
            2.5,
        )
        .data(
            "surface_class",
            "Untagged tracks and paths count by their track grade or a guess; see unknown surface.",
        ),
        PrefId::PavedSmooth => p(
            Surface,
            "Smooth tarmac",
            "Tarmac",
            "Asphalt and concrete in good shape.",
            50,
            0.75,
            2.0,
        ),
        PrefId::PavedRough => p(
            Surface,
            "Cobbles & rough paving",
            "Cobbles",
            "Sett, cobblestone, concrete plates and broken tarmac.",
            -60,
            0.85,
            2.5,
        ),
        PrefId::FineGravel => p(
            Surface,
            "Compacted fine gravel",
            "Fine gravel",
            "Hard-packed, rolls almost like tarmac.",
            60,
            0.75,
            2.0,
        ),
        PrefId::SoftGround => p(
            Surface,
            "Soft ground, grass, sand",
            "Soft ground",
            "Slow when dry, a mess when wet. Includes grade 4–5 tracks.",
            -50,
            0.85,
            3.0,
        ),
        PrefId::UnknownSurface => p(
            Surface,
            "Unknown surface",
            "Unknown",
            "No surface tag and no good guess. Unknown is not bad, only unknown.",
            -30,
            0.85,
            2.0,
        )
        .data(
            "surface_class",
            "Streets without a surface tag count as paved, not unknown.",
        ),
        PrefId::Tracktype => p(
            Surface,
            "Firm tracks (grade 1–2)",
            "Firm tracks",
            "Track grade: 1 is solid, 5 is soft and overgrown. Avoiding it seeks the rough ones.",
            50,
            0.75,
            1.8,
        )
        .ends("rough tracks", "firm tracks")
        .data("tracktype", "Mapped on most tracks, rarely elsewhere."),
        PrefId::Smoothness => p(
            Surface,
            "Smoothness",
            "Smooth",
            "The smoothness tag, where someone mapped it: smooth is cheaper, bumpy dearer.",
            40,
            0.8,
            1.8,
        )
        .ends("bumpy", "smooth")
        .data(
            "smoothness",
            "Mapped on few ways: a bonus where known, nothing elsewhere.",
        ),
        PrefId::Track => p(
            Ways,
            "Farm & forest tracks",
            "Tracks",
            "Two-lane tracks for tractors and forestry.",
            60,
            0.7,
            2.5,
        ),
        PrefId::Path => p(
            Ways,
            "Narrow paths",
            "Paths",
            "Footpaths, bridleways and singletrack.",
            40,
            0.75,
            2.5,
        ),
        PrefId::CyclewaySep => p(
            Ways,
            "Bike paths away from the road",
            "Bike paths",
            "Their own line through the land, no cars in sight.",
            60,
            0.6,
            2.0,
        )
        .data(
            "road_near_share",
            "Told apart from roadside paths by their distance to the nearest motor road.",
        ),
        PrefId::CyclewayRoad => p(
            Ways,
            "Bike paths beside a road",
            "Roadside paths",
            "Separate, but you hear and see the traffic.",
            -30,
            0.8,
            2.0,
        )
        .data(
            "road_near_share",
            "Separate paths within 20 m of a motor road, and tracks tagged on the road.",
        ),
        PrefId::Residential => p(
            Ways,
            "Residential streets",
            "Residential",
            "Slow streets through villages and estates.",
            30,
            0.8,
            2.0,
        ),
        PrefId::Service => p(
            Ways,
            "Service & access roads",
            "Service",
            "Driveways, farm access, parking aisles, industrial yards.",
            -20,
            0.85,
            2.0,
        ),
        PrefId::Minor => p(
            Ways,
            "Small country roads",
            "Country roads",
            "Unclassified and tertiary roads.",
            30,
            0.8,
            2.5,
        ),
        PrefId::Main => p(
            Ways,
            "Main roads",
            "Main roads",
            "Secondary, primary and trunk roads.",
            -80,
            0.85,
            5.0,
        ),
        PrefId::Quiet => p(
            Traffic,
            "Low traffic",
            "Quiet",
            "Guessed from road class, speed limit, lanes and who may drive there; a path beside a busy road gets part of its traffic.",
            50,
            0.85,
            4.0,
        )
        .ends("don't care", "must be calm")
        .data(
            "maxspeed_kmh",
            "Unknown speed limits are guessed from the road class and whether it is built-up.",
        ),
        PrefId::Speed => p(
            Traffic,
            "Fast roads (70 km/h and up)",
            "Fast roads",
            "By speed limit, whatever the road class.",
            -60,
            0.85,
            3.0,
        )
        .data(
            "maxspeed_kmh",
            "Unknown speed limits are guessed from the road class and whether it is built-up.",
        ),
        PrefId::Lanes => p(
            Traffic,
            "Multi-lane roads",
            "Multi-lane",
            "Three lanes or more.",
            -70,
            0.9,
            3.0,
        )
        .data("lanes", "Mapped on most main roads, rarely on small ones."),
        PrefId::NearRoad => p(
            Traffic,
            "Within earshot of a motor road",
            "Road noise",
            "Ways within 20 m of a motor road, the roads included.",
            -40,
            0.85,
            2.0,
        ),
        PrefId::Forest => p(
            Landscape,
            "Through forest",
            "Forest",
            "Share of the way under trees.",
            50,
            0.8,
            1.6,
        )
        .gated(),
        PrefId::ForestEdge => p(
            Landscape,
            "Along a forest edge",
            "Forest edge",
            "Trees on one side, a view on the other.",
            60,
            0.75,
            1.6,
        )
        .gated(),
        PrefId::Water => p(
            Landscape,
            "Along rivers & lakes",
            "Water",
            "Ways within 100 m of a river, a canal or a lake.",
            60,
            0.75,
            1.6,
        )
        .gated(),
        PrefId::Open => p(
            Landscape,
            "Open land",
            "Open land",
            "Neither forest nor built-up: fields and meadows, wind included.",
            40,
            0.85,
            1.5,
        )
        .gated(),
        PrefId::Built => p(
            Landscape,
            "Built-up areas",
            "Built-up",
            "Towns, villages, industrial estates.",
            -40,
            0.85,
            2.0,
        )
        .gated(),
        PrefId::Climb => p(
            Terrain,
            "Climbing",
            "Climb",
            "Total ascent along the way. Avoiding it adds a cost per metre of climbing.",
            -40,
            0.7,
            25.0,
        )
        .gated()
        .ends("keep it flat", "bring it on")
        .data(
            "ascent_fwd_m",
            "From a surface model: noisy under trees, so small wiggles are ignored (more so in forest).",
        ),
        PrefId::Steep => p(
            Terrain,
            "Steep ramps",
            "Ramps",
            "Stretches over 8 % up (and half as much down), full at 16 %.",
            -50,
            0.85,
            3.0,
        )
        .data(
            "max_grade_fwd_pct",
            "From a surface model: forest grades are discounted, they are mostly canopy noise.",
        ),
        PrefId::RampsOver6 => ramps_over("Steeper than 6 %", "Over 6 %", "Climbs over 6 %, full at 9 %; descents count half."),
        PrefId::RampsOver8 => ramps_over("Steeper than 8 %", "Over 8 %", "Climbs over 8 %, full at 11 %; descents count half."),
        PrefId::RampsOver10 => ramps_over("Steeper than 10 %", "Over 10 %", "Climbs over 10 %, full at 13 %; descents count half."),
        PrefId::RampsOver12 => ramps_over("Steeper than 12 %", "Over 12 %", "Climbs over 12 %, full at 15 %; descents count half."),
        PrefId::RampsOver15 => ramps_over("Steeper than 15 %", "Over 15 %", "Climbs over 15 %, full at 18 %; descents count half."),
        PrefId::BikeRoutes => p(
            Signs,
            "Signed bike routes",
            "Bike routes",
            "Local, regional and long-distance cycle routes (the longer, the more).",
            40,
            0.8,
            1.5,
        )
        .gated(),
        PrefId::MtbRoutes => p(
            Signs,
            "Signed MTB routes",
            "MTB routes",
            "Ways of a mountain bike route.",
            0,
            0.8,
            1.5,
        )
        .gated(),
        PrefId::Access => p(
            Signs,
            "Doubtful access",
            "Doubtful access",
            "Bikes are tolerated, not clearly allowed: footways, private, farm-only, use-the-sidepath.",
            -70,
            0.9,
            3.0,
        )
        .data(
            "bike_access",
            "Footways and pedestrian areas without a bicycle tag count as foot only (the German default).",
        ),
        PrefId::Sketchy => p(
            Trail,
            "Sketchy trails",
            "Sketchy",
            "Technical, faint, informal or grade 5 – whatever might turn into pushing.",
            -50,
            0.85,
            3.0,
        ),
        PrefId::Mtb => p(
            Trail,
            "Technical trails",
            "Technical",
            "MTB scale (or hiking scale): roots, rocks, steps.",
            -50,
            0.85,
            3.0,
        )
        .data("mtb_scale", "Mapped on few paths."),
        PrefId::Visibility => p(
            Trail,
            "Faint trails",
            "Faint trails",
            "Trail visibility: paths that are hard to see on the ground.",
            -50,
            0.85,
            2.5,
        )
        .data("trail_visibility", "Mapped on very few paths."),
        PrefId::Novel => p(
            History,
            "Never ridden",
            "New",
            "Ways none of your imported rides touch.",
            50,
            0.7,
            1.5,
        )
        .gated()
        .ends("stay familiar", "explore")
        .data("personal", "Needs your imported rides."),
        PrefId::Stale => p(
            History,
            "Not ridden for a long time",
            "Long ago",
            "Ridden before, but not in the last half year (full after two years).",
            40,
            0.8,
            1.4,
        )
        .gated()
        .data("personal", "Needs your imported rides."),
        PrefId::Familiar => p(
            History,
            "Ridden often",
            "Favourites",
            "The ways you keep coming back to (full at five rides).",
            40,
            0.8,
            1.5,
        )
        .gated()
        .data("personal", "Needs your imported rides."),
    }
}

/// The static facts of a limit.
#[derive(Debug, Clone, Copy)]
pub struct LimitMeta {
    pub group: Group,
    pub label: &'static str,
    pub hint: &'static str,
    pub number: Option<NumberRange>,
}

/// The facts of a limit.
#[must_use]
pub fn limit_meta(id: LimitId) -> LimitMeta {
    let flag = |group, label, hint| LimitMeta {
        group,
        label,
        hint,
        number: None,
    };
    match id {
        LimitId::NoMainRoads => flag(
            Group::Ways,
            "No main roads",
            "Secondary, primary and trunk roads are out, however short (unless they carry a separate cycle track).",
        ),
        LimitId::PavedOnly => flag(
            Group::Surface,
            "Paved only",
            "For the road bike: sealed surface or nothing. Untagged streets count as paved.",
        ),
        LimitId::NoUnknownSurface => flag(
            Group::Surface,
            "No unknown surface",
            "Only ways whose surface is mapped or safely guessed.",
        ),
        LimitId::MaxGrade => LimitMeta {
            group: Group::Terrain,
            label: "Max grade",
            hint: "Nothing steeper than this, up or down (forest grades discounted as noise).",
            number: Some(NumberRange {
                min: 4.0,
                max: 30.0,
                step: 1.0,
                default: 12.0,
                unit: "%",
            }),
        },
        LimitId::MaxMtbScale => LimitMeta {
            group: Group::Trail,
            label: "Max trail difficulty",
            hint: "MTB scale: S0 is a smooth path, S3 is for experts. Hiking scale counts too.",
            number: Some(NumberRange {
                min: 0.0,
                max: 5.0,
                step: 1.0,
                default: 1.0,
                unit: "S",
            }),
        },
        LimitId::NoStairs => flag(
            Group::Trail,
            "No stairs or carrying",
            "Nothing where the bike goes on the shoulder: steps, S4+ trails, alpine paths.",
        ),
        LimitId::LegalOnly => flag(
            Group::Signs,
            "Legal access only",
            "Only where bikes are allowed: no footways, private, farm-only or use-the-sidepath ways.",
        ),
        LimitId::NoFerries => flag(Group::Ways, "No ferries", "Never take a ferry."),
    }
}

fn group_info(id: Group) -> GroupInfo {
    let (label, blurb) = match id {
        Group::Surface => ("Surface", "What you roll on"),
        Group::Ways => ("Way type", "Tracks, paths, roads"),
        Group::Traffic => ("Traffic", "Cars, speed, noise"),
        Group::Landscape => ("Landscape", "Forest, water, open land"),
        Group::Terrain => ("Terrain", "Climbing and ramps"),
        Group::Signs => ("Routes & access", "Signed routes, legal access"),
        Group::Trail => ("Trail difficulty", "How sketchy it gets"),
        Group::History => ("My rides", "New ground or old favourites"),
    };
    GroupInfo { id, label, blurb }
}

/// The catalogue (no coverage shares: see [`catalogue_for`]).
#[must_use]
pub fn catalogue() -> Catalogue {
    let groups = [
        Group::Surface,
        Group::Ways,
        Group::Traffic,
        Group::Landscape,
        Group::Terrain,
        Group::Signs,
        Group::Trail,
        Group::History,
    ];
    let d = Bounds::default();
    Catalogue {
        version: CATALOGUE_VERSION,
        groups: groups.into_iter().map(group_info).collect(),
        preferences: PrefId::ALL
            .iter()
            .map(|&id| {
                let m = pref_meta(id);
                Preference {
                    id,
                    kind: Kind::Soft,
                    group: m.group,
                    label: m.label,
                    short: m.short,
                    hint: m.hint,
                    low_label: m.low_label,
                    high_label: m.high_label,
                    default: m.default,
                    max_bonus: m.max_bonus,
                    max_penalty: m.max_penalty,
                    gated: m.gated,
                    personal: m.coverage.is_some_and(|c| c.0 == "personal"),
                    coverage: m.coverage.map(|(attribute, note)| Coverage {
                        attribute,
                        share: None,
                        note,
                    }),
                }
            })
            .collect(),
        limits: LimitId::ALL
            .iter()
            .map(|&id| {
                let m = limit_meta(id);
                Limit {
                    id,
                    kind: if m.number.is_some() {
                        Kind::LimitNumber
                    } else {
                        Kind::LimitFlag
                    },
                    group: m.group,
                    label: m.label,
                    hint: m.hint,
                    number: m.number,
                }
            })
            .collect(),
        bounds: BoundsInfo {
            min_factor: BoundRange {
                min: Bounds::MIN_FACTOR_RANGE.0,
                max: Bounds::MIN_FACTOR_RANGE.1,
                default: d.min_factor,
            },
            max_factor: BoundRange {
                min: Bounds::MAX_FACTOR_RANGE.0,
                max: Bounds::MAX_FACTOR_RANGE.1,
                default: d.max_factor,
            },
        },
        turn_m: BoundRange {
            min: crate::profile::TURN_M_RANGE.0,
            max: crate::profile::TURN_M_RANGE.1,
            default: crate::profile::TURN_M,
        },
        structured: Some(crate::structured::info()),
    }
}

/// The catalogue with the coverage shares of a loaded region (one pass over the edges).
#[must_use]
pub fn catalogue_for(g: &Graph, personal: Option<&crate::personal::PersonalLayer>) -> Catalogue {
    let mut c = catalogue();
    let shares = crate::cost::coverage(g, personal);
    for pref in &mut c.preferences {
        if let Some(cov) = &mut pref.coverage {
            cov.share = shares.get(cov.attribute).copied();
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_sane() {
        let c = catalogue();
        assert_eq!(c.preferences.len(), PrefId::ALL.len());
        assert_eq!(c.limits.len(), LimitId::ALL.len());
        for p in &c.preferences {
            assert!(p.max_bonus > 0.0 && p.max_bonus < 1.0, "{}", p.id);
            assert!(p.max_penalty > 1.0, "{}", p.id);
            assert!((-100..=100).contains(&p.default), "{}", p.id);
            assert!(
                !p.hint.is_empty() && p.hint.len() < 140,
                "{}: {}",
                p.id,
                p.hint.len()
            );
        }
        for l in &c.limits {
            if let Some(n) = l.number {
                assert!(n.min <= n.default && n.default <= n.max, "{}", l.id);
            }
        }
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(json["preferences"][0]["id"], "unpaved");
        assert_eq!(json["preferences"][0]["kind"], "soft");
        assert_eq!(json["limits"][3]["kind"], "limit_number");
    }
}
