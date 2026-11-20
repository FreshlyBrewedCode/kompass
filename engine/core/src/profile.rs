//! The routing profile: what the rider wants, as data. Soft preferences are signed weights keyed by
//! the catalogue's preference ids ([`PrefId`]), hard limits are switches or numbers keyed by
//! [`LimitId`], and the factor clamp ([`Bounds`]) keeps every profile routable and the A* bound
//! valid. The meaning of every id is in [`crate::catalogue`]; how a profile becomes a cost is
//! [`crate::cost`]. Semantics for the UI: `docs/profile.md`.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

#[cfg(feature = "schema")]
use ts_rs::TS;

/// Declares a catalogue id enum: `snake_case` ids on the wire, `ALL` in catalogue order.
macro_rules! id_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $id:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $id)] $variant,)+
        }

        impl $name {
            /// Every id, in catalogue order.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The id on the wire.
            #[must_use]
            pub fn id(self) -> &'static str {
                match self {
                    $(Self::$variant => $id,)+
                }
            }

            /// The value of a wire id.
            #[must_use]
            pub fn from_id(id: &str) -> Option<Self> {
                match id {
                    $($id => Some(Self::$variant),)+
                    _ => None,
                }
            }

            /// Dense index (catalogue order), for per-id arrays.
            #[must_use]
            pub fn index(self) -> usize {
                self as usize
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.id())
            }
        }
    };
}

id_enum! {
    /// A soft preference of the catalogue (`catalogue().preferences`).
    PrefId {
        Unpaved = "unpaved",
        PavedSmooth = "paved_smooth",
        PavedRough = "paved_rough",
        FineGravel = "fine_gravel",
        SoftGround = "soft_ground",
        UnknownSurface = "unknown_surface",
        Tracktype = "tracktype",
        Smoothness = "smoothness",
        Track = "track",
        Path = "path",
        CyclewaySep = "cycleway_sep",
        CyclewayRoad = "cycleway_road",
        Residential = "residential",
        Service = "service",
        Minor = "minor",
        Main = "main",
        Quiet = "quiet",
        Speed = "speed",
        Lanes = "lanes",
        NearRoad = "near_road",
        Forest = "forest",
        ForestEdge = "forest_edge",
        Water = "water",
        Open = "open",
        Built = "built",
        Climb = "climb",
        Steep = "steep",
        BikeRoutes = "bike_routes",
        MtbRoutes = "mtb_routes",
        Access = "access",
        Sketchy = "sketchy",
        Mtb = "mtb",
        Visibility = "visibility",
        Novel = "novel",
        Stale = "stale",
        Familiar = "familiar",
    }
}

id_enum! {
    /// A hard limit of the catalogue (`catalogue().limits`).
    LimitId {
        NoMainRoads = "no_main_roads",
        PavedOnly = "paved_only",
        NoUnknownSurface = "no_unknown_surface",
        MaxGrade = "max_grade",
        MaxMtbScale = "max_mtb_scale",
        NoStairs = "no_stairs",
        LegalOnly = "legal_only",
        NoFerries = "no_ferries",
    }
}

/// Number of preferences (per-preference arrays).
pub const PREF_COUNT: usize = PrefId::ALL.len();

/// A soft preference's strength: −100 (avoid) … 0 (neutral) … +100 (seek).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
#[cfg_attr(feature = "schema", derive(TS), ts(type = "number"))]
pub struct Weight(i8);

impl Weight {
    pub const MIN: i8 = -100;
    pub const MAX: i8 = 100;

    /// A weight, `None` outside −100..=100.
    #[must_use]
    pub fn new(v: i64) -> Option<Weight> {
        i8::try_from(v)
            .ok()
            .filter(|w| (Self::MIN..=Self::MAX).contains(w))
            .map(Weight)
    }

    #[must_use]
    pub fn get(self) -> i8 {
        self.0
    }

    /// As a fraction, −1..=1.
    #[must_use]
    pub fn unit(self) -> f32 {
        f32::from(self.0) / 100.0
    }
}

impl TryFrom<i64> for Weight {
    type Error = String;
    fn try_from(v: i64) -> Result<Weight, String> {
        Weight::new(v).ok_or_else(|| format!("weight {v} is outside -100..100"))
    }
}

impl From<Weight> for i64 {
    fn from(w: Weight) -> i64 {
        i64::from(w.0)
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for Weight {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Weight".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "description": "A soft preference's strength: -100 avoid, 0 neutral, +100 seek.",
            "type": "integer",
            "minimum": -100,
            "maximum": 100,
        })
    }
}

/// A limit's setting: a switch (`true` on, `false` off, as if absent), or a number for limits that
/// take one (`true` there means the catalogue's default number).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum LimitValue {
    Flag(bool),
    Number(f64),
}

/// The clamp of the factor product (`docs/profile.md`): every arc costs between `min_factor` and
/// `max_factor` times its length (plus additive terms). `min_factor` is the A* bound.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Bounds {
    /// 0.3..=1.0, default 0.5. Lower lets bonuses stack further (and searches slow down a little).
    pub min_factor: f32,
    /// 2..=100, default 20. The most an allowed way can cost per metre.
    pub max_factor: f32,
}

impl Bounds {
    pub const MIN_FACTOR_RANGE: (f32, f32) = (0.3, 1.0);
    pub const MAX_FACTOR_RANGE: (f32, f32) = (2.0, 100.0);
}

impl Default for Bounds {
    fn default() -> Bounds {
        Bounds {
            min_factor: 0.5,
            max_factor: 20.0,
        }
    }
}

/// A routing profile.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Profile {
    /// Display name (presets have one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The preset this profile was made from (the UI's diff against it; routing ignores it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Soft preferences. An absent id has no opinion (factor 1); an explicit 0 is the same for
    /// routing, but stays on screen.
    #[serde(default)]
    pub weights: BTreeMap<PrefId, Weight>,
    /// Hard limits.
    #[serde(default)]
    pub limits: BTreeMap<LimitId, LimitValue>,
    /// The factor clamp; defaults apply when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
}

/// Why a profile is not valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileError(pub String);

impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProfileError {}

impl Profile {
    /// Parses a profile from JSON and validates it.
    pub fn from_json(json: &str) -> Result<Profile, ProfileError> {
        let p: Profile = serde_json::from_str(json).map_err(|e| ProfileError(format!("profile: {e}")))?;
        p.validate()?;
        Ok(p)
    }

    /// The weight of a preference, `None` without an opinion.
    #[must_use]
    pub fn weight(&self, id: PrefId) -> Option<i8> {
        self.weights.get(&id).map(|w| w.get())
    }

    /// Sets (or with `None` removes) a weight; panics outside −100..=100.
    pub fn set_weight(&mut self, id: PrefId, w: Option<i8>) {
        match w {
            Some(w) => {
                self.weights
                    .insert(id, Weight::new(i64::from(w)).expect("weight in -100..100"));
            }
            None => {
                self.weights.remove(&id);
            }
        }
    }

    #[must_use]
    pub fn bounds(&self) -> Bounds {
        self.bounds.unwrap_or_default()
    }

    /// The effective setting of a limit: `None` off, `Some(None)` on (a switch), `Some(Some(n))` on
    /// with its number (the default if given as `true`).
    #[must_use]
    pub fn limit(&self, id: LimitId) -> Option<Option<f64>> {
        let def = crate::catalogue::limit_meta(id);
        match self.limits.get(&id)? {
            LimitValue::Flag(false) => None,
            LimitValue::Flag(true) => Some(def.number.map(|n| n.default)),
            LimitValue::Number(n) => Some(Some(*n)),
        }
    }

    /// Checks the limits' values and the bounds (the weights are checked when parsed).
    pub fn validate(&self) -> Result<(), ProfileError> {
        for (&id, v) in &self.limits {
            let meta = crate::catalogue::limit_meta(id);
            match (v, meta.number) {
                (LimitValue::Number(_), None) => {
                    return Err(ProfileError(format!(
                        "limit `{id}` is a switch: give true or false, not a number"
                    )));
                }
                (LimitValue::Number(n), Some(range)) if !(range.min..=range.max).contains(n) => {
                    return Err(ProfileError(format!(
                        "limit `{id}`: {n} is outside {}..{}",
                        range.min, range.max
                    )));
                }
                _ => {}
            }
        }
        let b = self.bounds();
        let (lo, hi) = Bounds::MIN_FACTOR_RANGE;
        if !(lo..=hi).contains(&b.min_factor) {
            return Err(ProfileError(format!(
                "bounds.min_factor {} is outside {lo}..{hi}",
                b.min_factor
            )));
        }
        let (lo, hi) = Bounds::MAX_FACTOR_RANGE;
        if !(lo..=hi).contains(&b.max_factor) {
            return Err(ProfileError(format!(
                "bounds.max_factor {} is outside {lo}..{hi}",
                b.max_factor
            )));
        }
        Ok(())
    }

    /// What decides the cost: the weights (0 dropped), the active limits and the bounds. Two
    /// profiles with the same key route the same (the name and base do not matter).
    #[must_use]
    pub fn cost_key(&self) -> String {
        use std::fmt::Write;
        let mut s = String::new();
        for (id, w) in &self.weights {
            if w.get() != 0 {
                let _ = write!(s, "{id}={};", w.get());
            }
        }
        for &id in LimitId::ALL {
            if let Some(n) = self.limit(id) {
                let _ = write!(s, "!{id}={n:?};");
            }
        }
        let b = self.bounds();
        let _ = write!(s, "[{},{}]", b.min_factor, b.max_factor);
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_roundtrip() {
        for &p in PrefId::ALL {
            assert_eq!(PrefId::from_id(p.id()), Some(p));
            let json = serde_json::to_string(&p).unwrap();
            assert_eq!(json, format!("\"{}\"", p.id()));
            assert_eq!(PrefId::ALL[p.index()], p);
        }
        for &l in LimitId::ALL {
            assert_eq!(LimitId::from_id(l.id()), Some(l));
        }
    }

    #[test]
    fn parses_and_validates() {
        let p = Profile::from_json(
            r#"{"name":"x","weights":{"unpaved":70,"quiet":-100},"limits":{"max_grade":12,"no_stairs":true,"paved_only":false},"bounds":{"min_factor":0.4}}"#,
        )
        .unwrap();
        assert_eq!(p.weight(PrefId::Unpaved), Some(70));
        assert_eq!(p.weight(PrefId::Forest), None);
        assert_eq!(p.limit(LimitId::MaxGrade), Some(Some(12.0)));
        assert_eq!(p.limit(LimitId::NoStairs), Some(None));
        assert_eq!(p.limit(LimitId::PavedOnly), None);
        assert!((p.bounds().max_factor - 20.0).abs() < 1e-6);
        // `true` on a number limit means its default
        let q = Profile::from_json(r#"{"limits":{"max_grade":true}}"#).unwrap();
        assert_eq!(q.limit(LimitId::MaxGrade), Some(Some(12.0)));
    }

    #[test]
    fn rejects_bad_profiles() {
        for (json, want) in [
            (r#"{"weights":{"unpaved":101}}"#, "outside -100..100"),
            (r#"{"weights":{"gravelz":10}}"#, "unknown variant `gravelz`"),
            (r#"{"limits":{"no_stairs":3}}"#, "is a switch"),
            (r#"{"limits":{"max_grade":40}}"#, "outside"),
            (r#"{"bounds":{"min_factor":0.1}}"#, "min_factor"),
            (r#"{"bounds":{"max_factor":1.5}}"#, "max_factor"),
            (r#"{"weigths":{}}"#, "unknown field"),
        ] {
            let e = Profile::from_json(json).unwrap_err();
            assert!(e.0.contains(want), "{json}: {e}");
        }
    }

    #[test]
    fn cost_key_ignores_names_and_zero_weights() {
        let mut a = Profile::default();
        a.set_weight(PrefId::Unpaved, Some(50));
        let mut b = a.clone();
        b.name = Some("other".into());
        b.set_weight(PrefId::Forest, Some(0));
        assert_eq!(a.cost_key(), b.cost_key());
        b.set_weight(PrefId::Forest, Some(1));
        assert_ne!(a.cost_key(), b.cost_key());
    }
}
